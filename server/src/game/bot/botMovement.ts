import { ObjectType } from "../../../../shared/net/objectSerializeFns.ts";
import { collider } from "../../../../shared/utils/collider.ts";
import { collisionHelpers } from "../../../../shared/utils/collisionHelpers.ts";
import { util } from "../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { Obstacle } from "../objects/obstacle.ts";
import type { Player } from "../objects/player.ts";
import { currentSweetSpot } from "./botCombat.ts";
import { findPath } from "./nav/navAStar.ts";
import { isOpenableDoor, isWalkClear, pointClear } from "./nav/navGeom.ts";
import type { NavGraph } from "./nav/navGraph.ts";

type RangeMode = "close" | "retreat" | "strafe";

const REPATH_INTERVAL = 0.6;
const REPATH_GOAL_DELTA = 8;
const WAYPOINT_REACHED_DIST = 3;
const MAX_STRING_PULL = 3;
const MAX_PATH_EXPANSIONS = 1500;
const NODE_SEARCH_RADIUS = 40;
const STUCK_CHECK_INTERVAL = 1;
const STUCK_MOVE_THRESHOLD = 1;

const COVER_SEARCH_RAD = 30;
const COVER_BUFFER = 1.5;
const COVER_RECOMPUTE_INTERVAL = 1;
const COVER_REACHED_DIST = 1.5;

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

    /** Remaining nav-graph node ids to walk through, nearest first. Empty when no
     *  path is needed (direct line to the goal is clear) or none was found. */
    path: number[] = [];
    /** The goal position `path` was computed for - a big enough move invalidates it. */
    pathGoal?: Vec2;
    repathCooldown = 0;

    /** Anti-stuck: if the bot barely moves while following a path, the path is
     *  probably bad (a doorway it failed to open in time, a sampling error) - drop it
     *  and let the next tick request a fresh one. */
    stuckTimer = 0;
    stuckAnchor: Vec2 = v2.create(0, 0);

    /** The path node currently being string-pulled toward - see `followPath`. Node id,
     *  not an index into `path`, so it survives waypoints being shifted off the front. */
    pullTarget?: number;

    /** Cover currently held while retreating - see `findCover`. Kept as the obstacle
     *  itself, not just its position, so a live `obstacle.dead` check (every tick, for
     *  free) catches it being shot apart out from under the bot immediately rather than
     *  on the next multi-second recompute. */
    coverObstacle?: Obstacle;
    coverPos?: Vec2;
    coverRecheck = 0;
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
 *  probe. An unlocked door is excluded - same reasoning as the nav graph
 *  (`isOpenableDoor`): a bot walking toward a closed door should approach and open it
 *  (see `tryOpenNearbyDoor`), not swerve around it like a wall. The game's own
 *  movement collision still physically stops the bot right at the door until it's
 *  actually opened - this probe only decides which *direction* to walk, not whether
 *  the door is currently passable. */
