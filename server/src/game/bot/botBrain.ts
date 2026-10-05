import { GameConfig, WeaponSlot } from "../../../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { GameObject } from "../objects/gameObject.ts";
import type { Player } from "../objects/player.ts";
import { type AimTarget, BotAimState, updateAim } from "./botAim.ts";
import type { BotBarn } from "./botBarn.ts";
import {
    BotFireState,
    BotThrowState,
    effectiveHealThreshold,
    FIGHT_FLOOR_FRAC,
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
import { findGrenadeThreat, findGunshotHint, findVisibleTarget, hasBodyLineOfSight, muzzlePos } from "./botPerception.ts";

export type BotState = "idle" | "engage";

/** Taking a hit this recently while mid-heal means the enemy clearly still has a shot -
 *  finishing the bandage anyway is how a bot dies at full heal-bar-in-progress. This is
 *  deliberately the only *hit-based* abort trigger (a live grenade nearby also aborts,
 *  see the abort check itself) - see that same comment for why an enemy-proximity one
 *  was removed. */
const ABORT_HEAL_REACT_MS = 350;
/** A hit only aborts a heal if the enemy's gun comes back ready within this many seconds -
 *  otherwise they need a real pause (a reload, a slow bolt, a cooldown) before they can
 *  hit again, and the bot is better off finishing the heal with its HP lead than throwing
 *  it away and starting over. See `enemyCanHitSoon`. */
const ENEMY_REFIRE_WINDOW_S = 1.0;
/** After an abort, open some distance before the desperate-gamble override
 *  (`DESPERATE_HEAL_S`) is willing to kick in - see `healAbortCooldown`'s own doc
 *  comment for why this stops short of blocking a *genuinely* safe re-heal outright. */
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
/** How long `critical` with an item on hand but `shouldHeal` still refusing (almost
 *  always: an equally fast pursuer that never lets separation or sustained-lost
 *  actually happen) is tolerated before healing anyway, safety gate or not - "auch
 *  defensiv muss er sich healen um sicherzustellen dass er nicht gehittet wird".
 *  `fleeOrFight`'s own escape valve (fight back once genuinely `stuck`) doesn't cover
 *  this: a bot that's actively moving but simply never gaining ground against a
 *  same-speed chaser on a small arena is never "stuck", so without this it can flee
 *  indefinitely at critical health, landing shots opportunistically but never actually
 *  bandaging, until it's eventually finished off - exactly what a decoded real loss
 *  showed (11+ seconds at 10-29% health, passive regen only, no heal item ever used).
 *  Gambling on starting the heal anyway past this point is still a real gate, not a
 *  free pass: the existing heal-abort safety net (`ABORT_HEAL_REACT_MS`) still cancels
 *  it the instant an actual hit lands, so this only ever costs the brief window before
 *  that - strictly better than certain, slow attrition death for standing still doing
 *  nothing to fix the actual problem.
 *
 *  Originally 3 - lowered after a second decoded loss showed the *entire* critical
 *  window (dropping under the panic threshold to actually dying) lasting only ~4.3
 *  seconds in this fast-ttk matchup. A 3-second wait before even trying left barely
 *  enough of that window for a 2-3 second bandage to land, let alone finish before the
 *  fight was already over - the bot was gambling too late to matter. Matches
 *  `HEAL_ABORT_COOLDOWN_S`'s own timescale instead: long enough to not fire on a single
 *  one-tick blip, short enough to actually get a real shot at completing before a fast
 *  fight resolves either way. */
const DESPERATE_HEAL_S = 1.2;
/** How hurt the *target* has to be, as a fraction of max health, before `push` is
 *  willing to charge across open ground for it - see `pickDirective`. Pushing into a
 *  still-healthy enemy in the open is exactly the "dumb push" complaint: landing a
 *  handful of hits doesn't mean the fight is actually won yet, and charging a target
 *  that can still fight back just because *this bot* is on a hit streak is how a bot
 *  that's ahead trades itself away. Without a currently visible target to read health
 *  from, `push` never has enough information to justify it either. */
const ENEMY_LOW_HEALTH_FRAC = 0.4;
/** How far ahead a currently-tracked enemy's health has to be, as a fraction of max
 *  health, before being behind on it alone counts as worth retreating to fix - see
 *  `pickDirective`'s `behindOnHealth`. Not zero: health moves in real chunks (a graze, a
 *  passive-regen tick), and treating "enemy is 1-2 HP ahead right now" as a reason to
 *  break off would flip `low` back and forth every time either health value ticks across
 *  the other by a sliver - the exact tick-to-tick flapping already fixed elsewhere in
 *  this file (cover stickiness, range-mode hysteresis) for the same underlying reason. */
const HEALTH_DEFICIT_MARGIN = 0.05;
/** Closer than this, a visible enemy with a clear line and a loaded gun gets fought rather
 *  than fled from, even below the fight floor - see `closeShotFight` in `pickDirective`. */
const CLOSE_FIGHT_DIST = 12;
/** Within this distance an enemy can push a healing bot effectively, so a clear open shot may
 *  break the heal off - see `openShotReady` in `update()`. */
const OPEN_SHOT_PUSH_DIST = 14;
/** A heal with at most this much time left is finished, never broken off for a shot. */
const HEAL_FINISH_GRACE_S = 1.0;
/** Slower than this (units/s, from the aim's own velocity estimate) and a target counts as moving
 *  enough to dodge a shot - see `openShotReady` in `update()`. */
const SURE_SHOT_MAX_TARGET_SPEED = 1.5;
/** A hit costing less than this (HP) is a chip; with cover this close, a chip doesn't break a heal. */
const CHIP_HIT_HEALTH_LOSS = 10;
/** Above the fight floor, a push needs the bot to have hurt its target this recently, or the
 *  target to be within finishing range (`PUSH_FINISH_FRAC`). See `pickDirective`. */
const RECENT_DAMAGE_DEALT_MS = 2000;
const PUSH_FINISH_FRAC = 0.3;
/** Below the fight floor with a heal in hand, the bot heals first - except against an enemy at or
 *  under this health fraction, which is worth pressing right away. See `healFirst`. */
const HEAL_FIRST_FINISH_FRAC = 0.2;
const CHIP_HIT_COVER_DIST = 4;
/** How far ahead on health (as a fraction of max) the bot has to be before it pushes a
 *  visible or recently seen enemy outright, at any health - see `pickDirective`. */
const PUSH_HEALTH_ADVANTAGE_FRAC = 0.2;
/** How long a chosen retreat (heal/flee) holds against an immediate drop to holding ground -
 *  see `stickyRetreat`. */
const RETREAT_HOLD_MS = 500;
/** How long after taking a hit the bot waits before starting a non-critical heal. A real
 *  match had the bot start heals 1-2 seconds after a hit and get hit again mid-bandage; the
 *  player it was up against started them 7-21 seconds after the last hit. */
const HEAL_QUIET_MS = 4000;
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
/** Whether a hit taken now can be followed by another shot soon - see
 *  `ENEMY_REFIRE_WINDOW_S`. A reloading enemy, an empty or non-gun weapon, or a gun still
 *  on cooldown past that window can't. Seeing an enemy isn't enough: it also needs a bullet
 *  line from it to the bot (cover in between stops shots), and with no enemy in view at all
 *  there's nothing to abort for - the bot keeps healing behind whatever is between them. */
function enemyCanHitSoon(bot: Player, enemy: Player | undefined): boolean {
    if (!enemy) return false;
    if (!hasBodyLineOfSight(bot.game, muzzlePos(enemy), bot.pos, bot.layer)) return false;
    if (enemy.actionType === GameConfig.Action.Reload || enemy.actionType === GameConfig.Action.ReloadAlt) {
        return false;
    }
    const wm = enemy.weaponManager;
    const weapon = wm.weapons[wm.curWeapIdx];
    if (!weapon || (weapon.ammo ?? 0) <= 0) return false;
    return weapon.cooldown <= ENEMY_REFIRE_WINDOW_S;
}

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
    /** The last retreat directive chosen and when - see `stickyRetreat`. */
    private lastRetreat?: CombatDirective;
    private lastRetreatMs = -Infinity;
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
    /** Whether the aim was on target with the shot ready on the previous tick - see
     *  `openShotReady` in `update()`. */
    private lastCanFire = false;
    /** The target and its health on the last think, and when the bot last hurt its target - see
     *  the push rules in `pickDirective`. */
    private lastDamageTarget: Player | undefined;
    private lastTargetHealth = 0;
    private lastEnemyDamageMs = -Infinity;
    /** Health seen on the previous tick, and how much the most recent hit cost - see `update()`. */
    private lastHealthSeen = -1;
    private hitLossAtLastHit = 0;
    /** `game.now` the enemy last had a clear bullet line to the bot - what blocks a heal (see
     *  `enemySightBlocksHeal`). Seeing an enemy in the screen isn't enough. */
    private lastClearLineMs = -Infinity;
    /** Set for a short window after an aborted heal. No longer a hard block on
     *  re-starting while critical (see `pickDirective`'s own doc comment on why that was
     *  a real bug) - genuine safety (`canHealNow`) always governs that. Still suppresses
     *  `criticalUnsafeElapsedS` from accumulating during this same window, so the
     *  desperate-gamble override can't fire in the very first instant after an abort,
     *  only once genuinely stuck past it. */
    private healAbortCooldown = 0;
    /** Set for a short window the instant a heal action ends, completed or aborted
     *  alike - see `POST_HEAL_RETREAT_COOLDOWN_S`/`pickDirective`. Firing on an abort too
     *  is harmless (an aborted heal already means still hurt, so `low`/`healAbortCooldown`
     *  route to `flee` first regardless) rather than a reason to track the distinction. */
    private postHealRetreatCooldown = 0;
    /** Tracks the *previous* tick's `actionType` purely to detect the UseItem -> None
     *  transition that means a heal just ended, for `postHealRetreatCooldown` above. */
    private wasHealing = false;
    /** Consecutive seconds this bot has been critical *and* unable to safely heal (an
     *  item on hand, but `shouldHeal` refusing) - resets to 0 the instant that isn't true
     *  any more. `dt`-accumulated like `healAbortCooldown`/`postHealRetreatCooldown`
     *  above, not `game.now`-based - those aren't driven by real wall-clock time in a
     *  test harness that calls `update(dt)` directly. See `DESPERATE_HEAL_S`/
     *  `pickDirective`. */
    private criticalUnsafeElapsedS = 0;
    /** Set by `pickDirective` for the same tick it returns a desperate "heal" - read
     *  back in `update()`'s own `isSafeToHeal` gate, which would otherwise still block
     *  the actual bandage on the exact distance/cover requirement this whole escape
     *  valve exists to bypass. */
    private desperateHeal = false;
    /** Set by `pickDirective` every tick (not just while actually healing) - read back in
     *  `update()` for `updateMovement`'s `critical` param, which refuses `findCover`'s
     *  interior-cover fallback while fleeing. See `findCover`'s own doc comment on
     *  `noInteriorFallback` for the real match capture this is for. */
    private critical = false;

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
        // How much HP the latest hit actually cost (armour cuts a lot of raw damage).
        const healthNow = bot.health;
        if (this.lastHealthSeen >= 0 && healthNow < this.lastHealthSeen) {
            this.hitLossAtLastHit = this.lastHealthSeen - healthNow;
        }
        this.lastHealthSeen = healthNow;

        if (bot.actionType === GameConfig.Action.UseItem) {
            const justHit = bot.game.now - this.lastHitTakenTime < ABORT_HEAL_REACT_MS;
            // Abort only when the enemy can hit again right away. A single hit followed by
            // a real pause (reload, slow bolt) is better finished in the heal - see
            // `enemyCanHitSoon`.
            const enemyRefireReady = enemyCanHitSoon(bot, this.target);
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
            // A clear, ready shot at a visible enemy is worth more than finishing the heal:
            // healing blocks the trigger, so a loaded gun with the aim already on target and a
            // bullet line to them gets the shot instead. `lastCanFire` is last tick's aim -
            // this check runs before this tick's aim update.
            // Only worth it when the enemy would otherwise push effectively (close), and never
            // with the heal nearly done - see `OPEN_SHOT_PUSH_DIST` / `HEAL_FINISH_GRACE_S`.
            const healLeftS = bot.action.duration - bot.action.time;
            const enemyCanPush = !!this.target
                && v2.distance(bot.pos, this.target.pos) < OPEN_SHOT_PUSH_DIST;
            // Only a near-certain hit is worth a heal: a standing target, on aim, in close range.
            // A moving one can dodge the shot, and then the heal is simply lost.
            const targetStanding = v2.length(this.aim.vel) < SURE_SHOT_MAX_TARGET_SPEED;
            const openShotReady = this.lastCanFire && enemyCanPush && targetStanding
                && healLeftS > HEAL_FINISH_GRACE_S
                && hasBodyLineOfSight(bot.game, bot.pos, this.target!.pos, bot.layer)
                && (bot.weaponManager.weapons[bot.weaponManager.curWeapIdx]?.ammo ?? 0) > 0;
            // A small chip with cover a step away: keep healing and step behind it, rather than
            // breaking off to peek out and shoot.
            const chipWithCoverNear = this.hitLossAtLastHit < CHIP_HIT_HEALTH_LOSS
                && !!this.movement.coverPos
                && v2.distance(bot.pos, this.movement.coverPos) <= CHIP_HIT_COVER_DIST;
            if ((justHit && enemyRefireReady && !chipWithCoverNear) || grenadeThreat || exposedUnarmed || openShotReady) {
                bot.cancelAction();
                this.healAbortCooldown = HEAL_ABORT_COOLDOWN_S;
            }
        }

        const directive = this.stickyRetreat(
            this.pickDirective(bot, threatPos, dt, !!grenadeThreat),
            bot,
        );

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
            this.critical,
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
        this.lastCanFire = aimResult.canFire;

        // Before `updateThrowable`, not after: a covering grenade and a just-becoming-
        // safe heal can both turn eligible on the exact same tick - a bot forced to
        // retreat almost always ends up at a `THROW_MIN_DIST`-`THROW_MAX_DIST` range and
        // out of sight right around when it's also newly safe to heal. `updateThrowable`
        // claims the `Throwable` slot and holds `shouldHeal`'s own `cookingThrowable`
        // gate against it for the ~0.1s cook, which used to cost that first eligible
        // heal tick to the grenade whenever both fired together - "er hätte sofort nach
        // der Nade anfangen healen und weglaufen sollen", not have the heal wait out a
        // throw it didn't need to make first. `updateThrowable` already refuses to start
        // a new throw once `actionType !== None` (see its own `actionType` guard), so
        // giving heal first claim here simply makes the throw wait a tick instead -
        // never the other way around.
        if (
            directive === "heal"
            && this.healQuietEnough(bot)
            && isSafeToHeal(
                bot,
                this.movement,
                engageDist,
                this.sustainedlyLost(bot) || this.desperateHeal,
                bot.health / GameConfig.player.health < this.tier.healThreshold * PANIC_HEALTH_FRAC_MULT,
                !!this.target,
            )
        ) {
            updateHeal(
                bot,
                this.tier,
                this.enemySightBlocksHeal(bot),
                this.positionSafeForHeal(bot),
                this.desperateHeal,
                this.target ? this.target.health / GameConfig.player.health : undefined,
            );
        }

        // Before weapon selection: an in-progress or freshly-triggered throw claims the
        // `Throwable` slot for this tick, which `updateWeaponSelection`'s own guard
        // needs to see before it otherwise "fixes" the bot back onto a gun.
        // `threatPos`/`engageDist`/`recentlyVisible` (already computed above for
        // movement) are what let it bait a target that just ducked into cover;
        // `sustainedlyLost` (already computed for `isSafeToHeal`/`positionSafeForHeal`)
        // is the *enemy*-side "probably healing behind cover right now" case - a much
        // better-telegraphed target than the instant right after `recentlyVisible`.
        // `isFleeing` is the third, bot-side legitimate reason to throw - a bot that's
        // healthy and can see its target should always just shoot instead (see
        // `updateThrowable`'s own doc comment for why finishing a visible target with a
        // grenade used to be a case here, and isn't anymore). `hasCleanShot` (already
        // computed above as `aimResult.canFire`, which itself requires a currently
        // visible target) keeps a *newly*-fleeing bot from throwing away a shot that's
        // ready right now - see `updateThrowable`'s own doc comment on that guard.
        const isFleeing = directive === "flee" || directive === "heal";
        updateThrowable(
            bot,
            this.throwState,
            threatPos,
            engageDist,
            recentlyVisible,
            this.sustainedlyLost(bot),
            isFleeing,
            aimResult.canFire,
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
        updateReload(bot, !!this.target);
        updateFiring(bot, this.tier, this.fire, aimTarget?.pos, dist, aimResult.canFire, dt);

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
                pathLen: this.movement.path.length,
                pullTarget: this.movement.pullTarget ?? null,
                coverPos: this.movement.coverPos ? v2.copy(this.movement.coverPos) : null,
                settledAtCover: this.movement.settledAtCover,
                deflectSign: this.movement.deflectSign,
                pushedPastCover: this.movement.pushedPastCover,
                actionType: bot.actionType,
                ammo: {
                    primary: bot.weaponManager.weapons[WeaponSlot.Primary].ammo,
                    secondary: bot.weaponManager.weapons[WeaponSlot.Secondary].ammo,
                },
                peeking: this.movement.peeking,
                layer: bot.layer,
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
     * 4. Critically hurt, *has* an item, but `shouldHeal` has refused for too long
     *    (`DESPERATE_HEAL_S`) - gamble on starting the bandage right here instead of
     *    continuing to flee toward a safety an equally fast pursuer is never going to
     *    grant. See the doc comment at the check itself for the real loss this was
     *    caught from.
     * 5. Merely low (not `critical` - that already returned above) but the target is
     *    worse off than *I* am and genuinely low itself - finish them instead of
     *    breaking off to heal. Retreating here just hands a nearly-dead enemy the exact
     *    window it needs to heal back up and win the fight back - see the doc comment
     *    at the check itself for the real match this was caught from.
     * 6. Merely low (not yet critical) with no way to heal - still disengage rather
     *    than keep fighting or pushing at real risk just because it isn't dire yet.
     * 7. Merely low, *has* an item, but `shouldHeal` still refuses (in practice: the
     *    enemy is currently visible and health isn't critical enough to override
     *    that) - disengage anyway instead of fighting on hurt with a bandage it can't
     *    safely use. Breaking line of sight is what lets `shouldHeal` say yes next
     *    tick; standing and trading while "waiting" for an opening never creates one.
     * 8. Hurt enough to want to heal - retreats toward cover/distance immediately, but
     *    doesn't actually consume the item until `isSafeToHeal` (in `update()`) says
     *    the retreat has actually gone somewhere.
     * 9. The target is visible and hurt enough to be worth finishing
     *    (`ENEMY_LOW_HEALTH_FRAC`) and this bot itself isn't `low` - press it across
     *    open ground rather than waiting for a hit streak to build first, and ahead of
     *    the next three checks on purpose: an optional top-off heal, the post-heal
     *    grace retreat, and a reload are all "not actually urgent" pauses that would
     *    otherwise hand a barely-alive target exactly the recovery window it needs -
     *    "muss konsequenter pushen wenn der Gegner low ist", not let a secondary
     *    concern quietly override an easy finish. Short of pushing, `engageHold` still
     *    knows how to close distance using cover instead.
     * 10. Hurt enough to want an optional heal (not `low` - that already returned
     *     above) - retreats toward cover/distance immediately, but doesn't actually
     *     consume the item until `isSafeToHeal` (in `update()`) says the retreat has
     *     actually gone somewhere.
     * 11. A heal action just ended, completed or aborted (`POST_HEAL_RETREAT_COOLDOWN_S`)
     *     - keep opening distance for this short grace window instead of snapping
     *     straight back into holding or pushing at the exact spot the heal finished.
     *     "retreaten, dann healen, und weiter retreaten": creating a little extra
     *     separation right after a heal is worth more than immediately resuming the
     *     fight from wherever standing still to heal happened to leave the bot.
     * 12. Every equipped gun dry *and* actually under fire right now (`needsReload`) -
     *     retreat toward relative safety while the reload (already requested
     *     regardless, see `updateReload`) finishes. Dry with nobody shooting just
     *     reloads in place under whichever directive comes next instead.
     * 13. Default: hold a sane range, using cover once there instead of standing still.
     */
    private pickDirective(
        bot: Player,
        threatPos: Vec2 | undefined,
        dt: number,
        grenadeThreat: boolean,
    ): CombatDirective {
        // Reset unconditionally, not just on the branch that sets it true - every early
        // return below (already mid-heal, no target) must never leave a stale `true`
        // from an earlier tick around to wrongly wave a *different*, non-desperate heal
        // through `update()`'s `isSafeToHeal` gate later this same tick.
        this.desperateHeal = false;
        // Computed up front, before any early return, so `this.critical` (read back by
        // `update()` for `updateMovement`'s own `findCover` interior-fallback refusal -
        // see its own doc comment) always reflects the bot's actual health this tick,
        // not a stale value from whichever branch last happened to compute it.
        const healthFrac = bot.health / GameConfig.player.health;
        const critical = healthFrac < this.tier.healThreshold * PANIC_HEALTH_FRAC_MULT;
        this.critical = critical;
        if (bot.actionType === GameConfig.Action.UseItem) return "heal";
        if (!threatPos) {
            const canHeal = healthFrac < this.tier.healThreshold
                && pickHealItem(bot, healthFrac, /* positionSafe */ true, this.tier.healThreshold)
                    !== undefined;
            return canHeal ? "heal" : "idle";
        }

        const positionSafe = this.positionSafeForHeal(bot);
        // Visible enemy's real health, or the last sighting's while it's still inside the
        // same memory window `threatPos` uses - see the push checks below.
        const knownEnemyFrac = this.knownEnemyHealthFrac(bot);
        // "wenn nicht full und der Gegner mehr hp hat dann sollte heilen Prio sein" -
        // treated the same as ordinary `low` health below: worth disengaging to look for
        // a safe moment to close a real relative deficit, not just once hurt enough on
        // its own terms. See `effectiveHealThreshold`'s own doc comment for the matching
        // change to the actual heal-safety gate just below - without it, `low` alone
        // would retreat looking for safety and then just stand there once it found some,
        // since the plain tier threshold would still say "no need, already above it".
        // Above `FIGHT_FLOOR_FRAC` the enemy's health doesn't count against the bot at all:
        // it keeps fighting instead of healing or running, and only a clear health advantage
        // (`PUSH_HEALTH_ADVANTAGE_FRAC`) sends it forward - see the push checks below.
        const enemyHealthFrac = this.target && healthFrac < FIGHT_FLOOR_FRAC
            ? this.target.health / GameConfig.player.health
            : undefined;
        const behindOnHealth = healthFrac < 1
            && enemyHealthFrac !== undefined
            && enemyHealthFrac - healthFrac > HEALTH_DEFICIT_MARGIN;
        const low = healthFrac < this.tier.healThreshold * LOW_HEALTH_FRAC_MULT || behindOnHealth;
        const healThreshold = effectiveHealThreshold(this.tier, healthFrac, enemyHealthFrac);
        const noHealItem = pickHealItem(
            bot,
            healthFrac,
            positionSafe,
            healThreshold,
            this.enemySightBlocksHeal(bot),
        ) === undefined;
        const canHealNow = !noHealItem
            && this.healQuietEnough(bot)
            && shouldHeal(bot, this.tier, this.enemySightBlocksHeal(bot), positionSafe, false, enemyHealthFrac);

        // See `DESPERATE_HEAL_S`: tracks how long `critical` has gone on with an item
        // on hand that `shouldHeal` won't yet allow - an equally fast pursuer can hold
        // this true indefinitely, since `fleeOrFight`'s own escape valve only trips once
        // genuinely `stuck`, not merely "fleeing without gaining ground".
        if (critical && !noHealItem && !canHealNow && this.healAbortCooldown <= 0) {
            this.criticalUnsafeElapsedS += dt;
        } else {
            this.criticalUnsafeElapsedS = 0;
        }

        // Deliberately *not* also gated on `this.healAbortCooldown > 0` here, even though
        // an abort is what sets it - a real match loss showed the bot take a near-fatal
        // hit mid-heal (correctly aborting - `enemyCanHitSoon`), lose the
        // enemy's sight within ~150ms, and then just keep fleeing anyway for another
        // second-plus purely because the cooldown hadn't expired yet - genuinely safe to
        // heal again (`canHealNow` already true) the whole time it was forced to wait.
        // "er hat gezögert, dann angefangen zu healen" - the pursuer closed back in
        // during exactly that forced wait and finished it. The cooldown's own purpose
        // (don't immediately re-start the *same* exposed heal, see its own doc comment)
        // only makes sense while still genuinely unsafe - `canHealNow` below already
        // requires real safety before healing resumes regardless, so it isn't a free
        // pass; `healAbortCooldown` still suppresses `criticalUnsafeElapsedS` just below
        // while that's true, so the desperate-gamble override doesn't fire in the first
        // instant after an abort either, only once genuinely stuck for a while.
        //
        // `grenadeThreat` is checked explicitly here instead, rather than leaning on the
        // cooldown to incidentally cover it: unlike a survived hit (a one-off event, safe
        // to re-evaluate from scratch a moment later), a live grenade is an ongoing
        // hazard this exact spot - `canHealNow`/`isSafeToHeal` never factor it in at all,
        // so without this a bot could cancel and immediately re-start a heal right next
        // to a still-ticking grenade the instant distance/cover alone looked safe.
        if (critical && (noHealItem || grenadeThreat)) return this.fleeOrFight();
        // Been critical and unable to safely heal for too long - gamble on starting the
        // bandage right here instead of continuing to flee (or fight) toward a safety
        // this specific opponent is never going to grant. The existing heal-abort safety
        // net still cancels it the instant an actual hit lands. `desperateHeal` also
        // makes `update()`'s own `isSafeToHeal` gate wave the item through - directive
        // alone doesn't reach the actual bandage, see the field's own doc comment.
        this.desperateHeal = critical && this.criticalUnsafeElapsedS > DESPERATE_HEAL_S;
        if (this.desperateHeal) return "heal";

        // Even hurt myself (but not `critical` - survival above still takes priority
        // over that), a target who's already worse off than me is closer to dying than
        // I am - breaking off now just to heal hands them exactly the time they need to
        // recover, throwing away a fight that's already won. Real match evidence: a bot
        // at 40% retreated to heal while the enemy sat at 15%, well within finishing
        // range - by the time its own heal wrapped up, the enemy had used that same
        // window to heal all the way back to full and won the fight back. Requires
        // being genuinely ahead (their fraction below *both* mine and
        // `ENEMY_LOW_HEALTH_FRAC`, not just "also somewhat hurt") so this never fires
        // as an excuse to keep trading from a mutually bad position.
        // Uses the enemy's *remembered* health too, not just a currently visible reading -
        // a real match capture showed the bot heal/flee for several seconds at 52 HP while
        // the enemy, just out of sight, sat at 18 and got time to heal all the way back.
        // Push rules: an enemy at least `PUSH_HEALTH_ADVANTAGE_FRAC` down is always worth
        // pressing; below `FIGHT_FLOOR_FRAC` any health advantage is, ahead of healing.
        // Below the fight floor with a heal in hand, healing comes first: the bot retreats out of
        // sight and heals to the floor rather than pushing, even against a weaker enemy.
        // An enemy in finishing range is still pressed, even with a heal in hand.
        const healFirst = healthFrac < FIGHT_FLOOR_FRAC && !noHealItem
            && !(knownEnemyFrac !== undefined && knownEnemyFrac <= HEAL_FIRST_FINISH_FRAC);
        if (!critical && !healFirst && knownEnemyFrac !== undefined) {
            const pushAdvantage = knownEnemyFrac <= healthFrac - PUSH_HEALTH_ADVANTAGE_FRAC;
            const hurtAndAhead = healthFrac < FIGHT_FLOOR_FRAC
                && knownEnemyFrac < healthFrac - HEALTH_DEFICIT_MARGIN;
            // Above the fight floor a push needs a reason: the enemy is in finishing range, or we
            // have been hurting them. Otherwise, keep fighting.
            const pushWorthIt = healthFrac < FIGHT_FLOOR_FRAC
                || knownEnemyFrac <= PUSH_FINISH_FRAC
                || bot.game.now - this.lastEnemyDamageMs < RECENT_DAMAGE_DEALT_MS;
            if ((pushAdvantage && pushWorthIt) || hurtAndAhead) return "push";
        }
        if (low && !critical && !healFirst && knownEnemyFrac !== undefined) {
            if (knownEnemyFrac < healthFrac && knownEnemyFrac < ENEMY_LOW_HEALTH_FRAC) {
                return "push";
            }
        }
        // Low but not yet critical, and nothing to fix it with - disengage rather than
        // keep fighting (or even push) at real risk just because it isn't dire yet.
        // Except against a visible enemy that isn't ahead on health: real matches showed
        // the bot fleeing from such fights for 40-60% of its visible time while still
        // having a clean shot, so it fought back at range instead of running.
        // Too close to outrun, with a loaded gun on target and a clear line: running hands
        // the enemy free shots, so fight it out instead - even when it's ahead on health.
        const enemyDist = this.target ? v2.distance(this.player.pos, this.target.pos) : Infinity;
        const closeShotFight = !critical && enemyDist < CLOSE_FIGHT_DIST && this.lastCanFire
            && this.enemySightBlocksHeal(bot)
            && (bot.weaponManager.weapons[bot.weaponManager.curWeapIdx]?.ammo ?? 0) > 0;
        const holdInsteadOfFlee = !!this.target && !critical
            && (closeShotFight || !(knownEnemyFrac !== undefined && knownEnemyFrac - healthFrac > HEALTH_DEFICIT_MARGIN));
        if (low && noHealItem) return holdInsteadOfFlee ? "engageHold" : this.fleeOrFight();
        // Has a bandage but can't safely use it yet (almost always: the enemy can
        // still see it) - disengage to break line of sight rather than fight on hurt
        // and hope. Once concealed, `shouldHeal` flips to true on its own.
        if (low && !noHealItem && !canHealNow) {
            return holdInsteadOfFlee ? "engageHold" : this.fleeOrFight();
        }

        // A visible target actually hurt enough to be worth finishing is reason enough
        // to press it, on its own - no need to already be on a hit streak first, and
        // ahead of every check below it: a real fresh-air window on a target this hurt
        // rarely lasts long, and both an optional top-off heal (not yet `low`, just
        // `canHealNow`-eligible) and the post-heal grace retreat/a reload are exactly the
        // kind of "not actually urgent" pauses that hand a barely-alive target all the
        // time it needs to recover - same reasoning as the `low`-but-enemy-lower push
        // override above, just for the case where this bot itself isn't hurt at all.
        // `!low` (not a full `tier.healThreshold` bar - see the doc comment above) is
        // what stops "healed and immediately pushed while still low" without also
        // making the bot generally reluctant to press an advantage. Requiring a hit
        // streak *in addition* was the old "dumb push" fix's original mechanism; gating
        // on the target's actual health directly (see `ENEMY_LOW_HEALTH_FRAC`) is the
        // more direct fix, so the streak requirement was just needless hesitation once a
        // target is genuinely low. Short of that, `engageHold` still knows how to close
        // distance using cover instead.
        // Heal first below the floor: out of sight, not standing in the open waiting to push.
        if (healFirst && !canHealNow) return this.fleeOrFight();
        const enemyLow = knownEnemyFrac !== undefined && knownEnemyFrac < ENEMY_LOW_HEALTH_FRAC;
        if (!low && enemyLow && !healFirst) return "push";

        if (canHealNow) return "heal";
        // Just finished healing (or an abort just ended) - keep retreating for a short
        // grace window rather than immediately resuming the fight from right here. See
        // `POST_HEAL_RETREAT_COOLDOWN_S`.
        if (this.postHealRetreatCooldown > 0) return "flee";
        if (this.needsReload(bot)) return "reload";

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
        if (!hasBodyLineOfSight(bot.game, bot.pos, predictedPos, bot.layer)) return undefined;

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

    /** Whether enough time has passed since the last hit to start a non-critical heal - see
     *  `HEAL_QUIET_MS`. Critical bots heal regardless, that's the survival case. */
    private healQuietEnough(bot: Player): boolean {
        const critical = bot.health / GameConfig.player.health < this.tier.healThreshold * PANIC_HEALTH_FRAC_MULT;
        return critical || bot.game.now - this.lastHitTakenTime >= HEAL_QUIET_MS;
    }

    /** Whether a visible enemy should block starting a heal. Sticky for RECENTLY_VISIBLE_MS
     *  after the last sighting - a raw per-tick target read flickers as the enemy ducks in
     *  and out of view, so the heal/flee choice built on it flipped every tick and the bot
     *  never actually started a bandage. */
    private enemySightBlocksHeal(bot: Player): boolean {
        return bot.game.now - this.lastClearLineMs < RECENTLY_VISIBLE_MS;
    }

    /** Keeps a retreat (heal/flee) going for RETREAT_HOLD_MS after it was last chosen,
     *  instead of dropping straight to holding ground the instant a sight flicker makes the
     *  retreat's own gates read differently for a tick. A real match showed the bot cycling
     *  heal/flee/engageHold every few hundred ms with the cover spot unchanged, its movement
     *  reversing as it went. */
    private stickyRetreat(directive: CombatDirective, bot: Player): CombatDirective {
        const retreating = directive === "heal" || directive === "flee";
        if (retreating) {
            this.lastRetreat = directive;
            this.lastRetreatMs = bot.game.now;
            return directive;
        }
        const recent = bot.game.now - this.lastRetreatMs < RETREAT_HOLD_MS;
        const stillHurt = bot.health / GameConfig.player.health < this.tier.healThreshold;
        if (directive === "engageHold" && this.lastRetreat && recent && stillHurt) {
            return this.lastRetreat;
        }
        return directive;
    }

    /** The enemy's health fraction right now if visible, else the last sighting's while
     *  it's still inside `threatPos`'s own memory window - `undefined` once that's stale. */
    private knownEnemyHealthFrac(bot: Player): number | undefined {
        if (this.target) return this.target.health / GameConfig.player.health;
        if (this.lastKnownEnemyHealthFrac === undefined) return undefined;
        if (bot.game.now - this.lastKnownEnemyTimeMs > this.tier.memory * 1000) return undefined;
        return this.lastKnownEnemyHealthFrac;
    }

    private think(): void {
        this.target = findVisibleTarget(this.player);
        // Track whether the bot is actually landing damage on its target - above the fight floor
        // that's the only reason to push someone who is merely behind on health.
        if (this.target) {
            if (this.target === this.lastDamageTarget && this.target.health < this.lastTargetHealth) {
                this.lastEnemyDamageMs = this.player.game.now;
            }
            this.lastDamageTarget = this.target;
            this.lastTargetHealth = this.target.health;
        }
        if (this.target && (hasBodyLineOfSight(this.player.game, this.player.pos, this.target.pos, this.player.layer)
            || hasBodyLineOfSight(this.player.game, muzzlePos(this.target), this.player.pos, this.player.layer))) {
            this.lastClearLineMs = this.player.game.now;
        }
        this.state = this.target ? "engage" : "idle";
        if (this.target) {
            this.lastKnownEnemyPos = v2.copy(this.target.pos);
            this.lastKnownEnemyTimeMs = this.player.game.now;
            this.lastKnownEnemyHealthFrac = this.target.health / GameConfig.player.health;
        }
    }
}
