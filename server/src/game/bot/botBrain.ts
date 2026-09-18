import { GameConfig, WeaponSlot } from "../../../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { GameObject } from "../objects/gameObject.ts";
import type { Player } from "../objects/player.ts";
import { type AimTarget, BotAimState, updateAim } from "./botAim.ts";
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
import { logBotTick } from "./botDebugLog.ts";
import { BOT_TIERS, type BotDifficulty, type BotTierDef } from "./botDefs.ts";
import { BotMovementState, type CombatDirective, isSafeToHeal, updateMovement } from "./botMovement.ts";
import { findGrenadeThreat, findGunshotHint, findVisibleTarget, hasLineOfSight } from "./botPerception.ts";

export type BotState = "idle" | "engage";

/** Taking a hit this recently while mid-heal means the enemy clearly still has a shot -
 *  finishing the bandage anyway is how a bot dies at full heal-bar-in-progress. This is
 *  deliberately the only *hit-based* abort trigger (a live grenade nearby also aborts,
 *  see the abort check itself) - see that same comment for why an enemy-proximity one
 *  was removed. */
const ABORT_HEAL_REACT_MS = 350;
/** Health fraction at/below which a single unlucky hit (a shotgun blast up close, a
 *  sniper headshot) can plausibly still kill outright - worth bailing out of a heal
 *  for. Above it, tanking the hit and finishing the item is worth more than throwing
 *  the whole thing away and re-exposing itself all over again re-starting one later -
 *  "er cancelt immer noch relativ oft mid heal anstatt kurz voll durchzuziehen".
 *  Deliberately not also gated on how much of the heal is left: re-starting from
 *  scratch after an abort costs strictly more total exposure than just tanking one hit
 *  and continuing, regardless of whether the abort happens early or late. */
const ONE_SHOT_RISK_HEALTH_FRAC = 0.35;
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
 *  without a bandage is still a reason to disengage, not just being nearly dead.
 *  Deliberately left alone even after finding that a single burst can carry health
 *  straight from "fine" into "critical" in one hit: `shouldHeal` already starts the
 *  retreat-to-heal at the higher `tier.healThreshold` (0.75) the instant an item is
 *  available, regardless of this constant - this one only governs the narrower
 *  no-item/can't-safely-heal-yet disengage case, and raising it collides with the
 *  deliberately-tuned "push once cleared low, without needing full healThreshold"
 *  behavior for no real gain on the actual reaction-time problem. */
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
/** How long after losing sight of a moving target it's still worth trying an offscreen
 *  shot at its predicted position - see `offscreenAimTarget`. Deliberately short: this
 *  is "catch them stepping past a gap/window they just crossed", not sustained tracking
 *  through a wall - `aim.vel` is a real velocity estimate, not psychic, and the error
 *  compounds fast the longer it's extrapolated blind. */
const OFFSCREEN_PREDICT_MS = 450;
/** Below this speed (units/s), predicting is pointless - a target that was essentially
 *  stationary when last seen is already exactly where `lastKnownEnemyPos` says, nothing
 *  to extrapolate toward. Also what keeps this from degenerating into "just keep shooting
 *  the last spot they stood" for a target that merely ducked behind close cover. */
const OFFSCREEN_MIN_SPEED = 1.5;
/** How long after a bandage/medkit actually finishes (not an abort - that already has
 *  its own, longer `HEAL_ABORT_COOLDOWN_S`) before `pickDirective` is willing to resume
 *  normal engagement - see there. Without this, clearing the `low` bar the instant a
 *  heal completes was the literal "healed and immediately started pushing again"
 *  complaint; requiring a much higher health bar *permanently* instead (an earlier fix
 *  for the same complaint) overcorrected the other way, making the bot rarely press an
 *  advantage at all and feel far less dangerous in a fight generally. Keeping the bot
 *  actively retreating for this short grace window - not just refusing to `push`, which
 *  still let it plant and hold right where the heal finished - is the "retreaten, dann
 *  healen, und weiter retreaten" ask: opening a little extra distance right when a heal
 *  just ended is worth more than snapping straight back into the fight, without
 *  blunting ordinary aggression the rest of the time. */
