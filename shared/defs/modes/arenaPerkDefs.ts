/**
 * The perks of the arena perk slot (Domination, ...) and what each does there. Only
 * perks listed here can go into an arena loadout; how one is unlocked (start, level,
 * challenge) is in arenaDefs.ts like for the weapons.
 */
export interface ArenaPerkDef {
    /** what it does in the arena - shown in the loadout menu */
    description: string;
    /** its usual effect is off here - the arena gives what the fields below say instead */
    replacesEffect?: boolean;
    /** the vest worn with it (instead of ARENA_GEAR.chest) */
    chest?: string;
    /** more loadout points for the two guns (on top of ARENA_WEAPON_BUDGET) */
    budgetBonus?: number;
    /** revives (teammates; with self_revive itself) take only ARENA_FAST_REVIVE_S */
    fastRevive?: boolean;
    /** factor on how long medical items take */
    medTimeFactor?: number;
    /** the carrier's bullets go through vests (helmets still count) */
    ignoresVest?: boolean;
    /** less damage from explosions (0..1, after armor) */
    explosionReduction?: number;
    /** does nothing in the arena modes yet (no air strikes there) */
    noArenaEffect?: boolean;
}

/** A revive with a fast-revive perk (Mass Medicate, Revivify), in seconds. */
export const ARENA_FAST_REVIVE_S = 1;
/** Getting up on your own with Revivify (knocked, nobody else reviving), in seconds. */
export const ARENA_SELF_REVIVE_S = 1.5;

export const ARENA_PERK_DEFS: Record<string, ArenaPerkDef> = {
    takedown: { description: "Every kill: +10 health, 15% less damage for 8 s and 2 s of extra speed." },
    firepower: { description: "High-capacity magazines." },
    windwalk: { description: "When taking fire, gain a short burst of speed." },
    aoe_heal: {
        description: "Revive teammates almost instantly. Your medical items (and their damage resistance) affect all nearby players.",
        fastRevive: true,
    },
    endless_ammo: { description: "Guns always reload to full." },
    bonus_assault: {
        description: "Your bullets go straight through vests (helmets still protect).",
        replacesEffect: true,
        ignoresVest: true,
    },
    quickswitch: {
        description: "+50 loadout points: carry two stronger guns.",
        budgetBonus: 50,
    },
    steelskin: {
        description: "Spawn with a level 3 vest instead of level 1.",
        replacesEffect: true,
        chest: "chest03",
    },
    flak_jacket: {
        description: "Take 60% less damage from explosions.",
        replacesEffect: true,
        explosionReduction: 0.6,
    },
    broken_arrow: { description: "Worn on top of your perk: your air strike kill streak calls in two more fighters." },
    self_revive: {
        description: "Revive yourself almost instantly when knocked. Medical items take half as long.",
        fastRevive: true,
        medTimeFactor: 0.5,
    },
};

/** The perks the perk slot can hold. */
export const ARENA_PERKS = Object.keys(ARENA_PERK_DEFS);

/** Perks whose usual effect is off in the arena (Player.hasPerk says no there). */
export const ARENA_INERT_PERKS: ReadonlySet<string> = new Set(
    ARENA_PERKS.filter((perk) => ARENA_PERK_DEFS[perk].replacesEffect),
);
