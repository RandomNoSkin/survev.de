import type { MapDef } from "./mapDefs.ts";
import { RawMapObjectDefs } from "./mapObjectDefs.ts";
import { GameObjectDefs } from "./register.ts";

/**
 * A private-lobby map built on top of an existing map: its look (biome, assets) and
 * generation, edited. Game rules come from the lobby mode or the template (`rules`).
 * Everything here is validated and clamped by `validateCustomMap` on both ends.
 */
export interface CustomMapConfig {
    name?: string;
    /** Map that is the starting point (a `MapDefs` key). */
    template: string;
    /**
     * lobby = the lobby mode's rules (game mode, items, airdrops, roles) on the
     * template's map; template = the template's own rules, as if it were picked.
     */
    rules: "lobby" | "template";
    /**
     * Detailed creation (per-object amounts, buildings, loot pools, advanced rivers).
     * Off = only the basic settings apply; the detailed ones are kept but ignored.
     */
    advanced: boolean;
    /** Square side length in world units; 0 keeps the template's size. */
    size: number;
    rivers: {
        /** template = keep the template's rivers and lakes as they are. */
        mode: "template" | "none" | "simple" | "advanced";
        /** simple: this many rivers of `width`. */
        count: number;
        width: number;
        /** advanced: one entry per river. */
        widths: number[];
        /** advanced: how curvy rivers are (template default is usually 1). */
        smoothness: number;
        /** advanced: keep the template's lakes. */
        lakes: boolean;
    };
    /** Multipliers on the template's own amounts, per category. 1 = unchanged. */
    density: Record<CustomMapCategory, number>;
    /** Keep the template's buildings (fixed, random and place spawns). */
    templateBuildings: boolean;
    /** Exact number of an object to place; replaces the template's fixed count. */
    spawns: Record<string, number>;
    /** Advanced: per-object density (scaled by land area like the templates' own). */
    densityOverrides: Record<string, number>;
    /** Replaced loot pools (tier name -> entries); untouched pools keep the template's. New pools are just new names. */
    loot: Record<string, CustomMapLootEntry[]>;
    /** Which pools an object (crate, container, ground loot spot...) rolls when opened; replaces its own list. */
    objectLoot: Record<string, CustomMapObjectLoot[]>;
    /** Red zone. */
    gas: {
        enabled: boolean;
        /** Multiplier on how fast it closes in: 2 = every wait and move takes half as long. */
        speed: number;
        /** Multiplier on its damage. */
        damage: number;
        /** Advanced: number of circles until it closes completely (the stock zone has 10). */
        circles: number;
    };
    airdrops: {
        /** rules = whatever the game mode does; custom = `count` drops on a timer. */
        mode: "rules" | "none" | "custom";
        /** custom: drops at the listed `times`, or `count` drops every `interval`. */
        timing: "times" | "interval";
        /** Seconds after the match starts, one entry per drop (sorted). */
        times: number[];
        count: number;
        /** Seconds after the match starts. */
        firstAt: number;
        /** Seconds between drops. */
        interval: number;
        /** Chance (0-100) for a drop to be the gold crate. */
        goldChance: number;
    };
    /** Advanced: where players spawn. Undefined fields keep the game mode's. */
    spawn: {
        custom: boolean;
        /** Minimum distance to other players. */
        playerDistance: number;
        /** Minimum distance to the map edge. */
        edgeDistance: number;
        /** No spawns within this radius around the center. */
        centerFree: number;
    };
    /** Map colors (0xRRGGBB); unset ones keep the template's. */
    colors: Partial<Record<CustomMapColor, number>>;
    /** Advanced: place names; undefined = the template's. x/y 0..1, y from the top. */
    places?: CustomMapPlace[];
    /** Advanced: objects placed at a fixed spot. x/y 0..1, y from the top. */
    placements: CustomMapPlacement[];
    /** 0 = a new random map each match; otherwise the same terrain and layout every time. */
    seed: number;
}

