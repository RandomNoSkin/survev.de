import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getKeyDef } from "../../../../shared/defs/crateConfig";
import { MapId } from "../../../../shared/gameConfig";
import {
    CLAN_LEAGUE_MIN_GAMES,
    CLAN_MIN_LOBBY_PLAYERS,
    CLAN_REWARD_MIN_ACTIVE,
    CLAN_REWARD_MIN_GAMES_EACH,
    CLAN_GOAL_TIERS,
    CLAN_WEEK_REWARDS,
    clanGoalTier,
    clanTeamBonus,
    type ClanActionResponse,
    type ClanLeagueEntry,
    type ClanLeagueMetric,
    type ClanLeagueResponse,
    type ClanModeStats,
    type ClanRole,
    type ClanStatsResponse,
    type ClanWeek,
    type ClanWeekSummary,
    perGame,
    ratedWinRate,
} from "../../../../shared/utils/clan";
import { db } from "./index";
import { computeMatchXp } from "./passReconcile";
import { playerIcon, playerIconColumns } from "./playerIcon";
import {
    clanKeyPoolTable,
    clanMembersTable,
    clansTable,
    clanWeekGoalsTable,
    clanWeekRewardsTable,
    clanWeekStatsTable,
    itemsTable,
    playerWeekStatsTable,
    usersTable,
} from "./schema";

/** Maps that count for the clan stats (the `mode` column stays for future modes). */
const COMP_MAPS = new Set<number>([MapId.Comp, MapId.CompDuo, MapId.CompSolo]);
const MODE = "comp";

/** Monday 00:00 (server-local) of the week containing `t`, and the Monday after. */
export function clanWeek(t = Date.now()): ClanWeek {
    const d = new Date(t);
    const daysSinceMonday = (d.getDay() + 6) % 7; // getDay(): 0=Sun … 6=Sat
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysSinceMonday);
    // calendar days, not 7×24h, so a DST switch can't shift the reset
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    return { start: start.getTime(), end: end.getTime() };
}

