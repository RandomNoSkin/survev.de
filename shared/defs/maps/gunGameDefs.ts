import { MapId } from "../../gameConfig.ts";
import { util } from "../../utils/util";
import { v2 } from "../../utils/v2";
import type { PartialMapDef } from "./compDefs";
import { Local } from "./localDefs";

/**
 * Gun Game (GameMode.GunGame): a free-for-all with respawns. The rules live in
 * server/src/game/modes/gunGame.ts; this is the map - built like the 1v1 arena and,
 * for 10 players, as big (210 x 210) - without role
 * picking, loot or airdrops, and joinable for most of the match.
 */
const mapDef: PartialMapDef = {
    mapId: MapId.GunGame,
    desc: {
        name: "Gun Game",
        icon: "img/gui/bullets.svg",
        buttonCss: "",
        // l10n key: index-play-gungame-solo
        buttonText: "gungame",
        backgroundImg: "img/main_splash.png",
    },
    gameMode: {
        // the map is sized for about this many (lobbies with more scale it up, see
        // gunGameMapScale)
        maxPlayers: 10,
        killLeaderEnabled: true,

        arenaMode: false,
        arenaModeRoles: [],
        arenaLobbyRoles: 0,

        // weapons come from the ladder only
        pickup: false,
        // respawns: players can come in for (almost) the whole match
        // (join until the match's last minute - see the TIME_LIMIT_S)
        joinTime: 540,
        canDespawn: false,
        betterStats: true,
        unlimitedAdren: true,

        // respawns: at least about a screen away from everyone alive (the 1v1 arena
        // spawns anywhere; the battle royale default of 400 doesn't fit this map)
        // (respawns pick spots near this distance or a bit beyond, see GunGame#spawnPos)
        minSpawnRad: 40,

        xpMultiplier: {
            kill: 0.15,
            damage: 0,
            win: 0.5,
            timeSurvived: 0,
        },
    },
    /* STRIP_FROM_PROD_CLIENT:START */
    gameConfig: {
        // full damage (comp / local deal 0.9) - fights are short in gun game
        damageMult: 1,
    },
    mapGen: {
        map: {
            baseWidth: 210,
            baseHeight: 210,
            scale: { small: 1, large: 1 },
            extension: 0,
            shoreInset: 3,
            grassInset: 6,
            rivers: {
                lakes: [],
                weights: [{ weight: 1, widths: [] }],
                smoothness: 1,
                spawnCabins: false,
                masks: [],
            },
        },
        places: [
            { name: "The Killpit", pos: v2.create(0.5, 0.5) },
            { name: "Sweatbath", pos: v2.create(0.84, 0.18) },
            { name: "Tarkhany", pos: v2.create(0.15, 0.13) },
            { name: "Todesfelde", pos: v2.create(0.82, 0.84) },
            { name: "Pineapple", pos: v2.create(0.18, 0.82) },
            { name: "Fowl Forest", pos: v2.create(0.76, 0.5) },
            { name: "Ranchito Pollo", pos: v2.create(0.5, 0.18) },
            { name: "Ytyk-Kyuyol", pos: v2.create(0.22, 0.48) },
        ],
        bridgeTypes: {
            medium: "",
            large: "",
            xlarge: "",
        },
        customSpawnRules: {
            locationSpawns: [],
            placeSpawns: ["warehouse_01", "house_red_01", "house_red_02", "barn_01"],
        },
        densitySpawns: [
            {
                stone_01: 25,
                barrel_01: 5,
                tree_01: 30,
            },
        ],
        // about the 1v1 arena's, same size
        fixedSpawns: [
            {
                stone_01: 43,
                barrel_01: 5,
                silo_01: 1,
                tree_01: 56,
                container_01: 1,
                container_02: 2,
                container_03: 1,
                container_04: 1,
                outhouse_01: 2,
                stone_01_indestructible: 2,
            },
        ],
        randomSpawns: [
            {
                spawns: [
                    "logging_complex_01local",
                    "mansion_structure_01",
                    "police_01",
                    "club_complex_01",
                    "warehouse_complex_01",
                    "workshop_complex_01",
                    "kopje_patch_01",
                    "river_town_02_local",
                    "reserve_complex_01",
                ],
                choose: 2,
            },
            {
                spawns: ["bank_01", "greenhouse_01", "saloon_structure_01"],
                choose: 2,
            },
            {
                spawns: ["warehouse_01", "house_red_01", "house_red_02", "barn_01", "barn_02"],
                choose: 2,
            },
            {
                spawns: ["teahouse_complex_01su", "shack_01", "shack_01", "shack_01", "shack_01"],
                choose: 3,
            },
        ],
        spawnReplacements: [{}],
        importantSpawns: [
            "logging_complex_01local",
            "mansion_structure_01",
            "police_01",
            "club_complex_01",
            "warehouse_complex_01",
            "workshop_complex_01",
            "kopje_patch_01",
            "river_town_02_local",
            "reserve_complex_01",
        ],
    },
    /* STRIP_FROM_PROD_CLIENT:END */
};

export const GunGame = util.mergeDeep({}, Local, mapDef);
