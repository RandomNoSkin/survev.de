import { and, eq, gte, lte, sql } from "drizzle-orm";
import { PassDefs } from "../../../../shared/defs/gameObjects/passDefs";
import { getMapDefById, MapDefs } from "../../../../shared/defs/mapDefs";
import { GameConfig } from "../../../../shared/gameConfig";
import { backfillWelcomeGoldenFries, reconcilePassGoldenFries } from "./goldenFries";
import { db } from "./index";
import { grantPassItems } from "./passGrants";
import { matchDataTable, userXpTable } from "./schema";

/**
 * Full pass reconcile for ALL users across ALL passes: recomputes XP from match
 * data, grants any missing item unlocks, and backfills owed Golden Fries.
 *
 * Idempotent — XP is only raised when the recomputed value is higher, item unlocks
 * use `onConflictDoNothing`, and Golden Fries are gated by the per-level ledger
 * reason. Shared by the moderation "Reconcile" button and the daily midnight cron.
 */
export async function reconcileAllPasses(): Promise<{
    usersReconciled: number;
    totalXpAdded: number;
    totalUnlocksGranted: number;
    totalGoldenFriesAwarded: number;
}> {
    const allPasses = (GameConfig.serverSettings as any).passes as Record<
        string,
        { passMaxLevel: number; seasonStart: string; seasonEnd: string }
    >;
    const mapIdToName = Object.fromEntries(
        Object.entries(MapDefs).map(([name, def]) => [def.mapId, name]),
    ) as Record<number, string>;

    let usersReconciled = 0;
    let totalXpAdded = 0;
    let totalUnlocksGranted = 0;
    let totalGoldenFriesAwarded = 0;

    // Retroactive one-time welcome Golden Fries for every account that predates the
    // grant (idempotent; only the first run actually pays out).
    totalGoldenFriesAwarded += await backfillWelcomeGoldenFries();

    for (const [passType, passCfg] of Object.entries(allPasses)) {
        const seasonStart = new Date(passCfg.seasonStart);
        const seasonEnd = new Date(passCfg.seasonEnd);
        const passMaxLevel = passCfg.passMaxLevel;

        const allUserXp = await db
            .select()
            .from(userXpTable)
            .where(eq(userXpTable.passType, passType));

        for (const record of allUserXp) {
            const currentXp = Number(record.xp);

            // Admin XP edits anchor the reconcile: only matches AFTER `reconcileFrom`
            // count, added on top of `reconcileBaseXp` (0 / no anchor ⇒ whole season).
            const windowStart =
                record.reconcileFrom && record.reconcileFrom > seasonStart
                    ? record.reconcileFrom
                    : seasonStart;

            const stats = await db
                .select({
                    gameId: matchDataTable.gameId,
                    kills: sql<number>`max(${matchDataTable.kills})`,
                    damage: sql<number>`max(${matchDataTable.damageDealt})`,
                    timeAlive: sql<number>`max(${matchDataTable.timeAlive})`,
                    rank: sql<number>`min(${matchDataTable.rank})`,
                    mapId: sql<number>`max(${matchDataTable.mapId})`,
                    createdAt: sql<Date>`max(${matchDataTable.createdAt})`,
                })
                .from(matchDataTable)
                .where(
                    and(
                        eq(matchDataTable.userId, record.userId),
                        gte(matchDataTable.createdAt, windowStart),
                        lte(matchDataTable.createdAt, seasonEnd),
                    ),
                )
                .groupBy(matchDataTable.gameId)
                .having(sql`count(*) = 1`);

            let correctXp = Number(record.reconcileBaseXp);
            for (const stat of stats) {
                const mapDef = getMapDefById(stat.mapId);
                const xpMultiplier = mapDef?.gameMode?.xpMultiplier || {
                    kill: 0,
                    damage: 0,
                    win: 0,
                    timeSurvived: 0,
                };
                const mapTypeName = mapIdToName[stat.mapId] ?? "";
                const boostEvents = (GameConfig.serverSettings as any).xpBoostEvents?.[
                    passType
                ];
                let boost = 1;
                if (boostEvents) {
                    const t =
                        stat.createdAt instanceof Date
                            ? stat.createdAt.getTime()
                            : new Date(stat.createdAt).getTime();
                    for (const event of Object.values(boostEvents) as any[]) {
                        if (
                            t >= new Date(event.start).getTime() &&
                            t <= new Date(event.end).getTime() &&
                            event.maps.includes(mapTypeName)
                        ) {
                            boost = event.boost;
                            break;
                        }
                    }
                }
                let matchXp = 0;
                matchXp += stat.kills * xpMultiplier.kill;
                matchXp += stat.damage * xpMultiplier.damage;
                matchXp += (stat.rank === 1 ? 1 : 0) * xpMultiplier.win;
                matchXp += stat.timeAlive * xpMultiplier.timeSurvived;
                correctXp += matchXp * boost;
            }
            correctXp = Math.round(correctXp * 1e5) / 1e5;

            if (correctXp > currentXp) {
                const { level } = getPassLevelAndXp(passType, correctXp, passMaxLevel);
                await db
                    .update(userXpTable)
                    .set({ xp: String(correctXp), level, lastUpdated: new Date() })
                    .where(
                        and(
                            eq(userXpTable.userId, record.userId),
                            eq(userXpTable.passType, passType),
                        ),
                    );
                usersReconciled++;
                totalXpAdded += correctXp - currentXp;
            }

            // Reconcile item unlocks for this pass (only missing ones — PK constraint prevents duplicates)
            const { level: currentLevel } = getPassLevelAndXp(
                passType,
                Math.max(correctXp, currentXp),
                passMaxLevel,
            );
            // Grant any missing pass cosmetics up to the current level (idempotent
            // via pass_item_grants, so already-granted/sold items are never re-added).
            totalUnlocksGranted += await grantPassItems(
                record.userId,
                passType,
                currentLevel,
            );

            // Retroactively backfill pass Golden Fries up to the current level
            // (idempotent: only pays out levels not already in the ledger).
            totalGoldenFriesAwarded += await reconcilePassGoldenFries(
                record.userId,
                passType,
                currentLevel,
            );
        }
    }

    return {
        usersReconciled,
        totalXpAdded,
        totalUnlocksGranted,
        totalGoldenFriesAwarded,
    };
}

function getPassLevelXp(passType: string, level: number): number {
    const passDef = PassDefs[passType as keyof typeof PassDefs];
    const levelIdx = level - 1;
    return levelIdx < passDef.xp.length
        ? passDef.xp[levelIdx]
        : passDef.xp[passDef.xp.length - 1];
}

export function getPassLevelAndXp(passType: string, passXp: number, passMaxLevel?: number) {
    const maxLevel = passMaxLevel ?? GameConfig.serverSettings.passMaxLevel;
    let xp = passXp;
    let level = 1;
    while (level < maxLevel) {
        const levelXp = getPassLevelXp(passType, level);
        if (xp < levelXp) break;
        xp -= levelXp;
        level++;
    }
    return { level, xp };
}