/** "YYYY-MM-DD" of the week's Monday - the `week` column. */
export function weekKey(t = Date.now()): string {
    const d = new Date(clanWeek(t).start);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Adds a finished game to the weekly stats of every player in it who is in a clan.
 * Only public Comp games with a full lobby of humans count - private lobbies or a
 * half-empty server would let a clan farm stats. (Games with bots are never saved.)
 */
export async function recordClanStats(
    rows: {
        userId?: string | null;
        mapId: number;
        teamId: number;
        rank: number;
        damageDealt: number;
        kills: number;
        userBanned?: boolean | null;
    }[],
    isPrivate: boolean,
): Promise<void> {
    if (isPrivate || rows.length < CLAN_MIN_LOBBY_PLAYERS) return;
    const counted = rows.filter((r) => r.userId && !r.userBanned && COMP_MAPS.has(r.mapId));
    if (!counted.length) return;
    const members = await db
        .select({ userId: clanMembersTable.userId, clanId: clanMembersTable.clanId })
        .from(clanMembersTable)
        .where(inArray(clanMembersTable.userId, counted.map((r) => r.userId!)));
    const clanOf = new Map(members.map((m) => [m.userId, m.clanId]));
    const week = weekKey();

    // players in no clan: kept aside, they move into the clan they join this week
    const clanless = counted.filter((r) => !clanOf.has(r.userId!));
    if (clanless.length) {
        const p = playerWeekStatsTable;
        await db
            .insert(p)
            .values(
                clanless.map((r) => ({
                    week,
                    userId: r.userId!,
                    mode: MODE,
                    games: 1,
                    wins: r.rank === 1 ? 1 : 0,
                    damage: Math.max(0, Math.round(r.damageDealt)),
                    kills: Math.max(0, r.kills),
                })),
            )
            .onConflictDoUpdate({
                target: [p.week, p.userId, p.mode],
                set: {
                    games: sql`${p.games} + excluded.games`,
                    wins: sql`${p.wins} + excluded.wins`,
                    damage: sql`${p.damage} + excluded.damage`,
                    kills: sql`${p.kills} + excluded.kills`,
                },
            });
    }
    if (!clanOf.size) return;
    // team bonus: how many members of the same clan were in each team
    const mates = new Map<string, number>();
    const teamsOf = new Map<number, Set<number>>();
    for (const r of counted) {
        const clanId = clanOf.get(r.userId!);
        if (clanId === undefined) continue;
        const k = `${clanId}:${r.teamId}`;
        mates.set(k, (mates.get(k) ?? 0) + 1);
        teamsOf.set(clanId, (teamsOf.get(clanId) ?? new Set()).add(r.teamId));
    }
    // A clan on more than one team played against itself: the game doesn't count for it at
    // all - else a clan could fill a lobby on both sides (a sure win + team bonus every
    // game) or throw / team up between its own members. Other clans in it count normally.
    const values = counted
        .filter((r) => clanOf.has(r.userId!) && teamsOf.get(clanOf.get(r.userId!)!)!.size === 1)
        .map((r) => ({
            week,
            clanId: clanOf.get(r.userId!)!,
            userId: r.userId!,
            mode: MODE,
            games: 1,
            wins: r.rank === 1 ? 1 : 0,
            weightedWins: r.rank === 1 ? clanTeamBonus(mates.get(`${clanOf.get(r.userId!)}:${r.teamId}`) ?? 1) : 0,
            damage: Math.max(0, Math.round(r.damageDealt)),
            kills: Math.max(0, r.kills),
        }));
    if (!values.length) return;
    const t = clanWeekStatsTable;
    await db
        .insert(t)
        .values(values)
        .onConflictDoUpdate({
            target: [t.week, t.clanId, t.userId, t.mode],
            set: {
                games: sql`${t.games} + excluded.games`,
                wins: sql`${t.wins} + excluded.wins`,
                damage: sql`${t.damage} + excluded.damage`,
                kills: sql`${t.kills} + excluded.kills`,
                weightedWins: sql`${t.weightedWins} + excluded.weighted_wins`,
            },
        });
}

/**
 * Clan progress: every clan member's match XP (the same base XP they earn for the
 * battle pass) is added to their clan's XP.
 */
export async function addClanXp(
    rows: { userId?: string | null; mapId: number; rank: number; damageDealt: number; kills: number; timeAlive: number; userBanned?: boolean | null }[],
): Promise<void> {
    const players = rows.filter((r) => r.userId && !r.userBanned);
    if (!players.length) return;
    const members = await db
        .select({ userId: clanMembersTable.userId, clanId: clanMembersTable.clanId })
        .from(clanMembersTable)
        .where(inArray(clanMembersTable.userId, players.map((r) => r.userId!)));
    if (!members.length) return;
    const clanOf = new Map(members.map((m) => [m.userId, m.clanId]));
    const xpByClan = new Map<number, number>();
    for (const r of players) {
        const clanId = clanOf.get(r.userId!);
        if (clanId === undefined) continue;
        const xp = computeMatchXp({ kills: r.kills, damage: r.damageDealt, timeAlive: r.timeAlive, rank: r.rank, mapId: r.mapId });
        if (xp > 0) xpByClan.set(clanId, (xpByClan.get(clanId) ?? 0) + xp);
    }
    for (const [clanId, xp] of xpByClan) {
        await db
            .update(clansTable)
            .set({ xp: sql`${clansTable.xp} + ${xp}` })
            .where(eq(clansTable.id, clanId));
    }
}

/**
 * A player just joined or founded `clanId`: their games of this week from before (while in
 * no clan) count for it - unless they already played for another clan this week; then
 * only games from the join on count (each game counts once, for the clan the player was
 * in, so switching around the join can't move games). No team bonus for those games:
 * they had no clan mates.
 */
export async function adoptWeekStats(tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0], userId: string, clanId: number) {
    const week = weekKey();
    const [other] = await tx
        .select({ clanId: clanWeekStatsTable.clanId })
        .from(clanWeekStatsTable)
        .where(and(eq(clanWeekStatsTable.week, week), eq(clanWeekStatsTable.userId, userId), ne(clanWeekStatsTable.clanId, clanId)))
        .limit(1);
    if (other) return;
    const p = playerWeekStatsTable;
    const rows = await tx
        .delete(p)
        .where(and(eq(p.week, week), eq(p.userId, userId)))
        .returning();
    const t = clanWeekStatsTable;
    for (const r of rows) {
        await tx
            .insert(t)
            .values({
                week,
                clanId,
                userId,
                mode: r.mode,
                games: r.games,
                wins: r.wins,
                weightedWins: r.wins,
                damage: r.damage,
                kills: r.kills,
            })
            .onConflictDoUpdate({
                target: [t.week, t.clanId, t.userId, t.mode],
                set: {
                    games: sql`${t.games} + excluded.games`,
                    wins: sql`${t.wins} + excluded.wins`,
                    weightedWins: sql`${t.weightedWins} + excluded.weighted_wins`,
                    damage: sql`${t.damage} + excluded.damage`,
                    kills: sql`${t.kills} + excluded.kills`,
                },
            });
    }
}

