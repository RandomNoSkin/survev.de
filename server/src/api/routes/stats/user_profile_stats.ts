import { eq, type SQL, sql } from "drizzle-orm";
import { MapId, TeamMode } from "../../../../../shared/gameConfig.ts";
import { Hono } from "hono";
import { statsRangeFor, statsSeasons } from "../../../../../shared/statsPeriods.ts";
import {
    type UserProfileOverview,
    type UserProfileStatsResponse,
    type UserProfileWeapon,
    zUserProfileStatsRequest,
} from "../../../../../shared/types/stats.ts";
import { databaseEnabledMiddleware, rateLimitMiddleware, validateParams } from "../../auth/middleware.ts";
import { db } from "../../db/index.ts";
import { isPremiumActive } from "../../db/premium.ts";
import { usersTable } from "../../db/schema.ts";
import type { Context } from "../../index.ts";

/**
 * The extended stats on a player profile: overview with the period before for
 * comparison, by mode / map, per weapon and activity over time. Public, but only for
 * accounts with Premium (staff count as Premium) - everyone else gets `premium: false`.
 */
export const UserProfileStatsRouter = new Hono<Context>();

const n = (v: unknown) => Number(v ?? 0);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

function matchWhere(userId: string, from: number | null, to: number, teamMode?: number, mapId?: number): SQL {
    const conds: SQL[] = [sql`user_id = ${userId}`, sql`created_at < to_timestamp(${to / 1000})`];
    if (from !== null) conds.push(sql`created_at >= to_timestamp(${from / 1000})`);
    if (teamMode !== undefined) conds.push(sql`team_mode = ${teamMode}`);
    if (mapId !== undefined) conds.push(sql`map_id = ${mapId}`);
    return sql.join(conds, sql` AND `);
}

/** Hits per shot in % - capped at 100: older rows counted every pierce / reflect /
 *  splinter / explosion hit, so hits could outnumber shots. */
const accuracyPct = (hits: number, shots: number) => (shots ? r1(Math.min(100, (hits / shots) * 100)) : null);

async function overview(where: SQL): Promise<UserProfileOverview> {
    const res = await db.execute(sql`
        SELECT COUNT(*) AS games,
            COUNT(*) FILTER (WHERE rank = 1) AS wins,
            COUNT(*) FILTER (WHERE rank <= 5) AS top5,
            COALESCE(SUM(kills), 0) AS kills,
            COUNT(*) FILTER (WHERE died) AS deaths,
            COALESCE(SUM(assists), 0) AS assists,
            COALESCE(SUM(damage_dealt), 0) AS damage,
            COALESCE(MAX(kills), 0) AS max_kills,
            COALESCE(MAX(damage_dealt), 0) AS max_damage,
            COALESCE(SUM(time_alive), 0) AS time_alive,
            COALESCE(SUM(revives), 0) AS revives,
            COALESCE(SUM(teammate_saves), 0) AS saves,
            COALESCE(AVG(rank), 0) AS avg_rank,
            AVG(impact_score) AS avg_impact,
            COALESCE(SUM(shots_fired), 0) AS shots,
            COALESCE(SUM(bullet_hits), 0) AS hits
        FROM match_data WHERE ${where}
    `);
    const r = (res.rows[0] ?? {}) as Record<string, unknown>;
    const games = n(r.games);
    const kills = n(r.kills);
    const deaths = n(r.deaths);
    const shots = n(r.shots);
    return {
        games,
        wins: n(r.wins),
        winRate: games ? r1((n(r.wins) / games) * 100) : 0,
        top5: n(r.top5),
        kills,
        deaths,
        kd: r2(kills / Math.max(1, deaths)),
        assists: n(r.assists),
        avgKills: games ? r2(kills / games) : 0,
        avgDamage: games ? Math.round(n(r.damage) / games) : 0,
        totalDamage: n(r.damage),
        maxKills: n(r.max_kills),
        maxDamage: n(r.max_damage),
        avgTimeAlive: games ? Math.round(n(r.time_alive) / games) : 0,
        totalTimeAlive: n(r.time_alive),
        revives: n(r.revives),
        teammateSaves: n(r.saves),
        avgRank: r1(n(r.avg_rank)),
        avgImpact: r.avg_impact === null || r.avg_impact === undefined ? null : Math.round(n(r.avg_impact)),
        shots,
        hits: n(r.hits),
        accuracy: accuracyPct(n(r.hits), shots),
    };
}

