import {
    type CustomMapConfig,
    cloneData,
    customMapCategory,
    effectiveCustomMap,
    validateCustomMap,
} from "../../../shared/defs/customMap";
import { type MapDef, MapDefs } from "../../../shared/defs/mapDefs";
import { RawMapObjectDefs } from "../../../shared/defs/mapObjectDefs";
import { GameConfig } from "../../../shared/gameConfig";

type MapGen = MapDef["mapGen"];
type FixedSpawn = MapGen["fixedSpawns"][0][string];

const objectDefs = RawMapObjectDefs as unknown as Record<string, { type?: string }>;
const isBuilding = (type: string) => {
    const t = objectDefs[type]?.type;
    return t === "building" || t === "structure";
};

function scaleFixed(value: FixedSpawn, mult: number): FixedSpawn {
    if (typeof value === "number") return Math.round(value * mult);
    if ("odds" in value) return { odds: Math.min(1, value.odds * mult) };
    return { small: Math.round(value.small * mult), large: Math.round(value.large * mult) };
}

/**
 * Swaps `mapDef.mapGen` for the custom map's: the template's generation settings with
 * the lobby's overrides on top. `mapDef` is the per-game clone, so this never touches
 * the shared definitions. Rules and look (gameMode, biome) stay the lobby mode's.
 */
export function applyCustomMap(mapDef: MapDef, rawConfig: CustomMapConfig) {
    const cfg = effectiveCustomMap(validateCustomMap(rawConfig));
    const template = (MapDefs as Record<string, MapDef>)[cfg.template];
    const gen: MapGen = cloneData(template?.mapGen ?? mapDef.mapGen);

    // size: a square of `size`, independent of team mode scaling
    const map = gen.map;
    if (cfg.size > 0) {
        const oldSize = map.baseWidth * map.scale.large + map.extension;
        const ratio = cfg.size / oldSize;
        map.baseWidth = cfg.size;
        map.baseHeight = cfg.size;
        map.scale = { small: 1, large: 1 };
        map.extension = 0;
        // lake spawn areas are in absolute coordinates
        for (const lake of map.rivers.lakes) {
            lake.spawnBound = {
                pos: { x: lake.spawnBound.pos.x * ratio, y: lake.spawnBound.pos.y * ratio },
                rad: lake.spawnBound.rad * ratio,
            };
            lake.innerRad *= Math.min(1, ratio);
            lake.outerRad *= Math.min(1, ratio);
        }
    }

    // rivers
    const rivers = map.rivers;
    switch (cfg.rivers.mode) {
        case "none":
            rivers.weights = [{ weight: 1, widths: [] }];
            rivers.lakes = [];
            rivers.masks = [];
            break;
        case "simple":
            rivers.weights = [{ weight: 1, widths: Array(cfg.rivers.count).fill(cfg.rivers.width) }];
            break;
        case "advanced":
            rivers.weights = [{ weight: 1, widths: [...cfg.rivers.widths] }];
            rivers.smoothness = cfg.rivers.smoothness;
            if (!cfg.rivers.lakes) rivers.lakes = [];
            break;
    }

    // template buildings off: keep nature/loot, drop every building and structure
    const fixed = gen.fixedSpawns[0];
    if (!cfg.templateBuildings) {
        for (const type of Object.keys(fixed)) {
            if (isBuilding(type)) delete fixed[type];
        }
        // containers, shacks, outhouses etc. come per land area, not as fixed counts
        for (const type of Object.keys(gen.densitySpawns[0])) {
            if (isBuilding(type)) delete gen.densitySpawns[0][type];
        }
        gen.randomSpawns = [];
        gen.importantSpawns = [];
        gen.customSpawnRules = { locationSpawns: [], placeSpawns: [] };
    }

    // category multipliers on the template's own amounts
    const density = gen.densitySpawns[0];
    for (const [type, value] of Object.entries(density)) {
        const cat = customMapCategory(type);
        if (cat) density[type] = value * cfg.density[cat];
    }
    for (const [type, value] of Object.entries(fixed)) {
        const cat = customMapCategory(type);
        if (cat) fixed[type] = scaleFixed(value, cfg.density[cat]);
    }

    // explicit amounts win over everything above: they replace the type's fixed
    // and its per-area spawns
    for (const [type, count] of Object.entries(cfg.spawns)) {
        if (count > 0) fixed[type] = Math.round(count);
        else delete fixed[type];
        delete density[type];
    }
    for (const [type, value] of Object.entries(cfg.densityOverrides)) {
        if (value > 0) density[type] = value;
        else delete density[type];
    }

    // fixed placements (cfg.placements) are spawned by GameMap.generateObjects itself,
    // ahead of everything the template places

    if (cfg.places) {
        gen.places = cfg.places.map((p) => ({ name: p.name, pos: { x: p.x, y: p.y } }));
    }

    mapDef.mapGen = gen;
    mapDef.lootTable = buildLootTable(mapDef.lootTable, template?.lootTable, cfg.loot);

    applyAirdrops(mapDef, cfg.airdrops);

    if (cfg.spawn.custom) {
        // the spread-out spawn picker is the one that honours these
        const minSide = map.baseWidth * map.scale.small + map.extension;
        mapDef.gameMode.betterSpawn = true;
        mapDef.gameMode.edgeBuffer = Math.min(cfg.spawn.edgeDistance, minSide * 0.4);
        mapDef.gameMode.minSpawnRad = cfg.spawn.playerDistance;
        mapDef.gameMode.centerNoSpawnRadius = Math.min(cfg.spawn.centerFree, minSide * 0.4);
    }
    return cfg;
}

