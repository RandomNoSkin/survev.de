import { aliasedTable, and, desc, eq, gte, inArray, lte, sql, sum } from "drizzle-orm";
import type { TeamMode } from "../../../../shared/gameConfig.ts";
import { ALL_TEAM_MODES, type MatchHistoryResponse } from "../../../../shared/types/stats.ts";
import { db } from "./index.ts";
import { matchDataTable, usersTable } from "./schema.ts";

const aliased = aliasedTable(matchDataTable, "aliased");

/**
 * Per-game match history rows for one account within a date range. Shared by the
 * public `/api/match_history` route (hardcoded to a rolling 7-day window) and the
 * bearer-token-authenticated `/api/external/match_history` resource endpoint
 * (caller-supplied range), so the query/join logic isn't duplicated between the two.
 */
export async function matchHistoryQuery(opts: {
    userId: string;
    teamModeFilter: number;
    /** Omit for "no lower bound" (just the most recent games). */
    from?: Date;
    /** Omit for "up to now". */
    to?: Date;
    offset: number;
    limit: number;
    /** Only games where every one of these slugs also played (in addition to `userId`). */
    withSlugs?: string[];
}): Promise<MatchHistoryResponse> {
    const { userId, teamModeFilter, from, to, offset, limit, withSlugs } = opts;

    // Resolve the "played together" filter to a concrete set of gameIds first — games
    // where ALL of `withSlugs` have a row (COUNT DISTINCT userId == withSlugs.length).
    // A separate query keeps this simple/reliable instead of a correlated subquery.
    let gameIdFilter: string[] | undefined;
    if (withSlugs && withSlugs.length) {
        const withUserIds = (
            await db
                .select({ id: usersTable.id })
                .from(usersTable)
                .where(inArray(usersTable.slug, withSlugs))
        ).map((r) => r.id);

        // An unknown slug can never co-occur in a game — short-circuit to "no matches".
        if (withUserIds.length !== withSlugs.length) return [];

        const rows = await db
            .select({ gameId: matchDataTable.gameId })
            .from(matchDataTable)
            .where(inArray(matchDataTable.userId, withUserIds))
            .groupBy(matchDataTable.gameId)
            .having(sql`COUNT(DISTINCT ${matchDataTable.userId}) = ${withUserIds.length}`);

        gameIdFilter = rows.map((r) => r.gameId);
        if (!gameIdFilter.length) return [];
    }

    return db
        .select({
            guid: matchDataTable.gameId,
            region: matchDataTable.region,
            map_id: matchDataTable.mapId,
            team_mode: matchDataTable.teamMode,
            team_count: matchDataTable.teamCount,
            team_total: matchDataTable.teamTotal,
            end_time: matchDataTable.createdAt,
            time_alive: matchDataTable.timeAlive,
            rank: matchDataTable.rank,
            kills: matchDataTable.kills,
            team_kills: sum(aliased.kills).mapWith(Number),
            damage_dealt: matchDataTable.damageDealt,
            damage_taken: matchDataTable.damageTaken,
            slug: usersTable.slug,
        })
        .from(matchDataTable)
        .groupBy(
            matchDataTable.gameId,
            matchDataTable.region,
            matchDataTable.mapId,
            matchDataTable.teamMode,
            matchDataTable.teamCount,
            matchDataTable.teamTotal,
            matchDataTable.createdAt,
            matchDataTable.timeAlive,
            matchDataTable.rank,
            matchDataTable.kills,
            matchDataTable.damageDealt,
            matchDataTable.damageTaken,
            usersTable.slug,
        )
        .leftJoin(
            aliased,
            and(
                eq(aliased.gameId, matchDataTable.gameId),
                eq(aliased.teamId, matchDataTable.teamId),
            ),
        )
        .innerJoin(usersTable, eq(usersTable.id, matchDataTable.userId))
        .where(
            and(
                eq(usersTable.id, userId),
                eq(matchDataTable.teamMode, teamModeFilter as TeamMode).if(
                    teamModeFilter != ALL_TEAM_MODES,
                ),
                from ? gte(matchDataTable.createdAt, from) : undefined,
                to ? lte(matchDataTable.createdAt, to) : undefined,
                gameIdFilter ? inArray(matchDataTable.gameId, gameIdFilter) : undefined,
            ),
        )
        .orderBy(desc(matchDataTable.createdAt))
        .offset(offset)
        .limit(limit);
}
