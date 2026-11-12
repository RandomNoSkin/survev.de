/**
 * Domination (GameMode.Domination) settings - see server/src/game/modes/domination.ts.
 *
 * Two teams of up to 6, three zones A / B / C across the map. Standing in a zone with
 * only your team takes it: a neutral one in CAPTURE_S, an enemy one first back to
 * neutral (NEUTRALIZE_S) and then for you. Every zone a team holds gives it a point
 * every POINT_INTERVAL_S - not while enemies are in it. First to SCORE_LIMIT, else the higher score
 * when the clock runs out.
 */

/** Seconds to take a neutral zone / to bring an enemy zone back to neutral (one player). */
export const DOMINATION_CAPTURE_S = 5;
export const DOMINATION_NEUTRALIZE_S = 5;
/** The team size (a group of up to 6). */
export const DOMINATION_TEAM_SIZE = 6;
/** Two or more players of a team in a zone take it this much faster. */
export const DOMINATION_GROUP_SPEED = 1.5;

/** A held zone gives its team a point every POINT_INTERVAL_S (not while enemies are in it). */
export const DOMINATION_POINT_INTERVAL_S = 5;
/** Players of the holding team standing in its zone multiply its points: x(1 + players),
 *  at most x ZONE_MAX_MULTIPLIER. */
export const DOMINATION_ZONE_MAX_MULTIPLIER = 3;
export const DOMINATION_SCORE_LIMIT = 250;
export const DOMINATION_TIME_LIMIT_S = 900;

/** The zones, along the line between the two team sides (0 = team 1's edge, 1 = team 2's). */
export const DOMINATION_ZONES = [
    { name: "A", at: 0.22 },
    { name: "B", at: 0.5 },
    { name: "C", at: 0.78 },
];
export const DOMINATION_ZONE_RAD = 12;

/** Where a team spawns: this far (fraction of the map) from its own edge. */
export const DOMINATION_SPAWN_DEPTH = 0.14;
/** The match start: a team spawns in a tight bunch - within this of their side's spot. */
export const DOMINATION_START_CLUSTER_RAD = 6;

/** The map is made for this many players (6v6)... */
export const DOMINATION_BASE_PLAYERS = 12;
/** ...fewer at the match start shrink it (side length), at most down to this. */
export const DOMINATION_MAP_SCALE_MIN = 0.65;

/** Map scale (side length) for a Domination match with `players` - area grows with the players. */
export function dominationMapScale(players: number): number {
    const scale = Math.sqrt(Math.max(1, players) / DOMINATION_BASE_PLAYERS);
    return Math.round(Math.min(1, Math.max(DOMINATION_MAP_SCALE_MIN, scale)) * 100) / 100;
}

/** Dead for this long - time to pick another loadout. */
export const DOMINATION_RESPAWN_DELAY_S = 10;
/** The loadout menu holds a player out of the game at most this long (joining, or opened while dead). */
export const DOMINATION_MENU_MAX_S = 30;
/** Respawns keep at least this far from enemies when the map allows it. */
export const DOMINATION_SPAWN_SAFE_DIST = 45;
/** A zone without hard cover this close gets some (indestructible stones). */
/** Hard cover in a zone: around its middle in this many directions (sectors)... */
export const DOMINATION_COVER_SECTORS = 6;
/** ...at least this many of them with a piece inside the zone - the missing ones get one. */
export const DOMINATION_COVER_MIN = 5;
/** Destructible cover this tough counts as hard cover too (sandbags: 2500). */
export const DOMINATION_HARD_COVER_HEALTH = 1000;
/** A loadout picked this soon after spawning (nothing fired, no damage taken) is given right away. */
export const DOMINATION_LOADOUT_SWAP_S = 15;
export const DOMINATION_SPAWN_PROTECTION_S = 2;
/** Warmup: public games start with this many players (a private lobby: its own players). */
export const DOMINATION_MIN_PLAYERS = 6;
export const DOMINATION_COUNTDOWN_S = 10;
/** The countdown before the match by player count: at least `players` → `seconds`. */
export const DOMINATION_COUNTDOWNS: Array<{ players: number; seconds: number }> = [
    { players: 12, seconds: 10 },
    { players: 8, seconds: 20 },
    { players: 4, seconds: 30 },
    { players: 0, seconds: 50 },
];
/** No extra cut for a full game - DOMINATION_COUNTDOWNS decides (a full 2-player lobby: 50 s). */
export const DOMINATION_FULL_COUNTDOWN_S = Number.POSITIVE_INFINITY;
export const DOMINATION_PRIVATE_WAIT_S = 20;
/** A whole team gone this long (a reload is back in a few seconds): the other team wins. */
export const DOMINATION_ABANDON_S = 20;

/** Damage dealt to a victim in the last seconds before the kill that makes an assist. */
export const DOMINATION_ASSIST_WINDOW_S = 10;
export const DOMINATION_ASSIST_MIN_DAMAGE = 25;
