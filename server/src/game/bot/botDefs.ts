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
}

/**
 * `expert` is deliberately not perfect - 0.18s reaction and 2.5 degrees of error is
 * roughly a strong human. A flawless tier would only be frustrating to play against.
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
    },
    expert: {
        reaction: 0.18,
        aimErrorDeg: 2.5,
        turnRate: 14,
        fireConeDeg: 4,
        leadFactor: 0.92,
        thinkHz: 20,
        memory: 6,
        healThreshold: 0.75,
        quickswitch: true,
        burstMin: 0.45,
        burstMax: 1,
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
