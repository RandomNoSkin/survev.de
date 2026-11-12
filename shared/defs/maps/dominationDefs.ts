import { MapId } from "../../gameConfig.ts";
import { util } from "../../utils/util";
import type { PartialMapDef } from "./compDefs";
import { Local } from "./localDefs";

/**
 * Domination (GameMode.Domination): 6v6, two teams (groups of up to 6, like squads)
 * holding the zones A / B / C - the rules live in
 * server/src/game/modes/domination.ts. Built like the Gun Game map: no loot (players
 * only pick up what others drop), no airdrops, no rivers.
 */
const mapDef: PartialMapDef = {
    mapId: MapId.Domination,
    desc: {
        name: "Domination",
        icon: "img/gui/crown.svg",
        buttonCss: "",
        // l10n key: index-play-domination-squad (the button text + its team mode)
        buttonText: "domination",
        backgroundImg: "img/main_splash.png",
    },
    gameMode: {
        maxPlayers: 12,
        killLeaderEnabled: true,

        arenaMode: false,
        arenaModeRoles: [],
        arenaLobbyRoles: 0,

        // only what dead players drop - the mode allows nothing else (see Domination)
        pickup: true,
        // (join until the match's last minute - see the TIME_LIMIT_S)
        joinTime: 840,
        canDespawn: false,
        betterStats: true,
        unlimitedAdren: true,
        // respawns keep this far from enemies (the mode picks a spot on the own side)
        minSpawnRad: 25,

        xpMultiplier: {
            kill: 0.15,
            damage: 0,
            win: 0.5,
            timeSurvived: 0,
        },
    },
    /* STRIP_FROM_PROD_CLIENT:START */
    gameConfig: {
        damageMult: 1,
    },
    mapGen: {
        map: {
            baseWidth: 240,
            baseHeight: 240,
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
        // no place names: the zones are drawn on the map themselves (and move every match)
        places: [],
        bridgeTypes: {
            medium: "",
            large: "",
            xlarge: "",
        },
        customSpawnRules: {
            locationSpawns: [],
            placeSpawns: [],
        },
        densitySpawns: [
            {
                stone_01: 20,
                barrel_01: 4,
                tree_01: 26,
            },
        ],
        fixedSpawns: [
            {
                stone_01: 60,
                barrel_01: 8,
                tree_01: 80,
                container_01: 2,
                container_02: 2,
                container_03: 2,
                container_04: 2,
                outhouse_01: 3,
                // hard cover all over the map (indestructible / only AP rounds break it)
                stone_01_indestructible: 8,
                sandbags_01: 22,
                sandbags_02: 12,
                stone_04: 4,
                stone_05: 4,
                stone_06: 3,
                silo_01: 2,
            },
        ],
        randomSpawns: [
            {
                spawns: ["warehouse_01", "house_red_01", "house_red_02", "barn_01", "barn_02"],
                choose: 3,
            },
            {
                spawns: ["bank_01", "greenhouse_01", "saloon_structure_01"],
                choose: 1,
            },
            {
                spawns: ["shack_01", "shack_01", "shack_01", "shack_01"],
                choose: 3,
            },
        ],
        spawnReplacements: [{}],
        importantSpawns: [],
    },
    /* STRIP_FROM_PROD_CLIENT:END */
};

export const Domination = util.mergeDeep({}, Local, mapDef);