/** One pool an object rolls: `min`-`max` times (random in between). */
export interface CustomMapObjectLoot {
    tier: string;
    min: number;
    max: number;
}

export type CustomMapColor ="grass" | "beach" | "water" | "riverbank";
export const CUSTOM_MAP_COLORS: CustomMapColor[] = ["grass", "beach", "water", "riverbank"];

export interface CustomMapPlace {
    name: string;
    x: number;
    y: number;
}

export interface CustomMapPlacement {
    type: string;
    x: number;
    y: number;
}

/** One loot pool entry: an item, another pool ("tier_..."), or "" for "drops nothing". */
export interface CustomMapLootEntry {
    name: string;
    count: number;
    weight: number;
}

export type CustomMapCategory = "trees" | "rocks" | "bushes" | "loot" | "props" | "groundLoot";

export const CUSTOM_MAP_CATEGORIES: CustomMapCategory[] = ["trees", "rocks", "bushes", "loot", "props", "groundLoot"];

export const CUSTOM_MAP_LIMITS = {
    minSize: 128,
    /** map positions are sent relative to Constants.MaxPosition (1024) */
    maxSize: 1024,
    maxRivers: 4,
    minRiverWidth: 4,
    maxRiverWidth: 40,
    maxDensityMult: 3,
    /** per obstacle type; a full-size main map has ~500 of its most common tree */
    maxSpawnCount: 2500,
    /** per building/structure type */
    maxBuildingCount: 200,
    maxDensityOverride: 200,
    /** sum of every explicit `spawns` entry (map generation also has a time limit) */
    maxTotalSpawns: 12000,
    maxEntries: 400,
    maxLootPools: 40,
    maxLootEntries: 60,
    maxLootCount: 999,
    maxLootWeight: 10000,
    maxObjectLoot: 80,
    maxObjectLootEntries: 8,
    /** items one object can drop, all its pools together */
    maxObjectLootRolls: 10,
    /** ground loot items a custom map places while generating */
    maxGenLoot: 4000,
    nameMaxLen: 24,
    /** saved configs per player */
    maxSaved: 20,
    gasMinSpeed: 0.25,
    gasMaxSpeed: 4,
    gasMaxDamage: 5,
    gasMaxCircles: 10,
    maxAirdrops: 30,
    maxAirdropTime: 1800,
    maxSpawnDistance: 1000,
    maxPlaces: 16,
    placeNameMaxLen: 24,
    maxPlacements: 200,
    /** Park-Miller seeds must stay in 1..2^31-2 */
    maxSeed: 2147483646,
} as const;

/** Maps that can serve as a template (they carry generation settings). */
export const CUSTOM_MAP_TEMPLATES = [
    "main",
    "desert",
    "woods",
    "snow",
    "savannah",
    "cobalt",
    "beach",
    "halloween",
    "potato",
    "faction",
    "comp",
    "local",
    "scrims",
    "two_vs_two",
    "four_vs_four",
    "comp_solo",
    "comp_duo",
    "main_spring",
    "main_summer",
    "woods_spring",
    "woods_summer",
    "woods_snow",
    "potato_spring",
    "turkey",
    "birthday",
    "faction_potato",
];

export const DEFAULT_CUSTOM_MAP: CustomMapConfig = {
    template: "local",
    rules: "lobby",
    advanced: false,
    size: 0,
    rivers: { mode: "template", count: 1, width: 12, widths: [12], smoothness: 1, lakes: true },
    density: { trees: 1, rocks: 1, bushes: 1, loot: 1, props: 1, groundLoot: 1 },
    templateBuildings: true,
    spawns: {},
    densityOverrides: {},
    loot: {},
    objectLoot: {},
    gas: { enabled: true, speed: 1, damage: 1, circles: 10 },
    airdrops: { mode: "rules", timing: "times", times: [90, 210], count: 2, firstAt: 90, interval: 120, goldChance: 10 },
    spawn: { custom: false, playerDistance: 400, edgeDistance: 150, centerFree: 0 },
    colors: {},
    placements: [],
    seed: 0,
};