/**
 * none: no planes at all. custom: the mode's own plane schedule is dropped (the game
 * schedules `count` drops on a timer instead, see Game) and the crate pick follows
 * `goldChance`. Gold = the mode's "_02" crate (its own look, e.g. snow's 02x).
 */
function applyAirdrops(mapDef: MapDef, airdrops: CustomMapConfig["airdrops"]) {
    const planes = mapDef.gameConfig.planes;
    if (airdrops.mode === "rules") return;
    planes.timings = planes.timings.filter((t) => t.options.type !== GameConfig.Plane.Airdrop);
    if (airdrops.mode === "none") return;

    const isGold = (name: string) => /_02/.test(name);
    let normal = planes.crates.filter((c) => !isGold(c.name)).map((c) => c.name);
    let gold = planes.crates.filter((c) => isGold(c.name)).map((c) => c.name);
    if (!normal.length) normal = ["airdrop_crate_01"];
    if (!gold.length) gold = ["airdrop_crate_02"];
    const g = airdrops.goldChance;
    planes.crates = [
        ...normal.map((name) => ({ name, weight: (100 - g) / normal.length })),
        ...gold.map((name) => ({ name, weight: g / gold.length })),
    ].filter((c) => c.weight > 0);
}

type LootTable = MapDef["lootTable"];

/**
 * Mode map pools (so tiers it relies on, e.g. airdrops, keep existing), then the
 * template's (they match its buildings), then the lobby's edits - and then made safe:
 * the loot roller indexes past the end of an all-zero pool and recurses forever on a
 * tier that leads back to itself, both of which would take the game down.
 */
function buildLootTable(
    modeTable: LootTable,
    templateTable: LootTable | undefined,
    edits: CustomMapConfig["loot"],
): LootTable {
    const table: LootTable = cloneData({ ...modeTable, ...templateTable });
    for (const [tier, entries] of Object.entries(edits)) {
        table[tier] = entries.map((e) => ({ ...e }));
    }

    for (const tier of Object.keys(table)) {
        table[tier] = table[tier].filter((e) => !e.name.startsWith("tier_") || e.name in table);
    }

    // drop every reference that closes a loop (DFS back edges)
    const state = new Map<string, "visiting" | "done">();
    const visit = (tier: string) => {
        state.set(tier, "visiting");
        table[tier] = table[tier].filter((e) => {
            if (!e.name.startsWith("tier_")) return true;
            const s = state.get(e.name);
            if (s === "visiting") return false;
            if (!s) visit(e.name);
            return true;
        });
        state.set(tier, "done");
    };
    for (const tier of Object.keys(table)) {
        if (!state.has(tier)) visit(tier);
    }

    for (const tier of Object.keys(table)) {
        if (!table[tier].some((e) => e.weight > 0)) table[tier] = [{ name: "", count: 1, weight: 1 }];
    }
    return table;
}
