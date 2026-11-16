/**
 * Static data for the server-side bot system: difficulty tiers and the display-name
 * pool. Deliberately free of any runtime import from the game modules so it can be
 * pulled into `player.ts` (for `BotDifficulty`) without creating an import cycle.
 */

export type BotDifficulty = "easy" | "normal" | "hard" | "expert";

export const BOT_DIFFICULTIES: readonly BotDifficulty[] = [
    "easy",
    "normal",
    "hard",
    "expert",
] as const;

export function parseBotDifficulty(value: string | undefined): BotDifficulty | undefined {
    if (!value) return undefined;
    const lower = value.toLowerCase();
    return BOT_DIFFICULTIES.find((d) => d === lower);
}

export interface BotTierDef {
    /** Seconds between acquiring a target and being allowed to fire. */
    reaction: number;
    /** Standard deviation of the slowly drifting aim bias, in degrees. */
    aimErrorDeg: number;
    /** Max turn speed in rad/s. `Player.dir` has no turn limit of its own, so without
     *  this bots snap-aim, which reads as an aimbot instantly. */
    turnRate: number;
    /** Max angle between aim and target before the bot is allowed to fire, in degrees. */
    fireConeDeg: number;
    /** 0 = no target leading, 1 = perfect lead for the bullet's travel time. */
    leadFactor: number;
    /** Brain think rate in Hz. `act()` still runs every tick. */
    thinkHz: number;
    /** Seconds a lost target's last known position stays interesting. */
    memory: number;
    /** Heal below this fraction of max health, when it is safe to do so. */
    healThreshold: number;
    /** Whether the bot uses the weapon-switch damage/slowdown tech. */
    quickswitch: boolean;
    /** Seconds of sustained fire before pausing, for automatic weapons. */
    burstMin: number;
    burstMax: number;
    /** 0-1: how decisively the bot moves and repositions - everything aim already scales
     *  by tier (`reaction`/`aimErrorDeg`/...), but movement itself didn't scale at all
     *  before this, so an "expert" bot held cover, peeked and juked exactly like an
     *  "easy" one and only out-aimed it. Higher scales peeking faster/more often (see
     *  `PEEK_HOLD_MIN/MAX`), re-checking cover against a moving enemy more often (see
     *  `COVER_RECOMPUTE_INTERVAL`), and strafing with sharper, more frequent feints (see
     *  `rollStrafeCycle`) - a more skilled bot should look more alive, not just hit
     *  harder. */
    aggression: number;
}

/**
 * `expert` is deliberately not perfect - 0.1s reaction and 1.4 degrees of error is
 * still a very strong human, not a flawless aimbot. `aggression` for `expert` is
 * intentionally pushed past 1 - `peekPaceMult`/`coverRecomputeMult`/`feintChanceFor`/
 * `retreatRecomputeMult` (see `botMovement.ts`) are plain, unclamped linear
 * interpolations, so this extrapolates *past* their originally tuned ceiling instead of
 * just hitting it - "der Bot muss einfach schneller sein" across peeking, re-covering,
 * pushing and fleeing, in response to real playtesting still reading `expert` as
 * noticeably slower to react and reposition than a genuinely strong human opponent.
 */
export const BOT_TIERS: Record<BotDifficulty, BotTierDef> = {
    easy: {
        reaction: 0.75,
        aimErrorDeg: 14,
        turnRate: 5,
        fireConeDeg: 14,
        leadFactor: 0.15,
        thinkHz: 8,
        memory: 2,
        healThreshold: 0.35,
        quickswitch: false,
        burstMin: 0.2,
        burstMax: 0.5,
        aggression: 0.2,
    },
    normal: {
        reaction: 0.45,
        aimErrorDeg: 8,
        turnRate: 8,
        fireConeDeg: 9,
        leadFactor: 0.45,
        thinkHz: 12,
        memory: 3.5,
        healThreshold: 0.5,
        quickswitch: false,
        burstMin: 0.3,
        burstMax: 0.7,
        aggression: 0.45,
    },
    hard: {
        reaction: 0.28,
        aimErrorDeg: 4.5,
        turnRate: 11,
        fireConeDeg: 6,
        leadFactor: 0.75,
        thinkHz: 15,
        memory: 5,
        healThreshold: 0.65,
        quickswitch: true,
        burstMin: 0.35,
        burstMax: 0.9,
        aggression: 0.7,
    },
    expert: {
        reaction: 0.1,
        aimErrorDeg: 1.4,
        turnRate: 20,
        fireConeDeg: 4,
        leadFactor: 0.97,
        thinkHz: 28,
        memory: 6,
        healThreshold: 0.75,
        quickswitch: true,
        burstMin: 0.45,
        burstMax: 1,
        aggression: 1.4,
    },
};

/** Default display names. Bots also carry a `[BOT]` role tag, so these need not be
 *  self-describing - they only have to be recognizable and not collide with real ones. */
export const DEFAULT_BOT_NAMES: string[] = [
    "Bot Alpha",
    "Bot Bravo",
    "Bot Charlie",
    "Bot Delta",
    "Bot Echo",
    "Bot Foxtrot",
    "Bot Golf",
    "Bot Hotel",
];