const empty = (): ClanModeStats => ({ games: 0, wins: 0, damage: 0, kills: 0, weightedWins: 0 });

function add(a: ClanModeStats, b: ClanModeStats) {
    a.games += Number(b.games);
    a.wins += Number(b.wins);
    a.damage += Number(b.damage);
    a.kills += Number(b.kills);
    a.weightedWins += Number(b.weightedWins);
}

/** Win rate over every clan's games of a week - what the rated win rate pulls towards. */
async function leagueAverage(week: string): Promise<number> {
    const [r] = await db
        .select({
            wins: sql<number>`coalesce(sum(${clanWeekStatsTable.weightedWins}), 0)`,
            games: sql<number>`coalesce(sum(${clanWeekStatsTable.games}), 0)`,
        })
        .from(clanWeekStatsTable)
        .where(and(eq(clanWeekStatsTable.week, week), eq(clanWeekStatsTable.mode, MODE)));
    return perGame(Number(r?.wins ?? 0), Number(r?.games ?? 0));
}

/** Totals + player counts from one clan's per-player rows of a week. */
function summarize(rows: ClanModeStats[], average: number): ClanWeekSummary {
    const s = empty();
    let players = 0;
    let qualified = 0;
    let qualifiedGames = 0;
    for (const r of rows) {
        add(s, r);
        if (r.games > 0) players++;
        if (r.games >= CLAN_REWARD_MIN_GAMES_EACH) {
            qualified++;
            qualifiedGames += Number(r.games);
        }
    }
    const avgGames = qualified ? qualifiedGames / qualified : 0;
    return {
        ...s,
        players,
        qualified,
        rating: ratedWinRate(s.weightedWins, s.games, average),
        eligible: qualified >= CLAN_REWARD_MIN_ACTIVE,
        avgGames,
        goalTier: qualified >= CLAN_REWARD_MIN_ACTIVE ? clanGoalTier(avgGames) : 0,
    };
}

/** A week's rows of a clan. */
function weekRows(clanId: number, week = weekKey()) {
    return db
        .select()
        .from(clanWeekStatsTable)
        .where(
            and(
                eq(clanWeekStatsTable.week, week),
                eq(clanWeekStatsTable.clanId, clanId),
                eq(clanWeekStatsTable.mode, MODE),
            ),
        );
}

/** This week's summary of a clan (everything played for it, also by players who left). */
export async function getClanWeekTotals(clanId: number): Promise<ClanWeekSummary> {
    return summarize(await weekRows(clanId), await leagueAverage(weekKey()));
}

/** This week's stats of a clan: the summary and each current member's own numbers. */
export async function getClanStats(clanId: number): Promise<ClanStatsResponse> {
    const rows = await weekRows(clanId);
    const byUser = new Map<string, ClanModeStats>();
    for (const r of rows) {
        const u = byUser.get(r.userId) ?? empty();
        add(u, r);
        byUser.set(r.userId, u);
    }
    const members = await db
        .select({
            userId: clanMembersTable.userId,
            role: clanMembersTable.role,
            slug: usersTable.slug,
            username: usersTable.username,
            ...playerIconColumns,
        })
        .from(clanMembersTable)
        .innerJoin(usersTable, eq(usersTable.id, clanMembersTable.userId))
        .where(eq(clanMembersTable.clanId, clanId));
    return {
        week: clanWeek(),
        totals: summarize([...byUser.values()], await leagueAverage(weekKey())),
        members: members
            .map((m) => ({
                slug: m.slug,
                username: m.username,
                icon: playerIcon(m),
                role: (m.role === "owner" || m.role === "lieutenant" ? m.role : "member") as ClanRole,
                stats: byUser.get(m.userId) ?? empty(),
            }))
            .sort((a, b) => b.stats.wins - a.stats.wins || b.stats.games - a.stats.games),
    };
}

/** The clan of `userId`, if any. */
export async function clanIdOf(userId: string): Promise<number | null> {
    const [m] = await db
        .select({ clanId: clanMembersTable.clanId })
        .from(clanMembersTable)
        .where(eq(clanMembersTable.userId, userId));
    return m?.clanId ?? null;
}

