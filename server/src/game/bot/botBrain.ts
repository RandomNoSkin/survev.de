import { GameConfig, WeaponSlot } from "../../../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { GameObject } from "../objects/gameObject.ts";
import type { Player } from "../objects/player.ts";
import { BotAimState, updateAim } from "./botAim.ts";
import type { BotBarn } from "./botBarn.ts";
import {
    BotFireState,
    BotThrowState,
    pickHealItem,
    shouldHeal,
    updateFiring,
    updateHeal,
    updateReload,
    updateThrowable,
    updateWeaponSelection,
} from "./botCombat.ts";
import { BOT_TIERS, type BotDifficulty, type BotTierDef } from "./botDefs.ts";
import { BotMovementState, type CombatDirective, isSafeToHeal, updateMovement } from "./botMovement.ts";
import { findGrenadeThreat, findVisibleTarget } from "./botPerception.ts";

export type BotState = "idle" | "engage";

/** Taking a hit this recently while mid-heal means the enemy clearly still has a shot -
 *  finishing the bandage anyway is how a bot dies at full heal-bar-in-progress. This is
 *  deliberately the only *hit-based* abort trigger (a live grenade nearby also aborts,
 *  see the abort check itself) - see that same comment for why an enemy-proximity one
 *  was removed. */
const ABORT_HEAL_REACT_MS = 350;
/** After an abort, don't immediately re-start the same heal - open some distance
 *  first, which is exactly what `flee` (see `pickDirective`) is for. */
const HEAL_ABORT_COOLDOWN_S = 1.2;
/** Being out of ammo is only worth retreating over if actually under fire this
 *  recently - see `needsReload`. Reloading in place is fine when nothing is shooting
 *  at you (or the fight isn't even live, e.g. the enemy is out of sight); retreating
 *  unconditionally every time a magazine empties, "makes sense" or not, is a bigger
 *  tempo loss over a whole match than the risk it's meant to avoid. */
const RELOAD_RETREAT_DANGER_MS = 2000;
/** Fraction of `tier.healThreshold` counted as "critical" - too hurt to just hold and
 *  trade; only worth fighting on from here if there's truly no way to disengage. */
const PANIC_HEALTH_FRAC_MULT = 0.5;
/** Fraction of `tier.healThreshold` counted as "low" - worth being cautious about even
 *  before it's "critical". Sits between `PANIC_HEALTH_FRAC_MULT` and 1.0 (the point
 *  `shouldHeal` itself wants to start healing): with a heal item this band is normally
 *  invisible, since `shouldHeal` already fires first and starts a retreat-to-heal - it
 *  only matters when there's *no* item to fix the problem with, where the bot would
 *  otherwise just keep fighting (or even push) at real risk because it technically
 *  isn't "critical" yet. That's the "attacks when it should retreat" bug: being low
 *  without a bandage is still a reason to disengage, not just being nearly dead. */
const LOW_HEALTH_FRAC_MULT = 0.75;
/** How hurt the *target* has to be, as a fraction of max health, before `push` is
 *  willing to charge across open ground for it - see `pickDirective`. Pushing into a
 *  still-healthy enemy in the open is exactly the "dumb push" complaint: landing a
 *  handful of hits doesn't mean the fight is actually won yet, and charging a target
 *  that can still fight back just because *this bot* is on a hit streak is how a bot
 *  that's ahead trades itself away. Without a currently visible target to read health
 *  from, `push` never has enough information to justify it either. */
const ENEMY_LOW_HEALTH_FRAC = 0.4;
/** How recently the target has to have actually been visible to count as "just ducked
 *  out of sight" rather than "genuinely lost track of them" - see `updateMovement`'s
 *  `recentlyVisible` and the eager re-peek it triggers. Comfortably past a peek's own
 *  exposure window (0.5-1s) so this stays true through the entire gap a bot's own
 *  peek/hide cycle produces. */
