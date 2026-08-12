import { and, eq, gte, max, type SQL, sql, sum } from "drizzle-orm";
import {
    ALL_MAPS,
    type UserStatsRequest,
    type UserStatsResponse,
} from "../../../../shared/types/stats.ts";
import { db } from "./index.ts";
import { getRatingTier } from "./ratingTiers.ts";
import { matchDataTable, regionGroupsTable, usersTable } from "./schema.ts";

/** Minimum data required for the UI to show the user doesn't exist. */
export const emptyUserStats = {
    slug: "",
    username: "",
    assists: 0,
    primaryRegion: null,
    modes: [],
};

const intervalFilter: Record<string, SQL<unknown>> = {
    daily: gte(matchDataTable.createdAt, sql`NOW() - INTERVAL '1 day'`),
    weekly: gte(matchDataTable.createdAt, sql`NOW() - INTERVAL '7 days'`),
};

/**
 * Aggregated per-teamMode stats (games/wins/kills/avgDamage/...) for one account.
 * Shared by the public `/api/user_stats` route (looked up by slug) and the
 * bearer-token-authenticated `/api/external/stats` resource endpoint (looked up via
 * the OAuth grant's userId) so the query logic isn't duplicated between the two.
 */
export async function userStatsSqlQuery(
    userId: string,
    mapIdFilter: string,
    interval: UserStatsRequest["interval"],
): Promise<UserStatsResponse> {
    const withSelect = db.$with("mode_stats").as(
        db
            .select({
                team_mode: matchDataTable.teamMode,
                games: sql`COUNT(*)`.as("games"),
                wins: sql`SUM(CASE WHEN ${matchDataTable.rank} = 1 THEN 1 ELSE 0 END)`.as(
                    "wins",
                ),
                kills: sum(matchDataTable.kills).as("kills"),
                assists: sum(matchDataTable.assists).as("assists"),
                winPct: sql`ROUND(SUM(CASE WHEN ${matchDataTable.rank} = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1)`
                    .as(
                        "winpct",
                    ),
                most_kills: max(matchDataTable.kills).as("most_kills"),
                most_damage: max(matchDataTable.damageDealt).as("most_damage"),
                kpg: sql`ROUND(SUM(${matchDataTable.kills}) * 1.0 / COUNT(*), 1)`.as(
                    "kpg",
                ),
                avg_damage: sql`ROUND(AVG(${matchDataTable.damageDealt}))`.as(
                    "avg_damage",
                ),
                avg_time_alive: sql`ROUND(AVG(${matchDataTable.timeAlive}))`.as(
                    "avg_time_alive",
                ),
                // AVG() ignores NULL rows on its own, so matches without an impact score
                // (solo, or maps that don't opt in) don't skew this. FILTER further scopes
                // it to matches in the account's primary region group, so Rating only
                // compares against a same-cohort pool (see ratingTiers.ts) — every other
                // aggregate here stays all-region.
                rating: sql`ROUND(AVG(${matchDataTable.impactScore})
                    FILTER (WHERE ${regionGroupsTable.groupName} = ${usersTable.primaryRegion}))`
                    .as("rating"),
            })
            .from(matchDataTable)
            .innerJoin(usersTable, eq(matchDataTable.userId, usersTable.id))
            .leftJoin(regionGroupsTable, eq(matchDataTable.region, regionGroupsTable.region))
            .where(
                and(
                    eq(matchDataTable.userId, userId),
                    mapIdFilter !== ALL_MAPS
                        ? eq(matchDataTable.mapId, parseInt(mapIdFilter))
                        : undefined,
                    interval in intervalFilter ? intervalFilter[interval] : undefined,
                ),
            )
            .groupBy(matchDataTable.teamMode),
    );

    const res = await db
        .with(withSelect)
        .select({
            slug: usersTable.slug,
            username: usersTable.username,
            banned: usersTable.banned,
            primaryRegion: sql`NULLIF(${usersTable.primaryRegion}, '')`,
            player_icon: sql`JSON_EXTRACT_PATH(ANY_VALUE(${usersTable.loadout}), 'player_icon')`,
            games: sql`COALESCE(SUM("mode_stats".games), 0)`,
            wins: sql`COALESCE(SUM("mode_stats".wins), 0)`,
            kills: sql`COALESCE(SUM("mode_stats".kills), 0)`,
            assists: sql`COALESCE(SUM("mode_stats".assists), 0)`,
            kpg: sql`COALESCE(ROUND(SUM("mode_stats".kills) * 1.0 / NULLIF(SUM("mode_stats".games), 0), 1), 0)`,
            modes: sql`
        COALESCE(JSON_AGG(
            CASE WHEN "mode_stats".team_mode IS NOT NULL THEN
                JSON_BUILD_OBJECT(
                    'wins', "mode_stats".wins,
                    'kills', "mode_stats".kills,
                    'assists', "mode_stats".assists,
                    'teamMode', "mode_stats".team_mode,
                    'avgDamage', "mode_stats".avg_damage,
                    'avgTimeAlive', "mode_stats".avg_time_alive,
                    'mostDamage', "mode_stats".most_damage,
                    'kpg', "mode_stats".kpg,
                    'winPct', "mode_stats".winPct,
                    'mostKills', "mode_stats".most_kills,
                    'games', "mode_stats".games,
                    'rating', "mode_stats".rating
                )
            END
        ), '[]')`,
        })
        .from(usersTable)
        .leftJoin(withSelect, eq(sql`1`, 1))
        .where(eq(usersTable.id, userId))
        .groupBy(usersTable.slug, usersTable.username, usersTable.banned, usersTable.primaryRegion)
        .limit(1);

    const userStats = res[0] as UserStatsResponse;

    if (!userStats || !userStats.slug) return emptyUserStats as unknown as UserStatsResponse;

    const modes = userStats?.modes;
    const formatedData: UserStatsResponse = {
        ...userStats,
        // sql fuckery, it returns [null] where no result
        modes: (modes[0] === null ? [] : modes).map((mode) => ({
            ...mode,
            tier: getRatingTier(mode.teamMode, userStats.primaryRegion ?? "", mode.rating),
        })),
    };
    return formatedData;
}
