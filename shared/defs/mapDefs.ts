import type { MapId } from "../gameConfig.ts";
import type { Vec2 } from "../utils/v2.ts";
import type { RoleDef } from "./gameObjects/roleDefs.ts";
import { TwoVsTwo } from "./maps/2v2Defs.ts";
import { FourVsFour } from "./maps/4v4Defs.ts";
import { Main } from "./maps/baseDefs.ts";
import { Beach } from "./maps/beachDefs.ts";
import { Birthday } from "./maps/birthdayDefs.ts";
import { Cobalt } from "./maps/cobaltDefs.ts";
import { Comp } from "./maps/compDefs.ts";
import { Scrims } from "./maps/scrimsDefs.ts";
import { CompDuo } from "./maps/compDuoDefs.ts";
import { CompSolo } from "./maps/compSoloDefs.ts";
import { Desert } from "./maps/desertDefs.ts";
import { Faction } from "./maps/factionDefs.ts";
import { factionPotato } from "./maps/factionPotatoDefs.ts";
import { Halloween } from "./maps/halloweenDefs.ts";
import { Local } from "./maps/localDefs.ts";
import { MainSpring } from "./maps/mainSpringDefs.ts";
import { MainSummer } from "./maps/mainSummerDefs.ts";
import { Potato } from "./maps/potatoDefs.ts";
import { PotatoSpring } from "./maps/potatoSpringDefs.ts";
import { Savannah } from "./maps/savannahDefs.ts";
import { Snow } from "./maps/snowDefs.ts";
import { testFaction, testNormal } from "./maps/testDefs.ts";
import { Turkey } from "./maps/turkeyDefs.ts";
import { Woods } from "./maps/woodsDefs.ts";
import { WoodsSnow } from "./maps/woodsSnowDefs.ts";
import { WoodsSpring } from "./maps/woodsSpringDefs.ts";
import { WoodsSummer } from "./maps/woodsSummerDefs.ts";

export type Atlas =
    | "gradient"
    | "loadout"
    /** Player sprites for composing outfit previews off the map (stats page). Never listed in a map's assets. */
    | "skins"
    | "shared"
    | "main"
    | "desert"
    | "faction"
    | "halloween"
    | "potato"
    | "snow"
    | "woods"
    | "cobalt"
    | "savannah"
    | "turkey"
    | "beach";

const _MapDefs = {
    main: Main,
    main_spring: MainSpring,
    main_summer: MainSummer,
    desert: Desert,
    faction: Faction,
    faction_potato: factionPotato,
    halloween: Halloween,
    potato: Potato,
    potato_spring: PotatoSpring,
    snow: Snow,
    woods: Woods,
    woods_snow: WoodsSnow,
    woods_spring: WoodsSpring,
    woods_summer: WoodsSummer,
    savannah: Savannah,
    cobalt: Cobalt,
    turkey: Turkey,
    birthday: Birthday,
    beach: Beach,
    comp: Comp,
    local: Local,
    scrims: Scrims,
    two_vs_two: TwoVsTwo,
    four_vs_four: FourVsFour,
    comp_solo: CompSolo,
    comp_duo : CompDuo,

    /* STRIP_FROM_PROD_CLIENT:START */
    test_normal: testNormal,
    test_faction: testFaction,
    /* STRIP_FROM_PROD_CLIENT:END */
} satisfies Record<string, MapDef>;

export type MapDefKey = keyof typeof _MapDefs;

export const MapDefs = _MapDefs as Record<MapDefKey, MapDef>;

