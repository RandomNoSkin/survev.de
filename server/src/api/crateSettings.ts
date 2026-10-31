import { eq } from "drizzle-orm";
import {
    type CrateFries,
    type CrateOverride,
    type CrateType,
    crateOverrides,
    isCrateEligible,
} from "../../../shared/defs/crateConfig";
import { Rarity } from "../../../shared/gameConfig";
import { Config } from "../config";
import { server } from "./apiServer";
import { db } from "./db";
import { crateSettingsTable } from "./db/schema";

/**
 * Crate loot settings edited in the moderation dashboard. Kept in the DB and mirrored into
 * the shared `crateOverrides`, which the roll (openCrate) and the client's drop-chance
 * view (via /api/crate_config) both read.
 */

export async function loadCrateSettings(): Promise<void> {
    if (!Config.database.enabled) return;
    try {
        const rows = await db.select().from(crateSettingsTable);
        const map: Partial<Record<CrateType, CrateOverride>> = {};
        for (const r of rows) {
            map[r.crate as CrateType] = {
                pool: r.pool ?? null,
                rarityWeights: (r.rarityWeights as CrateOverride["rarityWeights"]) ?? null,
                fries: r.fries ?? null,
            };
        }
        crateOverrides.set(map);
    } catch (err) {
        server.logger.error("Failed to load crate settings:", err);
    }
}

/** Keeps only real rarities with a sane weight; null when nothing is left. */
export function cleanWeights(raw: Record<string, number> | null | undefined) {
    if (!raw) return null;
    const out: Partial<Record<Rarity, number>> = {};
    for (const [k, v] of Object.entries(raw)) {
        const r = Number(k);
        if (!(r in Rarity) || r === Rarity.Stock) continue;
        const w = Math.round(Number(v));
        if (Number.isFinite(w) && w > 0 && w <= 100000) out[r as Rarity] = w;
    }
    return Object.keys(out).length ? out : null;
}

/** Whole numbers in a sane range; weight 0 switches the fries drop off. */
export function cleanFries(raw: CrateFries | null | undefined): CrateFries | null {
    if (!raw) return null;
    const int = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
    const max = int(raw.max, 1_000_000);
    return { weight: int(raw.weight, 100000), min: Math.min(int(raw.min, 1_000_000), max), max };
}

/** Drops unknown / non-droppable types and duplicates. */
export function cleanPool(raw: string[] | null | undefined) {
    if (!raw) return null;
    return [...new Set(raw)].filter(isCrateEligible);
}

export async function saveCrateSettings(
    crate: CrateType,
    pool: string[] | null,
    rarityWeights: Partial<Record<Rarity, number>> | null,
    fries: CrateFries | null,
    updatedBy: string,
) {
    const values = { pool, rarityWeights, fries, updatedAt: new Date(), updatedBy };
    await db
        .insert(crateSettingsTable)
        .values({ crate, ...values })
        .onConflictDoUpdate({ target: crateSettingsTable.crate, set: values });
    await loadCrateSettings();
}

export async function resetCrateSettings(crate: CrateType) {
    await db.delete(crateSettingsTable).where(eq(crateSettingsTable.crate, crate));
    await loadCrateSettings();
}

void loadCrateSettings();
