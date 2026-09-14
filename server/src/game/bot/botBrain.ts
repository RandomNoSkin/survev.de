import { GameConfig } from "../../../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { GameObject } from "../objects/gameObject.ts";
import type { Player } from "../objects/player.ts";
import { BotAimState, updateAim } from "./botAim.ts";
import type { BotBarn } from "./botBarn.ts";
import {
    BotFireState,
    pickHealItem,
    shouldHeal,
    updateFiring,
    updateHeal,
    updateReload,
    updateWeaponSelection,
} from "./botCombat.ts";
import { BOT_TIERS, type BotDifficulty, type BotTierDef } from "./botDefs.ts";
import { BotMovementState, type CombatDirective, isSafeToHeal, updateMovement } from "./botMovement.ts";
import { findVisibleTarget } from "./botPerception.ts";

export type BotState = "idle" | "engage";

/** Recent landed hits (see `updateMomentum`) needed to switch to `push` - "winning the
 *  trade enough to press the advantage", not any single lucky shot. */
const PUSH_HIT_THRESHOLD = 2;
/** Momentum points lost per second - a burst of hits keeps `push` alive for a few
 *  seconds after the last one connects, not just the instant tick it landed. */
const PUSH_MOMENTUM_DECAY = 1 / 3;
/** Taking a hit this recently while mid-heal means the enemy clearly still has a shot -
 *  finishing the bandage anyway is how a bot dies at full heal-bar-in-progress. This is
 *  deliberately the *only* abort trigger - see the doc comment on the abort check
 *  itself for why a proximity-based one was removed. */
const ABORT_HEAL_REACT_MS = 350;
/** After an abort, don't immediately re-start the same heal - open some distance
 *  first, which is exactly what `flee` (see `pickDirective`) is for. */
const HEAL_ABORT_COOLDOWN_S = 1.2;
/** Fraction of `tier.healThreshold` counted as "critical" - too hurt to just hold and
 *  trade; only worth fighting on from here if there's truly no way to disengage. */
