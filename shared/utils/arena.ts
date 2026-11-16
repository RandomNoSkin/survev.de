/**
 * Arena progression rules, shared by the API (what may be saved / joined with) and the
 * client (the arena menu): levels from XP, what is unlocked, challenge progress, which
 * loadout slot an item belongs in. The tables themselves are in shared/defs/modes/arenaDefs.ts.
 */
import { ARENA_PERK_DEFS } from "../defs/modes/arenaPerkDefs";
import {
    ARENA_AIRDROP_WEAPONS,
    ARENA_DEFAULT_STREAKS,
    ARENA_EXTRA_PERKS,
    ARENA_STREAK_ITEMS,
    ARENA_STREAKS,
    type ArenaStreakSettings,
} from "../defs/modes/arenaStreakDefs";
import { z } from "zod";
import {
    ARENA_CHALLENGES,
    ARENA_LEVEL_UNLOCKS,
    ARENA_LOADOUT_SLOTS,
    ARENA_MAX_LEVEL,
    ARENA_PERKS,
    ARENA_STARTER_ITEMS,
    ARENA_WEAPON_BUDGET,
    ARENA_WEAPON_POINTS,
    type ArenaChallenge,
    type ArenaLoadout,
    arenaXpForLevel,
} from "../defs/modes/arenaDefs";
import { GunDefs } from "../defs/gameObjects/gunDefs";
import { gunCategory } from "../defs/gameObjects/gunCategories";
import { GameObjectDefs } from "../defs/register";
import { weaponSkinBase } from "../defs/lobby/weaponStats";

export type ArenaSlot = keyof ArenaLoadout;

/** The default loadout. */
export const ARENA_DEFAULT_LOADOUT: ArenaLoadout = { primary: "hk416", pistol: "p30l", throwable: "frag", perk: "takedown" };
/** What an empty slot holds (and what guests pick from). */
export const ARENA_PRESET_LOADOUTS: ArenaLoadout[] = [
    ARENA_DEFAULT_LOADOUT,
    { primary: "m870", pistol: "mp5", throwable: "frag", perk: "takedown" },
    { primary: "mk12", pistol: "mp5", throwable: "frag", perk: "takedown" },
];

/** Level and progress for an amount of arena XP. */
export function arenaLevelFromXp(xp: number): { level: number; into: number; needed: number } {
    let level = 1;
    let left = Math.max(0, Math.floor(xp));
    while (level < ARENA_MAX_LEVEL && left >= arenaXpForLevel(level)) {
        left -= arenaXpForLevel(level);
        level++;
    }
    return { level, into: level >= ARENA_MAX_LEVEL ? 0 : left, needed: level >= ARENA_MAX_LEVEL ? 0 : arenaXpForLevel(level) };
}

/** Every item the arena knows: the guns, starters, level unlocks, challenge unlocks. */
export function arenaItems(): string[] {
    return [
        ...new Set([
            ...Object.keys(ARENA_WEAPON_POINTS),
            ...ARENA_STARTER_ITEMS,
            ...Object.values(ARENA_LEVEL_UNLOCKS).flat(),
            ...Object.keys(ARENA_CHALLENGES),
            ...ARENA_PERKS,
        ]),
    ];
}

/** The level that unlocks `type` (1 for the starters and the guns), if a level does. */
export function arenaUnlockLevel(type: string): number | undefined {
    if (ARENA_STARTER_ITEMS.includes(type) || ARENA_WEAPON_POINTS[type] !== undefined) return 1;
    for (const [level, items] of Object.entries(ARENA_LEVEL_UNLOCKS)) {
        if (items.includes(type)) return Number(level);
    }
    return undefined;
}

/** Which loadout slot an item goes in (undefined: none - not an arena item, or a kill
 *  streak's: those are picked apart, see ArenaStreakSettings). A gun: "primary" - it fits
 *  either gun slot (see arenaFitsSlot). */