export interface MapDef {
    mapId: MapId;
    desc: {
        name: string;
        icon: string;
        buttonCss: string;
        buttonText?: string;
        backgroundImg: string;
    };
    assets: {
        audio: Array<{
            name: string;
            channel: string;
        }>;
        atlases: Atlas[];
    };
    biome: {
        colors: {
            background: number;
            water: number;
            waterRipple: number;
            beach: number;
            riverbank: number;
            lakeWater?: number;
            lakeWaterRipple?: number;
            lakeRiverbank?: number;
            grass: number;
            underground: number;
            playerSubmerge: number;
            playerGhillie: number;
        };
        valueAdjust: number;
        sound: {
            riverShore: string;
        };
        particles: {
            camera: string;
        };
        tracerColors: Record<string, Record<string, number>>;
        airdrop: {
            planeImg: string;
            planeSound: string;
            airdropImg: string;
            // optional override for supply drops (falls from a SupplyDrop plane)
            supplyImg?: string;
        };
    };
    gameMode: {
        maxPlayers: number;
        killLeaderEnabled: boolean;
        
        freezeTime?: number,
        joinTime?: number, // time until players can move after game start
        airdropMinDistance?: number, // minimum distance between airdrops

        unlimitedAdren?: boolean; //if true, players will not lose adrenaline and start with max adrenaline || default false
        pickup?: boolean; //true to allow players to pick up items from the ground || default true
        indicator?: boolean; //true to show all players on the map || default false
        betterStats?: boolean; //true to show every players stats || default false
        canDespawn?: boolean; //if set to true players can despawn for a short time after spawning || default: true

        betterMapGen?: boolean; //if set to true, will do MinDistances between POIs || default: false

        // spawn related settings
        //spawning can now be changed per map
        betterSpawn?: boolean; //use our better spawn algorithm (only for 2 team matches) | default: false
        edgeBuffer?: number, // distance to maps border (to prevent pakistani spawns) | default: 150
        centerNoSpawnRadius?: number, // no spawn zone in the center of the map | default: 170
        minSpawnRad?: number, // spawn radius away from alive players | default: 400 (used for default spawn system too)
        minPosSpawnRad?: number, // spawn radius away from other spawn points |default: 100
        spawnCenter?: boolean, // spawn in the center of the map

        camperPunishmentDistance?: number, // distance player has to move to not get punished || default: 10
        camperDecayTime?: number, // time in ms until punishment || default: 6000
        camperPunishment?: boolean, // enables camper bunishment || default false
        camperPunishmentTime?: number, // time in ms how long punishment lasts || default: 5000
        camperGracePeriod?: number, // time in ms after spawn before camping checks start || default: 40000

        announceTeams?: boolean;
        enableChat?: boolean;

        desertMode?: boolean;
        factionMode?: boolean;
        factions?: number;
        potatoMode?: boolean;
        woodsMode?: boolean;
        sniperMode?: boolean;
        perkMode?: boolean;
        perkModeRoles?: string[];

        arenaMode?: boolean;
        arenaModeRoles?: string[];
        arenaModePools?: Record<
            string,
            Array<{
                name: string;
            }>
        >;
        arenaLobbyRoles?: number;

        turkeyMode?: boolean;
        spookyKillSounds?: boolean;

        xpMultiplier?: {
            kill: number;
            damage: number;
            win: number;
            timeSurvived: number;
        };

    };
    gameConfig: {
        planes: {
            timings: Array<{
                circleIdx: number;
                wait: number;
                options: {
                    type: number;
                    numPlanes?: Array<{
                        count: number;
                        weight: number;
                    }>;
                    airstrikeZoneRad?: number;
                    wait?: number;
                    delay?: number;
                    airdropType?: string;
                };
            }>;
            crates: Array<{
                name: string;
                weight: number;
            }>;
        };
        roles?: {
            timings: Array<{
                role: string | (() => string);
                circleIdx: number;
                wait: number;
            }>;
            roleOverrides?: Record<string, Partial<RoleDef>>;
        };
        unlocks?: {
            timings: Array<{
                type: string; // can either be a building with the door(s) to unlock OR the door itself, no support for structures yet
                stagger: number; // only for buildings with multiple unlocks, will stagger the unlocks instead of doing them all at once
                circleIdx: number;
                wait: number;
            }>;
        };
        bagSizes: Record<string, number[]>;
        bleedDamage: number;
        bleedDamageMult: number;
    };

    defaultItems?: {
        weapons: [
            { type: string, ammo: number },
            { type: string, ammo: number },
            { type: string, ammo: number },
            { type: string, ammo: number },
        ];
        outfit: string;
        backpack: string;
        helmet: string;
        chest: string;
        scope: string;
        perks: (string | (() => string))[];
        inventory: {
            "9mm": number;
            "762mm": number;
            "556mm": number;
            "12gauge": number;
            "50AE": number;
            "308sub": number;
            flare: number;
            "45acp": number;
            frag: number;
            smoke: number;
            strobe: number;
            mirv: number;
            snowball: number;
            potato: number;
            coconut: number;
            bandage: number;
            healthkit: number;
            soda: number;
            painkiller: number;
            "1xscope": number;
            "2xscope": number;
            "4xscope": number;
            "8xscope": number;
            "15xscope": number;
        };
    };

    lootTable: Record<
        string,
        Array<{
            name: string;
            count: number;
            weight: number;
            preload?: boolean;
        }>
    >;
    mapGen: {
        map: {
            baseWidth: number;
            baseHeight: number;
            scale: {
                small: number;
                large: number;
            };
            extension: number;
            shoreInset: number;
            grassInset: number;
            rivers: {
                lakes: Array<{
                    odds: number;
                    innerRad: number;
                    outerRad: number;
                    centerObj?: string;
                    riverMaskRad?: number;
                    spawnBound: {
                        pos: Vec2;
                        rad: number;
                    };
                }>;
                weights: Array<{
                    weight: number;
                    widths: number[];
                }>;
                smoothness: number;
                masks: Array<{
                    pos?: Vec2;
                    genOnShore?: boolean;
                    rad: number;
                }>;
                spawnCabins: boolean;
            };
        };
        places: Array<{
            name: string;
            pos: Vec2;
            dontSpawnObjects?: boolean;
        }>;
        bridgeTypes: {
            medium: string;
            large: string;
            xlarge: string;
        };
        customSpawnRules: {
            locationSpawns: Array<{
                type: string;
                pos: Vec2;
                rad: number;
                retryOnFailure: boolean;
            }>;
            placeSpawns: string[];
        };
        densitySpawns: [Record<string, number>];
        fixedSpawns: [
            Record<string, number | { odds: number } | { small: number; large: number }>,
        ];
        randomSpawns: Array<{
            spawns: string[];
            choose: number;
        }>;
        spawnReplacements: [Record<string, string>];
        importantSpawns: string[];
        spawnOnRiver?: string[];
    };
}

export function getMapDefById(mapId: number) {
    return Object.values(MapDefs).find((def) => def.mapId === mapId);
}
