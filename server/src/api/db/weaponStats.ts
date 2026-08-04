import { and, eq, gte, lte, sql, sum } from "drizzle-orm";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import type { TeamMode } from "../../../../shared/gameConfig.ts";
import { ALL_MAPS, ALL_TEAM_MODES, type WeaponStatsResponse } from "../../../../shared/types/stats.ts";
import { db } from "./index.ts";
import { weaponStatsDailyTable } from "./schema.ts";

/**
 * Weapon damage/kills ranking for the weapon-stats page, aggregated from the daily
 * rollup table over an inclusive [from, to] day range, optionally filtered to one map
 * and/or one team mode.
 */
export async function weaponStatsSqlQuery(
    from: string,
    to: string,
    mapIdFilter: string,
    teamModeFilter: number,
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
        .groupBy(weaponStatsDailyTable.weaponType)
        .orderBy(sql`SUM(${weaponStatsDailyTable.damageDealt}) DESC`);

    return rows.map((row) => {
        const def = GameObjectDefs.typeToDefSafe(row.weaponType) as
            | { name?: string }
            | undefined;
        return {
            type: row.weaponType,
            name: def?.name || row.weaponType,
            totalDamage: row.totalDamage,
            kills: row.kills,
            gamesUsed: row.gamesUsed,
            avgDamagePerGame: row.gamesUsed > 0
                ? Math.round((row.totalDamage / row.gamesUsed) * 10) / 10
                : 0,
        };
    });
}