export function arenaSlotOf(type: string): ArenaSlot | undefined {
    if (ARENA_STREAK_ITEMS.includes(type) || ARENA_EXTRA_PERKS.includes(type)) return undefined;
    const def = GameObjectDefs.typeToDefSafe(type) as { type?: string } | undefined;
    if (!def) return undefined;
    if (def.type === "gun") return "primary";
    if (def.type === "throwable") return "throwable";
    if (def.type === "perk") return "perk";
    return undefined;
}

/** A gun slot (the two guns share the point budget). */
export const isArenaGunSlot = (slot: ArenaSlot) => slot === "primary" || slot === "pistol";

/** What a gun costs in a loadout (undefined: it can't go into one - airdrop / event only). */
export function arenaWeaponPoints(type: string): number | undefined {
    return ARENA_WEAPON_POINTS[type];
}

/** The points the two guns of a loadout with `perk` may cost together (Quickswitch: more). */
export function arenaWeaponBudget(perk?: string): number {
    return ARENA_WEAPON_BUDGET + (perk ? (ARENA_PERK_DEFS[perk]?.budgetBonus ?? 0) : 0);
}

/** What the two guns of a loadout cost together. */
export function arenaLoadoutPoints(loadout: Pick<ArenaLoadout, "primary" | "pistol">): number {
    return (ARENA_WEAPON_POINTS[loadout.primary] ?? 0) + (ARENA_WEAPON_POINTS[loadout.pistol] ?? 0);
}

/** Whether an item may go into a loadout slot: a gun with points into either gun slot. */
export function arenaFitsSlot(type: string, slot: ArenaSlot): boolean {
    if (isArenaGunSlot(slot)) return ARENA_WEAPON_POINTS[type] !== undefined;
    return arenaSlotOf(type) === slot;
}

/** Kills counted per weapon - skins count for their base weapon. */
export function normalizeWeaponKills(kills: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [type, n] of Object.entries(kills)) {
        const base = weaponSkinBase(type) ?? type;
        out[base] = (out[base] ?? 0) + n;
    }
    return out;
}

/** How far a challenge is: kills that count towards it (normalized kills, see above). */
export function challengeProgress(challenge: ArenaChallenge, kills: Record<string, number>): number {
    const w = challenge.with;
    if ("weapon" in w) return kills[w.weapon] ?? 0;
    let sum = 0;
    for (const [type, n] of Object.entries(kills)) {
        const def = GameObjectDefs.typeToDefSafe(type) as { type?: string } | undefined;
        if (w.category === "throwable" ? def?.type === "throwable" : GunDefs[type] && gunCategory(type) === w.category) {
            sum += n;
        }
    }
    return sum;
}

/** Everything a player with `level` and these kills may put into a loadout. */
export function arenaUnlocked(level: number, kills: Record<string, number>): Set<string> {
    const out = new Set<string>([...ARENA_STARTER_ITEMS, ...Object.keys(ARENA_WEAPON_POINTS)]);
    for (const [l, items] of Object.entries(ARENA_LEVEL_UNLOCKS)) {
        if (Number(l) <= level) for (const it of items) out.add(it);
    }
    for (const [type, challenge] of Object.entries(ARENA_CHALLENGES)) {
        if (challengeProgress(challenge, kills) >= challenge.kills) out.add(type);
    }
    // the perk slot: only perks the arena uses (the level table may list more later)
    for (const it of [...out]) {
        if (arenaSlotOf(it) === "perk" && !ARENA_PERKS.includes(it)) out.delete(it);
    }
    return out;
}

/**
 * A loadout made valid: every slot holds an unlocked item of its kind - or nothing ("",
 * a cleared slot) - else the fallback's; two different guns within the point budget
 * (else the second gun goes - the fallback's, then the cheapest that fits).
 */