const LOOT_TIER_RE = /^tier_[a-z0-9_]{1,48}$/;

/** Item types that can appear in a loot pool. */
export function isLootItem(type: string): boolean {
    const def = GameObjectDefs.typeToDefSafe(type) as { type?: string } | undefined;
    return !!def && [
        "gun", "melee", "throwable", "ammo", "heal", "boost", "helmet", "chest",
        "backpack", "scope", "perk", "outfit", "xp",
    ].includes(def.type ?? "");
}

function cleanLoot(input: unknown): Record<string, CustomMapLootEntry[]> {
    const out: Record<string, CustomMapLootEntry[]> = {};
    if (!input || typeof input !== "object") return out;
    const L = CUSTOM_MAP_LIMITS;
    let pools = 0;
    for (const [tier, raw] of Object.entries(input as Record<string, unknown>)) {
        if (pools >= L.maxLootPools) break;
        if (!LOOT_TIER_RE.test(tier) || !Array.isArray(raw)) continue;
        const entries: CustomMapLootEntry[] = [];
        for (const e of raw.slice(0, L.maxLootEntries)) {
            if (!e || typeof e !== "object") continue;
            const name = typeof e.name === "string" ? e.name : "";
            if (name !== "" && !LOOT_TIER_RE.test(name) && !isLootItem(name)) continue;
            entries.push({
                name,
                count: Math.round(clamp(e.count, 1, L.maxLootCount, 1)),
                weight: Math.round(clamp(e.weight, 0, L.maxLootWeight, 1) * 1000) / 1000,
            });
        }
        // a pool needs something to roll; "" = drops nothing
        if (!entries.some((e) => e.weight > 0)) entries.splice(0, entries.length, { name: "", count: 1, weight: 1 });
        out[tier] = entries;
        pools++;
    }
    return out;
}

type ObjDef = { type?: string; isTree?: boolean; isBush?: boolean; loot?: unknown[] };
const objDefs = RawMapObjectDefs as unknown as Record<string, ObjDef>;

/** The density category an object counts towards, or null for everything else. */
export function customMapCategory(type: string): CustomMapCategory | null {
    const def = objDefs[type];
    if (def?.type === "loot_spawner") return "groundLoot";
    if (!def || def.type !== "obstacle") return null;
    if (def.isTree) return "trees";
    if (def.isBush) return "bushes";
    if (type.startsWith("stone_")) return "rocks";
    if (def.loot?.length) return "loot";
    return "props";
}

/** Object types a custom map may place: buildings, structures, obstacles and ground loot. */
export function isCustomMapSpawnable(type: string): boolean {
    const t = objDefs[type]?.type;
    return t === "building" || t === "structure" || t === "obstacle" || t === "loot_spawner";
}

export function isCustomMapBuilding(type: string): boolean {
    const t = objDefs[type]?.type;
    return t === "building" || t === "structure";
}

const clamp = (n: unknown, min: number, max: number, fallback: number) => {
    const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
    return Math.min(max, Math.max(min, v));
};

function cleanCounts(
    input: unknown,
    max: number,
    budget = Number.POSITIVE_INFINITY,
): Record<string, number> {
    const out: Record<string, number> = {};
    if (!input || typeof input !== "object") return out;
    let total = 0;
    let entries = 0;
    for (const [type, raw] of Object.entries(input as Record<string, unknown>)) {
        if (entries >= CUSTOM_MAP_LIMITS.maxEntries) break;
        if (!isCustomMapSpawnable(type)) continue;
        const cap = isCustomMapBuilding(type) ? Math.min(max, CUSTOM_MAP_LIMITS.maxBuildingCount) : max;
        const v = Math.round(clamp(raw, 0, cap, 0) * 100) / 100;
        if (total + v > budget) continue;
        out[type] = v;
        total += v;
        entries++;
    }
    return out;
}