/** Every clan that played in `week`, with its summary. */
async function weekSummaries(week: string) {
    const rows = await db
        .select({
            clanId: clanWeekStatsTable.clanId,
            userId: clanWeekStatsTable.userId,
            weightedWins: clanWeekStatsTable.weightedWins,
            games: clanWeekStatsTable.games,
            wins: clanWeekStatsTable.wins,
            damage: clanWeekStatsTable.damage,
            kills: clanWeekStatsTable.kills,
            name: clansTable.name,
            tag: clansTable.tag,
            icon: clansTable.icon,
            tagColor: clansTable.tagColor,
            banner: clansTable.banner,
        })
        .from(clanWeekStatsTable)
        .innerJoin(clansTable, eq(clansTable.id, clanWeekStatsTable.clanId))
        .where(and(eq(clanWeekStatsTable.week, week), eq(clanWeekStatsTable.mode, MODE)));
    const byClan = new Map<number, { info: { name: string; tag: string; icon: string; tagColor: number; banner: number }; rows: (ClanModeStats & { userId: string })[] }>();
    for (const r of rows) {
        const c = byClan.get(r.clanId) ?? { info: { name: r.name, tag: r.tag, icon: r.icon, tagColor: r.tagColor, banner: r.banner }, rows: [] };
        c.rows.push(r);
        byClan.set(r.clanId, c);
    }
    const average = await leagueAverage(week);
    return [...byClan].map(([id, c]) => ({ id, ...c.info, rows: c.rows, ...summarize(c.rows, average) }));
}

/** Rewards order: rated win rate, then total wins, then games. */
function byRating(a: ClanWeekSummary, b: ClanWeekSummary) {
    return b.rating - a.rating || b.wins - a.wins || b.games - a.games;
}

async function titlesOf(clanIds: number[]): Promise<Map<number, number>> {
    if (!clanIds.length) return new Map();
    const rows = await db
        .select({ clanId: clanWeekRewardsTable.clanId, n: sql<number>`count(*)` })
        .from(clanWeekRewardsTable)
        .where(and(inArray(clanWeekRewardsTable.clanId, clanIds), eq(clanWeekRewardsTable.rank, 1)))
        .groupBy(clanWeekRewardsTable.clanId);
    return new Map(rows.map((r) => [r.clanId, Number(r.n)]));
}

/**
 * This week's league in one of four views. "rated" (smoothed win rate) is the one that
 * pays: only clans with CLAN_REWARD_MIN_ACTIVE members of CLAN_REWARD_MIN_GAMES_EACH+
 * games are ranked there, the rest is listed as unranked.
 */
export async function getClanLeague(metric: ClanLeagueMetric): Promise<ClanLeagueResponse> {
    const all = await weekSummaries(weekKey());
    const titles = await titlesOf(all.map((c) => c.id));
    const value = (c: ClanWeekSummary) =>
        metric === "rated"
            ? c.rating
            : metric === "wins"
              ? c.wins
              : metric === "winrate"
                ? perGame(c.wins, c.games)
                : perGame(c.damage, c.games);
    const entries: ClanLeagueEntry[] = all.map(({ rows: _rows, ...c }) => ({ ...c, titles: titles.get(c.id) ?? 0, value: value(c) }));
    let ranked: ClanLeagueEntry[];
    let unranked: ClanLeagueEntry[] = [];
    if (metric === "rated") {
        ranked = entries.filter((e) => e.eligible).sort(byRating);
        unranked = entries.filter((e) => !e.eligible).sort(byRating);
    } else if (metric === "wins") {
        ranked = entries.sort((a, b) => b.wins - a.wins || b.games - a.games);
    } else {
        ranked = entries.filter((e) => e.games >= CLAN_LEAGUE_MIN_GAMES).sort((a, b) => b.value - a.value || b.games - a.games);
    }
    return {
        week: clanWeek(),
        minGames: CLAN_LEAGUE_MIN_GAMES,
        entries: ranked.slice(0, 100),
        unranked: unranked.slice(0, 50),
        leagueAverage: await leagueAverage(weekKey()),
    };
}

// ── weekly rewards ───────────────────────────────────────────────────────────

/**
 * Pays the league of a finished week (top 3 by rated win rate, eligible clans only)
 * into the clans' key pools. Idempotent: the (week, rank) rows are the lock, so running
 * it again - at every midnight, at boot - never pays twice.
 */
