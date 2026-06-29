import { count } from "drizzle-orm";
import { GameObjectDefs } from "../../../shared/defs/gameObjectDefs";
import { UnlockDefs } from "../../../shared/defs/gameObjects/unlockDefs";
import {
    type CosmeticStat,
    cosmeticStats,
    rarityFromPercent,
} from "../../../shared/utils/cosmeticStats";
import { Config } from "../config";
import { server } from "./apiServer";
import { db } from "./db";
import { itemsTable, usersTable } from "./db/schema";

/** Cosmetic def types whose rarity is driven by ownership. */
const COSMETIC_TYPES = new Set([
    "outfit",
    "melee",
    "emote",
    "heal_effect",
    "boost_effect",
    "death_effect",
    "crosshair",
]);

/**
 * Below this many registered accounts the ownership sample is too small to be meaningful,
 * so we leave the stats empty and everything falls back to its static def rarity.
 */
const MIN_ACCOUNTS = 2;

// Ownership-based rarity is a slow-moving daily statistic, so it is recomputed once at
// boot and once per day by the midnight cron in index.ts — no background loop, no
// per-request work. The endpoint just serves this cached snapshot.
let cache: { stats: Record<string, CosmeticStat>; totalAccounts: number } = {
    stats: {},
    totalAccounts: 0,
};

export function getCachedCosmeticStats() {
    return cache;
}

/** All cosmetic-type def keys (the items that get a dynamic rarity). */
function allCosmeticTypes(): string[] {
    const out: string[] = [];
    for (const type in GameObjectDefs) {
        const def = GameObjectDefs[type] as { type?: string };
        if (def?.type && COSMETIC_TYPES.has(def.type)) out.push(type);
    }
    return out;
}

/**
 * Recompute ownership-based rarity from the DB and publish it to the shared
 * {@link cosmeticStats} map (used by pricing + the client via /api/cosmetic_stats).
 */
export async function computeCosmeticStats(): Promise<void> {
    if (!Config.database.enabled) return;

    try {
        const [{ total }] = await db.select({ total: count() }).from(usersTable);
        const totalAccounts = Number(total) || 0;

        if (totalAccounts < MIN_ACCOUNTS) {
            cache = { stats: {}, totalAccounts };
            cosmeticStats.set({}, totalAccounts);
            return;
        }

        // Total existing copies per item type. Each row is one copy, so duplicates a
        // single user holds (e.g. from trading) all count — rarity is tied to how many
        // of the item exist, not how many players own it.
        const rows = await db
            .select({ type: itemsTable.type, copies: count() })
            .from(itemsTable)
            .groupBy(itemsTable.type);

        const copiesByType = new Map<string, number>();
        for (const row of rows) {
            copiesByType.set(row.type, Number(row.copies) || 0);
        }

        // Items unlocked by default for everyone count as one copy per account (100%).
        const defaultUnlocked = new Set(UnlockDefs.unlock_default.unlocks);

        const stats: Record<string, CosmeticStat> = {};
        for (const type of allCosmeticTypes()) {
            const copies = defaultUnlocked.has(type)
                ? totalAccounts
                : (copiesByType.get(type) ?? 0);
            // Copies relative to the player base. Can exceed 100% when duplicates exist
            // (=> very common => Stock), which is the intended behaviour.
            const percent = totalAccounts > 0 ? copies / totalAccounts : 0;
            stats[type] = {
                count: copies,
                percent,
                rarity: rarityFromPercent(percent),
            };
        }

        cache = { stats, totalAccounts };
        cosmeticStats.set(stats, totalAccounts);
    } catch (err) {
        server.logger.error("Failed to compute cosmetic stats:", err);
    }
}

/** Warm the cache once at boot so pricing + the endpoint have data before midnight. */
export function warmCosmeticStats(): void {
    void computeCosmeticStats();
}
