import { Config } from "../../config.ts";
import type { Game } from "../game.ts";
import type { Group } from "../group.ts";
import type { Player } from "../objects/player.ts";
import { BotBrain } from "./botBrain.ts";
import type { BotDifficulty } from "./botDefs.ts";
import { buildNavGraph } from "./nav/navBuilder.ts";
import type { NavGraph } from "./nav/navGraph.ts";

/** Watchdog: per-tick bot pass cost, sampled over WATCHDOG_SAMPLES ticks... */
const WATCHDOG_SAMPLES = 100;
/** ...minus the worst few (a GC pause or a disk hiccup isn't the brains' fault) */
const WATCHDOG_DROP_WORST = 5;
/** above this (ms, trimmed average) the think rates are halved, once */
const SLOW_MS = 3;
/** above this the brains pause for PAUSE_MS and come back at half the think rate */
const OVERLOAD_MS = 8;
const PAUSE_MS = 10_000;
/** one pass this slow pauses them right away (a 13 s tick froze a comp game once -
 *  the brains aren't built for BR-scale maps yet) */
const EMERGENCY_MS = 250;
/** think rates never drop below this share of the tier's */
const MIN_THINK_RATE_SCALE = 0.125;

/**
 * Owns every server-side bot in one game: spawning, the per-tick brain pass and the
 * CPU budget for it.
 *
 * The whole subsystem is inert unless `Config.bots.enabled` - a normal match never
 * allocates anything here and never enters the tick body.
 */
export class BotBarn {
    readonly bots: Player[] = [];

    /** Rolling self-measurement, in ms, used by the overload watchdog. */
    private tickCosts: number[] = [];
    /** performance.now() until which the watchdog paused the brains (bots stay in
     *  the match, they just stop thinking for a moment) */
    private pausedUntil = 0;
    private warnedSlow = false;

    /** Built lazily on the first spawn, once, for the whole match - see
     *  `ensureNavGraph`. Undefined until then, and left undefined forever if the build
     *  itself throws (bots keep running on the M1 steering-only fallback rather than
     *  taking the game down over a nav bug). */
    navGraph?: NavGraph;
    private navBuildFailed = false;

    constructor(readonly game: Game) {}

    get enabled(): boolean {
        return Config.bots.enabled;
    }

    get count(): number {
        return this.bots.length;
    }

    /**
     * Spawn up to `count` bots. Returns the players actually created - fewer than
     * requested when `maxBotsPerGame` is hit. With `group` they join it (teammates of
     * whoever is in it), otherwise each gets its own.
     */
    spawn(count: number, difficulty: BotDifficulty, group?: Group): Player[] {
        if (!this.enabled) return [];

        this.ensureNavGraph();

        const room = Config.bots.maxBotsPerGame - this.bots.length;
        const toSpawn = Math.min(count, Math.max(room, 0));
        const spawned: Player[] = [];

        for (let i = 0; i < toSpawn; i++) {
            let player: Player;
            try {
                player = this.game.playerBarn.addBotPlayer({ difficulty, group });
            } catch (err) {
                this.game.logger.error("Failed to spawn bot", err);
                break;
            }
            player.botDifficulty = difficulty;
            player.botBrain = new BotBrain(player, difficulty, this);
            this.bots.push(player);
            spawned.push(player);
        }

        return spawned;
    }

    /** Builds the nav graph once per match, the moment it's first actually needed
     *  (i.e. the first bot spawn) - a game nobody ever puts a bot in never pays for
     *  one. One-shot, not incremental: fine at arena-map scale (this milestone's
     *  target); an incremental BR-scale builder is M5's job. */
    private ensureNavGraph(): void {
        if (this.navGraph || this.navBuildFailed) return;
        try {
            const started = performance.now();
            this.navGraph = buildNavGraph(this.game);
            const stats = this.navGraph.stats();
            this.game.logger.info(
                `Bot nav graph built in ${(performance.now() - started).toFixed(0)}ms `
                    + `(${stats.nodeCount} nodes, ${stats.edgeCount} edges)`,
            );
        } catch (err) {
            this.navBuildFailed = true;
            this.game.logger.error("Failed to build bot nav graph", err);
        }
    }

    update(dt: number): void {
        if (!this.enabled || !this.bots.length) return;

        const started = performance.now();
        const paused = started < this.pausedUntil;

        // Dead bots stay in the match - kill feed, dead bodies, loot drops and rank all
        // have to behave normally - but they stop being driven.
        for (let i = this.bots.length - 1; i >= 0; i--) {
            const bot = this.bots[i];
            if (bot.dead || !bot.botDifficulty) {
                bot.botBrain = undefined;
                this.bots.splice(i, 1);
                continue;
            }
            if (paused) continue;

            bot.botBrain?.update(dt);
        }

        if (!paused) this.sampleTickCost(performance.now() - started);
    }

    /**
     * Watchdog. One runaway subsystem has taken a server down before, so the bot pass
     * polices its own cost: when it's slow the brains think less often, when it's
     * overloaded they pause for a moment and come back thinking even less often -
     * rather than degrade the match for the humans in it. Judged on the trimmed
     * average, so a single stall (GC, disk) doesn't count.
     */
    private sampleTickCost(ms: number): void {
        this.tickCosts.push(ms);
        if (ms > EMERGENCY_MS) {
            this.tickCosts = [];
            this.pause(`one bot pass took ${ms.toFixed(0)}ms`);
            return;
        }
        if (this.tickCosts.length < WATCHDOG_SAMPLES) return;

        const sorted = this.tickCosts.sort((a, b) => a - b).slice(0, -WATCHDOG_DROP_WORST);
        this.tickCosts = [];
        const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;

        if (avg > OVERLOAD_MS) {
            this.pause(`${avg.toFixed(2)}ms/tick exceeds the ${OVERLOAD_MS}ms budget`);
        } else if (avg > SLOW_MS && !this.warnedSlow) {
            this.warnedSlow = true;
            this.thinkRateScale = Math.max(MIN_THINK_RATE_SCALE, this.thinkRateScale * 0.5);
            this.game.logger.warn(
                `Bot thinking is slow (${avg.toFixed(2)}ms/tick), halving think rates`,
            );
        }
    }

    private pause(why: string): void {
        this.pausedUntil = performance.now() + PAUSE_MS;
        // stand still instead of running / firing on the last inputs while paused
        for (const bot of this.bots) {
            bot.moveLeft = bot.moveRight = bot.moveUp = bot.moveDown = false;
            bot.shootStart = bot.shootHold = false;
        }
        this.thinkRateScale = Math.max(MIN_THINK_RATE_SCALE, this.thinkRateScale * 0.5);
        this.game.logger.error(
            `Bot brains paused for ${PAUSE_MS / 1000}s: ${why} (think rate now ${this.thinkRateScale * 100}%)`,
        );
    }

    /** Multiplier applied to every tier's `thinkHz`; lowered by the watchdog. Read
     *  directly by `BotBrain.update()`. */
    thinkRateScale = 1;
}
