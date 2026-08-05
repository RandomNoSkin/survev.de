import { and, eq, gte, lte, sql, sum } from "drizzle-orm";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import type { TeamMode } from "../../../../shared/gameConfig.ts";
import {
    ALL_MAPS,
    ALL_TEAM_MODES,
    WEAPON_STATS_MAX_RESULTS,
    type WeaponStatsResponse,
    type WeaponStatsSortBy,
} from "../../../../shared/types/stats.ts";
import { db } from "./index.ts";
import { weaponStatsDailyTable } from "./schema.ts";

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Weapon damage/kills ranking for the weapon-stats page, aggregated from the daily
 * rollup table over an inclusive [from, to] day range, optionally filtered to one map
 * and/or one team mode. Returns the top `WEAPON_STATS_MAX_RESULTS` weapons ranked by
 * `sortBy`.
 */
export async function weaponStatsSqlQuery(
    from: string,
    to: string,
    mapIdFilter: string,
    teamModeFilter: number,
    sortBy: WeaponStatsSortBy,
): Promise<WeaponStatsResponse> {
    const rows = await db
        .select({
            weaponType: weaponStatsDailyTable.weaponType,
            totalDamage: sum(weaponStatsDailyTable.damageDealt).mapWith(Number),
            kills: sum(weaponStatsDailyTable.kills).mapWith(Number),
            gamesUsed: sum(weaponStatsDailyTable.gamesUsed).mapWith(Number),
        })
        .from(weaponStatsDailyTable)
        .where(
            and(
                gte(weaponStatsDailyTable.day, from),
                lte(weaponStatsDailyTable.day, to),
                eq(weaponStatsDailyTable.mapId, parseInt(mapIdFilter)).if(
                    mapIdFilter !== ALL_MAPS,
                ),
                eq(weaponStatsDailyTable.teamMode, teamModeFilter as TeamMode).if(
                    teamModeFilter !== ALL_TEAM_MODES,
                ),
            ),
        )
        .groupBy(weaponStatsDailyTable.weaponType);

    const entries: WeaponStatsResponse = rows.map((row) => {
        const def = GameObjectDefs.typeToDefSafe(row.weaponType) as
            | { name?: string }
            | undefined;
        return {
            type: row.weaponType,
            name: def?.name || row.weaponType,
            totalDamage: row.totalDamage,
            kills: row.kills,
            gamesUsed: row.gamesUsed,
            avgDamagePerGame: row.gamesUsed > 0 ? round1(row.totalDamage / row.gamesUsed) : 0,
            avgKillsPerGame: row.gamesUsed > 0 ? round1(row.kills / row.gamesUsed) : 0,
        };
    });

    type NumericKey = "gamesUsed" | "totalDamage" | "avgDamagePerGame" | "kills" | "avgKillsPerGame";
    const sortKey: Record<WeaponStatsSortBy, NumericKey> = {
        games: "gamesUsed",
        damage: "totalDamage",
        damage_per_game: "avgDamagePerGame",
        kills: "kills",
        kills_per_game: "avgKillsPerGame",
    };
    const key = sortKey[sortBy];
    entries.sort((a, b) => b[key] - a[key]);

    return entries.slice(0, WEAPON_STATS_MAX_RESULTS);
}
