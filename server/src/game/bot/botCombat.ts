import type { BulletDef } from "../../../../shared/defs/gameObjects/bulletDefs.ts";
import type { HealDef } from "../../../../shared/defs/gameObjects/gearDefs.ts";
import type { GunDef } from "../../../../shared/defs/gameObjects/gunDefs.ts";
import type { ThrowableDef } from "../../../../shared/defs/gameObjects/throwableDefs.ts";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import { GameConfig, type InventoryItem, WeaponSlot } from "../../../../shared/gameConfig.ts";
import { ObjectType } from "../../../../shared/net/objectSerializeFns.ts";
import { coldet } from "../../../../shared/utils/coldet.ts";
import { collider } from "../../../../shared/utils/collider.ts";
import { util } from "../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { Obstacle } from "../objects/obstacle.ts";
import type { Player } from "../objects/player.ts";
import type { BotTierDef } from "./botDefs.ts";

/** Fire-mode-specific trigger state, persisted across ticks by the brain.
 *  `burstTimer < 0` is the "not engaged yet" sentinel: a fresh engagement must start by
 *  firing immediately, not by toggling straight into a pause window. */
export class BotFireState {
    burstTimer = -1;
    firing = true;
    /** Has the *current* weapon actually fired since the last quickswitch landed on
     *  it? Gates the next quickswitch - see `updateWeaponSelection`. Starts true so
     *  the very first engagement isn't blocked. */
    firedSinceSwitch = true;
}

function gunDefOf(type: string): GunDef | undefined {
    if (!type) return undefined;
    const def = GameObjectDefs.typeToDefSafe(type);
    return def?.type === "gun" ? (def as GunDef) : undefined;
}

function hasAmmo(bot: Player, slot: number): boolean {
    const weapon = bot.weaponManager.weapons[slot];
    return !!weapon.type && weapon.ammo > 0;
}

/** How far this gun wants to be used from, in units. Shotguns want close, slow
 *  bolt-actions want as much range as practical, everything else sits in the middle.
 *  Capped well below the bullet's absolute falloff distance (a mosin's 500 units is
 *  "can hit anything on screen", not "wants to stand 500 units away") so a bot never
 *  tries to backpedal off the edge of the map to reach its theoretical sweet spot.
 *
 *  The bolt-action cap (originally 70) was still far too generous for this specific
 *  matchup: decoding 40 real human-vs-human 1v1 matches on this same compact arena, with
 *  this same mosin/shotgun loadout, showed real mosin engagements sitting at a median of
 *  just 14.2 (average 15.8) - real players hold this close with a bolt-action and win
 *  anyway. At 70, `engageHold`'s hold band sat so far past `MAX_RETREAT_DIST` that the
 *  bot spent real fights hovering right at the 20-unit retreat edge - exactly where
 *  actual engagements happen - instead of ever committing to trade, which throttled its
 *  effective shots-per-minute well below a human's despite comparable accuracy. */
function sweetSpotFor(gunDef: GunDef): number {
    const bulletDef = GameObjectDefs.typeToDefSafe(gunDef.bulletType) as
        | BulletDef
        | undefined;
    const maxRange = bulletDef?.distance ?? 60;
    if (gunDef.bulletCount > 1) return Math.min(10, maxRange * 0.3);
    if (gunDef.fireDelay > 1.1) return Math.min(18, maxRange * 0.85);
    return Math.min(45, maxRange * 0.45);
}

function scoreWeaponForRange(type: string, dist: number): number {
    const def = gunDefOf(type);
    if (!def) return -Infinity;
    return -Math.abs(dist - sweetSpotFor(def));
}

/** The current gun's preferred engagement distance, or a generic mid-range default
 *  when nothing is equipped (e.g. bare fists). Used by botMovement to decide whether
 *  to close in, back off, or strafe. */
export function currentSweetSpot(bot: Player): number {
    const def = gunDefOf(bot.weaponManager.activeWeapon);
    return def ? sweetSpotFor(def) : 25;
}

/** The equipped slot (Primary/Secondary) that best fits `dist`, regardless of whether
 *  it's currently ready to fire - "what do I want to be holding". */
