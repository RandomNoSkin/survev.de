import type { BulletDef } from "../../../../shared/defs/gameObjects/bulletDefs.ts";
import type { GunDef } from "../../../../shared/defs/gameObjects/gunDefs.ts";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import { GameConfig } from "../../../../shared/gameConfig.ts";
import { math } from "../../../../shared/utils/math.ts";
import { util } from "../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { Player } from "../objects/player.ts";
import type { BotTierDef } from "./botDefs.ts";

/** Everything `updateAim` actually needs from a target - a real `Player` (visible) or a
 *  brief, predicted stand-in (`BotBrain`'s offscreen tracking, see its doc comment)
 *  satisfy this the same way, so aim/lead/turn/reaction all work unchanged either way. */
export interface AimTarget {
    __id: number;
    pos: Vec2;
}

/** Per-bot aim state, persisted across ticks by the brain. */
export class BotAimState {
    /** Our own smoothed facing direction - kept separate from `player.dir` because we
     *  write `dirNew` and it isn't committed to `dir` until `Player.update()` runs
     *  later this same tick. */
    dir = v2.create(1, 0);
    reactionTimer = 0;
    targetId = 0;
    /** `game.now` this bot last actually saw `targetId` - see the reacquisition note in
     *  `updateAim`. */
    lastSeenTimeMs = -Infinity;
    sampleTimeMs = 0;
    samplePos = v2.create(0, 0);
    /** EMA-smoothed target velocity, units/s. */
    vel = v2.create(0, 0);
    /** Slowly drifting aim bias, in radians - a "wandering hand", not per-tick jitter. */
    noiseBias = 0;
    noiseGoal = 0;
    noiseTimer = 0;
}

export interface AimResult {
    /** Reaction time has elapsed and the true angle to the target is inside the fire
     *  cone. Ammo/range/friendly-fire are botCombat's job, not this layer's. */
    canFire: boolean;
}

const NO_FIRE: AimResult = { canFire: false };

function activeGunDef(bot: Player): GunDef | undefined {
    const def = GameObjectDefs.typeToDefSafe(bot.weaponManager.activeWeapon);
    return def?.type === "gun" ? (def as GunDef) : undefined;
}

