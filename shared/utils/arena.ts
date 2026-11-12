/**
 * Arena progression rules, shared by the API (what may be saved / joined with) and the
 * client (the arena menu): levels from XP, what is unlocked, challenge progress, which
 * loadout slot an item belongs in. The tables themselves are in shared/defs/modes/arenaDefs.ts.
 */
import { ARENA_QUICKSWITCH } from "../defs/modes/arenaPerkDefs";
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
/** What an empty slot holds (and what guests pick from): one per starter main gun. */
export const ARENA_PRESET_LOADOUTS: ArenaLoadout[] = [
    ARENA_DEFAULT_LOADOUT,
    { primary: "mp5", pistol: "p30l", throwable: "frag", perk: "takedown" },
    { primary: "m870", pistol: "p30l", throwable: "frag", perk: "takedown" },
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

/** Every item the arena knows: starters, level unlocks, challenge unlocks. */
export function arenaItems(): string[] {
    return [...new Set([...ARENA_STARTER_ITEMS, ...Object.values(ARENA_LEVEL_UNLOCKS).flat(), ...Object.keys(ARENA_CHALLENGES), ...ARENA_PERKS])];
}

/** The level that unlocks `type` (1 for the starters), if a level does. */
export function arenaUnlockLevel(type: string): number | undefined {
    if (ARENA_STARTER_ITEMS.includes(type)) return 1;
    for (const [level, items] of Object.entries(ARENA_LEVEL_UNLOCKS)) {
        if (items.includes(type)) return Number(level);
    }
    return undefined;
}

/** Which loadout slot an item goes in (undefined: none - not an arena item, or a kill
 *  streak's: those are picked apart, see ArenaStreakSettings). */
export function arenaSlotOf(type: string): ArenaSlot | undefined {
    if (ARENA_STREAK_ITEMS.includes(type) || ARENA_EXTRA_PERKS.includes(type)) return undefined;
    const def = GameObjectDefs.typeToDefSafe(type) as { type?: string } | undefined;
    if (!def) return undefined;
    if (def.type === "gun") return gunCategory(type) === "pistol" ? "pistol" : "primary";
    if (def.type === "throwable") return "throwable";
    if (def.type === "perk") return "perk";
    return undefined;
}

/** Main guns that may go into the pistol slot as well (a secondary). */
export const ARENA_ALSO_SECONDARY = ["p90", "mp220"];

/**
 * Whether an item may go into a loadout slot - its own, or a main gun allowed as
 * secondary (any main gun with the Quickswitch perk: `perk` is the loadout's).
 */
export function arenaFitsSlot(type: string, slot: ArenaSlot, perk?: string): boolean {
    const own = arenaSlotOf(type);
    if (!own) return false;
    if (own === slot) return true;
    return slot === "pistol" && own === "primary" && (ARENA_ALSO_SECONDARY.includes(type) || perk === ARENA_QUICKSWITCH);
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
    const out = new Set<string>(ARENA_STARTER_ITEMS);
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

/** A loadout made valid: every slot holds an unlocked item of its kind, else the fallback's. */
export function sanitizeArenaLoadout(
    loadout: Partial<ArenaLoadout> | undefined,
    unlocked: Set<string>,
    fallback: ArenaLoadout = ARENA_DEFAULT_LOADOUT,
): ArenaLoadout {
    const out = { ...fallback };
    // the perk first: Quickswitch decides what the pistol slot may hold
    const ok = (slot: ArenaSlot, perk?: string) => {
        const type = loadout?.[slot];
        return !!type && unlocked.has(type) && arenaFitsSlot(type, slot, perk);
    };
    if (ok("perk")) out.perk = loadout!.perk!;
    for (const slot of ["primary", "pistol", "throwable"] as ArenaSlot[]) {
        if (ok(slot, out.perk)) out[slot] = loadout![slot]!;
    }
    // (a fallback's main gun as secondary without Quickswitch: its pistol back)
    if (!arenaFitsSlot(out.pistol, "pistol", out.perk)) out.pistol = ARENA_DEFAULT_LOADOUT.pistol;
    // one gun once (the MP220 as main gun and secondary: only by picking up another in game)
    if (out.pistol === out.primary) out.pistol = fallback.pistol !== out.primary ? fallback.pistol : ARENA_DEFAULT_LOADOUT.pistol;
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
export const zArenaLoadout = z.object({ primary: zItem, pistol: zItem, throwable: zItem, perk: zItem });
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