export function sanitizeArenaLoadout(
    loadout: Partial<ArenaLoadout> | undefined,
    unlocked: Set<string>,
    fallback: ArenaLoadout = ARENA_DEFAULT_LOADOUT,
): ArenaLoadout {
    const out = { ...fallback };
    const ok = (slot: ArenaSlot) => {
        const type = loadout?.[slot];
        // (empty: the player cleared it)
        if (type === "") return true;
        return !!type && unlocked.has(type) && arenaFitsSlot(type, slot);
    };
    for (const slot of ["perk", "primary", "pistol", "throwable"] as ArenaSlot[]) {
        if (ok(slot)) out[slot] = loadout![slot]!;
    }
    const budget = arenaWeaponBudget(out.perk);
    const fits = (primary: string, second: string) =>
        (primary !== second || !primary) && arenaLoadoutPoints({ primary, pistol: second }) <= budget;
    if (!fits(out.primary, out.pistol)) {
        // the main gun stays; a second one that fits (the fallback's, the default's, the cheapest)
        const cheapest = Object.keys(ARENA_WEAPON_POINTS).sort((a, b) => ARENA_WEAPON_POINTS[a] - ARENA_WEAPON_POINTS[b]);
        const second = [fallback.pistol, ARENA_DEFAULT_LOADOUT.pistol, ...cheapest].find((t) => fits(out.primary, t));
        if (second) {
            out.pistol = second;
        } else {
            // (a main gun no second gun fits with: the default's two)
            out.primary = ARENA_DEFAULT_LOADOUT.primary;
            out.pistol = ARENA_DEFAULT_LOADOUT.pistol;
        }
    }
    return out;
}

/** Kill streak picks made valid: unlocked variants only, else the defaults. */
export function sanitizeArenaStreaks(settings: Partial<ArenaStreakSettings> | undefined, unlocked: Set<string>): ArenaStreakSettings {
    const out = { ...ARENA_DEFAULT_STREAKS };
    const tier = (kind: string) => ARENA_STREAKS.find((t) => t.kind === kind)!;
    if (settings?.airdrop && tier("airdrop").options.includes(settings.airdrop) && unlocked.has(settings.airdrop)) out.airdrop = settings.airdrop;
    if (settings?.juggernaut && tier("juggernaut").options.includes(settings.juggernaut) && unlocked.has(settings.juggernaut)) {
        out.juggernaut = settings.juggernaut;
    }
    if (settings?.airdropWeapon && ARENA_AIRDROP_WEAPONS.includes(settings.airdropWeapon)) out.airdropWeapon = settings.airdropWeapon;
    out.brokenArrow = !!settings?.brokenArrow && unlocked.has("broken_arrow");
    out.eagleEye = unlocked.has("8xscope");
    const kinds = new Set(ARENA_STREAKS.map((t) => t.kind));
    out.off = [...new Set((settings?.off ?? []).filter((k) => kinds.has(k)))];
    return out;
}

// ── API ─────────────────────────────────────────────────────────────────────


const zItem = z.string().min(1).max(64);
/** a loadout slot: an item, or "" (cleared) */
const zSlot = z.string().max(64);
export const zArenaLoadout = z.object({ primary: zSlot, pistol: zSlot, throwable: zSlot, perk: zSlot });
export const zArenaLoadoutRequest = z.object({
    slot: z.number().int().min(0).max(ARENA_LOADOUT_SLOTS - 1),
    loadout: zArenaLoadout,
});

/** The arena menu's data. */
export interface ArenaProfileResponse {
    xp: number;
    level: number;
    /** XP into the current level / needed for the next (0 at the max level) */
    into: number;
    needed: number;
    /** kills per weapon that count for the challenges (skins under their base) */
    kills: Record<string, number>;
    unlocked: string[];
    loadouts: ArenaLoadout[];
    /** the kill streak picks */
    streaks: ArenaStreakSettings;
}

export const zArenaStreaks = z.object({
    airdrop: zItem,
    juggernaut: zItem,
    airdropWeapon: zItem,
    brokenArrow: z.boolean(),
    eagleEye: z.boolean().optional(),
    off: z.array(z.enum(["airdrop", "juggernaut", "eagle_eye", "airstrike"])).max(4).optional(),
});
