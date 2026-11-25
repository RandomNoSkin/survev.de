/**
 * Arena (Team Deathmatch, Domination, ...) progression: what the arena loadout may hold
 * and how each of it is unlocked.
 *
 * Weapons are unlocked either by the arena level (ARENA_LEVEL_UNLOCKS) or by a weapon
 * challenge (ARENA_CHALLENGES: kills with another weapon / a category). Everything not
 * listed here can't go into an arena loadout. PROPOSAL - numbers still to be tuned.
 */
import type { GunCategory } from "../gameObjects/gunCategories";

/** Perks the perk slot can hold, and what they do there: arenaPerkDefs.ts. */
export { ARENA_PERK_DEFS, ARENA_PERKS } from "./arenaPerkDefs";

/** What a loadout holds: two guns (ARENA_WEAPON_POINTS - within the point budget), a
 *  throwable and a perk. The melee is the one from the cosmetic loadout. */
export interface ArenaLoadout {
    primary: string;
    /** the second gun - any kind (the name from when it was a pistol slot: the DB column) */
    pistol: string;
    throwable: string;
    perk: string;
}

/** What everyone wears and carries on every spawn: level 2 helmet, level 1 vest, a
 *  level 2 backpack with ammo for the guns (ARENA_SPAWN_AMMO_MULT), 5 bandages, 3 sodas
 *  and a pill; adrenaline is always full. */
export const ARENA_GEAR = {
    helmet: "helmet02",
    chest: "chest01",
    backpack: "backpack02",
    fullAmmo: true,
    heals: { bandage: 5, soda: 3, painkiller: 1 } as Record<string, number>,
    /** the scopes everyone has; the last one is selected on spawn */
    scopes: ["1xscope", "2xscope", "4xscope"],
    adrenalineAlwaysFull: true,
};

/**
 * Adrenaline is always full in the arena, so a soda / pill does something else there:
 * less damage taken for a few seconds (`reduction` of the damage, after armor). A new
 * one while one runs: the stronger / longer one counts.
 */
export const ARENA_BOOST_RESIST: Record<string, { reduction: number; seconds: number }> = {
    soda: { reduction: 0.2, seconds: 9 },
    painkiller: { reduction: 0.3, seconds: 15 },
    /** (no item: what Takedown gives per kill - see ARENA_TAKEDOWN) */
    takedown: { reduction: 0.15, seconds: 8 },
};

/** Spawn ammo per gun: this many times what the gun drops with in the battle royale
 *  (its ammoSpawnCount) - two guns of one ammo type add up, the backpack caps it. */
export const ARENA_SPAWN_AMMO_MULT = 2;
/** ...pistols and shotguns more (their drop is small). `max`: at most that many. */
export const ARENA_SPAWN_AMMO_BY_CATEGORY: Record<string, { mult: number; max?: number }> = {
    pistol: { mult: 4 },
    shotgun: { mult: 3 },
};
/** Grenades (any throwable) a player can carry at most - whatever the backpack holds. */
export const ARENA_MAX_THROWABLES = 4;

/** Takedown in the arena modes (Gun Game too): per kill a bit of health, a short damage
 *  resistance (ARENA_BOOST_RESIST.takedown - half a pill's) and a short burst of speed. */
export const ARENA_TAKEDOWN = { health: 10, boost: "takedown", hasteSeconds: 2 };

/** How long a revive takes in the arena (the battle royale: 8 s) - a fast-revive perk:
 *  ARENA_FAST_REVIVE_S. */
export const ARENA_REVIVE_S = 3;
/** Every kill gives the killer ammo for their guns: this much of the spawn ammo (per gun,
 *  see ARENA_SPAWN_AMMO_MULT), the backpack caps it. */
export const ARENA_KILL_AMMO_FRACTION = 0.5;
/** Windwalk's burst of speed in the arena: this much of the usual. */
export const ARENA_WINDWALK_SPEED_FACTOR = 0.75;

/** Health after a revive (on top: a pill's damage resistance, ARENA_BOOST_RESIST). */
export const ARENA_REVIVE_HEALTH = 50;
/** Arena modes: no shot fired and no enemy damage dealt or taken this long - out of combat. */
export const ARENA_OUT_OF_COMBAT_S = 4;
/** Arena modes, in the match: this long without moving, aiming, shooting or a key -
 *  kicked (the place is free for someone joining in). */
export const ARENA_AFK_KICK_S = 75;
/** Out of combat the adrenaline heals this much faster. */
export const ARENA_OUT_OF_COMBAT_HEAL_MULT = 2;

/** How many loadouts a player can keep (picked from on every respawn). */
export const ARENA_LOADOUT_SLOTS = 3;

/**
 * The guns of a loadout: every gun listed here is free from the start - a loadout takes
 * two of them (any kind, a pistol too) worth at most ARENA_WEAPON_BUDGET points together
 * (Quickswitch: more, see ArenaPerkDef.budgetBonus). Strong guns cost a lot, so they go
 * with a weak one; two average ones fit as well. Guns not listed (most of the airdrop's
 * ARENA_AIRDROP_WEAPONS, the [+] guns, the kill streaks') never go into a loadout - only
 * found in the game. The numbers: the user's (set with the points page).
 */