/** Box-Muller transform - a roughly human "drifting hand" instead of uniform noise. */
function gaussianRandom(): number {
    const u = Math.max(Math.random(), 1e-6);
    const v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Runs every tick regardless of the brain's think rate, so turning and tracking stay
 * smooth between perception updates. Writes `dirNew`/`toMouseLen` - the exact fields a
 * human's InputMsg would set (see `Player.handleInput`).
 *
 * `target` is an `AimTarget`, not necessarily a live `Player` - `BotBrain` passes a
 * brief predicted position (with the same `__id` as the real target had) while it's
 * offscreen but still moving predictably, so the same turn/lead/error/reaction model
 * applies unchanged whether it's tracking someone visible or trying an offscreen shot.
 */
export function updateAim(
    bot: Player,
    aim: BotAimState,
    tier: BotTierDef,
    target: AimTarget | undefined,
    dt: number,
): AimResult {
    if (!target) return NO_FIRE;

    const nowMs = bot.game.now;

    // (Re)acquisition: a full reaction delay - "noticing" someone - only applies to a
    // genuinely different target, or the same one after long enough that memory of
    // them has gone stale (`tier.memory`, the same window `BotBrain`'s own threat
    // memory uses). A brief reappearance of the *same* target doesn't reset it: the
    // most common source of one is the bot's own peek/hide cover cycle, and treating
    // every peek as a fresh sighting meant a reaction delay comparable to (or longer
    // than) a single peek window could make the bot duck back into hiding before ever
    // finishing "noticing" the enemy it had already spotted seconds earlier - it never
    // actually got to fire.
    const knownRecently = aim.targetId === target.__id
        && nowMs - aim.lastSeenTimeMs <= tier.memory * 1000;
    if (!knownRecently) {
        aim.targetId = target.__id;
        aim.reactionTimer = tier.reaction * util.random(0.8, 1.25);
        aim.sampleTimeMs = nowMs;
        aim.samplePos = v2.copy(target.pos);
        aim.vel = v2.create(0, 0);
    }
    aim.lastSeenTimeMs = nowMs;

    // Target velocity estimate, resampled at ~12Hz rather than every tick so it isn't
    // dominated by per-tick integration noise.
    const elapsed = (nowMs - aim.sampleTimeMs) / 1000;
    if (elapsed >= 0.08) {
        const raw = v2.mul(v2.sub(target.pos, aim.samplePos), 1 / elapsed);
        const maxSpeed = GameConfig.player.moveSpeed * 1.4;
        const clamped = v2.length(raw) > maxSpeed ? v2.mul(v2.normalizeSafe(raw), maxSpeed) : raw;
        aim.vel = v2.lerp(0.35, aim.vel, clamped);
        aim.samplePos = v2.copy(target.pos);
        aim.sampleTimeMs = nowMs;
    }

    // Target leading, from the muzzle position (not the body center, or there is a
    // systematic bias at close range) - one refinement pass on the travel time.
    const gunDef = activeGunDef(bot);
    const bulletDef = gunDef
        ? (GameObjectDefs.typeToDefSafe(gunDef.bulletType) as BulletDef | undefined)
        : undefined;
    const bulletSpeed = bulletDef?.speed ?? 80;
    const muzzle = v2.add(bot.pos, v2.mul(aim.dir, gunDef?.barrelLength ?? 1));

    let leadFactor = tier.leadFactor;
    // The spread already covers the lead for shotguns; over-leading makes the whole
    // pattern miss instead of just some pellets.
    if (gunDef && gunDef.bulletCount > 1) leadFactor *= 0.4;

    let aimPoint = target.pos;
    if (leadFactor > 0.01 && v2.length(aim.vel) > 0.1) {
        let t = v2.distance(target.pos, muzzle) / bulletSpeed;
        aimPoint = v2.add(target.pos, v2.mul(aim.vel, t * leadFactor));
        t = v2.distance(aimPoint, muzzle) / bulletSpeed;
        aimPoint = v2.add(target.pos, v2.mul(aim.vel, t * leadFactor));
    }

    // Aim error: a slowly drifting bias angle, resampled every 0.25-0.5s and
    // interpolated toward - a crosshair vibrating at gameTps reads as a bot instantly.
    aim.noiseTimer -= dt;
    if (aim.noiseTimer <= 0) {
        aim.noiseTimer = util.random(0.25, 0.5);
        const dist = v2.distance(bot.pos, target.pos);
        const movingFactor = 1 + 0.5 * Math.min(v2.length(aim.vel) / GameConfig.player.moveSpeed, 1);
        const distFactor = 1 + dist / 120;
        const selfMoveFactor = bot.touchMoveActive && bot.touchMoveLen ? 1.35 : 0.85;
        const sigmaDeg = math.clamp(
            tier.aimErrorDeg * movingFactor * distFactor * selfMoveFactor,
            tier.aimErrorDeg * 0.3,
            tier.aimErrorDeg * 3,
        );
        aim.noiseGoal = gaussianRandom() * sigmaDeg * (Math.PI / 180);
    }
    aim.noiseBias = math.lerp(0.15, aim.noiseBias, aim.noiseGoal);

    const trueAngle = Math.atan2(target.pos.y - bot.pos.y, target.pos.x - bot.pos.x);
    const goalAngle = Math.atan2(aimPoint.y - bot.pos.y, aimPoint.x - bot.pos.x) + aim.noiseBias;

    // Turn-rate slew: `Player.dir` has no turn limit of its own, so without this bots
    // snap-aim instantly, which reads as an aimbot. This is the single strongest
    // "feels human" lever in the whole model.
    const curAngle = Math.atan2(aim.dir.y, aim.dir.x);
    const maxStep = tier.turnRate * dt;
    const step = math.clamp(math.angleDiff(curAngle, goalAngle), -maxStep, maxStep);
    const newAngle = curAngle + step;
    aim.dir = v2.create(Math.cos(newAngle), Math.sin(newAngle));

    bot.dirNew = aim.dir;
    bot.toMouseLen = math.clamp(v2.distance(bot.pos, target.pos), 0, 64);

    aim.reactionTimer -= dt;
    const angleErrDeg = Math.abs(math.angleDiff(curAngle, trueAngle)) * (180 / Math.PI);

    return {
        canFire: aim.reactionTimer <= 0 && angleErrDeg <= tier.fireConeDeg,
    };
}
