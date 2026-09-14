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

type RangeMode = "close" | "retreat" | "hold";

/** What the brain wants movement to do this tick, decided from health, heal
 *  availability and recent combat momentum - see `BotBrain`.
 *  - `idle`: nothing to engage, wander.
 *  - `engageHold`: fight at a sane range - close in if too far, back off if too close,
 *    otherwise use cover and peek instead of standing in the open.
 *  - `push`: winning the exchange (landing lots of hits) - charge straight at the
 *    threat instead of holding position.
 *  - `heal`: retreat to cover and hunker down to use a heal item.
 *  - `flee`: too hurt to fight and either out of heal items or just got interrupted -
 *    put distance (and cover, if any is nearby) between the bot and the threat. */
export type CombatDirective = "idle" | "engageHold" | "push" | "heal" | "flee";

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
// Short enough that cover keeps up with an enemy actually circling around it - a full
// second was long enough for a repositioning threat to walk around a piece of cover
// before the bot ever noticed it had gone stale, leaving it exposed at the old spot.
const COVER_RECOMPUTE_INTERVAL = 0.4;
const COVER_REACHED_DIST = 1.5;

/** Angles (radians) off "directly behind cover" tried when leaning out to peek - not 0,
 *  which is fully hidden, and not near π, which is fully in the open; these sample the
 *  obstacle's silhouette edge, closest offset first. */
const PEEK_ANGLES = [1.05, -1.05, 1.4, -1.4, 1.75, -1.75];
const PEEK_HOLD_MIN = 1.0;
const PEEK_HOLD_MAX = 2.2;
const PEEK_EXPOSE_MIN = 0.5;
const PEEK_EXPOSE_MAX = 1.0;
const PEEK_RETRY_DELAY = 0.3;
const PEEK_REACHED_DIST = 1;

/** `push` never closes tighter than this. Not just a style choice: a gun's aim/lead
 *  math (`botAim.ts`) works from the *muzzle* position (`pos + dir * barrelLength`,
 *  ~2.5-2.7 units for most guns), so once actual separation drops below roughly a
 *  barrel's length the muzzle point can end up past the target entirely - the aim
 *  vector inverts and the bot freezes aiming the wrong way, unable to fire, for as
 *  long as it stays wedged there. Stopping the approach with room to spare avoids ever
 *  reaching that regime instead of trying to special-case it after the fact. */
const PUSH_MIN_DIST = 6;

/** Per-bot movement state, persisted across ticks by the brain. */
export class BotMovementState {
    strafeSign: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    strafeTimer = util.random(0.6, 1.6);
    wanderDir: Vec2 = v2.randomUnit();
    wanderTimer = 0;
    /** Which of close/retreat/hold the bot is committed to - see `pickRangeMode`. */
    rangeMode: RangeMode = "hold";
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

    /** Cover currently held - see `findCover`. Kept as the obstacle itself, not just
     *  its position, so a live `obstacle.dead` check (every tick, for free) catches it
     *  being shot apart out from under the bot immediately rather than on the next
     *  multi-second recompute. Used for healing, fleeing, and holding a mid-fight
     *  position alike. */
    coverObstacle?: Obstacle;
    coverPos?: Vec2;
    coverRecheck = 0;