function bestRangeSlot(bot: Player, slots: number[], dist: number): number {
    const wm = bot.weaponManager;
    let best = slots[0];
    let bestScore = scoreWeaponForRange(wm.weapons[best].type, dist);
    for (let i = 1; i < slots.length; i++) {
        const score = scoreWeaponForRange(wm.weapons[slots[i]].type, dist);
        if (score > bestScore) {
            best = slots[i];
            bestScore = score;
        }
    }
    return best;
}

/** Switches to `slot` (and marks it as not-yet-fired) if it's actually ready and isn't
 *  already current. Used for both the range-preference switch and quickswitch, so
 *  every path that can switch weapons also arms the same "must fire before switching
 *  away again" commitment. */
function switchTo(bot: Player, fire: BotFireState, slot: number): boolean {
    const wm = bot.weaponManager;
    if (slot === wm.curWeapIdx || !hasAmmo(bot, slot) || wm.weapons[slot].cooldown > 0) {
        return false;
    }
    wm.setCurWeapIndex(slot);
    fire.firedSinceSwitch = false;
    return true;
}

/**
 * Picks the better of the Primary/Secondary slots for the current range, and - on
 * `hard`/`expert` bots only - performs the "quickswitch" tech real players use: swap
 * away (to the other gun, or to melee if that's not viable) the instant a shot leaves
 * the bot slowed, then swap back.
 *
 * The point isn't DPS - it's mobility. `Player.recalculateSpeed` applies a flat 50%
 * movement penalty for the whole `shotSlowdownTimer` window after *any* shot from
 * *any* gun (up to 1.75s for a bolt-action rifle), regardless of that gun's own
 * `speed.attack` stat. `setCurWeapIndex` instantly zeroes that timer by default
 * (`cancelSlowdown`) - so switching away, even to a weapon the bot has no intention of
 * actually firing, converts "stuck at half speed for over a second" into "back at full
 * speed immediately". A human player does this reflexively; a solid bot has to too,
 * "wasted" switch-delay and all - being able to move is worth more than the marginal
 * DPS a non-free switch costs.
 *
 * Three things keep this from degenerating into aimless flip-flopping:
 * - It never fires while a burst is in flight (auto/burst fire modes): a weapon
 *   already cycling every fraction of a second re-applies its own slowdown on every
 *   shot anyway, so interrupting the burst to "dodge" it just forfeits DPS for nothing.
 * - Once *any* switch happens, nothing switches away *from a gun* again until that gun
 *   has actually fired (`fire.firedSinceSwitch`) - without this a bot can ping-pong
 *   between two guns without ever pulling either trigger, because the switch-in delay
 *   for a non-free switch can outlast the other gun's own cooldown clearing again in
 *   the meantime. Parking on melee purely to shed slowdown is exempt from this - it
 *   was never a commitment to actually fight with fists, so the very next tick is free
 *   to swap back onto whichever gun's cooldown is ready first.
 * - It's skipped entirely while the bot is mid-action (healing, reviving, ...) -
 *   `setCurWeapIndex` unconditionally cancels whatever action is in progress, and a
 *   bot fiddling with its loadout mid-bandage is exactly the "heals but keeps
 *   interrupting itself" bug this guards against.
 *
 * Lower tiers never quickswitch: they only ever move to the range-preferred slot, and
 * only once it's actually ready - they wait out a cooldown (and the slowdown with it)
 * rather than juggle weapons to dodge it.
 *
 * `isFleeing` (the brain's `flee`/`heal` directive) is a separate, tier-independent
 * reason to hold melee: `Player.recalculateSpeed` adds `weaponDef.speed.equip` every
 * tick, which is +1 for fists but 0 for every gun in the game - a permanent, "free"
 * speed edge over a pursuer that has nothing to do with `shotSlowdownTimer` and applies
 * even to a bot that never fired a shot. Worth more than staying combat-ready while the
 * actual goal right now is putting distance, not winning a stand-up fight - see the
 * `cur !== Primary/Secondary` branch below for the other half (staying on melee instead
 * of immediately snapping back to a gun) and the un-flagged case for switching back the
 * moment fleeing ends.
 *
 * Also requires `!recentContact`: real match debug logging caught the bot holding
 * fists while the enemy was visible and as close as 1-3 units, unable to fire back at
 * all right when it mattered most. A first fix gating this on the bot's own *current*
 * visibility check wasn't enough - a full decoded-replay pass showed 50 of 51 "on
 * melee" sightings landed within 2s of the human actually firing at it, 27 of 104
 * match-seconds spent unarmed. The bot's own FOV is deliberately much narrower than
 * what a real player can actually see/track (see `viewHalfExtentsFor`), so "I don't
 * currently see them" is a bad proxy for "they can't see or hit me" - the asymmetry is
 * exactly backwards from what's safe. `recentContact` is `!sustainedlyLost` instead -
 * the same bar `isSafeToHeal` already trusts for "the fight has genuinely paused"
 * (a real multi-second gap, not just this tick's momentary non-sighting) - so melee only
 * gets preferred once there's real confidence nothing is still tracking the bot.
 */