const PANIC_HEALTH_FRAC_MULT = 0.5;

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

    /** Where an enemy was last actually seen, and when - lets combat decisions (cover,
     *  push, flee, heal) keep reacting to a threat for a short while after it ducks out
     *  of sight, instead of collapsing back to idle the instant LOS breaks (which would
     *  make hiding behind cover pointless - see `updateMovement`'s `engageHold`). */
    private lastKnownEnemyPos?: Vec2;
    private lastKnownEnemyTimeMs = 0;

    /** Decaying count of recently landed hits - see `updateMomentum`. Drives the
     *  `push` directive: land enough shots and the bot presses the advantage instead
     *  of holding its current range. */
    private pushMomentum = 0;
    private lastBulletHits: number;

    /** Wall-clock ms (`game.now`) this bot last took damage - see `onDamaged` and the
     *  heal-abort check in `update()`. */
    private lastHitTakenTime = -Infinity;
    /** Set for a short window after an aborted heal, so the bot doesn't immediately
     *  re-start the exact bandage that just got interrupted - see `pickDirective`. */
    private healAbortCooldown = 0;

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
        this.lastBulletHits = player.bulletHits;
        // Stagger: bots must not all think on the same tick.
        this.thinkTimer = Math.random() / this.tier.thinkHz;
    }

    /** Hooked from `Player.damage()` for any damage this bot takes, from any source. */
    onDamaged(_source: GameObject, _attacker?: Player): void {
        this.lastHitTakenTime = this.player.game.now;
    }

    update(dt: number): void {
        const bot = this.player;
        if (bot.dead || bot.downed) return;

        this.thinkTimer -= dt;
        if (this.thinkTimer <= 0) {
            this.thinkTimer += 1 / (this.tier.thinkHz * this.barn.thinkRateScale);
            this.think();
        }

        this.updateMomentum(dt);
        this.healAbortCooldown = Math.max(0, this.healAbortCooldown - dt);

        // `dist`/`this.target` below stay tied to the *currently visible* target only -
        // aim and fire must never act on a remembered position. `threatPos`/`engageDist`
        // are the broader "am I in a fight" read movement and heal/push/flee decisions
        // use instead, which tolerates a target that's ducked behind cover a moment ago.
        const dist = this.target ? v2.distance(bot.pos, this.target.pos) : Infinity;
        const threatPos = this.threatPos();
        const engageDist = threatPos ? v2.distance(bot.pos, threatPos) : Infinity;

        // Abort an in-progress heal the instant an actual enemy action makes finishing
        // the bandage the wrong call - concretely, taking a hit mid-heal, which means
        // the enemy clearly still has a shot. `cancelAction` is exactly what a weapon
        // switch already does to an in-progress heal (see `updateWeaponSelection`'s doc
        // comment) - this just triggers it from a combat read instead of an incidental
        // gun swap, so the bot can shoot back or run instead of finishing a bandage
        // into a losing fight.
        //
        // Deliberately *not* also a proximity check ("enemy within N units"): a heal
        // only ever starts once `isSafeToHeal` has already confirmed real separation
        // (or cover) exists, so plain distance alone right after that shouldn't flip
        // back to "unsafe" on its own - and while it could still drift closer between
        // recomputes, that's `pickRangeMode`'s job to correct once the heal ends, not a
        // reason to cancel a heal nothing has actually threatened yet. A bot bailing out
        // of every heal it starts, without ever having been shot at, is worse than
        // occasionally finishing one a beat later than a human would.
        if (bot.actionType === GameConfig.Action.UseItem) {
            const justHit = bot.game.now - this.lastHitTakenTime < ABORT_HEAL_REACT_MS;
            if (justHit) {
                bot.cancelAction();
                this.healAbortCooldown = HEAL_ABORT_COOLDOWN_S;
            }
        }

        const directive = this.pickDirective(bot, threatPos);

        updateMovement(bot, this.movement, directive, threatPos, engageDist, dt, this.barn.navGraph);

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

        // Not just `directive === "heal"`: that flips true the instant `shouldHeal`
        // does, before the retreat it kicks off in `updateMovement` above has actually
        // gone anywhere. Consuming the item immediately regardless was the other half
        // of the "starts a heal and cancels it right away" bug - `isSafeToHeal` gates
        // the actual item-use on having reached cover or opened real distance first.
        // Once healing is under way this is a no-op every tick anyway (`shouldHeal`
        // itself returns false while `actionType !== None`), so it only matters for the
        // very first tick.
        if (directive === "heal" && isSafeToHeal(bot, this.movement, engageDist)) {
            updateHeal(bot, this.tier, !!this.target);
        }
    }

    /** Tracks recently landed hits for the `push` directive. `bulletHits` is a
     *  monotonically increasing per-match counter (`Player.damage()`), so a rising edge
     *  here means a shot connected since last tick - decayed continuously rather than
     *  reset per-window so a burst of hits keeps `push` alive for a few seconds after
     *  the last one lands instead of cutting off at an arbitrary window boundary. */
    private updateMomentum(dt: number): void {
        // Decay before adding, not after: a fresh hit must count at its full value the
        // tick it lands (`pushMomentum += 1` reaching exactly `PUSH_HIT_THRESHOLD`
        // should already qualify as "pushing" that same tick), not the same tick's
        // decay already having nibbled it just under the threshold.
        this.pushMomentum = Math.max(0, this.pushMomentum - dt * PUSH_MOMENTUM_DECAY);
        const hits = this.player.bulletHits;
        if (hits > this.lastBulletHits) this.pushMomentum += hits - this.lastBulletHits;
        this.lastBulletHits = hits;
    }

    /**
     * The single combat decision every other system (movement, healing) reacts to this
     * tick. Priority, high to low:
     * 1. No target and no recent memory of one - nothing to react to.
     * 2. Already mid-heal - see through the bandage (interrupting it is `update()`'s
     *    `cancelAction` job above, not a directive switch on its own; without this,
     *    `shouldHeal` degenerately returns false the instant `actionType` becomes
     *    `UseItem`, which would otherwise make the bot abandon cover mid-bandage the
     *    moment health ticks back over the threshold).
     * 3. Critically hurt with no way to heal right now (no item, or just interrupted
     *    and still cooling down) - disengage instead of trading.
     * 4. Hurt enough to want to heal - retreats toward cover/distance immediately, but
     *    doesn't actually consume the item until `isSafeToHeal` (in `update()`) says
     *    the retreat has actually gone somewhere.
     * 5. Recently landed enough hits to be winning the exchange - press it.
     * 6. Default: hold a sane range, using cover once there instead of standing still.
     */
    private pickDirective(bot: Player, threatPos: Vec2 | undefined): CombatDirective {
        if (!threatPos) return "idle";
        if (bot.actionType === GameConfig.Action.UseItem) return "heal";

        const healthFrac = bot.health / GameConfig.player.health;
        const critical = healthFrac < this.tier.healThreshold * PANIC_HEALTH_FRAC_MULT;
        const noHealItem = pickHealItem(bot, healthFrac) === undefined;
        if (critical && (noHealItem || this.healAbortCooldown > 0)) return "flee";

        if (shouldHeal(bot, this.tier, !!this.target)) return "heal";
        if (this.pushMomentum >= PUSH_HIT_THRESHOLD) return "push";

        return "engageHold";
    }

    /** Engagement position for everything downstream of perception: the target itself
     *  if still visible, else wherever it was last seen, as long as that memory hasn't
     *  gone stale. */
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