/** Fills defaults and clamps everything into the limits; safe on untrusted input. */
export function validateCustomMap(input: Partial<CustomMapConfig> | undefined | null): CustomMapConfig {
    const src = (input ?? {}) as Partial<CustomMapConfig>;
    const L = CUSTOM_MAP_LIMITS;
    const rivers = (src.rivers ?? {}) as Partial<CustomMapConfig["rivers"]>;
    const mode = ["template", "none", "simple", "advanced"].includes(rivers.mode as string)
        ? (rivers.mode as CustomMapConfig["rivers"]["mode"])
        : "template";
    const width = clamp(rivers.width, L.minRiverWidth, L.maxRiverWidth, 12);
    const widths = (Array.isArray(rivers.widths) ? rivers.widths : [width])
        .slice(0, L.maxRivers)
        .map((w) => clamp(w, L.minRiverWidth, L.maxRiverWidth, width));
    const size = Math.round(clamp(src.size, 0, L.maxSize, 0));
    const density = {} as Record<CustomMapCategory, number>;
    for (const c of CUSTOM_MAP_CATEGORIES) {
        density[c] = Math.round(clamp(src.density?.[c], 0, L.maxDensityMult, 1) * 100) / 100;
    }
    const name = typeof src.name === "string" ? src.name.trim().slice(0, L.nameMaxLen) : "";
    const gas = (src.gas ?? {}) as Partial<CustomMapConfig["gas"]>;
    const airdrops = (src.airdrops ?? {}) as Partial<CustomMapConfig["airdrops"]>;
    const spawn = (src.spawn ?? {}) as Partial<CustomMapConfig["spawn"]>;
    return {
        name: name || undefined,
        template: CUSTOM_MAP_TEMPLATES.includes(src.template as string) ? (src.template as string) : DEFAULT_CUSTOM_MAP.template,
        rules: src.rules === "template" ? "template" : "lobby",
        // maps saved before the switch existed keep their detailed settings working
        advanced: typeof src.advanced === "boolean"
            ? src.advanced
            : mode === "advanced" || [src.spawns, src.densityOverrides, src.loot].some(
                (o) => !!o && typeof o === "object" && Object.keys(o).length > 0,
            ),
        size: size === 0 ? 0 : Math.max(L.minSize, size),
        rivers: {
            mode,
            count: Math.round(clamp(rivers.count, 0, L.maxRivers, 1)),
            width,
            widths: widths.length ? widths : [width],
            smoothness: Math.round(clamp(rivers.smoothness, 0, 3, 1) * 100) / 100,
            lakes: rivers.lakes !== false,
        },
        density,
        templateBuildings: src.templateBuildings !== false,
        spawns: cleanCounts(src.spawns, L.maxSpawnCount, L.maxTotalSpawns),
        densityOverrides: cleanCounts(src.densityOverrides, L.maxDensityOverride),
        loot: cleanLoot(src.loot),
        objectLoot: cleanObjectLoot(src.objectLoot),
        gas: {
            enabled: gas.enabled !== false,
            speed: round2(clamp(gas.speed, L.gasMinSpeed, L.gasMaxSpeed, 1)),
            damage: round2(clamp(gas.damage, 0, L.gasMaxDamage, 1)),
            circles: Math.round(clamp(gas.circles, 1, L.gasMaxCircles, L.gasMaxCircles)),
        },
        airdrops: {
            mode: airdrops.mode === "none" || airdrops.mode === "custom" ? airdrops.mode : "rules",
            // maps saved before drop times existed were on the interval timer
            timing: airdrops.timing === "times" || (airdrops.timing === undefined && !src.airdrops)
                ? "times"
                : "interval",
            times: Array.isArray(airdrops.times)
                ? airdrops.times
                    .filter((t): t is number => typeof t === "number" && Number.isFinite(t))
                    .slice(0, L.maxAirdrops)
                    .map((t) => Math.round(clamp(t, 0, L.maxAirdropTime, 0)))
                    .sort((a, b) => a - b)
                : [90, 210],
            count: Math.round(clamp(airdrops.count, 0, L.maxAirdrops, 2)),
            firstAt: Math.round(clamp(airdrops.firstAt, 0, L.maxAirdropTime, 90)),
            interval: Math.round(clamp(airdrops.interval, 5, L.maxAirdropTime, 120)),
            goldChance: Math.round(clamp(airdrops.goldChance, 0, 100, 10)),
        },
        spawn: {
            custom: spawn.custom === true,
            playerDistance: Math.round(clamp(spawn.playerDistance, 0, L.maxSpawnDistance, 400)),
            edgeDistance: Math.round(clamp(spawn.edgeDistance, 0, L.maxSpawnDistance / 2, 150)),
            centerFree: Math.round(clamp(spawn.centerFree, 0, L.maxSpawnDistance / 2, 0)),
        },
        colors: cleanColors(src.colors),
        places: Array.isArray(src.places) ? cleanPlaces(src.places) : undefined,
        placements: cleanPlacements(src.placements),
        seed: Math.round(clamp(src.seed, 0, L.maxSeed, 0)),
    };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: unknown) => Math.round(clamp(n, 0, 1, 0.5) * 10000) / 10000;

