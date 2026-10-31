import { GameConfig, Rarity } from "../gameConfig";
import type { CrateKeyDef } from "./gameObjects/crateKeyDefs";
import { PassDefs } from "./gameObjects/passDefs";
import { GameObjectDefs } from "./register.ts";
import { getItemCategory, getItemPrice, getItemRarity } from "./shopConfig";

/**
 * Loadout crates. Opening one uses up a key of the crate's tier or higher and grants a
 * random cosmetic from the crate's pool. The roll is two-step: first a rarity by
 * `rarityWeights` (rarities without any item in the pool drop out), then an item of that
 * rarity uniformly - so the shown chances are exactly what the server rolls. Golden Fries
 * are one more outcome next to the rarities, with their own weight on the same scale.
 */

export type CrateType = "wooden" | "soviet" | "airdrop";

/** Golden Fries as a crate drop: `weight` on the rarity-weight scale (0 = off), and a
 *  uniformly rolled amount in [min, max]. */
export interface CrateFries {
    weight: number;
    min: number;
    max: number;
}

export interface CrateDef {
    name: string;
    tier: number;
    /** Closed / opened art (svg under client/public). */
    img: string;
    openImg?: string;
    /** Relative weight per rarity; only the ratios matter. */
    rarityWeights: Partial<Record<Rarity, number>>;
    /**
     * Explicit item list. Unset = the automatic pool (getAutoPool). Usually edited live
     * in the moderation dashboard instead (crateOverrides).
     */
    pool?: string[];
    fries?: CrateFries;
}

export const CrateDefs: Record<CrateType, CrateDef> = {
    wooden: {
        name: "Wooden Crate",
        tier: 1,
        img: "img/map/map-crate-01.svg",
        rarityWeights: {
            [Rarity.Common]: 60,
            [Rarity.Uncommon]: 28,
            [Rarity.Rare]: 12,
        },
        // the average payout equals the key value (400 / 800 / 1300)
        fries: { weight: 15, min: 200, max: 600 },
    },
    soviet: {
        name: "Soviet Crate",
        tier: 2,
        img: "img/map/map-crate-02.svg",
        rarityWeights: {
            [Rarity.Common]: 30,
            [Rarity.Uncommon]: 35,
            [Rarity.Rare]: 24,
            [Rarity.Epic]: 9,
            [Rarity.Mythic]: 2,
        },
        fries: { weight: 12, min: 400, max: 1200 },
    },
    airdrop: {
        name: "Airdrop",
        tier: 3,
        img: "img/map/map-airdrop-01.svg",
        openImg: "img/map/map-airdrop-02.svg",
        rarityWeights: {
            [Rarity.Rare]: 55,
            [Rarity.Epic]: 32,
            [Rarity.Mythic]: 13,
        },
        fries: { weight: 10, min: 700, max: 1900 },
    },
};

export const CRATE_TYPES = Object.keys(CrateDefs) as CrateType[];

export function isCrateType(s: string): s is CrateType {
    return Object.prototype.hasOwnProperty.call(CrateDefs, s);
}

export function getKeyDef(type: string): CrateKeyDef | undefined {
    const def = GameObjectDefs.typeToDefSafe(type);
    return def?.type === "crate_key" ? def : undefined;
}

/** All key types, weakest first. */
export function getKeyTypes(): string[] {
    return GameObjectDefs.getAllTypes()
        .filter((t) => getKeyDef(t))
        .sort((a, b) => getKeyDef(a)!.tier - getKeyDef(b)!.tier);
}

/** A key opens every crate up to its own tier. */
export function keyOpensCrate(keyType: string, crate: CrateType): boolean {
    const key = getKeyDef(keyType);
    return !!key && key.tier >= CrateDefs[crate].tier;
}

/**
 * Live edits from the moderation dashboard (stored in the DB, table crate_settings). The
 * API server sets them at boot and on every save, the client fetches them from
 * /api/crate_config. A field left unset falls back to the CrateDefs default.
 */
export interface CrateOverride {
    /** Explicit item list; null = the automatic pool. */
    pool?: string[] | null;
    rarityWeights?: Partial<Record<Rarity, number>> | null;
    fries?: CrateFries | null;
}

let overrides: Partial<Record<CrateType, CrateOverride>> = {};

export const crateOverrides = {
    set(map: Partial<Record<CrateType, CrateOverride>>) {
        overrides = map ?? {};
    },
    get(): Partial<Record<CrateType, CrateOverride>> {
        return overrides;
    },
};

export function getCrateWeights(crate: CrateType): Partial<Record<Rarity, number>> {
    return overrides[crate]?.rarityWeights ?? CrateDefs[crate].rarityWeights;
}