export function updateWeaponSelection(
    bot: Player,
    tier: BotTierDef,
    fire: BotFireState,
    dist: number,
    isFleeing = false,
    recentContact = false,
): void {
    if (bot.actionType !== GameConfig.Action.None) return;

    const wm = bot.weaponManager;
    const preferMelee = isFleeing && !recentContact;
    // An in-progress bot-initiated grenade throw (see `updateThrowable`) owns this slot
    // until the weapon manager actually releases it - without this, the very first
    // check below (not holding a gun) would immediately switch straight back to a gun
    // before `cookThrowable`/`throwThrowable` ever got a chance to run, since a
    // throwable slot obviously never counts as "holding a gun" either.
    if (wm.curWeapIdx === WeaponSlot.Throwable) return;

    const slots = [WeaponSlot.Primary, WeaponSlot.Secondary].filter(
        (i) => wm.weapons[i].type,
    );
    if (!slots.length) return;

    const cur = wm.curWeapIdx;
    const meleeType = wm.weapons[WeaponSlot.Melee].type;

    // Not holding a gun at all - fresh spawn, right after a role assigns weapons into
    // slots but leaves `curWeapIdx` on melee (see `Player.promoteToRole`/`setWeapon`),
    // or a first-ever pickup in BR. A human client auto-sends
    // Input.EquipPrimary/Secondary here; bots have to do the equivalent themselves or
    // they'll stand there holding fists forever. Unconditional - being unarmed is
    // strictly worse than holding an empty gun (which `updateReload` then handles) -
    // *except* while genuinely fleeing on melee already, where staying unarmed for the
    // speed bonus is the whole point (see the doc comment above).
    if (cur !== WeaponSlot.Primary && cur !== WeaponSlot.Secondary) {
        if (preferMelee && cur === WeaponSlot.Melee && meleeType) return;
        wm.setCurWeapIndex(bestRangeSlot(bot, slots, dist));
        fire.firedSinceSwitch = true; // wasn't holding a gun to have fired anyway
        return;
    }

    // Hurt and running, with nothing actually watching right now: trade the gun for
    // melee's speed bonus - see the doc comment above. Reconsidered every tick, so the
    // moment fleeing ends *or* the target reappears, this falls through to the "not
    // holding a gun" branch above instead and re-equips a real gun.
    if (preferMelee && meleeType) {
        wm.setCurWeapIndex(WeaponSlot.Melee);
        fire.firedSinceSwitch = true;
        return;
    }

    // Current gun just ran dry - a loaded gun at the wrong range is still strictly
    // better than an empty one at the right range, so this jumps the range-preference
    // logic below entirely rather than waiting for it to happen to agree. Whichever
    // weapon this leaves equipped, `updateReload` (called after this every tick) picks
    // up requesting a reload for it.
    if (!hasAmmo(bot, cur)) {
        const loaded = slots.find((i) => i !== cur && hasAmmo(bot, i));
        if (loaded !== undefined) {
            switchTo(bot, fire, loaded);
            return;
        }
        // No loaded alternative either - fall through to the quickswitch-to-melee
        // logic below (still worth shedding `shotSlowdownTimer` even with nothing to
        // shoot) rather than getting stuck holding a gun that can't fire.
    }

    if (tier.quickswitch && fire.firedSinceSwitch && bot.shotSlowdownTimer > 0) {
        const curDef = gunDefOf(wm.weapons[cur].type);
        const burstInFlight = curDef?.fireMode === "auto" || curDef?.fireMode === "burst";
        if (!burstInFlight) {
            const alt = slots.find((i) => i !== cur && hasAmmo(bot, i));
            if (alt !== undefined) {
                wm.setCurWeapIndex(alt);
            } else if (wm.weapons[WeaponSlot.Melee].type) {
                // No usable second gun - park on melee just long enough to shed the
                // slowdown. Melee doesn't track "ammo", so this bypasses `switchTo`'s
                // ammo check on purpose.
                wm.setCurWeapIndex(WeaponSlot.Melee);
            }
            // Either way, this was purely to dodge the slowdown, not a commitment to
            // actually fight with whatever we landed on - free to reconsider next tick.
            fire.firedSinceSwitch = true;
            return;
        }
    }

    // Committed to the current weapon until it's actually fired at least once - see
    // the doc comment above for why this matters.
    if (!fire.firedSinceSwitch) return;

    switchTo(bot, fire, bestRangeSlot(bot, slots, dist));
}