export const ARENA_WEAPON_BUDGET = 100;
export const ARENA_WEAPON_POINTS: Record<string, number> = {
    // (2026-11-22 repricing: from the Comp map's damage per game over 30 days - the
    // stats page's weapon leaderboard - smoothed toward the old price for guns with
    // few games; guns without data kept theirs; the shotguns kept theirs too. Origin / S&W 500 set
    // higher by hand.)
    // pistols (no M9, OT-38, M93R)
    glock: 10,
    m1911: 20,
    ots38: 40,
    p30l: 30,
    colt45: 25,
    deagle: 45,
    sw500: 70,
    // dual pistols (none of those either)
    glock_dual: 30,
    m1911_dual: 50,
    p30l_dual: 40,
    colt45_dual: 55,
    ots38_dual: 65,
    deagle_dual: 55,
    // SMGs
    mp5: 15,
    mac10: 20,
    ump9: 20,
    p90: 40,
    vss: 55,
    vector: 40,
    scorpion: 55,
    // assault rifles
    groza: 20,
    hk416: 30,
    ak47: 30,
    ak74: 50,
    famas: 50,
    m4a1: 50,
    imbel: 65,
    scar: 50,
    an94: 60,
    grozas: 55,
    // LMGs
    dp28: 50,
    bar: 55,
    qbb97: 50,
    l86: 55,
    m249: 60,
    pkp: 65,
    // DMRs
    mk12: 30,
    mkg45: 50,
    m39: 40,
    svd: 65,
    garand: 65,
    // bolt actions
    model94: 45,
    henry: 50,
    scout_elite: 50,
    blr: 70,
    mosin: 75,
    // shotguns (no M1100) - set by hand: their battle royale numbers undersell them here
    mp220: 45,
    m870: 50,
    spas16: 50,
    hawk: 75,
    saiga: 60,
    origin: 70,
    m1014: 70,
    spas12: 70,
};

/** The loadout's guns (ARENA_WEAPON_POINTS - also one picked up from a dead player) never
 *  run out: reloads take nothing from the backpack, and nobody spawns with ammo for them
 *  (so no Endless Ammo perk in the arena). Guns from elsewhere (the airdrop kill streak's)
 *  have only the rounds they came with - ARENA_AIRDROP_GUN_RESERVE_MAGS. */
export const ARENA_INFINITE_LOADOUT_AMMO = true;

/** Everyone has these from the start (level 1) - and every gun of ARENA_WEAPON_POINTS. */
export const ARENA_STARTER_ITEMS = [
    "frag",
    "takedown",
    // the kill streaks' defaults (arenaStreakDefs.ts)
    "flare_gun",
    "m134",
    "strobe",
];

/**
 * Level → what it unlocks: the perks and kill streak variants (the guns are all free, see
 * ARENA_WEAPON_POINTS; the grenades come by grenade kills, see ARENA_CHALLENGES).
 */
export const ARENA_LEVEL_UNLOCKS: Record<number, string[]> = {
    2: ["aoe_heal"],
    3: ["supply_flare_gun"],
    4: ["firepower"],
    5: ["flak_jacket"],
    6: ["windwalk"],
    7: ["self_revive"],
    8: ["quickswitch"],
    9: ["steelskin"],
    10: ["bonus_assault"],
};
export const ARENA_MAX_LEVEL = 10;

/** The kills of the endless M249 [+] Juggernaut count under this name (the M249 [+] as a
 *  weapon is just an M249 skin - its kills count for the M249). */
export const ARENA_JUGGERNAUT_M249_KILLS = "juggernaut_m249";

/** A weapon challenge: `kills` kills with the weapon `with`, or with any of a category. */
export interface ArenaChallenge {
    kills: number;
    with: { weapon: string } | { category: GunCategory | "throwable" };
}

/** Item → the challenge that unlocks it (the guns are free - these are the extras). */
export const ARENA_CHALLENGES: Record<string, ArenaChallenge> = {
    // grenades: by grenade kills - the frag (everyone's) unlocks smoke and dynamite, any
    // grenade's kills the MIRV
    smoke: { kills: 10, with: { weapon: "frag" } },
    dynamite: { kills: 25, with: { weapon: "frag" } },
    mirv: { kills: 50, with: { category: "throwable" } },
    // perks: Broken Arrow by the air strike kill streak's strobes
    broken_arrow: { kills: 50, with: { weapon: "strobe" } },
    // kill streaks: the endless M249 [+] Juggernaut by minigun kills, Eagle Eye by its kills
    modified_m249: { kills: 50, with: { weapon: "m134" } },
    "8xscope": { kills: 50, with: { weapon: ARENA_JUGGERNAUT_M249_KILLS } },
};

/** Arena XP per action, and per level. */
export const ARENA_XP = {
    kill: 25,
    assist: 10,
    /** Domination: taking a point / taking it away from the enemy */
    capture: 40,
    neutralize: 20,
    win: 150,
    loss: 50,
};
/** XP to get from `level` to the next one: 1000, 1250, 1500, ... */
export function arenaXpForLevel(level: number): number {
    return 1000 + 250 * (level - 1);
}