function isDirClear(bot: Player, dir: Vec2, dist: number): boolean {
    const aabb = collider.createAabbExtents(bot.pos, v2.create(dist + 1, dist + 1));
    const objs = bot.game.grid.intersectCollider(aabb);
    const obstacles: Obstacle[] = [];
    for (let i = 0; i < objs.length; i++) {
        if (objs[i].__type !== ObjectType.Obstacle) continue;
        const o = objs[i] as Obstacle;
        if (isOpenableDoor(o)) continue;
        obstacles.push(o);
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

/** Opens the nearest closed, unlocked door within interaction range, if any - the same
 *  overlap test `Player.getInteractableObstacles` uses for a human's `Input.Use`. Runs
 *  every tick regardless of movement mode, so a bot opens doors it merely walks past,
 *  not just ones directly on a computed path. */
export function tryOpenNearbyDoor(bot: Player): void {
    const searchRad = bot.rad + 5;
    const objs = bot.game.grid.intersectCollider(collider.createCircle(bot.pos, searchRad));
    for (let i = 0; i < objs.length; i++) {
        const o = objs[i];
        if (o.__type !== ObjectType.Obstacle) continue;
        const obstacle = o as Obstacle;
        if (
            obstacle.dead
            || !obstacle.isDoor
            || !obstacle.door
            || obstacle.door.open
            || obstacle.door.locked
            || !obstacle.door.canUse
            || obstacle.interactionRad <= 0
            || !util.sameLayer(obstacle.layer, bot.layer)
        ) {
            continue;
        }
        if (
            collider.intersectCircle(obstacle.collider, bot.pos, obstacle.interactionRad + bot.rad)
        ) {
            obstacle.interact(bot);
            return;
        }
    }
}

function obstacleRadius(o: Obstacle): number {
    const c = o.collider;
    if (c.type === collider.Type.Circle) return c.rad;
    return v2.distance(c.min, c.max) / 2;
}

/** Picks the nearest point (to the bot) that sits just past a live, collidable obstacle
 *  as seen from `threatPos` - real cover, not just "away from the enemy". Every
 *  candidate is checked against the *current* state of the obstacle it hides behind
 *  (`dead`/`collidable`), so a piece of cover that gets shot apart is never handed out;
 *  the caller (`updateMovement`) also re-checks that same obstacle every tick it's
 *  held, not just when this is called, so cover dying out from under the bot mid-fight
 *  drops it immediately rather than on the next recompute. */
export function findCover(
    bot: Player,
    navObstacles: Obstacle[],
    threatPos: Vec2,
): { obstacle: Obstacle; pos: Vec2 } | undefined {
    const layer = util.toGroundLayer(bot.layer);
    const aabb = collider.createAabbExtents(bot.pos, v2.create(COVER_SEARCH_RAD, COVER_SEARCH_RAD));
    const objs = bot.game.grid.intersectCollider(aabb);

    let best: { obstacle: Obstacle; pos: Vec2; distSqr: number } | undefined;
    for (let i = 0; i < objs.length; i++) {
        if (objs[i].__type !== ObjectType.Obstacle) continue;
        const o = objs[i] as Obstacle;
        if (o.dead || !o.collidable || isOpenableDoor(o)) continue;
        if (!util.sameLayer(o.layer, bot.layer)) continue;

        const away = v2.normalizeSafe(v2.sub(o.pos, threatPos), v2.create(0, 0));
        if (v2.length(away) < 0.01) continue; // bot's obstacle sits exactly on the threat - degenerate
        const candidate = v2.add(o.pos, v2.mul(away, obstacleRadius(o) + COVER_BUFFER));

        if (!pointClear(bot.game, navObstacles, candidate, layer)) continue;
        if (isWalkClear(navObstacles, threatPos, candidate, layer)) continue; // still exposed

        const distSqr = v2.lengthSqr(v2.sub(bot.pos, candidate));
        if (!best || distSqr < best.distSqr) best = { obstacle: o, pos: candidate, distSqr };
    }
    return best;
}

/** Direction to steer toward `goal`, routing through the nav graph when a direct line
 *  is blocked. Returns `undefined` when the direct line is already clear (the caller
 *  steers straight at `goal` itself) or when no usable path exists at all (nav isn't
 *  built yet, or the graph genuinely has nothing nearby) - both cases fall back to the
 *  M1 direct-steering behavior, which is worse but never broken.
 */
export function followPath(
    bot: Player,
    state: BotMovementState,
    graph: NavGraph,
    goal: Vec2,
    dt: number,
): Vec2 | undefined {
    const layer = util.toGroundLayer(bot.layer);

    if (isWalkClear(graph.navObstacles, bot.pos, goal, layer)) {
        state.path = [];
        return undefined;
    }

    state.repathCooldown -= dt;
    const staleGoal = !state.pathGoal || v2.distance(state.pathGoal, goal) > REPATH_GOAL_DELTA;
    if ((!state.path.length || staleGoal) && state.repathCooldown <= 0) {
        state.repathCooldown = REPATH_INTERVAL;
        const startNodes = graph.nearby(bot.pos, layer, NODE_SEARCH_RADIUS, 5);
        const goalNodes = new Set(graph.nearby(goal, layer, NODE_SEARCH_RADIUS, 5));
        state.path = startNodes.length && goalNodes.size
            ? findPath(graph, startNodes, goalNodes, goal, layer, MAX_PATH_EXPANSIONS) ?? []
            : [];
        state.pathGoal = v2.copy(goal);
    }

    if (!state.path.length) return undefined;

    // Reached pruning: drop every waypoint up to and including whichever one is
    // currently being steered toward - `pullTarget` if string-pulling has already
    // committed to one several hops ahead, else the nearest waypoint. Checking only
    // `path[0]` here (as if string-pulling didn't exist) is a real bug: once committed
    // to a further `pullTarget`, the bot converges on and orbits *that* node forever
    // without ever coming near enough to `path[0]` to prune it, since a per-tick step
    // that overshoots a reached target flips `normalize(target - pos)` to point the
    // other way next tick - an undamped limit cycle around the target instead of ever
    // advancing to the next leg.
    const reachId = state.pullTarget ?? state.path[0];
    const reachIdx = state.path.indexOf(reachId);
    if (reachIdx >= 0 && v2.distance(bot.pos, graph.pos(reachId)) < WAYPOINT_REACHED_DIST) {
        state.path.splice(0, reachIdx + 1);
        state.pullTarget = undefined;
    }
    if (!state.path.length) {
        state.pullTarget = undefined;
        return undefined;
    }

    // String-pulling: aim at the furthest waypoint still directly visible, so the bot
    // cuts corners instead of hugging every sampled node exactly.
    //
    // Committed, not re-picked from scratch every tick: right at a concave corner,
    // whether a further waypoint is "directly visible" from the bot's exact position
    // can flip on a sub-unit position change. Recomputing freely turned that into a
    // feedback loop - aim far, step toward it, that step makes the far waypoint no
    // longer visible, aim near instead, step back out, repeat - which froze the bot in
    // place oscillating 180 degrees every tick. Sticking with the current target until
    // it's actually reached or genuinely no longer visible removes the loop.
    const pullIdx = state.pullTarget === undefined ? -1 : state.path.indexOf(state.pullTarget);
    const targetStillGood = pullIdx >= 0
        && isWalkClear(graph.navObstacles, bot.pos, graph.pos(state.path[pullIdx]), layer);

    if (!targetStillGood) {
        let aimIdx = 0;
        const lookahead = Math.min(state.path.length - 1, MAX_STRING_PULL);
        for (let i = 1; i <= lookahead; i++) {
            if (isWalkClear(graph.navObstacles, bot.pos, graph.pos(state.path[i]), layer)) {
                aimIdx = i;
            } else {
                break;
            }
        }
        state.pullTarget = state.path[aimIdx];
    }

    return v2.normalizeSafe(v2.sub(graph.pos(state.pullTarget!), bot.pos));
}

/**
 * Direct steering with nav-graph-assisted pathing for the "close" (chase) case: when a
 * straight line to the target is blocked, this routes around buildings via `nav`
 * (waypoints, string-pulled) instead of just deflecting off whatever's immediately in
 * front of it. Retreating (healing) instead seeks actual cover - a point behind a live
 * obstacle that breaks the threat's line of sight, reached the same path-following way
 * - falling back to plain "move directly away" only when no cover is nearby or `nav`
 * doesn't exist yet. Strafe/wander stay on plain direct steering - they don't have a
 * single well-defined destination to path toward.
 *
 * `nav` is optional: undefined until `BotBarn` finishes building the graph (or if bots
 * are running before it exists at all), in which case this behaves exactly like the
 * M1 steering-only version - worse around buildings, never broken.
 */
export function updateMovement(
    bot: Player,
    state: BotMovementState,
    target: Player | undefined,
    dist: number,
    dt: number,
    retreatFrom?: Vec2,
    nav?: NavGraph,
): void {
    let move = v2.create(0, 0);

    if (retreatFrom) {
        if (state.coverObstacle?.dead || state.coverObstacle?.collidable === false) {
            state.coverObstacle = undefined;
            state.coverPos = undefined;
            state.coverRecheck = 0;
        }
        state.coverRecheck -= dt;
        if (nav && (!state.coverPos || state.coverRecheck <= 0)) {
            state.coverRecheck = COVER_RECOMPUTE_INTERVAL;
            const found = findCover(bot, nav.navObstacles, retreatFrom);
            state.coverObstacle = found?.obstacle;
            state.coverPos = found?.pos;
        }

        if (state.coverPos && v2.distance(bot.pos, state.coverPos) > COVER_REACHED_DIST) {
            const pathDir = nav ? followPath(bot, state, nav, state.coverPos, dt) : undefined;
            move = pathDir ?? v2.normalizeSafe(v2.sub(state.coverPos, bot.pos));
        } else {
            state.path = [];
            // Either already at cover (hold position - a zero `move` below is the
            // correct "stop and hunker down" behavior) or no cover exists nearby, in
            // which case the old "put distance between me and the threat" fallback is
            // strictly better than standing still.
            move = state.coverPos
                ? v2.create(0, 0)
                : v2.neg(v2.normalizeSafe(v2.sub(retreatFrom, bot.pos)));
        }
    } else if (target) {
        state.coverObstacle = undefined;
        state.coverPos = undefined;
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
            const pathDir = nav ? followPath(bot, state, nav, target.pos, dt) : undefined;
            move = pathDir ?? toTarget;
        } else if (mode === "retreat") {
            state.path = [];
            move = v2.neg(toTarget);
        } else {
            state.path = [];
            move = v2.mul(v2.perp(toTarget), state.strafeSign);
        }
        // Blend in strafe even while closing/opening distance, so approach/retreat
        // isn't a dead-straight line - the second biggest "feels human" lever after
        // aim turn rate. Skipped while actively following a multi-waypoint path -
        // strafing sideways off a narrow corridor waypoint just walks into the wall
        // next to it.
        if (!state.path.length) {
            move = v2.add(move, v2.mul(v2.perp(toTarget), state.strafeSign * 0.35));
        }
    } else {
        state.path = [];
        state.coverObstacle = undefined;
        state.coverPos = undefined;
        state.wanderTimer -= dt;
        if (state.wanderTimer <= 0) {
            state.wanderTimer = util.random(1, 2.5);
            state.wanderDir = v2.randomUnit();
        }
        move = state.wanderDir;
    }

    tryOpenNearbyDoor(bot);

    // Anti-stuck: barely moving while a path is active means that path is bad (a door
    // it didn't open in time, a stale waypoint) - drop it so the next tick requests a
    // fresh one instead of pushing against the same wall forever.
    state.stuckTimer += dt;
    if (state.stuckTimer >= STUCK_CHECK_INTERVAL) {
        if (state.path.length && v2.distance(bot.pos, state.stuckAnchor) < STUCK_MOVE_THRESHOLD) {
            state.path = [];
            state.repathCooldown = 0;
        }
        state.stuckTimer = 0;
        state.stuckAnchor = v2.copy(bot.pos);
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