/** Same effect as a human pressing the reload key: just requests one, the weapon
 *  manager owns the actual timing/animation.
 *
 *  Single-loader guns (shell-by-shell reload - `maxReload < maxClip`, a pump/bolt gun's
 *  tube or chamber, as opposed to swapping a whole magazine) top off whenever it's safe
 *  to, not just once fully dry - "soll single reload guns wie spas und mosin immer
 *  reloaden wenn gerade möglich um eig immer full mag zu haben", the same habit a real
 *  player has of topping off a shotgun/bolt gun between engagements instead of waiting
 *  to run completely dry. A magazine gun still only reloads once empty: swapping a mag
 *  that's merely down a few rounds burns the *entire* magazine's worth of downtime for
 *  no reason a single-loader (down one shell costs one shell's worth of downtime) never
 *  has. Gated on no currently visible target so this never chooses to top off instead
 *  of firing back mid-exchange - there's nothing to gain from one extra shell while
 *  already able to shoot. */
export function updateReload(bot: Player, hasVisibleTarget: boolean): void {
    const wm = bot.weaponManager;
    const cur = wm.curWeapIdx;
    if (cur !== WeaponSlot.Primary && cur !== WeaponSlot.Secondary) return;
    const weapon = wm.weapons[cur];
    if (!weapon.type || wm.scheduledReload) return;
    if (weapon.ammo <= 0) {
        wm.scheduledReload = true;
        return;
    }
    if (hasVisibleTarget) return;
    const def = GameObjectDefs.typeToDefSafe(weapon.type) as GunDef;
    const stats = wm.getAmmoStats(def);
    if (stats.maxReload < stats.maxClip && weapon.ammo < stats.maxClip) {
        wm.scheduledReload = true;
    }
}

/** True if a living teammate sits between the bot and `targetPos` - the single most
 *  annoying thing a bot can do in a squad. Takes a position rather than a `Player` so
 *  it also covers a blind throw at a merely-remembered spot (see `updateThrowable`'s
 *  bait case), not just a directly visible target. */
function friendlyFireInLine(bot: Player, targetPos: Vec2): boolean {
    const mates = bot.group?.livingPlayers;
    if (!mates || mates.length <= 1) return false;

    const from = bot.pos;
    const dir = v2.sub(targetPos, from);
    const len = v2.length(dir);
    if (len < 0.01) return false;
    const nDir = v2.mul(dir, 1 / len);

    for (const mate of mates) {
        if (mate === bot) continue;
        const toMate = v2.sub(mate.pos, from);
        const proj = v2.dot(toMate, nDir);
        if (proj <= 0 || proj >= len) continue;
        const closest = v2.add(from, v2.mul(nDir, proj));
        if (v2.distance(closest, mate.pos) < 1.2) return true;
    }
    return false;
}