/** UTC day ("YYYY-MM-DD") a timestamp falls on - the weapon table is per day. */
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

UserProfileStatsRouter.post(
    "/",
    databaseEnabledMiddleware,
    rateLimitMiddleware(40, 60 * 1000),
    validateParams(zUserProfileStatsRequest),
    async (c) => {
        const req = c.req.valid("json");
        const user = await db.query.usersTable.findFirst({
            where: eq(usersTable.slug, req.slug),
            columns: { id: true, username: true, banned: true, premiumUntil: true, admin: true, owner: true, moderator: true, trackDuels: true },
        });
        const premium =
            !!user &&
            !user.banned &&
            (isPremiumActive(user.premiumUntil ?? null) || !!user.admin || !!user.owner || !!user.moderator);
        if (!user || !premium) return c.json<UserProfileStatsResponse>({ premium: false });

        const range = statsRangeFor(req);
        const where = matchWhere(user.id, range.from, range.to, req.teamMode, req.mapId);
        const prevWhere =
            range.prevFrom !== null && range.prevTo !== null
                ? matchWhere(user.id, range.prevFrom, range.prevTo, req.teamMode, req.mapId)
                : null;
        const bucket = sql.raw(`(date_trunc('${range.bucket}', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`);

        // weapons are per day (+ map / mode since migration 0038; older rows have -1 there
        // and only count without those filters)
        const weaponConds: SQL[] = [sql`user_id = ${user.id}`, sql`day <= ${utcDay(range.to)}`];
        if (range.from !== null) weaponConds.push(sql`day >= ${utcDay(range.from)}`);
        if (req.teamMode !== undefined) weaponConds.push(sql`team_mode = ${req.teamMode}`);
        if (req.mapId !== undefined) weaponConds.push(sql`map_id = ${req.mapId}`);

        // 1v1 duels only exist in local (solo) mode - other map / mode filters have none
        const duelsApply =
            user.trackDuels &&
            (req.mapId === undefined || req.mapId === MapId.Local) && (req.teamMode === undefined || req.teamMode === TeamMode.Solo);
        const duelConds: SQL[] = [sql`(d.winner_user_id = ${user.id} OR d.loser_user_id = ${user.id})`, sql`d.created_at < to_timestamp(${range.to / 1000})`];
        if (range.from !== null) duelConds.push(sql`d.created_at >= to_timestamp(${range.from / 1000})`);

        const [ov, prev, modes, maps, weapons, activity, duels] = await Promise.all([
            overview(where),
            prevWhere ? overview(prevWhere) : Promise.resolve(null),
            db.execute(sql`
                SELECT team_mode, COUNT(*) AS games, COUNT(*) FILTER (WHERE rank = 1) AS wins,
                    COALESCE(SUM(kills), 0) AS kills, COUNT(*) FILTER (WHERE died) AS deaths,
                    COALESCE(AVG(damage_dealt), 0) AS avg_damage
                FROM match_data WHERE ${where} GROUP BY team_mode ORDER BY games DESC
            `),
            db.execute(sql`
                SELECT map_id, COUNT(*) AS games, COUNT(*) FILTER (WHERE rank = 1) AS wins,
                    COALESCE(SUM(kills), 0) AS kills, COALESCE(AVG(damage_dealt), 0) AS avg_damage
                FROM match_data WHERE ${where} GROUP BY map_id ORDER BY games DESC
            `),
            db.execute(sql`
                SELECT weapon_type, SUM(games) AS games, SUM(kills) AS kills, SUM(damage) AS damage,
                    MAX(max_damage) AS max_damage, SUM(shots) AS shots, SUM(hits) AS hits
                FROM user_weapon_stats_daily WHERE ${sql.join(weaponConds, sql` AND `)}
                GROUP BY weapon_type ORDER BY kills DESC, damage DESC
            `),
            db.execute(sql`
                SELECT ${bucket} AS bucket, COUNT(*) AS games, COALESCE(SUM(kills), 0) AS kills,
                    COUNT(*) FILTER (WHERE rank = 1) AS wins
                FROM match_data WHERE ${where} GROUP BY ${bucket} ORDER BY ${bucket}
            `),
            duelsApply
                ? db.execute(sql`
                    SELECT u.slug, u.username, x.duels, x.wins FROM (
                        SELECT CASE WHEN d.winner_user_id = ${user.id} THEN d.loser_user_id ELSE d.winner_user_id END AS opponent,
                            COUNT(*) AS duels, COUNT(*) FILTER (WHERE d.winner_user_id = ${user.id}) AS wins
                        FROM duel_results d WHERE ${sql.join(duelConds, sql` AND `)}
                        GROUP BY 1
                    ) x JOIN users u ON u.id = x.opponent
                    WHERE NOT u.banned AND u.track_duels
                    ORDER BY x.duels DESC, x.wins DESC LIMIT 25
                `)
                : Promise.resolve({ rows: [] }),
        ]);

        const rows = (x: { rows: unknown[] }) => x.rows as Record<string, unknown>[];
        return c.json<UserProfileStatsResponse>({
            premium: true,
            username: user.username,
            period: req.period,
            range: { from: range.from, to: range.to },
            prevRange:
                range.prevFrom !== null && range.prevTo !== null ? { from: range.prevFrom, to: range.prevTo } : null,
            seasons: statsSeasons(),
            season: range.season?.id,
            month: range.month?.id,
            overview: ov,
            previous: prev,
            byMode: rows(modes).map((r) => ({
                teamMode: n(r.team_mode),
                games: n(r.games),
                wins: n(r.wins),
                kills: n(r.kills),
                kd: r2(n(r.kills) / Math.max(1, n(r.deaths))),
                avgDamage: Math.round(n(r.avg_damage)),
                winRate: n(r.games) ? r1((n(r.wins) / n(r.games)) * 100) : 0,
            })),
            byMap: rows(maps).map((r) => ({
                mapId: n(r.map_id),
                games: n(r.games),
                wins: n(r.wins),
                kills: n(r.kills),
                avgDamage: Math.round(n(r.avg_damage)),
                winRate: n(r.games) ? r1((n(r.wins) / n(r.games)) * 100) : 0,
            })),
            weapons: rows(weapons).map((r): UserProfileWeapon => ({
                weaponType: String(r.weapon_type),
                games: n(r.games),
                kills: n(r.kills),
                damage: n(r.damage),
                avgDamage: n(r.games) ? Math.round(n(r.damage) / n(r.games)) : 0,
                maxDamage: n(r.max_damage),
                shots: n(r.shots),
                hits: n(r.hits),
                accuracy: accuracyPct(n(r.hits), n(r.shots)),
            })),
            duelsHidden: !user.trackDuels || undefined,
            // undefined = not tracked for this map / mode filter
            duels: !duelsApply ? undefined : rows(duels).map((r) => ({
                slug: String(r.slug),
                username: String(r.username),
                duels: n(r.duels),
                wins: n(r.wins),
                losses: n(r.duels) - n(r.wins),
                winRate: n(r.duels) ? r1((n(r.wins) / n(r.duels)) * 100) : 0,
            })),
            bucket: range.bucket,
            activity: rows(activity).map((r) => ({
                bucket: new Date(r.bucket as string).toISOString(),
                games: n(r.games),
                kills: n(r.kills),
                wins: n(r.wins),
            })),
        });
    },
);