/** The crate's fries drop, or null when it has none. */
export function getCrateFries(crate: CrateType): CrateFries | null {
    const f = overrides[crate]?.fries ?? CrateDefs[crate].fries;
    if (!f || !(f.weight > 0) || !(f.max > 0)) return null;
    return { weight: f.weight, min: Math.max(1, Math.min(f.min, f.max)), max: f.max };
}

/** The crate's item list before filtering: the custom one, else the automatic pool. */
export function getCratePoolTypes(crate: CrateType): string[] {
    return overrides[crate]?.pool ?? CrateDefs[crate].pool ?? getAutoPool();
}

/** Whether `type` can ever drop from a crate (a priced cosmetic, not a key). */
export function isCrateEligible(type: string): boolean {
    const category = getItemCategory(type);
    return !!category && category !== "key" && getItemPrice(type) > 0;
}

/** Automatic pool: shop items plus the items of every pass that has started (ended
 *  passes and the running one - future passes stay secret). */
export function getAutoPool(): string[] {
    const types = new Set(
        GameObjectDefs.getAllTypes().filter(
            (t) => (GameObjectDefs.typeToDefSafe(t) as { shop?: boolean }).shop === true,
        ),
    );
    const passes = GameConfig.serverSettings.passes as Record<string, { seasonStart: string }>;
    const now = Date.now();
    for (const [passType, passDef] of Object.entries(PassDefs)) {
        const cfg = passes[passType];
        if (!cfg || new Date(cfg.seasonStart).getTime() > now) continue;
        for (const it of passDef.items) if (it.item) types.add(it.item);
    }
    return [...types];
}

/** The crate's items grouped by (current) rarity. Stock and unpriced items never drop. */
export function getCratePool(crate: CrateType): Map<Rarity, string[]> {
    const weights = getCrateWeights(crate);
    const byRarity = new Map<Rarity, string[]>();
    for (const type of new Set(getCratePoolTypes(crate))) {
        if (!isCrateEligible(type)) continue;
        const rarity = getItemRarity(type) as Rarity;
        if (!weights[rarity]) continue;
        const list = byRarity.get(rarity) ?? [];
        list.push(type);
        byRarity.set(rarity, list);
    }
    for (const list of byRarity.values()) list.sort();
    return byRarity;
}

export interface CrateChance {
    rarity: Rarity;
    /** 0..1 */
    chance: number;
    items: string[];
}

/** Total weight of everything that can drop: the rarities the pool has, plus fries. */
function totalWeight(crate: CrateType, pool: Map<Rarity, string[]>): number {
    const weights = getCrateWeights(crate);
    let total = getCrateFries(crate)?.weight ?? 0;
    for (const r of pool.keys()) total += weights[r] ?? 0;
    return total;
}

/** Drop chance per rarity (renormalized over the rarities the pool actually has, and
 *  next to the Golden Fries chance - see getFriesChance). */
export function getCrateChances(crate: CrateType): CrateChance[] {
    const pool = getCratePool(crate);
    const weights = getCrateWeights(crate);
    const total = totalWeight(crate, pool);
    const out: CrateChance[] = [];
    for (const [rarity, items] of pool) {
        out.push({ rarity, chance: total ? (weights[rarity] ?? 0) / total : 0, items });
    }
    return out.sort((a, b) => a.rarity - b.rarity);
}

/** Chance (0..1) and amount range of the Golden Fries drop, null when it has none. */
export function getFriesChance(crate: CrateType): { chance: number; min: number; max: number } | null {
    const fries = getCrateFries(crate);
    if (!fries) return null;
    const total = totalWeight(crate, getCratePool(crate));
    return { chance: total ? fries.weight / total : 0, min: fries.min, max: fries.max };
}

export type CrateDrop = { type: string; fries?: undefined } | { fries: number; type?: undefined };

/** Rolls one drop; `rand` returns [0, 1). Null when the crate has nothing to drop. */
export function rollCrate(crate: CrateType, rand: () => number = Math.random): CrateDrop | null {
    const chances = getCrateChances(crate);
    const fries = getFriesChance(crate);
    const pick = (items: string[]) => ({ type: items[Math.floor(rand() * items.length)] });
    if (!chances.length && !fries) return null;
    let r = rand();
    if (fries) {
        if (r < fries.chance) return { fries: fries.min + Math.floor(rand() * (fries.max - fries.min + 1)) };
        r -= fries.chance;
    }
    for (const c of chances) {
        if (r < c.chance) return pick(c.items);
        r -= c.chance;
    }
    return chances.length ? pick(chances[chances.length - 1].items) : { fries: fries!.max };
}