/**
 * Fire gate + trigger discipline. `canFire` (from `updateAim`) already covers reaction
 * time and the aim cone; this layer adds ammo, effective range and friendly fire, then
 * drives `shootStart`/`shootHold` per the weapon's own fire mode so single/dual guns
 * pulse once per shot instead of firing every tick.
 *
 * `targetPos` is just the position being aimed at - a real bullet's collision is
 * resolved by physics along `bot.dir` regardless of what's actually there, so this never
 * needed a live `Player` for anything beyond that one position (friendly-fire, range).
 * That's what lets `BotBrain` also fire this during a brief, predicted offscreen shot
 * (see `updateAim`'s `AimTarget`) with no special-casing here at all.
 */
export function updateFiring(
    bot: Player,
    tier: BotTierDef,
    fire: BotFireState,
    targetPos: Vec2 | undefined,
    dist: number,
    canFire: boolean,
    dt: number,
): void {
    const wm = bot.weaponManager;
    const cur = wm.curWeapIdx;
    const gunDef = gunDefOf(wm.activeWeapon);

    if (!targetPos || !gunDef || !canFire || bot.actionType !== GameConfig.Action.None) {
        bot.shootHold = false;
        fire.firing = true;
        fire.burstTimer = -1; // next engagement starts by firing, see BotFireState
        return;
    }
    if (cur !== WeaponSlot.Primary && cur !== WeaponSlot.Secondary) {
        bot.shootHold = false;
        return;
    }
    const weapon = wm.weapons[cur];
    if (weapon.ammo <= 0) {
        bot.shootHold = false;
        return;
    }
    const bulletDef = GameObjectDefs.typeToDefSafe(gunDef.bulletType) as
        | BulletDef
        | undefined;
    if (bulletDef && dist > bulletDef.distance * 0.9) {
        bot.shootHold = false;
        return;
    }
    if (friendlyFireInLine(bot, targetPos)) {
        bot.shootHold = false;
        return;
    }

    if (gunDef.fireMode === "auto" || gunDef.fireMode === "burst") {
        // Sustained fire for a while, then a short pause - firing with no breathing
        // room at all reads as a bot.
        if (fire.burstTimer < 0) {
            // Fresh engagement: start by firing a full window, not by toggling
            // straight into a pause.
            fire.firing = true;
            fire.burstTimer = util.random(tier.burstMin, tier.burstMax);
        } else {
            fire.burstTimer -= dt;
        }
        if (fire.burstTimer <= 0) {
            fire.firing = !fire.firing;
            fire.burstTimer = fire.firing
                ? util.random(tier.burstMin, tier.burstMax)
                : util.random(0.1, 0.3);
        }
        bot.shootHold = fire.firing;
        if (fire.firing) fire.firedSinceSwitch = true;
    } else {
        // "single"/"dual": weaponManager clears `shootStart` once it consumes it, so a
        // fresh pulse here fires exactly once per shot instead of every tick.
        if (weapon.cooldown <= 0) {
            bot.shootStart = true;
            fire.firedSinceSwitch = true;
        }
        bot.shootHold = false;
    }
}

/** The best available heal item for `healthFrac`, or undefined if the bot has nothing
 *  usable - exported so the brain can also ask "do I even have a way to heal right
 *  now" when deciding whether being critically low means fleeing instead.
 *
 * Bandage vs. medkit is a real time/risk trade-off, not just "how much is missing":
 * a medkit is one `useTime`-long commitment to a full heal, a bandage is several
 * `heal`-sized chunks that can be interrupted between uses but adds up to more total
 * time once more than a couple are needed. `positionSafe` (real cover, or a sustained,
 * confident break in contact - see `BotBrain`'s `SUSTAINED_LOST_MS`) is what makes that
 * longer medkit commitment worth it: reaching for the slower-but-bigger heal on a
 * position that can't actually absorb 6 uninterrupted seconds just trades a shorter
 * bandage tick (which can bail between uses) for a longer, harder-to-abort one.
 *
 * `healThreshold` (the caller's `BotTierDef.healThreshold`) bounds how much "missing"
 * actually counts toward that comparison - real match replays showed the bot picking a
 * medkit over a bandage almost every single time it healed at all, something a decoded
 * human player's own games never did nearly as lopsidedly. The old comparison measured
 * bandage time against healing the *entire* deficit back to 100, but `shouldHeal` stops
 * wanting to heal at all once back past `healThreshold` - a bot is never actually going
 * to sit there bandaging all the way to full, so judging the bandage plan against a
 * regimen it would never finish systematically made the medkit look faster than the
 * bandage count it would genuinely take. Comparing against the threshold instead - what
 * a heal decision actually needs to close - routinely favors a single quick bandage for
 * an ordinary top-up, only reaching for the medkit once genuinely several bandages'
 * worth behind, matching how real players mix the two. */