/** Objects whose loot can be changed: everything with a loot list (crates, containers, ground loot spots...). */
export function hasObjectLoot(type: string): boolean {
    const def = objDefs[type];
    return !!def && (def.type === "obstacle" || def.type === "loot_spawner") && Array.isArray(def.loot);
}

/** The pools an object rolls by default (its def; fixed items are left out). */
export function defaultObjectLoot(type: string): CustomMapObjectLoot[] {
    const def = objDefs[type] as unknown as { loot?: Array<{ tier?: string; min?: number; max?: number }> } | undefined;
    return (def?.loot ?? [])
        .filter((l) => typeof l.tier === "string")
        .map((l) => ({ tier: l.tier!, min: l.min ?? 1, max: l.max ?? 1 }));
}

function cleanObjectLoot(input: unknown): CustomMapConfig["objectLoot"] {
    const out: CustomMapConfig["objectLoot"] = {};
    if (!input || typeof input !== "object") return out;
    const L = CUSTOM_MAP_LIMITS;
    for (const [type, raw] of Object.entries(input as Record<string, unknown>).slice(0, L.maxObjectLoot)) {
        if (!hasObjectLoot(type) || !Array.isArray(raw)) continue;
        out[type] = raw.slice(0, L.maxObjectLootEntries).flatMap((e) => {
            if (!e || typeof e !== "object") return [];
            const src = e as Partial<CustomMapObjectLoot>;
            if (typeof src.tier !== "string" || !LOOT_TIER_RE.test(src.tier)) return [];
            const min = Math.round(clamp(src.min, 0, L.maxObjectLootRolls, 1));
            const max = Math.round(clamp(src.max, min, L.maxObjectLootRolls, min));
            return [{ tier: src.tier, min, max }];
        });
        // an opened crate drops at most this many items in total
        let budget = L.maxObjectLootRolls;
        out[type] = out[type].flatMap((r) => {
            if (budget <= 0) return [];
            const max = Math.min(r.max, budget);
            budget -= max;
            return [{ ...r, min: Math.min(r.min, max), max }];
        });
    }
    return out;
}

function cleanColors(input: unknown): CustomMapConfig["colors"] {
    const out: CustomMapConfig["colors"] = {};
    if (!input || typeof input !== "object") return out;
    for (const key of CUSTOM_MAP_COLORS) {
        const v = (input as Record<string, unknown>)[key];
        if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffff) out[key] = v;
    }
    return out;
}

