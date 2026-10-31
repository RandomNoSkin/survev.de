import { expect, test } from "vitest";
import {
    CRATE_TYPES,
    crateOverrides,
    getCrateChances,
    getFriesChance,
    getKeyTypes,
    keyOpensCrate,
    rollCrate,
} from "../../shared/defs/crateConfig.ts";
import { getItemCategory, getItemPrice, getItemRarity } from "../../shared/defs/shopConfig.ts";

test("keys open their own crate and every weaker one", () => {
    expect(getKeyTypes()).toStrictEqual(["key_wooden", "key_soviet", "key_airdrop"]);
    expect(keyOpensCrate("key_wooden", "wooden")).toBe(true);
    expect(keyOpensCrate("key_wooden", "soviet")).toBe(false);
    expect(keyOpensCrate("key_wooden", "airdrop")).toBe(false);
    expect(keyOpensCrate("key_soviet", "wooden")).toBe(true);
    expect(keyOpensCrate("key_soviet", "soviet")).toBe(true);
    expect(keyOpensCrate("key_soviet", "airdrop")).toBe(false);
    for (const c of CRATE_TYPES) expect(keyOpensCrate("key_airdrop", c)).toBe(true);
    // not a key at all
    expect(keyOpensCrate("outfitBase", "wooden")).toBe(false);
});

test("keys are tradeable items with a fixed price", () => {
    expect(getItemCategory("key_wooden")).toBe("key");
    expect(getItemPrice("key_wooden")).toBe(400);
    expect(getItemPrice("key_airdrop")).toBe(1300);
});

test("drop chances (items + fries) add up to 100% and never include keys or stock items", () => {
    for (const c of CRATE_TYPES) {
        const chances = getCrateChances(c);
        expect(chances.length).toBeGreaterThan(0);
        const total = chances.reduce((s, x) => s + x.chance, 0) + (getFriesChance(c)?.chance ?? 0);
        expect(total).toBeCloseTo(1, 9);
        for (const { rarity, items } of chances) {
            expect(items.length).toBeGreaterThan(0);
            for (const t of items) {
                expect(getItemCategory(t)).not.toBe("key");
                expect(getItemRarity(t)).toBe(rarity);
                expect(getItemPrice(t)).toBeGreaterThan(0);
            }
        }
    }
});

test("rolls follow the shown chances", () => {
    // mulberry32: deterministic, so the test is stable
    let seed = 12345;
    const rand = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const chances = getCrateChances("soviet");
    const byType = new Map<string, number>();
    for (const c of chances) for (const t of c.items) byType.set(t, c.rarity);
    const fries = getFriesChance("soviet")!;
    const hits = new Map<number, number>();
    let friesHits = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
        const drop = rollCrate("soviet", rand)!;
        if (drop.fries !== undefined) {
            expect(drop.fries).toBeGreaterThanOrEqual(fries.min);
            expect(drop.fries).toBeLessThanOrEqual(fries.max);
            expect(Number.isInteger(drop.fries)).toBe(true);
            friesHits++;
            continue;
        }
        expect(byType.has(drop.type)).toBe(true);
        const r = byType.get(drop.type)!;
        hits.set(r, (hits.get(r) ?? 0) + 1);
    }
    for (const c of chances) expect(Math.abs((hits.get(c.rarity) ?? 0) / N - c.chance)).toBeLessThan(0.03);
    expect(Math.abs(friesHits / N - fries.chance)).toBeLessThan(0.03);
});

test("dashboard overrides replace the pool and weights, and reset back", () => {
    const pick = getCrateChances("wooden").flatMap((c) => c.items).slice(0, 3);
    crateOverrides.set({ wooden: { pool: [...pick, "key_soviet", "nonsense"], rarityWeights: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 } } });
    const items = getCrateChances("wooden").flatMap((c) => c.items);
    // keys and unknown types never drop, even when listed
    expect(items.sort()).toStrictEqual([...pick].sort());
    expect(getCrateChances("wooden").reduce((s, c) => s + c.chance, 0) + getFriesChance("wooden")!.chance).toBeCloseTo(1, 9);
    // fries weight 0 switches them off
    crateOverrides.set({ wooden: { fries: { weight: 0, min: 1, max: 5 } } });
    expect(getFriesChance("wooden")).toBe(null);
    expect(getCrateChances("wooden").reduce((s, c) => s + c.chance, 0)).toBeCloseTo(1, 9);
    crateOverrides.set({});
    expect(getCrateChances("wooden").flatMap((c) => c.items).length).toBeGreaterThan(3);
});