export function pickHealItem(
    bot: Player,
    healthFrac: number,
    positionSafe: boolean,
    healThreshold: number,
): InventoryItem | undefined {
    const missingToThreshold = Math.max(0, (healThreshold - healthFrac) * GameConfig.player.health);
    const bandageDef = GameObjectDefs.typeToDefSafe("bandage") as HealDef;
    const healthkitDef = GameObjectDefs.typeToDefSafe("healthkit") as HealDef;
    const bandageTime = Math.ceil(missingToThreshold / bandageDef.heal) * bandageDef.useTime;
    const medkitFaster = healthkitDef.useTime < bandageTime;

    // Critically hurt: grab whichever heals at all regardless of position - at this
    // point delaying is the bigger risk, not the exposure window a medkit costs.
    const wantsFull = healthFrac <= 0.25 || (medkitFaster && positionSafe);
    const order: InventoryItem[] = wantsFull
        ? ["healthkit", "bandage"]
        : ["bandage", "healthkit"];

    for (const item of order) {
        if (!bot.invManager.has(item)) continue;
        const def = GameObjectDefs.typeToDefSafe(item) as HealDef;
        if (bot.health < def.maxHeal) return item;
    }
    return undefined;
}

/** Whether the bot wants to heal right now: hurt, not mid-action, and either no
 *  visible enemy or critically low regardless. Split from `updateHeal` so the brain
 *  can also use it to decide *movement* (retreat instead of engaging) on the same
 *  tick it decides to heal, before actually spending the item. */
/** `desperate` (see `BotBrain.desperateHeal`/`DESPERATE_HEAL_MS`) skips the
 *  visible-enemy gate specifically - `actionType`/`cookingThrowable`/already-healed-past-
 *  threshold still apply regardless, since none of those are the "opponent won't ever
 *  let up" deadlock this exists for. */
export function shouldHeal(
    bot: Player,
    tier: BotTierDef,
    hasVisibleEnemy: boolean,
    positionSafe: boolean,
    desperate = false,
): boolean {
    if (bot.actionType !== GameConfig.Action.None) return false;
    if (bot.weaponManager.cookingThrowable) return false;

    const healthFrac = bot.health / GameConfig.player.health;
    if (healthFrac >= tier.healThreshold) return false;
    if (!desperate && hasVisibleEnemy && healthFrac > 0.25) return false;

    return pickHealItem(bot, healthFrac, positionSafe, tier.healThreshold) !== undefined;
}

/** Heals when hurt and it's safe to. See `shouldHeal` for the decision. */
export function updateHeal(
    bot: Player,
    tier: BotTierDef,
    hasVisibleEnemy: boolean,
    positionSafe: boolean,
    desperate = false,
): void {
    if (!shouldHeal(bot, tier, hasVisibleEnemy, positionSafe, desperate)) return;
    const healthFrac = bot.health / GameConfig.player.health;
    const item = pickHealItem(bot, healthFrac, positionSafe, tier.healThreshold);
    if (item) bot.useHealingItem(item);
}

/** Standard damage-dealing throwables, in priority order - deliberately excludes
 *  `smoke`/`strobe`/utility throwables, which don't hurt anyone at the target and would
 *  just waste the "throw something" action on nothing. */
const OFFENSIVE_THROWABLES: InventoryItem[] = ["frag", "mirv"];

/** Never lob one closer than this - `explosion_frag`'s own blast radius (`rad.max`,
 *  `explosionsDefs.ts`) is 12 units, so anything nearer risks the bot catching its own
 *  splash. Never bother past this either - beyond it a thrown arc becomes an unreliable,
 *  hard-to-land tool compared to just shooting, even before the game's own throw-power
 *  clamp (`throwableMaxMouseDist`) starts capping the distance further. */
const THROW_MIN_DIST = 14;
const THROW_MAX_DIST = 30;

