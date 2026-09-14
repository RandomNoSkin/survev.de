import { GameConfig } from "../../../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { GameObject } from "../objects/gameObject.ts";
import type { Player } from "../objects/player.ts";
import { BotAimState, updateAim } from "./botAim.ts";
import type { BotBarn } from "./botBarn.ts";
import {
    BotFireState,
    shouldHeal,
    updateFiring,
    updateHeal,
    updateReload,
    updateWeaponSelection,
} from "./botCombat.ts";
import { BOT_TIERS, type BotDifficulty, type BotTierDef } from "./botDefs.ts";
import { BotMovementState, updateMovement } from "./botMovement.ts";
import { findVisibleTarget } from "./botPerception.ts";

export type BotState = "idle" | "engage";

/**
 * Drives one bot. Perception (`think`) is throttled to `tier.thinkHz` - the expensive
 * part, a grid query plus up to 4 raycasts - while movement, aim and firing run every
 * game tick so motion stays smooth between thinks, exactly like a human whose last
 * InputMsg keeps applying between two network ticks.
 */
export class BotBrain {
    readonly tier: BotTierDef;

    state: BotState = "idle";
    target?: Player;

    /** Where an enemy was last actually seen, and when - the closest thing to a memory
     *  this bot has until Phase 2's threat tracking. Used only to give healing a
     *  direction to retreat toward when the enemy isn't currently visible. */
    private lastKnownEnemyPos?: Vec2;
    private lastKnownEnemyTimeMs = 0;

    /** Committed "I'm backing off to heal" state - see the hysteresis note in
     *  `update()`. Without it, health hovering right at `tier.healThreshold` during an
     *  ongoing trade flips the retreat decision every tick, which looks like the bot
     *  vibrating between advancing and backing away instead of doing either. */
    private retreating = false;

    private thinkTimer: number;
    private readonly aim = new BotAimState();
    private readonly fire = new BotFireState();
    private readonly movement = new BotMovementState();

    constructor(
        readonly player: Player,
        readonly difficulty: BotDifficulty,
        private readonly barn: BotBarn,
    ) {
        this.tier = BOT_TIERS[difficulty];
        this.aim.dir = v2.copy(player.dir);
        // Stagger: bots must not all think on the same tick.
        this.thinkTimer = Math.random() / this.tier.thinkHz;
    }

    /** Hooked from `Player.damage()`. Currently informational - Phase 2 (`botSquad`)
     *  is where a threat direction feeds squad-wide alerting; for a 1v1 duel the next
     *  `think()` already re-scans and finds whoever just shot the bot. */
    onDamaged(_source: GameObject, _attacker?: Player): void {}

    update(dt: number): void {
        const bot = this.player;
        if (bot.dead || bot.downed) return;

        this.thinkTimer -= dt;
        if (this.thinkTimer <= 0) {
            this.thinkTimer += 1 / (this.tier.thinkHz * this.barn.thinkRateScale);
            this.think();
        }

        const dist = this.target ? v2.distance(bot.pos, this.target.pos) : Infinity;

        // Decided before movement, not after: a bot that's about to bandage itself
        // must not spend that same tick closing distance into the fight it's trying to
        // sit out. Real cover-seeking (ducking behind a specific obstacle) needs the
        // nav graph and is M3's job; retreating from the last-known threat is the
        // cheap approximation available without one.
        //
        // Committed with hysteresis (start on `shouldHeal`, stop only once meaningfully
        // healthier than the threshold, not the instant it's crossed) - see `retreating`.
        if (shouldHeal(bot, this.tier, !!this.target)) {
            this.retreating = true;
        } else if (bot.health / GameConfig.player.health >= this.tier.healThreshold + 0.15) {
            this.retreating = false;
        }
        const retreatFrom = this.retreating ? this.threatPos() : undefined;

        updateMovement(bot, this.movement, this.target, dist, dt, retreatFrom, this.barn.navGraph);

        const aimResult = updateAim(bot, this.aim, this.tier, this.target, dt);

        // Weapon selection before reload, not after: switching resets `scheduledReload`
        // (see `setCurWeapIndex`), so requesting a reload first would just get wiped
        // out the moment selection decides to switch guns on the very same tick.
        //
        // Unconditional, not gated on having a target: a bot must equip a gun the
        // moment it has one (spawn, or a first pickup) rather than only once it
        // happens to spot an enemy - see the melee-stuck case in
        // `updateWeaponSelection`. It also no-ops entirely while mid-action (healing,
        // reviving, ...), since switching would otherwise cancel that action.
        updateWeaponSelection(bot, this.tier, this.fire, dist);
        updateReload(bot);
        updateFiring(bot, this.tier, this.fire, this.target, dist, aimResult.canFire, dt);

        updateHeal(bot, this.tier, !!this.target);
    }

    /** Enemy position to retreat from while healing: the target itself if still
     *  visible (only reachable when critically low, see `shouldHeal`), else wherever
     *  it was last seen, as long as that memory hasn't gone stale. */
    private threatPos(): Vec2 | undefined {
        if (this.target) return this.target.pos;
        if (!this.lastKnownEnemyPos) return undefined;
        const ageMs = this.player.game.now - this.lastKnownEnemyTimeMs;
        return ageMs <= this.tier.memory * 1000 ? this.lastKnownEnemyPos : undefined;
    }

    private think(): void {
        this.target = findVisibleTarget(this.player);
        this.state = this.target ? "engage" : "idle";
        if (this.target) {
            this.lastKnownEnemyPos = v2.copy(this.target.pos);
            this.lastKnownEnemyTimeMs = this.player.game.now;
        }
    }
}
