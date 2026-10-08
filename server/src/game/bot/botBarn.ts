import { Config } from "../../config.ts";
import type { Game } from "../game.ts";
import type { Player } from "../objects/player.ts";
import { BotBrain } from "./botBrain.ts";
import type { BotDifficulty } from "./botDefs.ts";
import { buildNavGraph } from "./nav/navBuilder.ts";
import type { NavGraph } from "./nav/navGraph.ts";

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
    private tickCostSum = 0;
    private tickCostSamples = 0;
    /** Set once the watchdog gives up, so bots stop thinking but stay in the match. */
    private disabled = false;
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
     * requested when `maxBotsPerGame` is hit.
     */
    spawn(count: number, difficulty: BotDifficulty): Player[] {
        if (!this.enabled) return [];

        this.ensureNavGraph();

        const room = Config.bots.maxBotsPerGame - this.bots.length;
        const toSpawn = Math.min(count, Math.max(room, 0));
        const spawned: Player[] = [];

        for (let i = 0; i < toSpawn; i++) {
            let player: Player;
            try {
                player = this.game.playerBarn.addBotPlayer({ difficulty });
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

        // Dead bots stay in the match - kill feed, dead bodies, loot drops and rank all
        // have to behave normally - but they stop being driven.
        for (let i = this.bots.length - 1; i >= 0; i--) {
            const bot = this.bots[i];
            if (bot.dead || !bot.botDifficulty) {
                bot.botBrain = undefined;
                this.bots.splice(i, 1);
                continue;
            }
            if (this.disabled) continue;

            bot.botBrain?.update(dt);
        }

        this.sampleTickCost(performance.now() - started);
    }

    /**
     * Watchdog. Production runs on a 2-core box where one runaway subsystem has taken
     * the server down before, so the bot pass polices its own cost: first it slows the
     * brains down, then it switches them off entirely rather than degrade the match for
     * the humans in it.
     */
    private sampleTickCost(ms: number): void {
        this.tickCostSum += ms;
        if (++this.tickCostSamples < 100) return;

        const avg = this.tickCostSum / this.tickCostSamples;
        this.tickCostSum = 0;
        this.tickCostSamples = 0;

        if (avg > 4) {
            this.disabled = true;
            for (const bot of this.bots) bot.botBrain = undefined;
            this.game.logger.error(
                `Bot brains disabled: ${avg.toFixed(2)}ms/tick average exceeds the 4ms budget`,
            );
        } else if (avg > 1.5 && !this.warnedSlow) {
            this.warnedSlow = true;
            this.game.logger.warn(
                `Bot thinking is slow (${avg.toFixed(2)}ms/tick), halving think rates`,
            );
            this.thinkRateScale *= 0.5;
        }
    }

    /** Multiplier applied to every tier's `thinkHz`; lowered by the watchdog. Read
     *  directly by `BotBrain.update()`. */
    thinkRateScale = 1;
}