/** How far immediately in front of the bot has to be clear before it even considers
 *  throwing - "wirft Granaten manchmal einfach vor sich gegen eine Wand". Deliberately
 *  *not* a full line-of-sight check all the way to `threatPos`: the bait case's whole
 *  point is throwing at someone who's specifically NOT in sight, over or around cover
 *  further away (a real throw arcs *over* a low obstacle it hasn't gained height to
 *  clear yet only matters right at the start) - this only catches a wall immediately
 *  blocking the bot's own throw, well short of `THROW_MIN_DIST`. */
const THROW_CLEARANCE_DIST = 6;

/** Sweeps the thrown projectile's own collision radius (not a thin ray - see below)
 *  along the intended throw direction for `THROW_CLEARANCE_DIST`. A real match capture
 *  showed a grenade thrown at a correctly-ranged, genuinely visible target instead clip
 *  a wall right next to the bot, *bounce* (`Projectile`'s own obstacle collision
 *  reflects it at 30% speed rather than just stopping it) and detonate back within its
 *  own blast radius on the bot that threw it. A zero-width line-of-sight ray checked
 *  over that same short distance used to miss exactly the kind of close wall/corner a
 *  bot is *most* likely to be pressed against right when it decides to throw a covering
 *  grenade while fleeing - the same "thin ray sees past what the real, radius-having
 *  thing would still hit" gap `isDirClear` has its own fix for. */
function hasThrowClearance(bot: Player, dir: Vec2, projectileRad: number): boolean {
    const dist = THROW_CLEARANCE_DIST;
    const aabb = collider.createAabbExtents(
        bot.pos,
        v2.create(dist + projectileRad + 1, dist + projectileRad + 1),
    );
    const objs = bot.game.grid.intersectCollider(aabb);
    const obstacles: Obstacle[] = [];
    for (let i = 0; i < objs.length; i++) {
        if (objs[i].__type !== ObjectType.Obstacle) continue;
        const o = objs[i] as Obstacle;
        if (o.dead || !o.collidable || o.isWindow) continue;
        if (!util.sameLayer(o.layer, bot.layer)) continue;
        obstacles.push(o);
    }
    const steps = Math.ceil(dist);
    for (let s = 1; s <= steps; s++) {
        const probe = collider.createCircle(v2.add(bot.pos, v2.mul(dir, Math.min(s, dist))), projectileRad);
        for (let i = 0; i < obstacles.length; i++) {
            if (coldet.test(probe, obstacles[i].collider)) return false;
        }
    }
    return true;
}

/** Per-bot grenade-throw state, persisted across ticks by the brain. */
export class BotThrowState {
    /** Seconds until the next throw is even considered - staggered per bot so they
     *  don't all open an engagement by lobbing a grenade on the very first tick. */
    cooldown = util.random(2, 5);
    /** Mid-throw: the bot has switched to the throwable slot and is waiting for
     *  `weaponManager` to actually release it (`cookThrowable`/`throwThrowable`,
     *  `GameConfig.player.cookTime` = 0.1s later) before switching back to `returnSlot`. */
    active = false;
    returnSlot: number = WeaponSlot.Primary;
}

/** The best owned offensive throwable, or undefined if the bot has none left. */
function pickOffensiveThrowable(bot: Player): InventoryItem | undefined {
    for (const type of OFFENSIVE_THROWABLES) {
        if (bot.invManager.has(type)) return type;
    }
    return undefined;
}