export async function awardClanWeek(week: string): Promise<number> {
    const ranked = (await weekSummaries(week)).filter((c) => c.eligible).sort(byRating).slice(0, 3);
    let paid = 0;
    for (const [i, clan] of ranked.entries()) {
        const rank = i + 1;
        const keys = CLAN_WEEK_REWARDS[rank];
        if (!keys) continue;
        await db.transaction(async (tx) => {
            const [claimed] = await tx
                .insert(clanWeekRewardsTable)
                .values({ week, rank, clanId: clan.id, rating: clan.rating, keys })
                .onConflictDoNothing()
                .returning({ rank: clanWeekRewardsTable.rank });
            if (!claimed) return;
            for (const [keyType, amount] of Object.entries(keys)) {
                await tx
                    .insert(clanKeyPoolTable)
                    .values({ clanId: clan.id, keyType, amount })
                    .onConflictDoUpdate({
                        target: [clanKeyPoolTable.clanId, clanKeyPoolTable.keyType],
                        set: { amount: sql`${clanKeyPoolTable.amount} + ${amount}` },
                    });
            }
            paid++;
        });
    }
    return paid;
}

/**
 * Pays the weekly activity goals of a finished week: for every eligible clan, each goal
 * tier its players reached (average games of the players with
 * CLAN_REWARD_MIN_GAMES_EACH+ games) pays one key straight to each of those players.
 * Idempotent through the (week, clan) row.
 */
export async function awardClanGoals(week: string): Promise<number> {
    let paid = 0;
    for (const clan of await weekSummaries(week)) {
        if (!clan.goalTier) continue;
        const players = clan.rows.filter((r) => r.games >= CLAN_REWARD_MIN_GAMES_EACH).map((r) => r.userId);
        await db.transaction(async (tx) => {
            const [claimed] = await tx
                .insert(clanWeekGoalsTable)
                .values({ week, clanId: clan.id, tier: clan.goalTier, avgGames: clan.avgGames, players: players.length })
                .onConflictDoNothing()
                .returning({ tier: clanWeekGoalsTable.tier });
            if (!claimed) return;
            const now = Date.now();
            const keys = CLAN_GOAL_TIERS.slice(0, clan.goalTier).map((t) => t.key);
            await tx.insert(itemsTable).values(
                players.flatMap((userId) => keys.map((type) => ({ userId, type, source: "clan_goal", timeAcquired: now }))),
            );
            paid++;
        });
    }
    return paid;
}

/** Pays last week (league + goals) if that hasn't happened yet (midnight cron + boot,
 *  so a restart over Sunday night can't skip a week). */
export async function awardFinishedClanWeeks(): Promise<number> {
    const lastWeek = weekKey(clanWeek().start - 1);
    return (await awardClanWeek(lastWeek)) + (await awardClanGoals(lastWeek));
}

/** The clan's undistributed keys, by key type. */
export async function getClanPool(clanId: number): Promise<Record<string, number>> {
    const rows = await db
        .select({ keyType: clanKeyPoolTable.keyType, amount: clanKeyPoolTable.amount })
        .from(clanKeyPoolTable)
        .where(and(eq(clanKeyPoolTable.clanId, clanId), gte(clanKeyPoolTable.amount, 1)));
    return Object.fromEntries(rows.map((r) => [r.keyType, r.amount]));
}

/** Owner hands `amount` pool keys of `keyType` to a member (themselves included). */
export async function giveFromPool(ownerId: string, slug: string, keyType: string, amount: number): Promise<ClanActionResponse> {
    if (!getKeyDef(keyType)) return { success: false, error: "not_found" };
    try {
        await db.transaction(async (tx) => {
            const [clan] = await tx.select({ id: clansTable.id }).from(clansTable).where(eq(clansTable.ownerId, ownerId));
            if (!clan) throw new Error("not_owner");
            const [target] = await tx
                .select({ id: usersTable.id })
                .from(usersTable)
                .innerJoin(clanMembersTable, eq(clanMembersTable.userId, usersTable.id))
                .where(and(eq(usersTable.slug, slug.trim().toLowerCase()), eq(clanMembersTable.clanId, clan.id)));
            if (!target) throw new Error("not_member");
            const [left] = await tx
                .update(clanKeyPoolTable)
                .set({ amount: sql`${clanKeyPoolTable.amount} - ${amount}` })
                .where(
                    and(
                        eq(clanKeyPoolTable.clanId, clan.id),
                        eq(clanKeyPoolTable.keyType, keyType),
                        gte(clanKeyPoolTable.amount, amount),
                    ),
                )
                .returning({ amount: clanKeyPoolTable.amount });
            if (!left) throw new Error("not_enough_keys");
            const now = Date.now();
            await tx.insert(itemsTable).values(
                Array.from({ length: amount }, () => ({ userId: target.id, type: keyType, source: "clan_reward", timeAcquired: now })),
            );
        });
        return { success: true };
    } catch (err) {
        const code = err instanceof Error ? err.message : "error";
        return { success: false, error: ["not_owner", "not_member", "not_enough_keys"].includes(code) ? code : "error" };
    }
}