const RECENTLY_VISIBLE_MS = 1200;
/** How long the enemy has to have been genuinely out of sight - not just this exact
 *  tick's momentary LOS break, a real sustained gap - before that alone counts as safe
 *  enough to start healing, regardless of raw distance (see `isSafeToHeal`). Without
 *  this, an equally-fast pursuer that never lets `engageDist` reach `SAFE_HEAL_DIST`
 *  (a straight chase never widens the gap on its own) permanently denies healing even
 *  after the bot has legitimately broken line of sight - which reads as "just keeps
 *  retreating and never actually heals". Deliberately longer than `RECENTLY_VISIBLE_MS`
 *  (tuned for a completely different job, re-peeking sooner): this needs real confidence
 *  the fight has actually paused, not just the ordinary gap a peek/hide cycle produces. */
const SUSTAINED_LOST_MS = 2500;

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

    /** Wall-clock ms (`game.now`) this bot last took damage - see `onDamaged` and the
     *  heal-abort check in `update()`. */
    private lastHitTakenTime = -Infinity;
    /** Set for a short window after an aborted heal, so the bot doesn't immediately
     *  re-start the exact bandage that just got interrupted - see `pickDirective`. */
    private healAbortCooldown = 0;

    private thinkTimer: number;
    private readonly aim = new BotAimState();
    private readonly fire = new BotFireState();
    private readonly throwState = new BotThrowState();
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

        this.healAbortCooldown = Math.max(0, this.healAbortCooldown - dt);

        // `dist`/`this.target` below stay tied to the *currently visible* target only -
        // aim and fire must never act on a remembered position. `threatPos`/`engageDist`
        // are the broader "am I in a fight" read movement and heal/push/flee decisions
        // use instead, which tolerates a target that's ducked behind cover a moment ago.
        const dist = this.target ? v2.distance(bot.pos, this.target.pos) : Infinity;
        const threatPos = this.threatPos();
        const engageDist = threatPos ? v2.distance(bot.pos, threatPos) : Infinity;

        // A live grenade nearby is worth reacting to at every step this tick, computed
        // once up front: it aborts an in-progress heal below exactly like taking a hit
        // does, and separately overrides whatever movement the directive ends up
        // picking, further down past `updateMovement`.
        const grenadeThreat = findGrenadeThreat(bot);

        // Abort an in-progress heal the instant an actual enemy action makes finishing
        // the bandage the wrong call - concretely, taking a hit mid-heal (which means
        // the enemy clearly still has a shot) or a live grenade landing nearby.
        // `cancelAction` is exactly what a weapon switch already does to an in-progress
        // heal (see `updateWeaponSelection`'s doc comment) - this just triggers it from
        // a combat read instead of an incidental gun swap, so the bot can shoot back or
        // run instead of finishing a bandage into a losing fight. This has to run
        // *before* `pickDirective`, not just after `updateMovement` alongside the
        // movement override below: `pickDirective`'s result is what the final
        // heal-retrigger check (`directive === "heal"` below) still acts on, so
        // cancelling only after it's already been computed as "heal" would just have
        // that check immediately restart the exact bandage this cancels.
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
            if (justHit || grenadeThreat) {
                bot.cancelAction();
                this.healAbortCooldown = HEAL_ABORT_COOLDOWN_S;
            }
        }

        const directive = this.pickDirective(bot, threatPos);

        // Not visible *right now*, but was a moment ago - almost always means the enemy
        // just ducked back behind their own cover, not that the bot genuinely lost
        // track of them. Feeds `engageHold`'s peek cycle so it checks again sooner
        // instead of waiting out a full "haven't seen them in a while" hiding window.
        const recentlyVisible = !this.target
            && bot.game.now - this.lastKnownEnemyTimeMs < RECENTLY_VISIBLE_MS;

        updateMovement(
            bot,
            this.movement,
            directive,
            threatPos,
            engageDist,
            dt,
            this.barn.navGraph,
            recentlyVisible,
            this.tier,
        );

        // A live grenade landing nearby overrides whatever movement the directive above
        // just picked, combat or not. Deliberately a flat override rather than folding
        // it into `pickDirective`/`updateMovement`'s own state: it's a one-or-two-tick
        // "get away from this exact spot" reaction, not a sustained retreat that needs
        // cover-seeking or a cached nav goal - simple and immediate beats routed and
        // correct for something that's already exploding in a second or two either way.
        if (grenadeThreat) {
            bot.touchMoveDir = v2.normalizeSafe(
                v2.sub(bot.pos, grenadeThreat),
                bot.touchMoveDir,
            );
            bot.touchMoveActive = true;
        }

        const aimResult = updateAim(bot, this.aim, this.tier, this.target, dt);

        // Before weapon selection: an in-progress or freshly-triggered throw claims the
        // `Throwable` slot for this tick, which `updateWeaponSelection`'s own guard
        // needs to see before it otherwise "fixes" the bot back onto a gun. `threatPos`/
        // `engageDist`/`recentlyVisible` (already computed above for movement) are what
        // let it bait a target that just ducked into cover, not just finish a visible one.
        updateThrowable(
            bot,
            this.throwState,
            this.target,
            dist,
            aimResult.canFire,
            threatPos,
            engageDist,
            recentlyVisible,
            dt,
        );

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
        if (
            directive === "heal"
            && isSafeToHeal(bot, this.movement, engageDist, this.sustainedlyLost(bot))
        ) {
            updateHeal(bot, this.tier, !!this.target, this.positionSafeForHeal(bot));
        }
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
     * 4. Merely low (not yet critical) with no way to heal - still disengage rather
     *    than keep fighting or pushing at real risk just because it isn't dire yet.
     * 5. Merely low, *has* an item, but `shouldHeal` still refuses (in practice: the
     *    enemy is currently visible and health isn't critical enough to override
     *    that) - disengage anyway instead of fighting on hurt with a bandage it can't
     *    safely use. Breaking line of sight is what lets `shouldHeal` say yes next
     *    tick; standing and trading while "waiting" for an opening never creates one.
     * 6. Hurt enough to want to heal - retreats toward cover/distance immediately, but
     *    doesn't actually consume the item until `isSafeToHeal` (in `update()`) says
     *    the retreat has actually gone somewhere.
     * 7. Every equipped gun dry *and* actually under fire right now (`needsReload`) -
     *    retreat toward relative safety while the reload (already requested
     *    regardless, see `updateReload`) finishes. Dry with nobody shooting just
     *    reloads in place under whichever directive comes next instead.
     * 8. The target is visible and hurt enough to be worth finishing
     *    (`ENEMY_LOW_HEALTH_FRAC`), and this bot's own health has actually recovered
     *    back up to `tier.healThreshold` - not merely cleared the laxer `low` bar -
     *    press it across open ground rather than waiting for a hit streak to build
     *    first. Charging into the open is the single most exposed thing this bot can
     *    do, so it needs a real cushion, not just "not low anymore": a bot that would
     *    still rather heal than fight (`shouldHeal` requires the same threshold)
     *    shouldn't push the instant a bandage happens to end mid-fight. Short of that,
     *    `engageHold` closes distance using cover instead.
     * 9. Default: hold a sane range, using cover once there instead of standing still.
     */
    private pickDirective(bot: Player, threatPos: Vec2 | undefined): CombatDirective {
        if (!threatPos) return "idle";
        if (bot.actionType === GameConfig.Action.UseItem) return "heal";

        const healthFrac = bot.health / GameConfig.player.health;
        const critical = healthFrac < this.tier.healThreshold * PANIC_HEALTH_FRAC_MULT;
        const low = healthFrac < this.tier.healThreshold * LOW_HEALTH_FRAC_MULT;
        const positionSafe = this.positionSafeForHeal(bot);
        const noHealItem = pickHealItem(bot, healthFrac, positionSafe) === undefined;

        if (critical && (noHealItem || this.healAbortCooldown > 0)) return "flee";
        // Low but not yet critical, and nothing to fix it with - disengage rather than
        // keep fighting (or even push) at real risk just because it isn't dire yet.
        if (low && noHealItem) return "flee";
        // Has a bandage but can't safely use it yet (almost always: the enemy can
        // still see it) - disengage to break line of sight rather than fight on hurt
        // and hope. Once concealed, `shouldHeal` flips to true on its own.
        if (low && !noHealItem && !shouldHeal(bot, this.tier, !!this.target, positionSafe)) {
            return "flee";
        }

        if (shouldHeal(bot, this.tier, !!this.target, positionSafe)) return "heal";
        if (this.needsReload(bot)) return "reload";
        // A visible target actually hurt enough to be worth finishing is reason enough
        // to press it, on its own - no need to already be on a hit streak first. Every
        // real disadvantage (own low health, needing to reload) has already returned
        // its own directive above, so reaching here already means pushing costs this
        // bot nothing. Requiring a hit streak *in addition* was the old "dumb push"
        // fix's original mechanism; gating on the target's actual health directly (see
        // `ENEMY_LOW_HEALTH_FRAC`) is the more direct fix, so the streak requirement
        // was just needless hesitation once a target is genuinely low. Short of that,
        // `engageHold` still knows how to close distance using cover instead.
        const enemyLow = !!this.target
            && this.target.health / GameConfig.player.health < ENEMY_LOW_HEALTH_FRAC;
        // Pushing is the single most exposed thing this bot can do - charging into open
        // ground on purpose - so it needs a real health cushion, not merely having
        // cleared the much laxer `low` bar (which only demands 75% of the point
        // `shouldHeal` itself would still want to top off from). Reusing
        // `tier.healThreshold` directly ties "healthy enough to push" to the exact same
        // bar that decides "healthy enough to no longer even want to heal" - a bot that
        // just finished a bandage and would still rather heal than fight shouldn't be
        // charging the instant that bandage happens to end mid-fight.
        if (healthFrac >= this.tier.healThreshold && enemyLow) return "push";

        return "engageHold";
    }

    /** Every gun (that's actually equipped) is dry, and worth retreating over right
     *  now - see the `reload` directive and `RELOAD_RETREAT_DANGER_MS`. Reloading in
     *  place (which happens regardless, via `updateReload`) is the right call whenever
     *  nothing is actually shooting at the bot; retreating is only "considering whether
     *  it makes sense" if it's actually under fire while it does it. */
    private needsReload(bot: Player): boolean {
        const wm = bot.weaponManager;
        const slots = [WeaponSlot.Primary, WeaponSlot.Secondary].filter(
            (i) => wm.weapons[i].type,
        );
        if (!slots.length || !slots.every((i) => wm.weapons[i].ammo <= 0)) return false;
        return bot.game.now - this.lastHitTakenTime < RELOAD_RETREAT_DANGER_MS;
    }

    /** True once the target has been genuinely out of sight for a while - not just this
     *  exact tick's momentary LOS break - see `SUSTAINED_LOST_MS`. */
    private sustainedlyLost(bot: Player): boolean {
        return !this.target && bot.game.now - this.lastKnownEnemyTimeMs > SUSTAINED_LOST_MS;
    }

    /** Whether the current spot can absorb a medkit's longer, harder-to-abort
     *  commitment - real cover, or a sustained/confident break in contact - as opposed
     *  to `shouldHeal`'s own laxer "wants to heal at all" gate. See `pickHealItem`. */
    private positionSafeForHeal(bot: Player): boolean {
        return !!this.movement.coverPos || this.sustainedlyLost(bot);
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