/**
 * Tactical grenade use - deliberately *not* a general "target visible, worth hurting"
 * tool: a gun is always the better choice whenever it's actually usable, so this never
 * throws just because a target happens to be there and in range. Only three cases earn
 * the slot instead of a bullet, all cases where shooting genuinely isn't the better
 * option right now - "das macht nur Sinn wenn der Gegner hinter Cover healt, oder man ihn
 * aus der Cover baiten will um ihn zu pushen, oder wenn man weg läuft um zu reseten":
 * - The enemy just ducked out of sight nearby (`justLostSight`, see `BotBrain`'s
 *   `recentlyVisible`) - can't shoot what it can't see, so lobbing one at `threatPos`,
 *   their last-known spot, is exactly the "bait them out of cover" tactic a real player
 *   uses a grenade for.
 * - The enemy has been out of sight long enough (`enemyLikelyHealing`, see `BotBrain`'s
 *   `sustainedlyLost`) that they're very likely holding still behind cover healing, not
 *   just mid-peek-cycle - a much better-telegraphed target than the instant-after-
 *   `justLostSight` case above, worth its own throw even once that shorter window has
 *   already passed without one landing.
 * - The bot itself is hurt enough to be retreating (`isFleeing` - the brain's `flee`/
 *   `heal` directive) - trying to out-shoot a healthy pursuer while low is a losing
 *   trade; tossing one back at the threat to cover the retreat is worth the slot even
 *   though winning the fight outright isn't the goal here.
 *
 * `bot.dirNew` is aimed at `threatPos` explicitly in all three cases, since `updateAim`
 * only ever tracks a currently-visible target and leaves `dir` untouched once one isn't.
 *
 * `hasCleanShot` (visible target, reaction elapsed, aim within the fire cone - see
 * `updateAim`'s own `canFire`) guards the `isFleeing` case specifically: a real match
 * capture showed the bot interrupt a dead-on, ready shot at 15-23 units the instant
 * health crossed the flee threshold, wasting the ~0.1s `cookTime` switch-away (and the
 * shot itself) on a grenade instead - "oft wären gezielte Schüsse eig besser". The other
 * two cases never need this guard: both already require the target to not currently be
 * visible (`justLostSight` is only "was visible a moment ago", `enemyLikelyHealing`
 * requires a sustained *lack* of sight), so `hasCleanShot` is always false for them
 * anyway - a shot that isn't there can't be interrupted.
 *
 * Only owns the `Throwable` weapon slot while `active` - `updateWeaponSelection` leaves
 * that slot alone for the same reason (see its own guard), and this hands it straight
 * back to `returnSlot` the instant `weaponManager` reports the throw resolved, so a
 * grenade never costs more than the ~0.1s `cookTime` of not being able to shoot back.
 */
export function updateThrowable(
    bot: Player,
    throwState: BotThrowState,
    threatPos: Vec2 | undefined,
    engageDist: number,
    justLostSight: boolean,
    enemyLikelyHealing: boolean,
    isFleeing: boolean,
    hasCleanShot: boolean,
    dt: number,
): void {
    const wm = bot.weaponManager;

    if (throwState.active) {
        if (!wm.cookingThrowable) {
            throwState.active = false;
            if (wm.weapons[throwState.returnSlot].type) {
                wm.setCurWeapIndex(throwState.returnSlot);
            }
        }
        return;
    }

    throwState.cooldown -= dt;
    if (throwState.cooldown > 0) return;
    if (bot.actionType !== GameConfig.Action.None) return;
    const fleeingWithoutAShot = isFleeing && !hasCleanShot;
    if (!threatPos || !(justLostSight || enemyLikelyHealing || fleeingWithoutAShot)) return;
    if (friendlyFireInLine(bot, threatPos)) return;
    if (engageDist < THROW_MIN_DIST || engageDist > THROW_MAX_DIST) return;

    const grenadeType = pickOffensiveThrowable(bot);
    if (!grenadeType) return;

    const throwDir = v2.normalizeSafe(v2.sub(threatPos, bot.pos));
    const projectileRad = (GameObjectDefs.typeToDefSafe(grenadeType) as ThrowableDef).rad;
    if (!hasThrowClearance(bot, throwDir, projectileRad)) return;

    // Aimed explicitly at the intended spot, not left to whatever `bot.dir` currently
    // is - a blast-radius weapon can afford to just aim straight at it rather than
    // waiting out however much turn is still in progress.
    bot.dirNew = throwDir;

    const cur = wm.curWeapIdx;
    throwState.returnSlot = cur === WeaponSlot.Primary || cur === WeaponSlot.Secondary
        ? cur
        : WeaponSlot.Primary;
    throwState.active = true;
    throwState.cooldown = util.random(5, 9);

    wm.setWeapon(WeaponSlot.Throwable, grenadeType, 0);
    wm.setCurWeapIndex(WeaponSlot.Throwable);
    bot.shootStart = true;
}
