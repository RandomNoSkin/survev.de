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

/** What a loadout holds: one main gun (any category but pistols), one pistol, a
 *  throwable and a perk. The melee is the one from the cosmetic loadout. */
export interface ArenaLoadout {
    primary: string;
    pistol: string;
    throwable: string;
    perk: string;
}

/** What everyone wears and carries on every spawn: level 2 helmet, level 1 vest, a
 *  backpack full of ammo, 5 bandages, 3 sodas and a pill; adrenaline is always full. */
export const ARENA_GEAR = {
    helmet: "helmet02",
    chest: "chest01",
    backpack: "backpack01",
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
    soda: { reduction: 0.2, seconds: 5 },
    painkiller: { reduction: 0.3, seconds: 8 },
};

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

/** Everyone has these from the start (level 1). */
export const ARENA_STARTER_ITEMS = [
    "mp5",
    "hk416",
    "mk12",
    "m870",
    "p30l",
    "frag",
    "takedown",
    "scavenger",
    // the kill streaks' defaults (arenaStreakDefs.ts)
    "flare_gun",
    "m134",
    "strobe",
];

/**
 * Level → what it unlocks (weapons, throwables, perks). Roughly from easy to strong,
 * the categories mixed so every few levels bring something for each playstyle.
 */
export const ARENA_LEVEL_UNLOCKS: Record<number, string[]> = {
    2: ["mac10"],
    3: ["ots38"],
    4: ["ak47", "aoe_heal"],
    5: ["smoke"],
    6: ["p90"],
    7: ["mp220"],
    8: ["famas", "endless_ammo"],
    9: ["glock_dual"],
    10: ["vector", "supply_flare_gun"],
    11: ["scout_elite"],
    12: ["scar", "firepower"],
    13: ["saiga"],
    14: ["m1911_dual", "flak_jacket"],
    15: ["groza", "windwalk"],
    16: ["model94", "self_revive"],
    17: ["dynamite"],
    18: ["vss"],
    19: ["dp28"],
    20: ["l86", "steelskin"],
    21: ["henry"],
    22: ["colt45"],
    23: ["blr"],
    24: ["qbb97"],
    25: ["origin"],
    26: ["m39"],
    27: ["bar"],
    28: ["mkg45"],
    29: ["deagle"],
    30: ["m249", "bonus_assault"],
    31: ["spas16"],
    32: ["svd"],
    33: ["pkp"],
    34: ["ash12"],
};
export const ARENA_MAX_LEVEL = 34;

/** The kills of the endless M249 [+] Juggernaut count under this name (the M249 [+] as a
 *  weapon is just an M249 skin - its kills count for the M249). */
export const ARENA_JUGGERNAUT_M249_KILLS = "juggernaut_m249";

/** A weapon challenge: `kills` kills with the weapon `with`, or with any of a category. */
export interface ArenaChallenge {
    kills: number;
    with: { weapon: string } | { category: GunCategory | "throwable" };
}

/** Weapon → the challenge that unlocks it (it builds on a level weapon of its kind). */
export const ARENA_CHALLENGES: Record<string, ArenaChallenge> = {
    // SMGs
    vector45: { kills: 150, with: { weapon: "vector" } },
    scorpion: { kills: 250, with: { category: "smg" } },
    // assault rifles / LMGs
    m4a1: { kills: 150, with: { weapon: "hk416" } },
    ak74: { kills: 300, with: { category: "rifle" } },
    an94: { kills: 50, with: { weapon: "ak74" } },
    grozas: { kills: 150, with: { weapon: "groza" } },
    imbel: { kills: 150, with: { weapon: "famas" } },
    pkm: { kills: 150, with: { weapon: "pkp" } },
    // snipers / DMRs
    scarssr: { kills: 300, with: { weapon: "scar" } },
    mosin: { kills: 150, with: { weapon: "scout_elite" } },
    sv98: { kills: 150, with: { weapon: "mosin" } },
    awc: { kills: 150, with: { weapon: "sv98" } },
    garand: { kills: 150, with: { weapon: "m39" } },
    barrett: { kills: 400, with: { category: "sniper" } },
    // shotguns
    hawk: { kills: 150, with: { weapon: "mp220" } },
    spas12: { kills: 150, with: { weapon: "spas16" } },
    m1014: { kills: 150, with: { weapon: "saiga" } },
    usas: { kills: 250, with: { category: "shotgun" } },
    // pistols: the dual version of a pistol, by playing that pistol
    p30l_dual: { kills: 75, with: { weapon: "p30l" } },
    ots38_dual: { kills: 75, with: { weapon: "ots38" } },
    colt45_dual: { kills: 75, with: { weapon: "colt45" } },
    deagle_dual: { kills: 100, with: { weapon: "deagle" } },
    sw500: { kills: 100, with: { weapon: "deagle_dual" } },
    // throwables
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
