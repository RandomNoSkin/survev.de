import { ObjectType } from "../../../../shared/net/objectSerializeFns.ts";
import { collider } from "../../../../shared/utils/collider.ts";
import { collisionHelpers } from "../../../../shared/utils/collisionHelpers.ts";
import { util } from "../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { Obstacle } from "../objects/obstacle.ts";
import type { Player } from "../objects/player.ts";
import { currentSweetSpot } from "./botCombat.ts";

type RangeMode = "close" | "retreat" | "strafe";

/** Per-bot movement state, persisted across ticks by the brain. */
export class BotMovementState {
    strafeSign: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    strafeTimer = util.random(0.6, 1.6);
    wanderDir: Vec2 = v2.randomUnit();
    wanderTimer = 0;
    /** Which of close/retreat/strafe the bot is committed to - see `pickRangeMode`. */
    rangeMode: RangeMode = "strafe";
    /** Which side the bot is currently deflecting around an obstacle, so it commits to
     *  one direction instead of re-deciding independently every tick. */
    deflectSign: 1 | -1 = 1;
}

const PROBE_DIST = 3;

/** A bot never insists on backing away further than this, regardless of how far a
 *  long-range weapon's own sweet spot is - see the note on `pickRangeMode`. */
const MAX_RETREAT_DIST = 20;

/**
 * Schmitt-trigger range gate: a bot must clear `[retreatEdge, closeEdge]` to START
 * closing in or backing off, but only needs to return to a narrower inner band to
 * STOP. Without this, a bot sitting near its sweet spot flickers between "close" and
 * "retreat" every single tick as its own strafing causes `dist` to wobble across the
 * boundary, which looks like it's vibrating in place instead of circling.
 *
 * `retreatEdge` is capped at `MAX_RETREAT_DIST` independently of `closeEdge`: a
 * bolt-action rifle's sweet spot (up to 70 units) is a fine reason to *close in* when
 * standing too far away, but backpedaling all the way out to 70 units of separation on
 * a map far smaller than that just walks the bot into the map edge instead of holding
 * a sane firing position. Real players don't keep retreating to maximize their
 * sniper's ideal range either - they hold once the enemy isn't in their face anymore.
 */
function pickRangeMode(
    state: BotMovementState,
    dist: number,
    sweet: number,
    band: number,
): RangeMode {
    const closeEdge = sweet + band;
    const retreatEdge = Math.min(sweet - band, MAX_RETREAT_DIST);
    const hysteresis = Math.max(2, band * 0.4);

    if (state.rangeMode === "close") {
        if (dist <= closeEdge - hysteresis) state.rangeMode = "strafe";
    } else if (state.rangeMode === "retreat") {
        if (dist >= retreatEdge + hysteresis) state.rangeMode = "strafe";
    } else if (dist > closeEdge) {
        state.rangeMode = "close";
    } else if (dist < retreatEdge) {
        state.rangeMode = "retreat";
    }
    return state.rangeMode;
}

/** Whether moving `dir` from the bot's position is clear for `dist` units. Ignores
 *  height (0 = "count every collidable obstacle") since this is a physical-blocker
 *  probe, not the bullet-height check LOS uses. */
function isDirClear(bot: Player, dir: Vec2, dist: number): boolean {
    const aabb = collider.createAabbExtents(bot.pos, v2.create(dist + 1, dist + 1));
    const objs = bot.game.grid.intersectCollider(aabb);
    const obstacles: Obstacle[] = [];
    for (let i = 0; i < objs.length; i++) {
        if (objs[i].__type === ObjectType.Obstacle) obstacles.push(objs[i] as Obstacle);
    }
    const hitDist = collisionHelpers.intersectSegmentDist(
        obstacles,
        bot.pos,
        dir,
        dist,
        0,
        bot.layer,
        false,
    );
    return hitDist >= dist - 0.1;
}

/**
 * Direct steering only - no nav graph yet (that's M2/M3), so this chases/kites toward
 * the current gun's sweet spot with light strafing, and deflects around whatever is
 * immediately in front of it. Works fine in the open and gets stuck on buildings,
 * which is the expected M1 limitation.
 *
 * `retreatFrom`, when set, overrides the usual chase/kite: the bot just increases
 * distance from that point instead. This is what keeps a bot from healing itself at
 * point-blank range mid-fight - genuine cover-seeking (ducking behind a specific
 * obstacle) needs the nav graph and is M3's job, but putting *some* distance and a
 * wall-deflection between itself and the last-known threat is cheap and already a
 * large improvement over healing in place.
 */
export function updateMovement(
    bot: Player,
    state: BotMovementState,
    target: Player | undefined,
    dist: number,
    dt: number,
    retreatFrom?: Vec2,
): void {
    let move = v2.create(0, 0);

    if (retreatFrom) {
        move = v2.neg(v2.normalizeSafe(v2.sub(retreatFrom, bot.pos)));
    } else if (target) {
        const toTarget = v2.normalizeSafe(v2.sub(target.pos, bot.pos));
        const sweet = currentSweetSpot(bot);
        const band = Math.max(2, sweet * 0.18);

        state.strafeTimer -= dt;
        if (state.strafeTimer <= 0) {
            state.strafeTimer = util.random(0.6, 1.6);
            state.strafeSign = (state.strafeSign * -1) as 1 | -1;
        }

        const mode = pickRangeMode(state, dist, sweet, band);
        if (mode === "close") {
            move = toTarget;
        } else if (mode === "retreat") {
            move = v2.neg(toTarget);
        } else {
            move = v2.mul(v2.perp(toTarget), state.strafeSign);
        }
        // Blend in strafe even while closing/opening distance, so approach/retreat
        // isn't a dead-straight line - the second biggest "feels human" lever after
        // aim turn rate.
        move = v2.add(move, v2.mul(v2.perp(toTarget), state.strafeSign * 0.35));
    } else {
        state.wanderTimer -= dt;
        if (state.wanderTimer <= 0) {
            state.wanderTimer = util.random(1, 2.5);
            state.wanderDir = v2.randomUnit();
        }
        move = state.wanderDir;
    }

    if (v2.length(move) < 0.01) {
        bot.touchMoveActive = false;
        return;
    }
    move = v2.normalizeSafe(move);

    if (!isDirClear(bot, move, PROBE_DIST)) {
        // Prefer whichever side the bot was already deflecting toward, so it commits
        // to going around an obstacle instead of re-picking a side independently every
        // tick (which, right at an obstacle's edge, can flip left/right each tick and
        // look like the bot is stuck vibrating against the wall).
        const preferred = v2.rotate(move, state.deflectSign * (Math.PI / 3));
        const other = v2.rotate(move, -state.deflectSign * (Math.PI / 3));
        if (isDirClear(bot, preferred, PROBE_DIST)) {
            move = preferred;
        } else if (isDirClear(bot, other, PROBE_DIST)) {
            move = other;
            state.deflectSign = (state.deflectSign * -1) as 1 | -1;
        } else {
            move = v2.neg(move); // fully boxed in - back off rather than push into it
        }
    }

    bot.touchMoveActive = true;
    bot.touchMoveDir = move;
    bot.touchMoveLen = 255;
}