const POST_HEAL_RETREAT_COOLDOWN_S = 1.5;
/** How long a heard-but-unseen gunshot stays worth reacting to - see
 *  `lastHeardShotPos`/`findGunshotHint`. Long enough to actually reposition toward it,
 *  short enough that the bot doesn't spend the next 10s convinced someone's still right
 *  there off one shot that's long since gone quiet. */
const GUNSHOT_MEMORY_MS = 3000;
/** How long a last-known enemy position stays worth actually walking back to once
 *  totally out of combat memory (past `tier.memory`/`GUNSHOT_MEMORY_MS` both) - "der Bot
 *  ist bisschen hohl sobald er den Fight verlässt": with nothing left to react to,
 *  aimlessly wandering reads as empty, but a stale sighting from minutes ago isn't worth
 *  a special trip either. Long enough that checking back on a small arena's worth of
 *  ground is still a reasonable bet, short enough that the bot gives up on a genuinely
 *  cold trail and just heads for the map's center instead - see `idleGoal`. */
const IDLE_LAST_KNOWN_MEMORY_MS = 15000;

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
    /** The enemy's health fraction at that same last sighting - see `idleGoal`, which
     *  only walks back to `lastKnownEnemyPos` when this bot is itself at full health or
     *  the enemy was already known to be hurt. Health can't be "seen" once out of sight
     *  any more than position can, so this is just as much a *last known* snapshot, not
     *  a live read. */
    private lastKnownEnemyHealthFrac = 1;

    /** Where a nearby hostile gunshot was last heard, and when - "checken in welche
     *  Richtung der Gegner sein könnte anhand von Schüssen": gives `threatPos` something
     *  to react to (repositioning, taking cover) even for an enemy the bot has never
     *  actually laid eyes on, the same way a real player reacts to gunfire they can hear
     *  but not see. Never feeds aim/fire (see `findGunshotHint`) - only ever a rough
     *  "something happened over there", the lowest-priority of `threatPos`'s three
     *  sources (behind an actually-visible target and a remembered sighting). */
    private lastHeardShotPos?: Vec2;
    private lastHeardShotTimeMs = 0;

    /** Wall-clock ms (`game.now`) this bot last took damage - see `onDamaged` and the
     *  heal-abort check in `update()`. */
    private lastHitTakenTime = -Infinity;
    /** Set for a short window after an aborted heal, so the bot doesn't immediately
     *  re-start the exact bandage that just got interrupted - see `pickDirective`. */
    private healAbortCooldown = 0;
    /** Set for a short window the instant a heal action ends, completed or aborted
     *  alike - see `POST_HEAL_RETREAT_COOLDOWN_S`/`pickDirective`. Firing on an abort too
     *  is harmless (an aborted heal already means still hurt, so `low`/`healAbortCooldown`
     *  route to `flee` first regardless) rather than a reason to track the distinction. */
    private postHealRetreatCooldown = 0;
    /** Tracks the *previous* tick's `actionType` purely to detect the UseItem -> None
     *  transition that means a heal just ended, for `postHealRetreatCooldown` above. */
    private wasHealing = false;

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
        let didThink = false;
        if (this.thinkTimer <= 0) {
            this.thinkTimer += 1 / (this.tier.thinkHz * this.barn.thinkRateScale);
            this.think();
            didThink = true;
        }

        // Every tick, not gated behind `thinkTimer` like `think()`'s own perception: a
        // gunshot only shows up in `newBullets` for the one tick it was actually fired,
        // so checking at `tier.thinkHz` would miss most of them outright.
        const gunshotPos = findGunshotHint(bot);
        if (gunshotPos) {
            this.lastHeardShotPos = gunshotPos;
            this.lastHeardShotTimeMs = bot.game.now;
        }

        this.healAbortCooldown = Math.max(0, this.healAbortCooldown - dt);
        this.postHealRetreatCooldown = Math.max(0, this.postHealRetreatCooldown - dt);
        if (this.wasHealing && bot.actionType !== GameConfig.Action.UseItem) {
            this.postHealRetreatCooldown = POST_HEAL_RETREAT_COOLDOWN_S;
        }
        this.wasHealing = bot.actionType === GameConfig.Action.UseItem;

        // `aimTarget`/`dist` below stay tied to the *currently visible* target, or a
        // brief predicted stand-in while it's just gone offscreen (see
        // `offscreenAimTarget`) - genuinely aiming/firing at a bare remembered position
        // with no such check is a very different, much less justified thing (see
        // `threatPos`/`engageDist` just below, the broader "am I in a fight" read
        // movement and heal/push/flee decisions use instead, which tolerates a target
        // that's ducked behind cover a moment ago with no distance/LOS guarantee at all).
        const aimTarget: AimTarget | undefined = this.target ?? this.offscreenAimTarget(bot);
        const dist = aimTarget ? v2.distance(bot.pos, aimTarget.pos) : Infinity;
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
        // Deliberately *not* also a plain proximity check ("enemy within N units") for
        // an *armed* bot: a heal only ever starts once `isSafeToHeal` has already
        // confirmed real separation (or cover) exists, so plain distance alone right
        // after that shouldn't flip back to "unsafe" on its own - and while it could
        // still drift closer between recomputes, that's `pickRangeMode`'s job to
        // correct once the heal ends, not a reason to cancel a heal nothing has
        // actually threatened yet. A bot bailing out of every heal it starts, without
        // ever having been shot at, is worse than occasionally finishing one a beat
        // later than a human would.
        if (bot.actionType === GameConfig.Action.UseItem) {
            const justHit = bot.game.now - this.lastHitTakenTime < ABORT_HEAL_REACT_MS;
            // Not in real danger of dying to a follow-up hit - tank this one and keep
            // going instead of throwing the whole heal away. See `ONE_SHOT_RISK_HEALTH_FRAC`.
            const healthFrac = bot.health / GameConfig.player.health;
            const pushThroughHit = healthFrac > ONE_SHOT_RISK_HEALTH_FRAC;
            // The one real exception to "no plain proximity check" above: unarmed on
            // melee *with an actual gun to switch back to* (from preferring melee
            // while fleeing/healing unseen - see `updateWeaponSelection`'s
            // `preferMelee`) with the target now visible again is a different risk
            // entirely - there's no "tank it and fight back" option at all while
            // holding fists. `updateWeaponSelection` itself won't touch loadout
            // mid-action (fiddling with gear mid-bandage is its own bug), so without
            // this the bot stayed defenseless for the rest of the heal even after the
            // exact threat that made healing risky reappeared - a real bug real match
            // debug logging caught directly. The "has a gun" check matters: a bot with
            // no gun at all (melee by default, nothing to switch to) has nothing to
            // gain from aborting either way, so this must not fire for it.
            const hasGun = !!bot.weaponManager.weapons[WeaponSlot.Primary].type
                || !!bot.weaponManager.weapons[WeaponSlot.Secondary].type;
            const exposedUnarmed = bot.weaponManager.curWeapIdx === WeaponSlot.Melee
                && hasGun
                && !!this.target;
            if ((justHit && !pushThroughHit) || grenadeThreat || exposedUnarmed) {
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
            !!this.target,
            this.idleGoal(bot),
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

        const aimResult = updateAim(bot, this.aim, this.tier, aimTarget, dt);

        // Before weapon selection: an in-progress or freshly-triggered throw claims the
        // `Throwable` slot for this tick, which `updateWeaponSelection`'s own guard
        // needs to see before it otherwise "fixes" the bot back onto a gun.
        // `threatPos`/`engageDist`/`recentlyVisible` (already computed above for
        // movement) are what let it bait a target that just ducked into cover.
        // `isFleeing` is the *other* legitimate reason to throw - a bot that's healthy
        // and can see its target should always just shoot instead (see
        // `updateThrowable`'s own doc comment for why finishing a visible target with a
        // grenade used to be a case here, and isn't anymore).
        const isFleeing = directive === "flee" || directive === "heal";
        updateThrowable(
            bot,
            this.throwState,
            threatPos,
            engageDist,
            recentlyVisible,
            isFleeing,
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
        updateWeaponSelection(bot, this.tier, this.fire, dist, isFleeing, !this.sustainedlyLost(bot));
        updateReload(bot);
        updateFiring(bot, this.tier, this.fire, aimTarget?.pos, dist, aimResult.canFire, dt);

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

        if (didThink) {
            logBotTick(bot, {
                directive,
                health: Math.round(bot.health),
                pos: { x: Math.round(bot.pos.x), y: Math.round(bot.pos.y) },
                targetVisible: !!this.target,
                dist: Number.isFinite(dist) ? Math.round(dist) : null,
                engageDist: Number.isFinite(engageDist) ? Math.round(engageDist) : null,
                weapon: bot.weaponManager.activeWeapon,
                canFire: aimResult.canFire,
                shootStart: bot.shootStart,
                shootHold: bot.shootHold,
                stuck: this.movement.stuck,
                move: bot.touchMoveActive ? v2.copy(bot.touchMoveDir) : null,
            });
        }
    }

    /**
     * The single combat decision every other system (movement, healing) reacts to this
     * tick. Priority, high to low:
     * 1. Already mid-heal - see through the bandage regardless of anything else,
     *    including having lost `threatPos` entirely (interrupting it is `update()`'s
     *    `cancelAction` job above, not a directive switch on its own; without this,
     *    `shouldHeal` degenerately returns false the instant `actionType` becomes
     *    `UseItem`, which would otherwise make the bot abandon cover mid-bandage the
     *    moment health ticks back over the threshold). Checked before the "no target"
     *    case below on purpose - a heal already in progress must never get orphaned
     *    just because `threatPos`'s own, shorter memory window happens to run out
     *    first.
     * 2. No target and no recent memory of one, but still hurt enough to want to heal
     *    ("wenn er keinen Plan hat wo der Gegner ist, soll er healen falls nötig") -
     *    nothing to react to combat-wise doesn't mean nothing to do; `positionSafe:
     *    true` here since there's no known threat to have made it unsafe in the first
     *    place, unlike a heal that's mid-fight. Otherwise: `idle` - `updateMovement`
     *    still has somewhere purposeful to go from there (see `idleGoal`), just
     *    nothing combat-related to react to.
     * 3. Critically hurt with no way to heal right now (no item, or just interrupted
     *    and still cooling down) - disengage instead of trading (see `fleeOrFight`: a
     *    retreat that's demonstrably not going anywhere gets one exception).
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
     * 7. A heal action just ended, completed or aborted (`POST_HEAL_RETREAT_COOLDOWN_S`)
     *    - keep opening distance for this short grace window instead of snapping
     *    straight back into holding or pushing at the exact spot the heal finished.
     *    "retreaten, dann healen, und weiter retreaten": creating a little extra
     *    separation right after a heal is worth more than immediately resuming the
     *    fight from wherever standing still to heal happened to leave the bot.
     * 8. Every equipped gun dry *and* actually under fire right now (`needsReload`) -
     *    retreat toward relative safety while the reload (already requested
     *    regardless, see `updateReload`) finishes. Dry with nobody shooting just
     *    reloads in place under whichever directive comes next instead.
     * 9. The target is visible and hurt enough to be worth finishing
     *    (`ENEMY_LOW_HEALTH_FRAC`) and this bot itself isn't `low` - press it across
     *    open ground rather than waiting for a hit streak to build first. Every real
     *    disadvantage, including having just healed (point 7), has already returned
     *    its own directive above, so reaching here already means pushing costs this
     *    bot nothing. Short of pushing, `engageHold` closes distance using cover instead.
     * 10. Default: hold a sane range, using cover once there instead of standing still.
     */
    private pickDirective(bot: Player, threatPos: Vec2 | undefined): CombatDirective {
        if (bot.actionType === GameConfig.Action.UseItem) return "heal";
        if (!threatPos) {
            const healthFrac = bot.health / GameConfig.player.health;
            const canHeal = healthFrac < this.tier.healThreshold
                && pickHealItem(bot, healthFrac, /* positionSafe */ true) !== undefined;
            return canHeal ? "heal" : "idle";
        }

        const healthFrac = bot.health / GameConfig.player.health;
        const critical = healthFrac < this.tier.healThreshold * PANIC_HEALTH_FRAC_MULT;
        const low = healthFrac < this.tier.healThreshold * LOW_HEALTH_FRAC_MULT;
        const positionSafe = this.positionSafeForHeal(bot);
        const noHealItem = pickHealItem(bot, healthFrac, positionSafe) === undefined;

        if (critical && (noHealItem || this.healAbortCooldown > 0)) return this.fleeOrFight();
        // Low but not yet critical, and nothing to fix it with - disengage rather than
        // keep fighting (or even push) at real risk just because it isn't dire yet.
        if (low && noHealItem) return this.fleeOrFight();
        // Has a bandage but can't safely use it yet (almost always: the enemy can
        // still see it) - disengage to break line of sight rather than fight on hurt
        // and hope. Once concealed, `shouldHeal` flips to true on its own.
        if (low && !noHealItem && !shouldHeal(bot, this.tier, !!this.target, positionSafe)) {
            return this.fleeOrFight();
        }

        if (shouldHeal(bot, this.tier, !!this.target, positionSafe)) return "heal";
        // Just finished healing (or an abort just ended) - keep retreating for a short
        // grace window rather than immediately resuming the fight from right here. See
        // `POST_HEAL_RETREAT_COOLDOWN_S`.
        if (this.postHealRetreatCooldown > 0) return "flee";
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
        // `!low` (not a full `tier.healThreshold` bar - see the doc comment above) is
        // what stops "healed and immediately pushed while still low" without also
        // making the bot generally reluctant to press an advantage - the
        // `postHealRetreatCooldown` check above already handles "just finished healing
        // entirely" before this is ever reached.
        if (!low && enemyLow) return "push";

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

    /** `flee`, unless last tick's retreat demonstrably wasn't going anywhere
     *  (`this.movement.stuck` - see its own doc comment on `BotMovementState`), in which
     *  case fight back instead - "wenn retreat nicht geht, muss er halt wenigstens
     *  schießen". Running from a cornered/boxed-in spot is worse than useless: it wastes
     *  the reaction time an actual fight would have used, for a retreat that was never
     *  going to create separation anyway. `engageHold`, not `push` - still hurt, so
     *  holding range from cover and shooting back is the right compromise, not charging
     *  in on top of it. */
    private fleeOrFight(): CombatDirective {
        return this.movement.stuck ? "engageHold" : "flee";
    }

    /** Where a bot with nothing combat-related to react to should actually head, instead
     *  of wandering aimlessly - "der Bot ist bisschen hohl sobald er den Fight verlässt".
     *  Prefers a still-recent-ish last-known enemy position (see
     *  `IDLE_LAST_KNOWN_MEMORY_MS`) - "vorsichtig zur letzten bekannten Position
     *  navigieren", they're probably still somewhere nearby - but only when walking back
     *  there is actually a good idea: at full health (nothing to lose by checking) or the
     *  enemy was already known to be hurt (`lastKnownEnemyHealthFrac`,
     *  `ENEMY_LOW_HEALTH_FRAC`) - not while this bot is itself banged up against a foe
     *  that, for all it knows, is still perfectly healthy. Falls back to the map's center
     *  as a generic "go find the fight" heuristic otherwise - that cold trail's gone,
     *  never existed (a fresh spawn), or just isn't worth the risk of walking back into. */
    private idleGoal(bot: Player): Vec2 {
        if (this.lastKnownEnemyPos) {
            const ageMs = bot.game.now - this.lastKnownEnemyTimeMs;
            const healthFrac = bot.health / GameConfig.player.health;
            const worthChecking = healthFrac >= 0.99
                || this.lastKnownEnemyHealthFrac < ENEMY_LOW_HEALTH_FRAC;
            if (ageMs <= IDLE_LAST_KNOWN_MEMORY_MS && worthChecking) return this.lastKnownEnemyPos;
        }
        return v2.create(bot.game.map.width / 2, bot.game.map.height / 2);
    }

    /** A brief, predicted stand-in for the target the instant it's gone offscreen but
     *  was recently moving fast enough to be worth tracking through the gap - "ein wenig
     *  predicten wo der Gegner sich hinbewegt, um offscreens zu treffen/versuchen".
     *  Extrapolates from `lastKnownEnemyPos` using `aim.vel` - already a live velocity
     *  estimate `updateAim` keeps while the target is visible, simply frozen the instant
     *  it isn't, not re-derived here - then requires an actual, geometrically clear line
     *  to that predicted point using the exact same raycast a real bullet would use, so
     *  this only ever "sees through" a genuine gap the target is passing (a window, a
     *  fence, the edge of cover) and never a solid wall. Reuses `aim.targetId` for the
     *  synthetic `AimTarget`'s id so `updateAim`'s reacquisition gate treats this as a
     *  continuation of already having noticed them, not a fresh sighting that needs its
     *  own reaction delay - it's still the same engagement, just briefly out of sight. */
    private offscreenAimTarget(bot: Player): AimTarget | undefined {
        if (this.target || !this.lastKnownEnemyPos) return undefined;
        const elapsedMs = bot.game.now - this.lastKnownEnemyTimeMs;
        if (elapsedMs > OFFSCREEN_PREDICT_MS) return undefined;
        if (v2.length(this.aim.vel) < OFFSCREEN_MIN_SPEED) return undefined;

        const predictedPos = v2.add(
            this.lastKnownEnemyPos,
            v2.mul(this.aim.vel, elapsedMs / 1000),
        );
        if (!hasLineOfSight(bot.game, bot.pos, predictedPos, bot.layer)) return undefined;

        return { __id: this.aim.targetId, pos: predictedPos };
    }

    /** Whether the current spot can absorb a medkit's longer, harder-to-abort
     *  commitment - real cover, or a sustained/confident break in contact - as opposed
     *  to `shouldHeal`'s own laxer "wants to heal at all" gate. See `pickHealItem`. */
    private positionSafeForHeal(bot: Player): boolean {
        return !!this.movement.coverPos || this.sustainedlyLost(bot);
    }

    /** Engagement position for everything downstream of perception: the target itself if
     *  still visible, else wherever it was last seen (as long as that memory hasn't gone
     *  stale), else a nearby gunshot it heard but never actually saw the source of - the
     *  same declining order of confidence a real player's own read on a fight would have.
     *  Movement/positioning only; `aimTarget` (visible or offscreen-predicted) is what
     *  actually gates aim/fire, and a mere gunshot direction is nowhere near precise
     *  enough for that. */
    private threatPos(): Vec2 | undefined {
        if (this.target) return this.target.pos;
        if (this.lastKnownEnemyPos) {
            const ageMs = this.player.game.now - this.lastKnownEnemyTimeMs;
            if (ageMs <= this.tier.memory * 1000) return this.lastKnownEnemyPos;
        }
        if (this.lastHeardShotPos) {
            const ageMs = this.player.game.now - this.lastHeardShotTimeMs;
            if (ageMs <= GUNSHOT_MEMORY_MS) return this.lastHeardShotPos;
        }
        return undefined;
    }

    private think(): void {
        this.target = findVisibleTarget(this.player);
        this.state = this.target ? "engage" : "idle";
        if (this.target) {
            this.lastKnownEnemyPos = v2.copy(this.target.pos);
            this.lastKnownEnemyTimeMs = this.player.game.now;
            this.lastKnownEnemyHealthFrac = this.target.health / GameConfig.player.health;
        }
    }
}
