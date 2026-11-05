/**
 * Gun Game (GameMode.GunGame) settings - see server/src/game/modes/gunGame.ts.
 *
 * Every match draws its own ladder: LADDER_SHAPE says how many guns of which
 * categories, in that order, are picked at random from the pool; the last step is
 * always the melee weapon below, and a kill with it on that step wins.
 */
import type { GunCategory } from "./gunCategories";

/** 19 guns + the melee = 20 steps. A step with several categories draws from all of
 *  them (there are only a handful of SMGs); no gun appears twice in a ladder. */
export const GUN_GAME_LADDER_SHAPE: Array<{ categories: GunCategory[]; count: number }> = [
    { categories: ["pistol"], count: 4 },
    // only a handful of SMGs: the SMG steps fill up with rifles
    { categories: ["smg", "rifle"], count: 4 },
    { categories: ["shotgun"], count: 3 },
    { categories: ["rifle"], count: 5 },
    { categories: ["sniper"], count: 3 },
];

/** Ladders only use guns players can find on this map (its loot tables)... */
export const GUN_GAME_POOL_MAP = "comp";
/** ...not counting these catch-all tables: safes hold nearly everything, the
 *  scavenger perk and the playtest table aren't map loot. */
export const GUN_GAME_IGNORED_LOOT_TIERS = ["tier_safe", "tier_scavenger_adv", "tier_playtest"];
/** Never drawn, even when found there (launchers / flares are always left out). m1911
 *  and glock only as duals; m93r only as dual (not as an SMG). */
export const GUN_GAME_EXCLUDED_GUNS = [
    "m134",
    "m1911",
    "glock",
    "ot38",
    "ot38_dual",
    "m93r",
    "ump9",
    "special_shotgun",
];

/** The final step, and the melee every player carries the whole match. */
export const GUN_GAME_MELEE = "karambit";

/** What everyone wears and carries the whole match (given again on every respawn).
 *  Level 2 helmet + level 1 vest: ~175 effective HP (level 3 / 3 was ~270 - too tanky). */
export const GUN_GAME_GEAR = {
    helmet: "helmet02",
    chest: "chest01",
    scopes: ["1xscope", "2xscope", "4xscope"],
};

/** The Gun Game map is sized for this many players (its maxPlayers)... */
export const GUN_GAME_BASE_PLAYERS = 10;
/** ...and a lobby with a higher / lower player limit scales it so every player keeps
 *  the same room - within these bounds (1.8 = about comp's size). */
export const GUN_GAME_MAP_SCALE_MIN = 0.8;
export const GUN_GAME_MAP_SCALE_MAX = 1.8;

/** Map scale (side length) for a Gun Game with `players` - area grows with the players. */
export function gunGameMapScale(players: number): number {
    const scale = Math.sqrt(Math.max(1, players) / GUN_GAME_BASE_PLAYERS);
    return Math.round(Math.min(GUN_GAME_MAP_SCALE_MAX, Math.max(GUN_GAME_MAP_SCALE_MIN, scale)) * 100) / 100;
}

/** Seconds a killed player is gone before respawning. */
export const GUN_GAME_RESPAWN_DELAY_S = 2;
/** Seconds after a respawn a player can't take damage. */
export const GUN_GAME_SPAWN_PROTECTION_S = 2;
/** Match length; when it runs out the highest level wins. */
export const GUN_GAME_TIME_LIMIT_S = 600;