function cleanPlaces(input: unknown[]): CustomMapPlace[] {
    const out: CustomMapPlace[] = [];
    for (const p of input.slice(0, CUSTOM_MAP_LIMITS.maxPlaces)) {
        if (!p || typeof p !== "object") continue;
        const src = p as Partial<CustomMapPlace>;
        const name = typeof src.name === "string" ? src.name.trim().slice(0, CUSTOM_MAP_LIMITS.placeNameMaxLen) : "";
        if (!name) continue;
        out.push({ name, x: clamp01(src.x), y: clamp01(src.y) });
    }
    return out;
}

function cleanPlacements(input: unknown): CustomMapPlacement[] {
    const out: CustomMapPlacement[] = [];
    if (!Array.isArray(input)) return out;
    let buildings = 0;
    for (const p of input) {
        if (out.length >= CUSTOM_MAP_LIMITS.maxPlacements) break;
        if (!p || typeof p !== "object") continue;
        const src = p as Partial<CustomMapPlacement>;
        if (typeof src.type !== "string" || !isCustomMapSpawnable(src.type)) continue;
        if (isCustomMapBuilding(src.type) && ++buildings > CUSTOM_MAP_LIMITS.maxBuildingCount) continue;
        out.push({ type: src.type, x: clamp01(src.x), y: clamp01(src.y) });
    }
    return out;
}

/** What actually gets generated: without `advanced`, the detailed settings drop out. */
export function effectiveCustomMap(cfg: CustomMapConfig): CustomMapConfig {
    if (cfg.advanced) return cfg;
    const rivers = cfg.rivers.mode === "advanced"
        ? { ...cfg.rivers, mode: "simple" as const, count: cfg.rivers.widths.length, width: cfg.rivers.widths[0] ?? cfg.rivers.width }
        : cfg.rivers;
    return {
        ...cfg,
        rivers,
        spawns: {},
        densityOverrides: {},
        loot: {},
        objectLoot: {},
        gas: { ...cfg.gas, circles: CUSTOM_MAP_LIMITS.gasMaxCircles },
        spawn: { ...cfg.spawn, custom: false },
        places: undefined,
        placements: [],
    };
}

/**
 * Deep copy that, unlike util.cloneDeep, also copies arrays (util.cloneDeep keeps them
 * shared with the source - editing a copied mapGen would edit the shared MapDefs for
 * every later game). Functions and class instances are kept by reference.
 */
export function cloneData<T>(value: T): T {
    if (Array.isArray(value)) return value.map((v) => cloneData(v)) as T;
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = cloneData(v);
        return out as T;
    }
    return value;
}

/** gameMode flags that belong to a map's world (its objects, loot, sounds), not its rules. */
const MAP_FLAVOR_FLAGS = ["desertMode", "woodsMode", "sniperMode", "potatoMode", "turkeyMode", "spookyKillSounds"] as const;

/**
 * Puts `rules`' game rules onto `mapDef` (a clone): its gameMode and gameConfig, but
 * the map keeps its world-bound parts - flavor flags and door unlock timings, which
 * name the map's own buildings. Server and client run this alike so both agree.
 */
export function applyLobbyRules(mapDef: MapDef, rules: MapDef) {
    const own = mapDef.gameMode;
    const gameMode = cloneData(rules.gameMode);
    for (const flag of MAP_FLAVOR_FLAGS) {
        if (own[flag] !== undefined) gameMode[flag] = own[flag];
        else delete gameMode[flag];
    }
    mapDef.gameMode = gameMode;
    // gameConfig is stripped from the prod client build (STRIP_FROM_PROD_CLIENT) -
    // only the server has it, and only the server needs it
    if (!rules.gameConfig) return;
    const unlocks = mapDef.gameConfig?.unlocks;
    mapDef.gameConfig = cloneData(rules.gameConfig);
    if (unlocks) mapDef.gameConfig.unlocks = unlocks;
    else delete mapDef.gameConfig.unlocks;
}

/** "warehouse_01" -> "Warehouse 01" (map objects have no display names). */
export function customMapObjectLabel(type: string): string {
    return type
        .split("_")
        .filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" ");
}
