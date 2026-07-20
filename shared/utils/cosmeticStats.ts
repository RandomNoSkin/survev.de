import { GameObjectDefs } from "../defs/register.ts";
import { Rarity } from "../gameConfig";

/**
 * Dynamic cosmetic rarity, derived from how many copies of each item exist.
 *
 * The stats are computed on the API server (from the DB) and shared with the client via
 * `GET /api/cosmetic_stats`. Both sides feed the result into the same runtime map here,
 * so rarity + copy count stay consistent across pricing (shopConfig) and all UI
 * (loadout / shop / market / profile).
 *
 * `count` is the total number of existing copies (duplicates a single user holds all
 * count). `percent` is those copies relative to the player base and can exceed 1 when
 * duplicates exist. Items unlocked by default for everyone are treated as one copy per
 * account (=> Stock).
 */
export interface CosmeticStat {
    /** Total number of existing copies of the item (duplicates included). */
    count: number;
    /** Copies relative to all registered accounts (can exceed 1 with duplicates). */
    percent: number;
    /** Rarity tier derived from `percent` via the thresholds below. */
    rarity: Rarity;
}

/**
 * Rarity thresholds (copies-per-account fractions, ascending). An item lands in the first
 * tier whose `maxPercent` it falls under — i.e. the fewer copies exist, the rarer.
 *
 * Tune freely. Values > 1 are possible (more copies than accounts) and map to Stock.
 */
export const RARITY_OWNERSHIP_THRESHOLDS: ReadonlyArray<{
    maxPercent: number;
    rarity: Rarity;
}> = [
    { maxPercent: 0.04, rarity: Rarity.Mythic },
    { maxPercent: 0.11, rarity: Rarity.Epic },
    { maxPercent: 0.34, rarity: Rarity.Rare },
    { maxPercent: 0.6, rarity: Rarity.Uncommon },
    { maxPercent: 0.76, rarity: Rarity.Common },
    { maxPercent: Number.POSITIVE_INFINITY, rarity: Rarity.Stock },
];

/** Format an ownership fraction (0..1) as a display percent, e.g. "3.1%" / "62%". */
export function formatOwnerPercent(percent: number): string {
    const pct = percent * 100;
    const str = pct > 0 && pct < 10 ? pct.toFixed(1) : Math.round(pct).toString();
    return `${str}%`;
}

/** Map an ownership fraction (0..1) to a rarity tier. */
export function rarityFromPercent(percent: number): Rarity {
    for (const tier of RARITY_OWNERSHIP_THRESHOLDS) {
        if (percent < tier.maxPercent) return tier.rarity;
    }
    return Rarity.Stock;
}

let statsMap: Record<string, CosmeticStat> = {};
let totalAccounts = 0;

export const cosmeticStats = {
    /** Replace the whole stats map (called by the server compute + the client fetch). */
    set(map: Record<string, CosmeticStat>, accounts: number) {
        statsMap = map ?? {};
        totalAccounts = accounts ?? 0;
    },
    getAll(): Record<string, CosmeticStat> {
        return statsMap;
    },
    getTotalAccounts(): number {
        return totalAccounts;
    },
    get(type: string): CosmeticStat | undefined {
        return statsMap[type];
    },
    /** Effective rarity: dynamic when stats exist, else the static def rarity, else Stock. */
    getRarity(type: string): Rarity {
        const stat = statsMap[type];
        if (stat) return stat.rarity;
        const def = GameObjectDefs.typeToDefSafe(type) as { rarity?: number } | undefined;
        return (def?.rarity as Rarity) ?? Rarity.Stock;
    },
    /** Number of accounts owning the item (0 when unknown). */
    getCount(type: string): number {
        return statsMap[type]?.count ?? 0;
    },
    /** Ownership fraction 0..1 (0 when unknown). */
    getPercent(type: string): number {
        return statsMap[type]?.percent ?? 0;
    },
    /** Whether dynamic stats are currently loaded. */
    hasData(): boolean {
        return totalAccounts > 0;
    },
};