    /** Peek cycle while holding cover mid-fight - see `updatePeekCycle`. `peeking`
     *  false means hiding at `coverPos`; true means leaning out to `peekPos`. */
    peeking = false;
    peekPos?: Vec2;
    peekTimer = 0;
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
        if (dist <= closeEdge - hysteresis) state.rangeMode = "hold";
    } else if (state.rangeMode === "retreat") {
        if (dist >= retreatEdge + hysteresis) state.rangeMode = "hold";
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
 *  the door is currently passable.
 *
 *  `ignore` excludes one specific obstacle from the check - used for the obstacle the
 *  bot is currently using as cover. Deliberately walking up to within a couple of units
 *  of that obstacle (to reach `coverPos`/`peekPos`, both placed right at its edge) is
 *  exactly what cover-seeking wants, not something to deflect away from; without this,
 *  this generic probe second-guessed `retreatToCover`'s already-correct approach
 *  direction the moment the bot got close enough to its own cover to matter, deflecting
 *  it sideways and never letting it actually settle within `COVER_REACHED_DIST` - which
 *  looked like "never really goes into cover" and "never peeks" from the outside, since
 *  the peek cycle only starts once cover is actually reached. */
function isDirClear(bot: Player, dir: Vec2, dist: number, ignore?: Obstacle): boolean {
    const aabb = collider.createAabbExtents(bot.pos, v2.create(dist + 1, dist + 1));
    const objs = bot.game.grid.intersectCollider(aabb);
    const obstacles: Obstacle[] = [];
    for (let i = 0; i < objs.length; i++) {
        if (objs[i].__type !== ObjectType.Obstacle) continue;
        const o = objs[i] as Obstacle;
        if (isOpenableDoor(o) || o === ignore) continue;
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

/** A point near `coverObstacle`'s edge, off to one side of "directly behind", that IS
 *  visible from `threatPos` - leaning out around the corner of cover rather than
 *  standing fully in the open. Tries progressively wider angles (`PEEK_ANGLES`);
 *  returns undefined if none clear (thin/oddly-shaped cover, or it died in the
 *  meantime), in which case the caller just keeps hiding. */
function findPeekSpot(
    bot: Player,
    navObstacles: Obstacle[],
    coverObstacle: Obstacle,
    threatPos: Vec2,
): Vec2 | undefined {
    if (coverObstacle.dead || !coverObstacle.collidable) return undefined;
    const layer = util.toGroundLayer(bot.layer);
    const away = v2.normalizeSafe(v2.sub(coverObstacle.pos, threatPos), v2.create(0, 0));
    if (v2.length(away) < 0.01) return undefined;
    const rad = obstacleRadius(coverObstacle) + COVER_BUFFER;

    for (const angle of PEEK_ANGLES) {
        const dir = v2.rotate(away, angle);
        const candidate = v2.add(coverObstacle.pos, v2.mul(dir, rad));
        if (!pointClear(bot.game, navObstacles, candidate, layer)) continue;
        if (!isWalkClear(navObstacles, threatPos, candidate, layer)) continue;
        return candidate;
    }
    return undefined;
}

/** Cycles a bot already at cover between hiding (`coverPos` - LOS to the threat fully
 *  blocked, no shot in or out) and peeking (`peekPos` - a brief lean out that regains
 *  line of sight, long enough to trade shots) instead of just standing at cover
 *  forever. This only owns the movement: perception (`BotBrain.think`) naturally
 *  reacquires the target during the exposed phase and loses it again once back in
 *  hiding, so firing falls out of the existing aim/fire pipeline for free. */
function updatePeekCycle(
    bot: Player,
    state: BotMovementState,
    nav: NavGraph,
    threatPos: Vec2,
    dt: number,
): Vec2 {
    state.peekTimer -= dt;
    if (state.peekTimer <= 0) {
        if (state.peeking) {
            state.peeking = false;
            state.peekPos = undefined;
            state.peekTimer = util.random(PEEK_HOLD_MIN, PEEK_HOLD_MAX);
        } else {
            const spot = findPeekSpot(bot, nav.navObstacles, state.coverObstacle!, threatPos);
            if (spot) {
                state.peeking = true;
                state.peekPos = spot;
                state.peekTimer = util.random(PEEK_EXPOSE_MIN, PEEK_EXPOSE_MAX);
            } else {
                state.peekTimer = PEEK_RETRY_DELAY;
            }
        }
    }

    const dest = state.peeking ? state.peekPos : state.coverPos;
    if (!dest || v2.distance(bot.pos, dest) < PEEK_REACHED_DIST) return v2.create(0, 0);
    return v2.normalizeSafe(v2.sub(dest, bot.pos));
}

/** Moves toward, then holds at, cover from `threatPos` - shared by healing, fleeing,
 *  and (with `holdAndPeek`) holding a mid-fight position instead of standing in the
 *  open. `holdAndPeek` cycles peeking out once cover is reached (see
 *  `updatePeekCycle`); without it the bot just hunkers down (healing), or if no cover
 *  exists nearby, keeps opening distance (fleeing) - `holdAndPeek` falls back to plain
 *  lateral strafing in that case instead, since standing still exposed with nothing to
 *  hide behind is strictly worse. */
function retreatToCover(
    bot: Player,
    state: BotMovementState,
    nav: NavGraph | undefined,
    threatPos: Vec2,
    dt: number,
    holdAndPeek: boolean,
): Vec2 {
    if (state.coverObstacle?.dead || state.coverObstacle?.collidable === false) {
        state.coverObstacle = undefined;
        state.coverPos = undefined;
        state.coverRecheck = 0;
        state.peeking = false;
    }
    state.coverRecheck -= dt;
    if (nav && (!state.coverPos || state.coverRecheck <= 0)) {
        state.coverRecheck = COVER_RECOMPUTE_INTERVAL;
        const found = findCover(bot, nav.navObstacles, threatPos);
        state.coverObstacle = found?.obstacle;
        state.coverPos = found?.pos;
    }

    if (state.coverPos && v2.distance(bot.pos, state.coverPos) > COVER_REACHED_DIST) {
        state.peeking = false;
        const pathDir = nav ? followPath(bot, state, nav, state.coverPos, dt) : undefined;
        return pathDir ?? v2.normalizeSafe(v2.sub(state.coverPos, bot.pos));
    }

    state.path = [];

    if (state.coverPos) {
        return holdAndPeek && nav
            ? updatePeekCycle(bot, state, nav, threatPos, dt)
            : v2.create(0, 0);
    }

    const away = v2.normalizeSafe(v2.sub(bot.pos, threatPos));
    return holdAndPeek ? v2.mul(v2.perp(away), state.strafeSign) : away;
}

/** Minimum plain distance from the threat before it's safe to start healing when no
 *  cover was found to hide behind instead - "create distance, then heal", not "start
 *  healing wherever the `heal` directive happened to be chosen". */
const SAFE_HEAL_DIST = 15;

/** Whether the bot has actually put enough separation between itself and `threatPos` to
 *  safely start a heal action - reached cover (if `retreatToCover` found any) or opened
 *  up `SAFE_HEAL_DIST` of plain distance otherwise. Gates *starting* a heal, not
 *  continuing one already in progress (`BotBrain.pickDirective` handles that by reading
 *  `actionType` directly) - deciding "I should heal" and immediately consuming the item
 *  regardless of whether the retreat has actually gone anywhere yet is what made bots
 *  visibly start a bandage and cancel it again on the very next tick, still standing
 *  right where the fight was. */
export function isSafeToHeal(bot: Player, state: BotMovementState, engageDist: number): boolean {
    if (state.coverPos) return v2.distance(bot.pos, state.coverPos) <= COVER_REACHED_DIST;
    return engageDist >= SAFE_HEAL_DIST;
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
 * Drives movement from the brain's `CombatDirective` plus a threat position - see the
 * type doc for what each directive means. `threatPos` need not be the *currently
 * visible* target: the brain passes a remembered last-known position while it's
 * momentarily out of sight (behind cover, mid-peek-cycle, ...), which is what lets
 * `engageHold`'s cover/peek behavior survive losing line of sight on purpose without
 * collapsing back to wandering.
 *
 * `nav` is optional: undefined until `BotBarn` finishes building the graph (or if bots
 * are running before it exists at all), in which case this behaves like plain direct
 * steering - worse around buildings and without cover-seeking, but never broken.
 */
export function updateMovement(
    bot: Player,
    state: BotMovementState,
    directive: CombatDirective,
    threatPos: Vec2 | undefined,
    dist: number,
    dt: number,
    nav?: NavGraph,
): void {
    let move = v2.create(0, 0);

    if (directive === "idle" || !threatPos) {
        state.path = [];
        state.coverObstacle = undefined;
        state.coverPos = undefined;
        state.peeking = false;
        state.wanderTimer -= dt;
        if (state.wanderTimer <= 0) {
            state.wanderTimer = util.random(1, 2.5);
            state.wanderDir = v2.randomUnit();
        }
        move = state.wanderDir;
    } else if (directive === "heal" || directive === "flee") {
        move = retreatToCover(bot, state, nav, threatPos, dt, false);
    } else if (directive === "push") {
        state.coverObstacle = undefined;
        state.coverPos = undefined;
        state.peeking = false;
        if (dist > PUSH_MIN_DIST) {
            const pathDir = nav ? followPath(bot, state, nav, threatPos, dt) : undefined;
            move = pathDir ?? v2.normalizeSafe(v2.sub(threatPos, bot.pos));
        } else {
            // Close enough to press the advantage without walking into melee contact -
            // hold here and keep firing rather than closing further (see `PUSH_MIN_DIST`).
            state.path = [];
        }
    } else {
        // engageHold: close distance if too far, back off if too close, otherwise hold
        // from cover (with peeking) instead of standing in the open at a stable range.
        const toThreat = v2.normalizeSafe(v2.sub(threatPos, bot.pos));
        const sweet = currentSweetSpot(bot);
        const band = Math.max(2, sweet * 0.18);

        state.strafeTimer -= dt;
        if (state.strafeTimer <= 0) {
            state.strafeTimer = util.random(0.6, 1.6);
            state.strafeSign = (state.strafeSign * -1) as 1 | -1;
        }

        const mode = pickRangeMode(state, dist, sweet, band);
        if (mode === "close") {
            state.coverObstacle = undefined;
            state.coverPos = undefined;
            state.peeking = false;
            const pathDir = nav ? followPath(bot, state, nav, threatPos, dt) : undefined;
            move = pathDir ?? toThreat;
        } else if (mode === "retreat") {
            state.coverObstacle = undefined;
            state.coverPos = undefined;
            state.peeking = false;
            state.path = [];
            move = v2.neg(toThreat);
        } else {
            move = retreatToCover(bot, state, nav, threatPos, dt, true);
        }
        // Blend in strafe even while closing/opening distance, so approach/retreat
        // isn't a dead-straight line - the second biggest "feels human" lever after
        // aim turn rate. Only for close/retreat: `hold`'s cover/peek cycle already has
        // its own deliberate micro-movement, and blending lateral strafe on top of a
        // peek step just walks the bot back into its own cover.
        if ((mode === "close" || mode === "retreat") && !state.path.length) {
            move = v2.add(move, v2.mul(v2.perp(toThreat), state.strafeSign * 0.35));
        }
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

    if (!isDirClear(bot, move, PROBE_DIST, state.coverObstacle)) {
        // Prefer whichever side the bot was already deflecting toward, so it commits
        // to going around an obstacle instead of re-picking a side independently every
        // tick (which, right at an obstacle's edge, can flip left/right each tick and
        // look like the bot is stuck vibrating against the wall).
        const preferred = v2.rotate(move, state.deflectSign * (Math.PI / 3));
        const other = v2.rotate(move, -state.deflectSign * (Math.PI / 3));
        if (isDirClear(bot, preferred, PROBE_DIST, state.coverObstacle)) {
            move = preferred;
        } else if (isDirClear(bot, other, PROBE_DIST, state.coverObstacle)) {
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
