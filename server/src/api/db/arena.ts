import { eq, sql } from "drizzle-orm";
import { ARENA_LOADOUT_SLOTS, type ArenaLoadout } from "../../../../shared/defs/modes/arenaDefs";
import { ARENA_DEFAULT_STREAKS, type ArenaStreakSettings } from "../../../../shared/defs/modes/arenaStreakDefs";
import {
    ARENA_PRESET_LOADOUTS,
    type ArenaProfileResponse,
    arenaLevelFromXp,
    arenaUnlocked,
    normalizeWeaponKills,
    sanitizeArenaLoadout,
    sanitizeArenaStreaks,
} from "../../../../shared/utils/arena";
import { db } from "./index";
import { arenaLoadoutsTable, arenaProgressTable, arenaStreaksTable, arenaWeaponKillsTable } from "./schema";

async function xpOf(userId: string): Promise<number> {
    const [row] = await db.select({ xp: arenaProgressTable.xp }).from(arenaProgressTable).where(eq(arenaProgressTable.userId, userId));
    return row?.xp ?? 0;
}

async function killsOf(userId: string): Promise<Record<string, number>> {
    const rows = await db
        .select({ weaponType: arenaWeaponKillsTable.weaponType, kills: arenaWeaponKillsTable.kills })
        .from(arenaWeaponKillsTable)
        .where(eq(arenaWeaponKillsTable.userId, userId));
    return normalizeWeaponKills(Object.fromEntries(rows.map((r) => [r.weaponType, r.kills])));
}

/** What the player may use right now. */
async function unlockedOf(userId: string): Promise<{ xp: number; kills: Record<string, number>; unlocked: Set<string> }> {
    const [xp, kills] = await Promise.all([xpOf(userId), killsOf(userId)]);
    return { xp, kills, unlocked: arenaUnlocked(arenaLevelFromXp(xp).level, kills) };
}

/** The saved loadouts, every slot filled and only with unlocked items. */
async function loadoutsOf(userId: string, unlocked: Set<string>): Promise<ArenaLoadout[]> {
    const rows = await db.select().from(arenaLoadoutsTable).where(eq(arenaLoadoutsTable.userId, userId));
    return Array.from({ length: ARENA_LOADOUT_SLOTS }, (_, slot) =>
        sanitizeArenaLoadout(rows.find((r) => r.slot === slot), unlocked, ARENA_PRESET_LOADOUTS[slot]),
    );
}

/** The kill streak picks, only with what's unlocked. */
async function streaksOf(userId: string, unlocked: Set<string>): Promise<ArenaStreakSettings> {
    const [row] = await db.select().from(arenaStreaksTable).where(eq(arenaStreaksTable.userId, userId));
    if (!row) return sanitizeArenaStreaks(undefined, unlocked);
    return sanitizeArenaStreaks({ ...row, off: (row.off ? row.off.split(",") : []) as ArenaStreakSettings["off"] }, unlocked);
}

/** The arena menu: level, kills, unlocks, loadouts, kill streak picks. */
export async function getArenaProfile(userId: string): Promise<ArenaProfileResponse> {
    const { xp, kills, unlocked } = await unlockedOf(userId);
    const { level, into, needed } = arenaLevelFromXp(xp);
    return {
        xp,
        level,
        into,
        needed,
        kills,
        unlocked: [...unlocked],
        loadouts: await loadoutsOf(userId, unlocked),
        streaks: await streaksOf(userId, unlocked),
    };
}

/** Saves the kill streak picks (locked ones fall back to the defaults). */
export async function saveArenaStreaks(userId: string, settings: ArenaStreakSettings): Promise<ArenaStreakSettings> {
    const { unlocked } = await unlockedOf(userId);
    const clean = sanitizeArenaStreaks(settings, unlocked);
    const { eagleEye: _derived, off, ...rest } = clean;
    const row = { ...rest, off: (off ?? []).join(",") };
    await db.insert(arenaStreaksTable).values({ userId, ...row }).onConflictDoUpdate({ target: arenaStreaksTable.userId, set: row });
    return clean;
}

/** The kill streak picks a player joins an arena game with (guests: the defaults). */
export async function getJoinArenaStreaks(userId: string | null): Promise<ArenaStreakSettings> {
    if (!userId) return ARENA_DEFAULT_STREAKS;
    const { unlocked } = await unlockedOf(userId);
    return streaksOf(userId, unlocked);
}

/** Saves a loadout slot (items that aren't unlocked fall back to the default's). */
export async function saveArenaLoadout(userId: string, slot: number, loadout: ArenaLoadout): Promise<ArenaLoadout> {
    const { unlocked } = await unlockedOf(userId);
    const clean = sanitizeArenaLoadout(loadout, unlocked, ARENA_PRESET_LOADOUTS[slot]);
    await db
        .insert(arenaLoadoutsTable)
        .values({ userId, slot, ...clean })
        .onConflictDoUpdate({ target: [arenaLoadoutsTable.userId, arenaLoadoutsTable.slot], set: clean });
    return clean;
}

/** The loadouts a player joins an arena game with (guests: the presets). */
export async function getJoinArenaLoadouts(userId: string | null): Promise<ArenaLoadout[]> {
    if (!userId) return ARENA_PRESET_LOADOUTS;
    const { unlocked } = await unlockedOf(userId);
    return loadoutsOf(userId, unlocked);
}

/** A finished game: arena XP and the kills per weapon that count for the challenges. */
export async function recordArenaResults(entries: Array<{ userId: string; xp: number; weaponKills: Record<string, number> }>) {
    for (const e of entries) {
        if (e.xp > 0) {
            await db
                .insert(arenaProgressTable)
                .values({ userId: e.userId, xp: e.xp })
                .onConflictDoUpdate({ target: arenaProgressTable.userId, set: { xp: sql`${arenaProgressTable.xp} + ${e.xp}` } });
        }
        const kills = Object.entries(e.weaponKills).filter(([, n]) => n > 0);
        if (kills.length) {
            await db
                .insert(arenaWeaponKillsTable)
                .values(kills.map(([weaponType, n]) => ({ userId: e.userId, weaponType, kills: n })))
                .onConflictDoUpdate({
                    target: [arenaWeaponKillsTable.userId, arenaWeaponKillsTable.weaponType],
                    set: { kills: sql`${arenaWeaponKillsTable.kills} + excluded.kills` },
                });
        }
    }
}
