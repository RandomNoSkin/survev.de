/**
 * The arena's kill streaks (Domination, ...): kills in a row without dying earn a bonus,
 * fired with its own key (Input.UseKillstreak) when the player wants. A higher one earned
 * before the last was fired replaces it; an earned one stays until fired (also over a
 * death), a fired one ends with the death. None of it can be dropped.
 *
 * Every tier has its variants (the first one is everyone's from the start, the others are
 * unlocked like weapons - arenaDefs.ts); which one a player gets they pick in the arena
 * loadout menu (ArenaStreakSettings).
 */

export type ArenaStreakKind = "airdrop" | "juggernaut" | "eagle_eye" | "airstrike";

export interface ArenaStreakTier {
    kind: ArenaStreakKind;
    name: string;
    /** kills in a row it takes */
    kills: number;
    /** the item types it can be (the first: the default) */
    options: string[];
}

export const ARENA_STREAKS: ArenaStreakTier[] = [
    /** a flare gun in the melee slot: one shot calls in a crate, then it's gone */
    { kind: "airdrop", name: "Airdrop", kills: 3, options: ["flare_gun", "supply_flare_gun"] },
    /** an 8x scope until the death */
    { kind: "eagle_eye", name: "Eagle Eye", kills: 5, options: ["8xscope"] },
    /** a minigun (or the endless M249 [+]) instead of the loadout, until the magazine is empty */
    { kind: "juggernaut", name: "Juggernaut", kills: 7, options: ["m134", "modified_m249"] },
    /** a strobe: an air strike where it lands */
    { kind: "airstrike", name: "Air Strike", kills: 10, options: ["strobe"] },
];

/** What each kill streak (variant) does - shown in the loadout menu. */
export const ARENA_STREAK_DESCRIPTIONS: Record<string, string> = {
    flare_gun: "A flare gun in your melee slot. Fire it to call in a crate with the weapon you picked below.",
    supply_flare_gun: "A supply flare in your melee slot. Fire it to call in a crate with a level 3 helmet and a level 2 vest.",
    m134: "A full M134 and a level 3 helmet - nothing else. You get your loadout back once the minigun is empty.",
    modified_m249: "An M249 [+] with endless ammo and the normal arena armor, until you die.",
    "8xscope": "An 8x scope until you die.",
    strobe: "An IR strobe: throw it to call in an air strike where it lands.",
};

/** Every item a kill streak gives - never droppable, never in a loadout slot. */
export const ARENA_STREAK_ITEMS = ARENA_STREAKS.flatMap((t) => t.options);

/** What a Juggernaut wears and whether its gun never runs dry (then: until the death). */
export const ARENA_JUGGERNAUTS: Record<string, { helmet?: string; chest?: string; endless: boolean }> = {
    // a level 3 helmet, the usual arena vest
    m134: { helmet: "helmet03", endless: false },
    // the default arena armor (ARENA_GEAR)
    modified_m249: { endless: true },
};

/** The guns a player can have the flare's airdrop bring (picked in the loadout menu). */
export const ARENA_AIRDROP_WEAPONS = ["awc", "barrett", "sv98", "spas12", "usas", "pkm", "scarssr"];
/** What the supply flare's crate holds: better armor (full level 3 was too much). */
export const ARENA_SUPPLY_DROP_LOOT = ["helmet03", "chest02"];
/** Called in crates come this much faster than usual (the plane and the fall). */
export const ARENA_AIRDROP_TIME_FACTOR = 0.4;

/** A player's kill streak picks (the arena loadout menu). */
export interface ArenaStreakSettings {
    /** the airdrop tier's flare */
    airdrop: string;
    /** the juggernaut tier's gun */
    juggernaut: string;
    /** what the flare's airdrop brings */
    airdropWeapon: string;
    /** Broken Arrow (unlocked by strobe kills) on top of the perk slot */
    brokenArrow: boolean;
    /** Eagle Eye is unlocked (not a pick - without it the tier gives nothing) */
    eagleEye?: boolean;
    /** the tiers switched off: they give nothing, the streak goes on to the next one */
    off?: ArenaStreakKind[];
}

/** Perks worn on top of the perk slot, switched on in the kill streak picks. */
export const ARENA_EXTRA_PERKS = ["broken_arrow"];

export const ARENA_DEFAULT_STREAKS: ArenaStreakSettings = {
    airdrop: "flare_gun",
    juggernaut: "m134",
    airdropWeapon: "awc",
    brokenArrow: false,
};

/** The tiers a player gets: switched off ones and a locked Eagle Eye left out. */
export function activeStreakTiers(settings: ArenaStreakSettings): ArenaStreakTier[] {
    const off = new Set(settings.off ?? []);
    return ARENA_STREAKS.filter((t) => !off.has(t.kind) && (t.kind !== "eagle_eye" || !!settings.eagleEye));
}

/** The tier a streak of `kills` reached last (undefined below the first). */
export function streakTierAt(kills: number): ArenaStreakTier | undefined {
    let reached: ArenaStreakTier | undefined;
    for (const t of ARENA_STREAKS) if (kills >= t.kills) reached = t;
    return reached;
}
