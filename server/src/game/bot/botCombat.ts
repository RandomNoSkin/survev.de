import type { BulletDef } from "../../../../shared/defs/gameObjects/bulletDefs.ts";
import type { HealDef } from "../../../../shared/defs/gameObjects/gearDefs.ts";
import type { GunDef } from "../../../../shared/defs/gameObjects/gunDefs.ts";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import { GameConfig, type InventoryItem, WeaponSlot } from "../../../../shared/gameConfig.ts";
import { util } from "../../../../shared/utils/util.ts";
import { v2 } from "../../../../shared/utils/v2.ts";
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
 *  tries to backpedal off the edge of the map to reach its theoretical sweet spot. */
function sweetSpotFor(gunDef: GunDef): number {
    const bulletDef = GameObjectDefs.typeToDefSafe(gunDef.bulletType) as
        | BulletDef
        | undefined;
    const maxRange = bulletDef?.distance ?? 60;
    if (gunDef.bulletCount > 1) return Math.min(10, maxRange * 0.3);
    if (gunDef.fireDelay > 1.1) return Math.min(70, maxRange * 0.85);
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
 */
export function updateWeaponSelection(
    bot: Player,
    tier: BotTierDef,
    fire: BotFireState,
    dist: number,
): void {
    if (bot.actionType !== GameConfig.Action.None) return;

    const wm = bot.weaponManager;
    const slots = [WeaponSlot.Primary, WeaponSlot.Secondary].filter(
        (i) => wm.weapons[i].type,
    );
    if (!slots.length) return;

    const cur = wm.curWeapIdx;

    // Not holding a gun at all - fresh spawn, right after a role assigns weapons into
    // slots but leaves `curWeapIdx` on melee (see `Player.promoteToRole`/`setWeapon`),
    // or a first-ever pickup in BR. A human client auto-sends
    // Input.EquipPrimary/Secondary here; bots have to do the equivalent themselves or
    // they'll stand there holding fists forever. Unconditional - being unarmed is
    // strictly worse than holding an empty gun (which `updateReload` then handles).
    if (cur !== WeaponSlot.Primary && cur !== WeaponSlot.Secondary) {
        wm.setCurWeapIndex(bestRangeSlot(bot, slots, dist));
        fire.firedSinceSwitch = true; // wasn't holding a gun to have fired anyway
        return;
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
 *  manager owns the actual timing/animation. */
export function updateReload(bot: Player): void {
    const wm = bot.weaponManager;
    const cur = wm.curWeapIdx;
    if (cur !== WeaponSlot.Primary && cur !== WeaponSlot.Secondary) return;
    const weapon = wm.weapons[cur];
    if (!weapon.type || weapon.ammo > 0 || wm.scheduledReload) return;
    wm.scheduledReload = true;
}

/** True if a living teammate sits between the bot and the target - the single most
 *  annoying thing a bot can do in a squad. */
function friendlyFireInLine(bot: Player, target: Player): boolean {
    const mates = bot.group?.livingPlayers;
    if (!mates || mates.length <= 1) return false;

    const from = bot.pos;
    const dir = v2.sub(target.pos, from);
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
 */
export function updateFiring(
    bot: Player,
    tier: BotTierDef,
    fire: BotFireState,
    target: Player | undefined,
    dist: number,
    canFire: boolean,
    dt: number,
): void {
    const wm = bot.weaponManager;
    const cur = wm.curWeapIdx;
    const gunDef = gunDefOf(wm.activeWeapon);

    if (!target || !gunDef || !canFire || bot.actionType !== GameConfig.Action.None) {
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
    if (friendlyFireInLine(bot, target)) {
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
 *  now" when deciding whether being critically low means fleeing instead. */
export function pickHealItem(bot: Player, healthFrac: number): InventoryItem | undefined {
    const missing = (1 - healthFrac) * GameConfig.player.health;
    const wantsFull = healthFrac <= 0.25 || missing > 60;
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
export function shouldHeal(bot: Player, tier: BotTierDef, hasVisibleEnemy: boolean): boolean {
    if (bot.actionType !== GameConfig.Action.None) return false;
    if (bot.weaponManager.cookingThrowable) return false;

    const healthFrac = bot.health / GameConfig.player.health;
    if (healthFrac >= tier.healThreshold) return false;
    if (hasVisibleEnemy && healthFrac > 0.25) return false;

    return pickHealItem(bot, healthFrac) !== undefined;
}

/** Heals when hurt and it's safe to. See `shouldHeal` for the decision. */
export function updateHeal(bot: Player, tier: BotTierDef, hasVisibleEnemy: boolean): void {
    if (!shouldHeal(bot, tier, hasVisibleEnemy)) return;
    const healthFrac = bot.health / GameConfig.player.health;
    const item = pickHealItem(bot, healthFrac);
    if (item) bot.useHealingItem(item);
}
