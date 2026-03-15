import { GameConfig } from "../../gameConfig";
import { util, type DeepPartial } from "../../utils/util";
import { v2 } from "../../utils/v2";
import type { MapDef } from "../mapDefs";
import { MapId } from "../types/misc";
import { Comp, PartialMapDef } from "./compDefs";

// @NOTE: Entries defined as single-element arrays, like fixedSpawns: [{ }],
// are done this way so that util.mergeDeep(...) will function as expected
// when used by derivative maps.
//
// Arrays are not mergeable, so the derived map will always redefine all
// elements if that property is set.

export const mapDef: PartialMapDef = {
    mapId: MapId.CompSolo,
    desc: {
        name: "Solo Comp",
        icon: "",
        buttonCss: "",
        buttonText: "comp-solo",
        backgroundImg: "img/main_splash.png",
    },
    assets: {
        audio: [
            { name: "club_music_01", channel: "ambient" },
            { name: "club_music_02", channel: "ambient" },
            { name: "ambient_steam_01", channel: "ambient" },
            { name: "log_11", channel: "sfx" },
            { name: "log_12", channel: "sfx" },
        ],
        atlases: ["gradient", "loadout", "shared", "main"],
    },
    biome: {
        colors: {
            background: 0x20536e,
            water: 0x3282ab,
            waterRipple: 0xb3f0ff,
            beach: 0xcdb35b,
            riverbank: 0x905e24,
            grass: 0x80af49,
            underground: 0x1b0d03,
            playerSubmerge: 0x2b8ca4,
            playerGhillie: 0x83af50,
        },
        valueAdjust: 1,
        sound: { riverShore: "sand" },
        particles: { camera: "" },
        tracerColors: {},
        airdrop: {
            planeImg: "map-plane-01.img",
            planeSound: "plane_01",
            airdropImg: "map-chute-01.img",
            supplyImg: "map-supply-chute-01.img",
        },
    },
    gameMode: {
        maxPlayers: 8,
        killLeaderEnabled: true,
        freezeTime: 10,
        joinTime: 10, // time until players can move after game start
        airdropMinDistance: 300, // minimum distance between airdrops
        betterSpawn: true,
        betterMapGen: true,

        betterStats: true,
        canDespawn: false,
    },
    /* STRIP_FROM_PROD_CLIENT:START */
    gameConfig: {
        planes: {
            timings: [
                {
                    circleIdx: 1,
                    wait: 10,
                    options: { type: GameConfig.Plane.Airdrop },
                },
                /* EU-Comp Special Supply Drop
                {
                    circleIdx: 1,
                    wait: 50,
                    options: { type: GameConfig.Plane.SupplyDrop, airdropType: "supply_crate_01" },
                },
                */
                {
                    circleIdx: 3,
                    wait: 2,
                    options: { type: GameConfig.Plane.Airdrop },
                },
            ],
            crates: [
                { name: "airdrop_crate_01", weight: 5 },
                { name: "airdrop_crate_02", weight: 1 },
            ],
        },
        bagSizes: {},
        bleedDamage: 2,
        bleedDamageMult: 1,
    },
    // NOTE: this loot table is not the original one so its not accurate
    // ? are guesses based on statistics
    // ! are uncertain data based on leak
    mapGen: {
        map: {
            baseWidth: 512,
            baseHeight: 512,
            scale: { small: 1.1875, large: 1.28125 },
            extension: 112,
            shoreInset: 48,
            grassInset: 18,
            rivers: {
                lakes: [],
                weights: [
                    { weight: 0.1, widths: [4] },
                    { weight: 0.15, widths: [8] },
                    { weight: 0.25, widths: [8, 4] },
                    { weight: 0.21, widths: [16] },
                    { weight: 0.09, widths: [16, 8] },
                    { weight: 0.2, widths: [16, 8, 4] },
                    {
                        weight: 1e-4,
                        widths: [16, 16, 8, 6, 4],
                    },
                ],
                smoothness: 0.45,
                spawnCabins: true,
                masks: [],
            },
        },
        places: [
            {
                name: "The Killpit",
                pos: v2.create(0.53, 0.64),
            },
            {
                name: "Sweatbath",
                pos: v2.create(0.84, 0.18),
            },
            {
                name: "Tarkhany",
                pos: v2.create(0.15, 0.11),
            },
            {
                name: "Ytyk-Kyuyol",
                pos: v2.create(0.25, 0.42),
            },
            {
                name: "Todesfelde",
                pos: v2.create(0.81, 0.85),
            },
            {
                name: "Pineapple",
                pos: v2.create(0.21, 0.79),
            },
            {
                name: "Fowl Forest",
                pos: v2.create(0.73, 0.47),
            },
            {
                name: "Ranchito Pollo",
                pos: v2.create(0.53, 0.25),
            },
        ],
        bridgeTypes: {
            medium: "bridge_md_structure_01",
            large: "bridge_lg_structure_01",
            xlarge: "",
        },
        customSpawnRules: {
            locationSpawns: [
                {
                    type: "club_complex_01",
                    pos: v2.create(0.5, 0.5),
                    rad: 10,
                    retryOnFailure: true,
                },
            ],
            placeSpawns: ["club_complex_01", "warehouse_complex_01"/*"warehouse_01", "house_red_01", "house_red_02", "barn_01"*/],
        },
        densitySpawns: [
            {
                stone_01: 350,
                barrel_01: 76,
                silo_01: 8,
                crate_01: 50,
                crate_02: 6,
                crate_03: 12, //grenade crates
                bush_01: 78,
                cache_06: 12,
                tree_01: 450,
                sandbags_01: 11,
                sandbags_02: 11,
                hedgehog_01: 24,
                container_01: 5,
                container_02: 5,
                container_03: 5,
                container_04: 5,
                shack_01: 7,
                outhouse_01: 6, //toilet houses
                loot_tier_1: 24,
                loot_tier_beach: 12,
            },
        ],
        fixedSpawns: [
            {
                // small is spawn count for solos and duos, large is spawn count for squads
                warehouse_01: { small: 2, large: 5,},
                house_red_01: { small: 3, large: 7,}, 
                house_red_02: { small: 3, large: 7,},
                teahouse_complex_01su: {
                    small: 1,
                    large: 3,
                },
                barn_01: { small: 1, large: 4,}, //green houses
                barn_02: { small: 1, large: 1,},
                hut_01: 3, // huts
                hut_02: 1, // spas hut
                hut_03: 1, // scout hut
                shack_03a: 2, // small river / sea cabins
                shack_03b: { small: 2, large: 3,}, // small river / sea cabins
                greenhouse_01: { small: 1, large: 1,}, // greenhouses
                cache_01: 1, // flare stone
                cache_02: { small: 1, large: 1,}, // mosin tree
                cache_07: 1, //barrel
                bunker_structure_01: { odds: 0.15 }, // ak74 bunker
                bunker_structure_02: 1, // vector bunker
                bunker_structure_03: 1, // storm bunker
                bunker_structure_04: 1, // sea bunker
                bunker_structure_05: 1, // river bunker
                warehouse_complex_01: 2, // docks
                chest_01: 1,
                chest_03: { odds: 0.35 }, // river chest
                mil_crate_02: { odds: 0.2 }, // ot chest
                tree_02: 10, // axe logs
                stone_04: { small: 1, large: 1,},
                mansion_structure_01: { small: 0, large: 1,},
                police_01: { small: 0, large: 1,},
                bank_01: { small: 0, large: 1,},
            },
        ],
        randomSpawns: [
            /*{
                spawns: ["mansion_structure_01", "police_01", "bank_01"],
                choose: 3,
            },*/
        ],
        spawnReplacements: [{}],
        importantSpawns: ["club_complex_01", "teahouse_complex_01su", "mansion_structure_01", "police_01", "bank_01", "warehouse_complex_01", "greenhouse_01"],
    },
    /* STRIP_FROM_PROD_CLIENT:END */
};

export const CompSolo = util.mergeDeep({}, Comp, mapDef);
