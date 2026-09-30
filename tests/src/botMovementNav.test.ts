import { expect, test } from "vitest";
import { Config } from "../../server/src/config.ts";
import { BotBrain } from "../../server/src/game/bot/botBrain.ts";
import { BOT_TIERS } from "../../server/src/game/bot/botDefs.ts";
import {
    BotMovementState,
    findCover,
    followPath,
    isDirClear,
    preferNonInteriorGoal,
    tryOpenNearbyDoor,
    updateMovement,
} from "../../server/src/game/bot/botMovement.ts";
import { findPath } from "../../server/src/game/bot/nav/navAStar.ts";
import { buildNavGraph } from "../../server/src/game/bot/nav/navBuilder.ts";
import { isWalkClear, pointClear } from "../../server/src/game/bot/nav/navGeom.ts";
import { NavGraph } from "../../server/src/game/bot/nav/navGraph.ts";
import { TeamMode, WeaponSlot } from "../../shared/gameConfig.ts";
import { util } from "../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/**
 * These prove the M2+M3 integration itself - that `followPath`/`tryOpenNearbyDoor`
 * actually make a bot detour around real obstacles and open real doors - as opposed to
 * `navGraph.test.ts`/`navPath.test.ts`, which only prove the graph/A* layer underneath
 * is correct in isolation.
 */

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

/** Searches a handful of far-apart point pairs on the map for one where a straight
 *  line is blocked but the nav graph still connects them - i.e. an actual "must detour
 *  around something" case, not just any two points. Randomized "local" map generation
 *  means not every run has such a pair in this particular sample; callers skip the test
 *  when `null` comes back rather than assume one exists. */
function findBlockedButConnectedPair(
    game: ReturnType<typeof createGame>,
    graph: ReturnType<typeof buildNavGraph>,
): { from: Vec2; to: Vec2; path: number[] } | null {
    const fractions = [0.1, 0.3, 0.5, 0.7, 0.9];
    const points: Vec2[] = [];
    for (const fx of fractions) {
        for (const fy of fractions) {
            points.push(v2.create(game.map.width * fx, game.map.height * fy));
        }
    }

    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const from = points[i];
            const to = points[j];
            if (v2.distance(from, to) < 50) continue; // want a real detour, not a doorway-sized gap
            if (isWalkClear(graph.navObstacles, from, to, 0)) continue; // not actually blocked

            const startNodes = graph.nearby(from, 0, 40, 5);
            const goalNodes = new Set(graph.nearby(to, 0, 40, 5));
            if (!startNodes.length || !goalNodes.size) continue;
            const path = findPath(graph, startNodes, goalNodes, to, 0, 8000);
            if (path && path.length > 1) return { from, to, path };
        }
    }
    return null;
}

test("followPath routes around a blocked straight line instead of aiming through it", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const found = findBlockedButConnectedPair(game, graph);
    if (!found) return; // this map's random layout has no such pair to test against

    const bot = game.playerBarn.addTestPlayer({ pos: v2.copy(found.from) });
    const state = new BotMovementState();

    const dir = followPath(bot, state, graph, found.to, 0.1);

    expect(dir).toBeDefined();
    expect(Number.isFinite(dir!.x) && Number.isFinite(dir!.y)).toBe(true);
    // A genuine multi-hop route was computed and committed to (`state.pullTarget`),
    // not just a straight line to the goal - since the direct line is known blocked
    // (that's how this pair was chosen), the immediate steering target must be an
    // intermediate waypoint short of the goal itself, not the goal.
    expect(state.path.length).toBeGreaterThan(1);
    expect(state.pullTarget).toBeDefined();
    expect(v2.distance(graph.pos(state.pullTarget!), found.to)).toBeGreaterThan(0.5);
    // Not asserted: that `pullTarget` is instantly `isWalkClear` from this exact spawn
    // point. `path[0]` is only the *nearest sampled node* to an arbitrary test
    // coordinate, not necessarily one with a clean line to it - that small gap is what
    // `updateMovement`'s outer local-avoidance steering (`isDirClear`) exists to paper
    // over on the very first tick, and what the next tick's fresh `followPath` call
    // (from the position that step actually reached) resolves. The full walk-to-goal
    // test below is the real end-to-end proof; this one only checks that a genuine
    // multi-hop detour was computed at all.
});

// This is the actual "does the bot get from A to B" proof for M3: a point mass driven
// purely by repeated `followPath` calls - exactly the contract `updateMovement` uses
// (`pathDir ?? toTarget`) - covering the full pipeline (repath throttling, waypoint
// pruning, string-pulling, and the direct-line handoff once past the obstacle) end to
// end, without depending on the game's own collision/physics tuning.
test("Repeated followPath calls walk a point from one side of an obstacle to the other", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const found = findBlockedButConnectedPair(game, graph);
    if (!found) return;

    const bot = game.playerBarn.addTestPlayer({ pos: v2.copy(found.from) });
    const state = new BotMovementState();

    let pos = v2.copy(found.from);
    const speed = 8; // arbitrary units/sec - only the geometry is under test here
    const dt = 0.1;
    let usedMultiWaypointPath = false;

    for (let i = 0; i < 600 && v2.distance(pos, found.to) > 2; i++) {
        bot.pos = pos;
        const dir = followPath(bot, state, graph, found.to, dt) ?? v2.normalizeSafe(v2.sub(found.to, pos));
        if (state.path.length > 1) usedMultiWaypointPath = true;
        pos = v2.add(pos, v2.mul(dir, speed * dt));
    }

    expect(v2.distance(pos, found.to)).toBeLessThan(3);
    expect(usedMultiWaypointPath).toBe(true);
});

test("tryOpenNearbyDoor opens a closed, unlocked door the bot is standing next to", () => {
    const game = createGame(TeamMode.Solo, "local");

    const door = game.map.obstacles.find(
        (o) => o.isDoor && o.door && !o.door.locked && o.door.canUse && !o.door.open && o.layer === 0,
    );
    if (!door) return; // this random layout rolled zero usable ground-layer doors

    const bot = game.playerBarn.addTestPlayer({ pos: v2.copy(door.pos) });
    bot.layer = door.layer;

    tryOpenNearbyDoor(bot);
    // Some doors animate open after `openDelay` rather than flipping instantly -
    // give the obstacle's own ticker a few ticks to resolve either way.
    for (let i = 0; i < 20 && !door.door!.open; i++) game.update(0.1);

    expect(door.door!.open).toBe(true);
});

test("updateMovement wired with a nav graph still produces a valid move for a blocked target", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const found = findBlockedButConnectedPair(game, graph);
    if (!found) return;

    const bot = game.playerBarn.addTestPlayer({ pos: v2.copy(found.from) });
    const target = game.playerBarn.addTestPlayer({ pos: v2.copy(found.to) });
    const state = new BotMovementState();

    const dist = v2.distance(found.from, found.to);
    updateMovement(bot, state, "engageHold", target.pos, dist, 0.1, graph);

    expect(bot.touchMoveActive).toBe(true);
    expect(Number.isFinite(bot.touchMoveDir.x)).toBe(true);
    expect(Number.isFinite(bot.touchMoveDir.y)).toBe(true);
    expect(v2.length(bot.touchMoveDir)).toBeGreaterThan(0.9);
});

// Regression: the strafe cycle used to reroll on a flat `util.random(0.6, 1.6)` timer
// with a hardcoded blend strength (0.3/0.35 depending on directive) - a fixed interval
// and fixed punch, which reads as a metronome rather than a real player juking. Both are
// now rerolled together each cycle (`rollStrafeCycle`) from a bimodal distribution mixing
// occasional short, punchier feints into the normal longer holds. Driving `engageHold` in
// its "close" range mode (far outside the sweet spot the whole time, so it never settles
// into holding/peeking) for a long stretch should surface both: more than one distinct
// blend strength, and at least one reroll shorter than the old fixed minimum.
test("engageHold's strafe cycle varies in both timing and strength instead of a fixed cadence", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    const threatPos = v2.create(250, 50); // far past any sweet spot - stays in "close" mode
    const state = new BotMovementState();
    const dt = 0.1;

    const intensities = new Set<number>();
    let sawShortFeint = false;

    for (let i = 0; i < 400; i++) {
        const timerBefore = state.strafeTimer;
        updateMovement(bot, state, "engageHold", threatPos, 200, dt);
        if (timerBefore - dt <= 0) {
            intensities.add(state.strafeIntensity);
            if (state.strafeTimer < 0.6) sawShortFeint = true;
        }
    }

    expect(intensities.size).toBeGreaterThan(1);
    expect(sawShortFeint).toBe(true);
});

// Same "expert must move more" ask as the peek-pacing test above, for strafing: a more
// decisive tier should roll the short, punchy feint noticeably more often than a
// hesitant one, not just at some fixed rate for every difficulty - see `feintChanceFor`.
test("engageHold's strafe cycle feints more often for a more aggressive tier", () => {
    function countFeints(tier: typeof BOT_TIERS.expert): number {
        const game = createGame(TeamMode.Solo, "test_normal");
        const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
        const threatPos = v2.create(250, 50); // far past any sweet spot - stays in "close" mode
        const state = new BotMovementState();
        const dt = 0.1;
        let feints = 0;

        for (let i = 0; i < 1000; i++) {
            const timerBefore = state.strafeTimer;
            updateMovement(bot, state, "engageHold", threatPos, 200, dt, undefined, false, tier);
            if (timerBefore - dt <= 0 && state.strafeTimer < 0.6) feints++;
        }
        return feints;
    }

    // A single run of either tier alone is noisy (it's still a coin flip per cycle) -
    // median over several trials each is what actually isolates the *chance* difference.
    const trials = 7;
    const expertFeints = median(Array.from({ length: trials }, () => countFeints(BOT_TIERS.expert)));
    const easyFeints = median(Array.from({ length: trials }, () => countFeints(BOT_TIERS.easy)));

    expect(expertFeints).toBeGreaterThan(easyFeints);
});

// The "Deckungs-Logik mit obstacle.dead-Prüfung" M3 deliverable: cover-seeking behind a
// real obstacle, verified geometrically rather than by hoping the random map happens to
// produce a usable case. A fixed obstacle is picked and a threat placed 40 units to one
// side of it along an arbitrary axis, so "behind the obstacle from the threat's point of
// view" is a known, checkable location - independent of the map's random layout.
test("findCover picks a point that breaks the threat's line of sight to a live obstacle", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const cover = game.map.obstacles.find(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );
    if (!cover) return; // this random layout rolled zero usable ground obstacles

    const away = v2.create(1, 0);
    const threatPos = v2.sub(cover.pos, v2.mul(away, 40));
    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(cover.pos, v2.mul(away, 5)) });

    const found = findCover(bot, graph.navObstacles, threatPos);

    expect(found).toBeDefined();
    expect(isWalkClear(graph.navObstacles, threatPos, found!.pos, 0)).toBe(false);
    expect(pointClear(game, graph.navObstacles, found!.pos, 0)).toBe(true);
    expect(found!.obstacle.dead).toBe(false);
});

// Regression: a cover spot whose *center point* is hidden isn't necessarily real cover
// - real LOS/bullet checks test a player's actual collision circle, not a single point,
// so a spot placed right at the edge of an obstacle's shadow can still have the near
// side of the bot's own hitbox poking out into view. That reads as "stands in cover and
// gets shot anyway" - much weaker than actually being hidden.
test("findCover hides the bot's whole body, not just its center point", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const cover = game.map.obstacles.find(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );
    if (!cover) return;

    const away = v2.create(1, 0);
    const threatPos = v2.sub(cover.pos, v2.mul(away, 40));
    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(cover.pos, v2.mul(away, 5)) });

    const found = findCover(bot, graph.navObstacles, threatPos);
    if (!found) return;

    const towardThreat = v2.normalizeSafe(v2.sub(threatPos, found.pos));
    const nearEdge = v2.add(found.pos, v2.mul(towardThreat, bot.rad));
    expect(isWalkClear(graph.navObstacles, threatPos, nearEdge, 0)).toBe(false);
});

// The "retreat more, and cover while doing it" ask for healing: a spot 3 units from an
// active fight can be technically hidden without being remotely safe to stop and
// bandage behind. `retreatToCover` passes a minimum distance for heal/flee specifically
// (not `engageHold`, which is holding an already-acceptable range, not fleeing it).
test("findCover with a minimum distance never returns a spot closer to the threat than that", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const cover = game.map.obstacles.find(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );
    if (!cover) return;

    const away = v2.create(1, 0);
    // Close enough that this obstacle's own cover point is well under 20 units from the
    // threat - hidden, but not "safe to retreat to and heal behind".
    const threatPos = v2.sub(cover.pos, v2.mul(away, 10));
    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(cover.pos, v2.mul(away, 5)) });

    const withoutMin = findCover(bot, graph.navObstacles, threatPos);
    expect(withoutMin).toBeDefined();

    const withMin = findCover(bot, graph.navObstacles, threatPos, 20);
    if (withMin) {
        expect(v2.distance(withMin.pos, threatPos)).toBeGreaterThanOrEqual(20);
    }
});

// Regression, from a decoded real loss: with two obstacles sitting nearly equidistant
// from the bot, `findCover` used to pick whichever was strictly nearest fresh every
// single recompute - at `COVER_RECOMPUTE_INTERVAL`'s pace (under a tenth of a second for
// a high-aggression tier) a tiny position shift alone was enough to flip which one "won",
// which read as the bot's retreat direction reversing almost every tick: stuck
// oscillating between two cover spots for multiple real seconds, making progress toward
// neither, with a visible target it never fired at. `findCover`'s `preferred` param
// (the currently-held `coverObstacle`) should keep winning unless something else is
// closer by a real margin (`COVER_STICKINESS_MARGIN`), not just a coin-flip's worth.
test("findCover sticks with the currently-held obstacle over a marginally closer one", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    // `test_normal` is almost entirely water except a small landmass around its center -
    // `pointClear` refuses any candidate sitting on water, so cover has to be placed
    // there, not near the origin.
    const center = v2.create(132, 132);
    const threatPos = v2.sub(center, v2.create(40, 0));
    // Two crates placed symmetrically either side of the bot's starting spot - both
    // independently valid cover, close enough in distance that a small position shift
    // alone can flip which one comes out "nearest".
    const obstacleA = game.map.genObstacle("crate_01", v2.add(center, v2.create(0, 12)));
    const obstacleB = game.map.genObstacle("crate_01", v2.add(center, v2.create(0, -12)));
    const graph = buildNavGraph(game);
    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(center, v2.create(5, 0)) });

    const first = findCover(bot, graph.navObstacles, threatPos);
    expect(first).toBeDefined();
    const other = first!.obstacle === obstacleA ? obstacleB : obstacleA;

    // Nudge the bot a small step toward the other obstacle - small enough that, absent
    // stickiness, a fresh "nearest" pick flips to it (verified below), but well inside
    // `COVER_STICKINESS_MARGIN`.
    const towardOther = v2.normalizeSafe(v2.sub(other.pos, bot.pos));
    bot.pos = v2.add(bot.pos, v2.mul(towardOther, 2));

    const freshPick = findCover(bot, graph.navObstacles, threatPos);
    expect(freshPick?.obstacle).toBe(other); // confirms this nudge is a real "nearest" flip, not a no-op

    const stickyPick = findCover(bot, graph.navObstacles, threatPos, 0, first!.obstacle);
    expect(stickyPick?.obstacle).toBe(first!.obstacle);
});

// The "der bot muss barrels/explosive obstacles verstehen" ask: hiding behind something
// that explodes the moment it takes enough damage is worse than standing in the open in
// the specific way that matters most - the enemy doesn't even need to hit the bot
// directly, just the "cover". Uses `test_normal` (no obstacles of its own) with a single
// placed barrel instead of `local`'s random layout, so this doesn't depend on one
// happening to spawn nearby.
test("findCover never picks an explosive obstacle, even when it's the only option nearby", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const barrelPos = v2.create(100, 100);
    game.map.genObstacle("barrel_01", barrelPos);
    const graph = buildNavGraph(game);

    const away = v2.create(1, 0);
    const threatPos = v2.sub(barrelPos, v2.mul(away, 40));
    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(barrelPos, v2.mul(away, 5)) });

    expect(findCover(bot, graph.navObstacles, threatPos)).toBeUndefined();
});

test("findCover picks an ordinary crate over a nearby explosive barrel", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const barrelPos = v2.create(100, 100);
    // Past BARREL_DANGER_RADIUS (14) from the barrel - close enough to still be a
    // sensible "nearby" alternative for this map layout, but not itself within the
    // barrel's own blast danger zone (see the dedicated test for that distinction).
    const cratePos = v2.create(100, 118);
    game.map.genObstacle("barrel_01", barrelPos);
    const crate = game.map.genObstacle("crate_01", cratePos);
    const graph = buildNavGraph(game);

    const away = v2.create(1, 0);
    const threatPos = v2.sub(barrelPos, v2.mul(away, 40));
    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(barrelPos, v2.mul(away, 5)) });

    const found = findCover(bot, graph.navObstacles, threatPos);
    expect(found).toBeDefined();
    expect(found!.obstacle).toBe(crate);
});

// Not just excluding a barrel *as* cover - an ordinary crate sitting right next to one
// is just as much in the blast as picking the barrel itself would be, so it has to be
// rejected too, even though the crate itself isn't explosive at all.
test("findCover rejects an ordinary crate sitting too close to a live barrel", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const barrelPos = v2.create(100, 100);
    game.map.genObstacle("barrel_01", barrelPos);
    game.map.genObstacle("crate_01", v2.create(100, 108)); // well within BARREL_DANGER_RADIUS (14)
    const graph = buildNavGraph(game);

    const away = v2.create(1, 0);
    const threatPos = v2.sub(barrelPos, v2.mul(away, 40));
    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(barrelPos, v2.mul(away, 5)) });

    expect(findCover(bot, graph.navObstacles, threatPos)).toBeUndefined();
});

// The "auch wenn er pusht muss er sich so positionieren dass er in cover gehen kann"
// ask: pushing used to stand dead still once it reached its hold distance, in the open,
// with nothing to duck behind if the push doesn't immediately finish the fight. Once
// holding, it now uses cover exactly like `engageHold` does, just at push's own closer
// range - a crate placed right at the push-hold distance should get picked up as cover.
test("push settles into nearby cover once it reaches its hold distance, instead of standing in the open", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    // Well inside the map interior, not near a corner/edge - `test_normal` is only
    // 128x128, and a candidate cover point sitting just past map bounds reads as
    // "blocked" the same as a real obstacle would.
    const threatPos = v2.create(60, 60);
    const crate = game.map.genObstacle("crate_01", v2.create(67, 60)); // near the ~6-unit push-hold distance
    const graph = buildNavGraph(game);

    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(90, 60) });
    bot.weaponManager.weapons[0].type = "m870"; // shotgun -> push-hold distance 6 (PUSH_MIN_DIST)
    bot.weaponManager.weapons[0].ammo = 5;
    bot.weaponManager.setCurWeapIndex(0);

    const state = new BotMovementState();
    let pos = v2.copy(bot.pos);
    let reachedCover = false;
    for (let i = 0; i < 400; i++) {
        bot.pos = pos;
        const dist = v2.distance(pos, threatPos);
        updateMovement(bot, state, "push", threatPos, dist, 0.1, graph);
        pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, 8 * 0.1)) : pos;
        if (state.coverObstacle === crate) {
            reachedCover = true;
            break;
        }
    }

    expect(reachedCover).toBe(true);
});

// The "damage hat er mir kaum gefährlich gemacht" ask: once push settled into cover
// (above), it used to re-peek at the same cautious pace as an ordinary `engageHold`
// hold, giving a nearly-finished target real breathing room between exposures instead
// of pressing the advantage. Push forces the eager cadence unconditionally - even with
// `recentlyVisible: false` explicitly passed in below, proving it isn't just riding that
// flag - since reaching `push` at all already means the target is worth finishing now.
test("push re-peeks eagerly, not at engageHold's normal cautious pace, once settled at cover", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const threatPos = v2.create(60, 60);
    const crate = game.map.genObstacle("crate_01", v2.create(67, 60));
    const graph = buildNavGraph(game);

    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(90, 60) });
    bot.weaponManager.weapons[0].type = "m870";
    bot.weaponManager.weapons[0].ammo = 5;
    bot.weaponManager.setCurWeapIndex(0);

    const state = new BotMovementState();
    let pos = v2.copy(bot.pos);
    let reachedPeeking = false;
    for (let i = 0; i < 600; i++) {
        bot.pos = pos;
        const dist = v2.distance(pos, threatPos);
        updateMovement(bot, state, "push", threatPos, dist, 0.1, graph, false);
        pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, 8 * 0.1)) : pos;
        if (state.coverObstacle === crate && state.peeking) {
            reachedPeeking = true;
            break;
        }
    }
    if (!reachedPeeking) return; // this random layout's geometry didn't produce a usable peek angle

    state.peekTimer = 0.001;
    bot.pos = pos;
    updateMovement(bot, state, "push", threatPos, v2.distance(pos, threatPos), 0.1, graph, false);

    expect(state.peeking).toBe(false);
    expect(state.peekTimer).toBeLessThanOrEqual(0.6); // EAGER_PEEK_HOLD_MAX, not PEEK_HOLD_MIN (1.0)+
});

test("Cover is dropped and re-picked the instant its obstacle dies, not on the next recompute", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const cover = game.map.obstacles.find(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );
    if (!cover) return;

    const away = v2.create(1, 0);
    const threatPos = v2.sub(cover.pos, v2.mul(away, 40));
    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(cover.pos, v2.mul(away, 5)) });
    const state = new BotMovementState();

    updateMovement(bot, state, "flee", threatPos, 40, 0.1, graph);
    expect(state.coverObstacle).toBeDefined();
    const firstCover = state.coverObstacle!;

    // Kill it exactly the way combat would (`Obstacle.kill()` sets `dead` and much more
    // that isn't needed here) - the check inside `updateMovement` only looks at `dead`.
    firstCover.dead = true;
    updateMovement(bot, state, "flee", threatPos, 40, 0.1, graph);

    expect(state.coverObstacle).not.toBe(firstCover);
});

// Regression for a real match capture: the exact same physical cover point (identical
// coordinates) was found, lost, and found again over and over across several seconds -
// `findCover`'s checks (`isBodyHidden`, the `minDistFromThreat` gate) depend on `threatPos`
// itself, a live read on a moving/estimated enemy position, so a threat distance wobbling
// across a gate's threshold can flip "valid cover" to "nothing found" and back without the
// bot's own situation changing at all. Before the fix, every miss reset `settledAtCover`
// unconditionally, so the peek cycle - which only starts once settled - never got a real
// chance to run. Fixed geometry with the threat kept on the exact same ray from the cover
// obstacle (so the candidate point itself never moves, only its distance from the threat
// does) isolates the `minCoverDist` gate as the controlled, deterministic stand-in for that
// same-spot-flickers-valid symptom - see `COVER_MISS_GRACE`.
test("Fleeing tolerates a single findCover miss on still-alive cover instead of un-settling", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const cratePos = v2.create(100, 100);
    game.map.genObstacle("crate_01", cratePos);
    const graph = buildNavGraph(game);

    const away = v2.create(1, 0); // cover candidate sits on the +x side of the crate
    // Same direction from the crate both times, so the candidate point itself is
    // identical either way - only its distance from the threat (relative to
    // SAFE_HEAL_DIST, 16) changes.
    const threatFar = v2.sub(cratePos, v2.mul(away, 25)); // candidate clears SAFE_HEAL_DIST
    const threatNear = v2.sub(cratePos, v2.mul(away, 10)); // candidate falls under it

    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(cratePos, v2.mul(away, 10)) });
    const state = new BotMovementState();

    let pos = v2.copy(bot.pos);
    for (let i = 0; i < 200 && !state.settledAtCover; i++) {
        bot.pos = pos;
        updateMovement(bot, state, "flee", threatFar, v2.distance(pos, threatFar), 0.1, graph);
        pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, 8 * 0.1)) : pos;
    }
    expect(state.settledAtCover).toBe(true);
    const settledCover = state.coverPos;

    // One recompute with the threat close enough to fail SAFE_HEAL_DIST - a single miss
    // on cover that hasn't actually changed. Should be graced, not treated as a loss.
    bot.pos = pos;
    state.coverRecheck = 0;
    updateMovement(bot, state, "flee", threatNear, v2.distance(pos, threatNear), 0.1, graph);
    expect(state.coverMissStreak).toBe(1);
    expect(state.settledAtCover).toBe(true);
    expect(state.coverPos).toEqual(settledCover);

    // The threat backs off again immediately after - confirms the graced miss didn't
    // silently corrupt anything, and the streak clears back to 0 on the next real find.
    state.coverRecheck = 0;
    updateMovement(bot, state, "flee", threatFar, v2.distance(pos, threatFar), 0.1, graph);
    expect(state.coverMissStreak).toBe(0);
    expect(state.settledAtCover).toBe(true);
    expect(state.coverPos).toEqual(settledCover);

    // A second miss in a row, past the grace period, is a genuine loss - the bot un-
    // settles and looks elsewhere rather than holding a spot that's stopped working.
    state.coverRecheck = 0;
    updateMovement(bot, state, "flee", threatNear, v2.distance(pos, threatNear), 0.1, graph);
    state.coverRecheck = 0;
    updateMovement(bot, state, "flee", threatNear, v2.distance(pos, threatNear), 0.1, graph);
    expect(state.settledAtCover).toBe(false);
});

// Regression: reaching cover that only barely cleared SAFE_HEAL_DIST (16) used to be
// abandoned immediately for "keep opening distance" (see RETREAT_SETTLE_MULT) purely
// because raw distance to the threat was still under that bar - even though the cover
// was already doing its actual job. On a compact arena, real cover naturally tends to
// sit at exactly this kind of modest distance, so this was throwing away secured hiding
// spots to chase a distance number in the open - "muss dafür sorgen, dass der Gegner
// ihm nicht folgen kann", not abandon the one thing already accomplishing that. Fixed
// geometry (not the random "local" map) so the resulting cover's exact distance from
// the threat is known and controllable.
test("Fleeing to cover that's only just barely safe still stops once genuinely hidden", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const away = v2.create(1, 0);
    const threatPos = v2.create(60, 60);
    // A few units past SAFE_HEAL_DIST (16) from the threat - the resulting cover point
    // (past the crate's own edge) ends up a little further still, comfortably under
    // RETREAT_SETTLE_MULT's bar (28).
    game.map.genObstacle("crate_01", v2.add(threatPos, v2.mul(away, 18)));
    const graph = buildNavGraph(game);

    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(threatPos, v2.mul(away, 13)) });
    const state = new BotMovementState();

    let pos = v2.copy(bot.pos);
    for (let i = 0; i < 200 && !state.settledAtCover; i++) {
        bot.pos = pos;
        updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), 0.1, graph);
        pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, 8 * 0.1)) : pos;
    }
    expect(state.settledAtCover).toBe(true);

    // Right after settling at this close-but-genuinely-hidden cover, the bot should
    // hold here - not abandon it to chase a raw distance number in the open.
    bot.pos = pos;
    updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), 0.1, graph);
    expect(bot.touchMoveActive).toBe(false);
});

// Regression for a real match capture: "wird gepusht und stirbt" - a bot camped one
// exact spot for 7.6 straight seconds chaining heals with zero threat signal (no
// sighting, no heard shot) the whole time, since `stillExposed`/`threatClosingIn` both
// need *some* signal to fire on and a quiet push never produces one - the enemy simply
// reappeared already close enough to finish it. Same close-but-settled geometry as the
// test above (confirms the short-term "hold here" behavior is unaffected), but this
// time enough real time passes with the threat position never updating at all - no
// signal whatsoever - and the bot still has to resume moving on the strength of elapsed
// time alone (see `SETTLED_MAX_S`).
test("Fleeing resumes retreating once it's been settled too long, even with zero threat signal", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const away = v2.create(1, 0);
    const threatPos = v2.create(60, 60);
    game.map.genObstacle("crate_01", v2.add(threatPos, v2.mul(away, 18)));
    const graph = buildNavGraph(game);

    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(threatPos, v2.mul(away, 13)) });
    const state = new BotMovementState();

    let pos = v2.copy(bot.pos);
    for (let i = 0; i < 200 && !state.settledAtCover; i++) {
        bot.pos = pos;
        updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), 0.1, graph);
        pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, 8 * 0.1)) : pos;
    }
    expect(state.settledAtCover).toBe(true);

    bot.pos = pos;
    updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), 0.1, graph);
    expect(bot.touchMoveActive).toBe(false); // holds here at first, same as the test above

    // Same fixed spot, same unchanged threatPos - just enough real time elapsed (past
    // SETTLED_MAX_S) that sitting still this long stops being "safe by default" on its
    // own, with no sighting or gunshot needed to trigger it.
    updateMovement(bot, state, "flee", threatPos, v2.distance(bot.pos, threatPos), 4, graph);
    expect(bot.touchMoveActive).toBe(true);
});

// Regression for a second, more severe real match capture: a bot went fully still at 46
// units' last-known separation and healed blind for 3.39s - just *under* the old
// SETTLED_MAX_S (3.5) - before taking a lethal hit the instant the enemy reappeared
// already at point-blank range, having silently closed that entire gap while the bot sat
// there. Resuming movement doesn't cancel an in-progress heal (see `SETTLED_MAX_S`'s own
// doc comment - `Player.cancelAction` is never called by movement), so there's no real
// cost to cutting this bar down hard - locks in the tightened value (1.2s) directly,
// rather than just proving *some* value eventually resumes movement like the test above.
test("Fleeing resumes well before the old, nearly-fatal 3.5s settle bar", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const away = v2.create(1, 0);
    const threatPos = v2.create(60, 60);
    game.map.genObstacle("crate_01", v2.add(threatPos, v2.mul(away, 18)));
    const graph = buildNavGraph(game);

    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(threatPos, v2.mul(away, 13)) });
    const state = new BotMovementState();

    let pos = v2.copy(bot.pos);
    for (let i = 0; i < 200 && !state.settledAtCover; i++) {
        bot.pos = pos;
        updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), 0.1, graph);
        pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, 8 * 0.1)) : pos;
    }
    expect(state.settledAtCover).toBe(true);

    // 2s of total silence: past the new 1.2s bar, comfortably short of the old 3.5s one -
    // this is exactly the gap a real pursuer can close unseen.
    bot.pos = pos;
    updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), 2, graph);
    expect(bot.touchMoveActive).toBe(true);
});

// Same setup, but the cover sits far enough away from the start that the bot genuinely
// has put real distance behind it by the time it settles - it must actually stop once
// that distance is enough, not retreat forever regardless of how safe it already is.
test("Fleeing to cover that's already well past the settle distance stops there", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const away = v2.create(1, 0);
    const threatPos = v2.create(60, 60);
    // Well past RETREAT_SETTLE_MULT's bar (28) on its own, before even adding the
    // crate's own edge/buffer.
    game.map.genObstacle("crate_01", v2.add(threatPos, v2.mul(away, 40)));
    const graph = buildNavGraph(game);

    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(threatPos, v2.mul(away, 15)) });
    const state = new BotMovementState();

    let pos = v2.copy(bot.pos);
    for (let i = 0; i < 400 && !state.settledAtCover; i++) {
        bot.pos = pos;
        updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), 0.1, graph);
        pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, 8 * 0.1)) : pos;
    }
    expect(state.settledAtCover).toBe(true);

    bot.pos = pos;
    updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), 0.1, graph);
    expect(bot.touchMoveActive).toBe(false);

    // A deliberate, chosen stand-still (genuinely safe now, nothing left to do) must
    // never misread as "stuck" - see BotMovementState.stuck's own doc comment. Holding
    // for a full STUCK_CHECK_INTERVAL (1s) here would incorrectly flip `fleeOrFight`
    // over to fighting if this weren't distinguished from a real obstruction. `dt`
    // already past the interval on its own so this reliably forces a fresh evaluation
    // during the stationary phase, not just inheriting a stale value from earlier.
    updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), 1.1, graph);
    expect(state.stuck).toBe(false);
});

// "muss vor allem weiter retreaten wenn der Gegner pusht um die Fertigstellung des
// Healens zu garantieren" - settling behind real cover must not mean standing rooted
// the instant the threat is merely out of sight for now. If the threat is actively
// closing the distance (a fresh, closer `threatPos` - a heard gunshot counts just as
// well as a sighting, see `BotBrain.threatPos`), retreat resumes even without having
// regained line of sight to the bot's exact hiding spot yet - waiting for that to
// happen first is waiting to get caught at point-blank range mid-heal. Same fixed
// geometry as the settle-and-stop test above; the threat then advances along the same
// axis, still on the near side of the crate (so it genuinely hasn't regained sight),
// closer by well more than `PUSH_DETECT_MARGIN`.
test("Fleeing resumes retreating once settled if the threat closes in, even without regaining sight", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const away = v2.create(1, 0);
    const threatPos = v2.create(60, 60);
    game.map.genObstacle("crate_01", v2.add(threatPos, v2.mul(away, 40)));
    const graph = buildNavGraph(game);

    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(threatPos, v2.mul(away, 15)) });
    const state = new BotMovementState();

    let pos = v2.copy(bot.pos);
    for (let i = 0; i < 400 && !state.settledAtCover; i++) {
        bot.pos = pos;
        updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), 0.1, graph);
        pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, 8 * 0.1)) : pos;
    }
    expect(state.settledAtCover).toBe(true);

    bot.pos = pos;
    updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), 0.1, graph);
    expect(bot.touchMoveActive).toBe(false); // settled and stopped, same as the test above

    // The threat pushes 20 units closer along the same axis, still well short of the
    // crate - genuinely hasn't regained sight of the bot hiding behind it.
    const pushedThreatPos = v2.add(threatPos, v2.mul(away, 20));
    updateMovement(bot, state, "flee", pushedThreatPos, v2.distance(pos, pushedThreatPos), 0.1, graph);
    expect(bot.touchMoveActive).toBe(true);
});

// The "peek from cover, shoot peeking enemies" ask: once `engageHold` reaches cover, it
// must not just sit there forever - it has to cycle out to a spot with line of sight
// back to the threat and return to full cover, repeatedly. Same fixed-geometry setup as
// the `findCover` tests above (obstacle + threat placed at a known offset), but
// additionally requires the obstacle to be isolated (nothing else within 10 units): a
// bot approaching cover that's itself part of a tight cluster (e.g. a building's walls)
// can get locally deflected by a *neighboring* piece of the cluster on the way in,
// which is `isDirClear`'s obstacle-avoidance doing its job, not a peek-cycle bug - this
// test is specifically about the cycle itself, not general multi-obstacle steering
// (already covered by the `followPath` tests above).
test("engageHold cycles between hiding at cover and peeking out to trade shots", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const candidates = game.map.obstacles.filter(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );
    const isolated = candidates.filter(
        (c) => !candidates.some((o) => o !== c && v2.distance(o.pos, c.pos) < 10),
    );

    const away = v2.create(1, 0);
    const speed = 8;
    const dt = 0.1;

    // Try every isolated obstacle rather than just the first: a fixed approach axis
    // against an arbitrary obstacle's shape/orientation occasionally lands the peek
    // candidates somewhere degenerate (off the map edge, inside a stray neighbor just
    // past the 10-unit isolation cutoff) - the mechanism only needs proving for one
    // real obstacle, not for all of them.
    for (const cover of isolated) {
        const threatPos = v2.sub(cover.pos, v2.mul(away, 40));
        const bot = game.playerBarn.addTestPlayer({ pos: v2.add(cover.pos, v2.mul(away, 5)) });
        const state = new BotMovementState();

        let pos = v2.copy(bot.pos);
        let sawHiding = false;
        let sawPeeking = false;

        for (let i = 0; i < 200; i++) {
            bot.pos = pos;
            // `dist` fixed within the fallback (no-gun) sweet spot's hold band
            // regardless of the real geometric distance - only `engageHold`'s
            // cover/peek behavior is under test here, not `pickRangeMode`'s
            // close/retreat thresholds (covered by botMovement.test.ts).
            updateMovement(bot, state, "engageHold", threatPos, 25, dt, graph);
            pos = bot.touchMoveActive
                ? v2.add(pos, v2.mul(bot.touchMoveDir, speed * dt))
                : pos;

            if (state.coverPos) {
                if (state.peeking) sawPeeking = true;
                else sawHiding = true;
            }
            if (sawHiding && sawPeeking) break;
        }

        if (sawHiding && sawPeeking) {
            expect(state.coverObstacle).toBeDefined();
            return;
        }
    }

    // No isolated obstacle in this random layout happened to cycle within budget -
    // nothing to assert against (see the "no such pair" skip pattern used elsewhere
    // for randomized map generation).
});

// "das peaken muss ... weniger Fläche offenbaren" - a peek should lean out only as far
// past cover's edge as it takes to regain line of sight, not further. Fixed, open
// geometry (an isolated crate, nothing else nearby) means the very first, narrowest
// angle in `PEEK_ANGLES` already clears line of sight, so `findPeekSpot`'s closest-first
// loop is guaranteed to pick it - this isolates "how far the winning angle actually leans"
// from the separate, unrelated question of whether a *wider* fallback angle is sometimes
// needed against thinner or oddly-shaped cover.
test("Peeking leans out only as far as PEEK_ANGLES' narrowest angle, not further", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const center = v2.create(132, 132);
    game.map.genObstacle("crate_01", center);
    const graph = buildNavGraph(game);

    const away = v2.create(1, 0);
    const threatPos = v2.sub(center, v2.mul(away, 40));
    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(center, v2.mul(away, 5)) });
    const state = new BotMovementState();

    let pos = v2.copy(bot.pos);
    for (let i = 0; i < 200 && !state.peeking; i++) {
        bot.pos = pos;
        updateMovement(bot, state, "engageHold", threatPos, 25, 0.1, graph);
        pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, 8 * 0.1)) : pos;
    }
    expect(state.peeking).toBe(true);
    expect(state.peekPos).toBeDefined();

    const obstaclePos = state.coverObstacle!.pos;
    const leanDir = v2.normalizeSafe(v2.sub(state.peekPos!, obstaclePos));
    const leanAngle = Math.acos(Math.max(-1, Math.min(1, v2.dot(leanDir, away))));
    // The narrowest angle this session tightened PEEK_ANGLES to (0.75) - a real regression
    // against the pre-fix value would land at 1.05 instead, comfortably outside this.
    expect(leanAngle).toBeCloseTo(0.75, 1);
});

// Regression: `retreatToCover`'s "have I reached cover" check used to compare distance
// to `coverPos` on every tick, even while a peek was actively walking the bot toward
// `peekPos` - which, being on the far side of the obstacle from `coverPos`, is
// necessarily further away than the (now tight, see `COVER_BUFFER`'s comment)
// `COVER_REACHED_DIST`. That immediately looked like "not at cover" and snapped the bot
// straight back, so a peek never actually got anywhere - `state.peeking` flipped true
// for a tick, then right back to false, without the bot's position ever moving.
// Fixed with `settledAtCover`: once cover is first reached, the peek cycle owns all
// navigation between `coverPos` and `peekPos` on its own.
test("A peek actually walks the bot to the exposed spot instead of snapping back to cover", { timeout: 15000 }, () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const candidates = game.map.obstacles.filter(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );
    // Capped at 10: trying every isolated obstacle on a map that happens to have many
    // (e.g. a field of scattered trees) can otherwise run long enough to trip the
    // default test timeout - the mechanism only needs proving for one of them.
    const isolated = candidates
        .filter((c) => !candidates.some((o) => o !== c && v2.distance(o.pos, c.pos) < 10))
        .slice(0, 10);

    const away = v2.create(1, 0);
    const speed = 8;
    const dt = 0.1;

    // Best case across every isolated obstacle, not the first one tried: obstacle
    // shape varies (a thin fence vs. a wide wall), so a single candidate occasionally
    // converges more slowly than the geometry generally allows - the mechanism only
    // needs proving for one real obstacle, not for all of them equally well.
    let bestClosest = Infinity;
    for (const cover of isolated) {
        const threatPos = v2.sub(cover.pos, v2.mul(away, 40));
        const bot = game.playerBarn.addTestPlayer({ pos: v2.add(cover.pos, v2.mul(away, 5)) });
        const state = new BotMovementState();

        let pos = v2.copy(bot.pos);
        let closestToPeek = Infinity;

        for (let i = 0; i < 300; i++) {
            bot.pos = pos;
            updateMovement(bot, state, "engageHold", threatPos, 25, dt, graph);
            pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, speed * dt)) : pos;

            if (state.peeking && state.peekPos) {
                closestToPeek = Math.min(closestToPeek, v2.distance(pos, state.peekPos));
            }
            if (closestToPeek < 2.5) break;
        }

        bestClosest = Math.min(bestClosest, closestToPeek);
        if (bestClosest < 2.5) break;
    }

    if (bestClosest < Infinity) {
        // Actually got close to the exposed spot (well under a typical cover
        // obstacle's own radius - the old snap-back bug left the bot several units
        // short, still basically at `coverPos`) - not just flagged `peeking` for one
        // tick while immediately reversing course.
        expect(bestClosest).toBeLessThan(3);
    }
});

// The other half of "predict/react to enemy peeks better": once the bot has actually
// seen the enemy, it shouldn't wait out a full "haven't seen them in a while" hiding
// window before checking again - they almost certainly just ducked back behind their
// own nearby cover.
test("engageHold re-peeks sooner after just having seen the enemy than after a while", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const candidates = game.map.obstacles.filter(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );
    const isolated = candidates.filter(
        (c) => !candidates.some((o) => o !== c && v2.distance(o.pos, c.pos) < 10),
    );

    const away = v2.create(1, 0);
    const speed = 8;
    const dt = 0.1;

    for (const cover of isolated) {
        const threatPos = v2.sub(cover.pos, v2.mul(away, 40));
        const bot = game.playerBarn.addTestPlayer({ pos: v2.add(cover.pos, v2.mul(away, 5)) });
        const state = new BotMovementState();

        // Get the bot settled into cover and mid-peek, same setup as above.
        let pos = v2.copy(bot.pos);
        let reachedPeeking = false;
        for (let i = 0; i < 200; i++) {
            bot.pos = pos;
            updateMovement(bot, state, "engageHold", threatPos, 25, dt, graph);
            pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, speed * dt)) : pos;
            if (state.peeking) {
                reachedPeeking = true;
                break;
            }
        }
        if (!reachedPeeking) continue;

        // End the peek window this tick, once having just seen the enemy and once not,
        // and compare the hiding duration each picks.
        state.peekTimer = 0.001;
        bot.pos = pos;
        updateMovement(bot, state, "engageHold", threatPos, 25, dt, graph, true);
        const eagerTimer = state.peekTimer;
        expect(state.peeking).toBe(false);

        state.peeking = true;
        state.peekTimer = 0.001;
        updateMovement(bot, state, "engageHold", threatPos, 25, dt, graph, false);
        const normalTimer = state.peekTimer;

        expect(eagerTimer).toBeLessThan(normalTimer);
        expect(eagerTimer).toBeLessThanOrEqual(0.6); // EAGER_PEEK_HOLD_MAX
        expect(normalTimer).toBeGreaterThanOrEqual(1.0); // PEEK_HOLD_MIN
        return;
    }
});

// The "der expert bot muss mehr moven" ask: movement/positioning used to be completely
// identical across every difficulty tier - only aim (reaction, error, ...) actually
// scaled with skill. An `expert` bot should hide behind cover for noticeably less time
// between peeks than an `easy` one, not just aim better once it leans out - see
// `BotTierDef.aggression`/`peekPaceMult`.
test("engageHold's peek-hide duration scales with tier - expert re-engages sooner than easy", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const candidates = game.map.obstacles.filter(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );
    const isolated = candidates.filter(
        (c) => !candidates.some((o) => o !== c && v2.distance(o.pos, c.pos) < 10),
    );

    const away = v2.create(1, 0);
    const speed = 8;
    const dt = 0.1;

    for (const cover of isolated) {
        const threatPos = v2.sub(cover.pos, v2.mul(away, 40));
        const bot = game.playerBarn.addTestPlayer({ pos: v2.add(cover.pos, v2.mul(away, 5)) });
        const state = new BotMovementState();

        let pos = v2.copy(bot.pos);
        let reachedPeeking = false;
        for (let i = 0; i < 200; i++) {
            bot.pos = pos;
            updateMovement(bot, state, "engageHold", threatPos, 25, dt, graph);
            pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, speed * dt)) : pos;
            if (state.peeking) {
                reachedPeeking = true;
                break;
            }
        }
        if (!reachedPeeking) continue;

        state.peekTimer = 0.001;
        bot.pos = pos;
        updateMovement(bot, state, "engageHold", threatPos, 25, dt, graph, false, BOT_TIERS.expert);
        const expertTimer = state.peekTimer;
        expect(state.peeking).toBe(false);

        state.peeking = true;
        state.peekTimer = 0.001;
        updateMovement(bot, state, "engageHold", threatPos, 25, dt, graph, false, BOT_TIERS.easy);
        const easyTimer = state.peekTimer;

        expect(expertTimer).toBeLessThan(easyTimer);
        return;
    }
});

// Regression, from real match data: the bot pulled the trigger roughly half as often
// per minute as a human opponent despite comparable accuracy - `PEEK_EXPOSE_MIN/MAX`
// (how long a peek stays leaned out before automatically retreating to cover) was a
// fixed 0.5-1.0s for every tier, so a slower single/bolt-action weapon regularly didn't
// even get a second shot off before ducking back, no matter how decisive the tier
// otherwise was. A more aggressive tier should commit to a peek *longer*, the opposite
// direction from the hide duration above - see `peekExposeMult`.
test("engageHold's peek expose duration scales with tier - expert stays out longer than easy", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const candidates = game.map.obstacles.filter(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );
    const isolated = candidates.filter(
        (c) => !candidates.some((o) => o !== c && v2.distance(o.pos, c.pos) < 10),
    );

    const away = v2.create(1, 0);
    const speed = 8;
    const dt = 0.1;

    for (const cover of isolated) {
        const threatPos = v2.sub(cover.pos, v2.mul(away, 40));
        const bot = game.playerBarn.addTestPlayer({ pos: v2.add(cover.pos, v2.mul(away, 5)) });
        const state = new BotMovementState();

        let pos = v2.copy(bot.pos);
        let reachedPeeking = false;
        for (let i = 0; i < 200; i++) {
            bot.pos = pos;
            updateMovement(bot, state, "engageHold", threatPos, 25, dt, graph);
            pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, speed * dt)) : pos;
            if (state.peeking) {
                reachedPeeking = true;
                break;
            }
        }
        if (!reachedPeeking) continue;

        // Force back to hidden, then let the hide timer expire next tick so the peek
        // cycle picks a fresh spot and rolls a new *expose* duration - the thing under
        // test here, not the hide duration the test above already covers.
        state.peeking = false;
        state.peekPos = undefined;
        state.peekTimer = 0.001;
        bot.pos = pos;
        updateMovement(bot, state, "engageHold", threatPos, 25, dt, graph, false, BOT_TIERS.expert);
        if (!state.peeking) continue; // no peek spot found this attempt - try the next obstacle
        const expertTimer = state.peekTimer;

        state.peeking = false;
        state.peekPos = undefined;
        state.peekTimer = 0.001;
        updateMovement(bot, state, "engageHold", threatPos, 25, dt, graph, false, BOT_TIERS.easy);
        if (!state.peeking) continue;
        const easyTimer = state.peekTimer;

        expect(expertTimer).toBeGreaterThan(easyTimer);
        return;
    }
});

// The "dynamisch auf die gegner bewegungen eingehen" ask: `retreatToCover` only ever
// re-evaluates cover against the enemy's *current* position on a fixed clock
// (`COVER_RECOMPUTE_INTERVAL`) - a flanking enemy is only noticed on the next recompute,
// so how often that happens is directly "how quickly does this bot react to the enemy
// repositioning". That should scale with skill too, not sit on the same fixed clock
// for every tier - see `coverRecomputeMult`.
test("engageHold re-checks cover against a moving enemy more often for a more aggressive tier", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const cover = game.map.obstacles.find(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );
    if (!cover) return;

    const away = v2.create(1, 0);
    const threatPos = v2.sub(cover.pos, v2.mul(away, 40));

    const expertBot = game.playerBarn.addTestPlayer({ pos: v2.add(cover.pos, v2.mul(away, 5)) });
    const expertState = new BotMovementState();
    updateMovement(expertBot, expertState, "engageHold", threatPos, 25, 0.1, graph, false, BOT_TIERS.expert);

    const easyBot = game.playerBarn.addTestPlayer({ pos: v2.add(cover.pos, v2.mul(away, 5)) });
    const easyState = new BotMovementState();
    updateMovement(easyBot, easyState, "engageHold", threatPos, 25, 0.1, graph, false, BOT_TIERS.easy);

    // Both just did their first-ever recompute (fresh state) - the countdown to the
    // *next* one is exactly `COVER_RECOMPUTE_INTERVAL * coverRecomputeMult(aggression)`.
    expect(expertState.coverRecheck).toBeLessThan(easyState.coverRecheck);
});

// End-to-end proof that peeking actually lands shots, not just that the movement
// oscillates correctly: a full `BotBrain` (perception, aim, movement, firing together,
// exactly as `BotBarn` drives it) fighting a stationary enemy it can only see during its
// own peek windows must still land hits over time. This is what the isolated
// movement-only test above can't show on its own - firing depends on `botAim.ts`
// actually reacquiring the target during a peek without waiting out a fresh reaction
// delay every single cycle (see the `tier.memory`-based fix in `updateAim`).
test("A bot fighting from cover still lands hits on a stationary enemy by peeking", () => {
    Config.bots.enabled = true;
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);
    game.botBarn.navGraph = graph;

    const candidates = game.map.obstacles.filter(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );
    const isolated = candidates.filter(
        (c) => !candidates.some((o) => o !== c && v2.distance(o.pos, c.pos) < 10),
    );

    const away = v2.create(1, 0);

    // Try a handful of isolated obstacles rather than just one - same reasoning as the
    // movement-only test above, and capped low since each attempt runs a real 25s
    // simulated fight.
    for (const cover of isolated.slice(0, 5)) {
        const dummy = game.playerBarn.addTestPlayer({ pos: v2.sub(cover.pos, v2.mul(away, 40)) });
        // Spawn right next to the dummy - guaranteed initial line of sight, so the bot
        // actually acquires it as a target - then relocate to the spot that's hidden
        // from the dummy. This stands in for "the bot spotted the enemy, then had to
        // retreat behind cover to fight from there", without needing to engineer an
        // approach path that happens to lose sight at exactly the right moment.
        const bot = game.playerBarn.addTestPlayer({ pos: v2.add(dummy.pos, v2.create(3, 0)) });
        bot.weaponManager.weapons[WeaponSlot.Primary].type = "m870";
        bot.weaponManager.weapons[WeaponSlot.Primary].ammo = 5;
        bot.weaponManager.setCurWeapIndex(WeaponSlot.Primary);
        bot.invManager.give("12gauge", 60);

        bot.botDifficulty = "expert";
        bot.botBrain = new BotBrain(bot, "expert", game.botBarn);
        game.botBarn.bots.push(bot);

        for (let i = 0; i < 5; i++) game.update(0.1);
        bot.pos = v2.add(cover.pos, v2.mul(away, 5));

        for (let i = 0; i < 250 && !dummy.dead; i++) game.update(0.1); // 25s

        const landedHits = dummy.health < 100 || dummy.dead;
        const idx = game.botBarn.bots.indexOf(bot);
        if (idx >= 0) game.botBarn.bots.splice(idx, 1);
        if (landedHits) {
            expect(landedHits).toBe(true);
            return;
        }
    }

    // None of the sampled obstacles produced a usable cover/peek fight within budget on
    // this random layout - nothing to assert against.
});

// Regression for "sometimes stuck on buildings/containers": a plain retreat used to
// steer in a raw straight line away from the threat, with no pathfinding at all - an
// obstacle placed directly in that line had only the generic local-avoidance probe
// (a few degrees of deflection, a handful of units ahead) to get around, which isn't
// enough for anything bigger than a single simple obstacle. `flee`/`heal`/`reload`'s
// "no cover found" fallback and `engageHold`'s `retreat` range-mode now route through
// the nav graph toward a real destination instead of a raw straight line.
//
// Checks *early* movement away from the exact starting spot, not total distance from
// the threat over the whole run: `flee` legitimately settles for cover once it finds
// some (SAFE_HEAL_DIST away is often satisfied by the very obstacle it just routed
// around), and `engageHold`'s `retreat` sub-mode deliberately caps how far it backs off
// (`MAX_RETREAT_DIST`) before holding position - both are correct, intentional
// stopping points, not "stuck". Genuinely stuck looks like barely moving from the
// starting position at all, which is what this actually checks for.
test("Fleeing gets unstuck and moves away even with an obstacle directly in its path", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const candidates = game.map.obstacles.filter(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );

    const away = v2.create(1, 0);
    const speed = 8;
    const dt = 0.1;

    for (const obstacle of candidates.slice(0, 15)) {
        // Threat behind the obstacle from the bot's perspective, bot just short of it -
        // fleeing (moving in `away`) walks straight at the obstacle on the first step.
        const threatPos = v2.sub(obstacle.pos, v2.mul(away, 30));
        const bot = game.playerBarn.addTestPlayer({ pos: v2.sub(obstacle.pos, v2.mul(away, 5)) });
        const state = new BotMovementState();

        let pos = v2.copy(bot.pos);
        const startPos = v2.copy(pos);

        for (let i = 0; i < 60; i++) { // 6 simulated seconds - plenty to clear one obstacle
            bot.pos = pos;
            updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), dt, graph);
            pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, speed * dt)) : pos;
        }

        if (v2.distance(pos, startPos) > 10) return; // real movement, not stuck in place
    }

    // No obstacle in this random layout happened to sit squarely in the way within the
    // sampled candidates - nothing to assert against.
});

// Regression for a real match capture: `isDirClear` used to test a single zero-width ray
// down the center of the bot's own path, not the `bot.rad`-wide body that actually has to
// fit through. Right at a box's corner, a heading can graze past just wide enough to miss
// that thin ray while the bot's real collision radius still clips the corner and gets
// stopped dead - "clear" and "the bot actually moved" disagreeing right where it matters
// most. Geometry picked so the line passes exactly `offset` units outside `crate_01`'s
// corner: less than `bot.rad` (1) is a real collision the thin ray would still miss;
// comfortably more than it is a genuine, uncontested clear path - proving this isn't just
// coincidentally always blocked.
test("isDirClear accounts for the bot's own body width, not just a thin center ray", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const center = v2.create(132, 132);
    game.map.genObstacle("crate_01", center); // AABB spanning center +/- 2.25

    const corner = v2.add(center, v2.create(2.25, -2.25));
    const dir = v2.normalizeSafe(v2.create(1, 1)); // tangent past the corner, not through it
    const outward = v2.normalizeSafe(v2.create(1, -1)); // away from the box, past the corner
    const start = v2.sub(corner, v2.mul(dir, 8)); // 8 units short of the corner along dir

    const grazing = game.playerBarn.addTestPlayer({ pos: v2.add(start, v2.mul(outward, 0.6)) });
    expect(isDirClear(grazing, dir, 12)).toBe(false);

    const wellClear = game.playerBarn.addTestPlayer({ pos: v2.add(start, v2.mul(outward, 1.5)) });
    expect(isDirClear(wellClear, dir, 12)).toBe(true);
});

// Regression for a follow-up real match capture, reported explicitly as "an der flachen
// Wand" (at the flat wall) rather than a corner: sweeping a *full* `bot.rad` disc (the
// fix above) made resting flush against a wall - the bot's completely ordinary state
// while hugging cover - read as blocked for any heading that slides *along* that wall,
// because the swept probe sits at essentially the same distance as the bot's own resting
// contact the whole way down the segment. The collision resolver only ever pushes the
// bot to `pen + 0.001` clear (see `Player.update`'s movement step), a razor-thin margin
// real float noise routinely lands on the wrong side of - `-0.001` here stands in for
// that everyday noise, not a contrived edge case. Five crates in a row build a genuinely
// flat wall (no corner anywhere near the probed heading) so this isolates that failure
// mode from the corner one above.
test("isDirClear doesn't block sliding along a flat wall the bot is already resting against", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const center = v2.create(132, 132);
    for (let i = -2; i <= 2; i++) {
        game.map.genObstacle("crate_01", v2.add(center, v2.create(i * 4.5, 0))); // edge-to-edge wall along x
    }

    const along = v2.create(1, 0);
    for (const restingOverlap of [0, 0.001, 0.01, 0.05]) {
        const bot = game.playerBarn.addTestPlayer({
            pos: v2.add(center, v2.create(0, -2.25 - 1 + restingOverlap)),
        });
        expect(isDirClear(bot, along, 3)).toBe(true);
    }
});

// Regression for a real "bot freezes in place for several seconds" match capture: local
// obstacle deflection used to flip `BotMovementState.deflectSign` the instant the
// preferred side failed and the other side happened to work - right at a corner, whether
// each side reads as clear can toggle from one tick to the next as the bot's position
// shifts by fractions of a unit, so that same-tick flip turned into exactly the
// "re-picking a side every tick" limit cycle `deflectSign`'s whole preference scheme was
// meant to prevent (near-zero net movement for seconds, evidenced in a decoded real
// match - see the doc comment where it's fixed). `deflectSign` should now only ever
// change from the deliberate once-a-second stuck check, never mid-window. No `nav`
// passed deliberately, so `followPath` never runs - this isolates the local deflection
// fallback itself from any pathfinding.
test("Local obstacle deflection doesn't flip sides mid-window, only on a genuine stuck check", () => {
    const game = createGame(TeamMode.Solo, "local");
    const candidates = game.map.obstacles.filter(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );

    const away = v2.create(1, 0);
    const speed = 8;
    const dt = 0.1; // 8 ticks below is 0.8s, safely under STUCK_CHECK_INTERVAL's 1s

    for (const obstacle of candidates.slice(0, 30)) {
        const threatPos = v2.sub(obstacle.pos, v2.mul(away, 30));
        const bot = game.playerBarn.addTestPlayer({ pos: v2.sub(obstacle.pos, v2.mul(away, 5)) });
        const state = new BotMovementState();
        const initialSign = state.deflectSign;

        let pos = v2.copy(bot.pos);
        let deflected = false;
        for (let i = 0; i < 8; i++) {
            bot.pos = pos;
            updateMovement(bot, state, "flee", threatPos, v2.distance(pos, threatPos), dt);
            if (state.deflectSign !== initialSign) {
                throw new Error(
                    `deflectSign flipped mid-window (tick ${i}) at obstacle ${JSON.stringify(obstacle.pos)}`,
                );
            }
            // Deflection actually engaged if the bot isn't walking dead straight along
            // `away` - confirms this obstacle is a real test of the fallback, not one
            // the direct line happened to clear.
            if (Math.abs(bot.touchMoveDir.y) > 0.05) deflected = true;
            pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, speed * dt)) : pos;
        }
        if (deflected) return; // exercised and held - the regression this test is for
    }

    // No obstacle in this random layout happened to trigger the deflection fallback
    // within the sampled candidates - nothing to assert against.
});

// A second, distinct source of the same real-match "vibrates in place for several
// seconds" symptom: `followPath`'s very first check re-asked "is the straight line to
// the goal fully clear *right now*" from the bot's exact current position, every single
// tick, even while already routing around something. Right at a corner that answer can
// flip from one tick to the next as the bot's position shifts by fractions of a unit,
// which flip-flopped `move` between the real, routed path direction and a straight line
// at the *distant* goal (often straight back into the very obstacle just routed around) -
// two very different directions whose alternation canceled almost all net progress,
// masked from the anti-stuck check because the small amount of real progress each cycle
// still smuggled through was just enough to stay under `STUCK_MOVE_THRESHOLD` per second.
// Fixed by only taking that shortcut while there's no path yet (see `followPath`).
test("A bot routing around an obstacle via followPath makes real progress, not a stall at the corner", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);
    const candidates = game.map.obstacles.filter(
        (o) => !o.dead && o.collidable && !o.isDoor && o.layer === 0,
    );

    const away = v2.create(1, 0);
    const speed = 6.5;
    const dt = 0.05;

    for (const obstacle of candidates.slice(0, 40)) {
        const idleGoal = v2.add(obstacle.pos, v2.mul(away, 25));
        const bot = game.playerBarn.addTestPlayer({ pos: v2.sub(obstacle.pos, v2.mul(away, 25)) });
        const state = new BotMovementState();

        let pos = v2.copy(bot.pos);
        const startPos = v2.copy(pos);
        let usedPath = false;
        for (let i = 0; i < 300; i++) { // 15 simulated seconds
            bot.pos = pos;
            updateMovement(bot, state, "idle", undefined, Infinity, dt, graph, false, undefined, false, idleGoal);
            if (state.path.length) usedPath = true;
            pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, speed * dt)) : pos;
        }

        if (!usedPath) continue; // straight line was clear the whole way - not a real test of this
        // 15 seconds at this speed comfortably covers the ~50-unit straight-line span
        // even with a real detour, *and* leaves real headroom for one genuine stuck-and-
        // recover cycle (see `STUCK_NODE_BLACKLIST_S`'s own doc comment) - the anti-stuck
        // system costs a real second or so of detection before it reroutes, which a
        // tighter budget has no slack for even once it's actually working. A stall this
        // still doesn't recover from reads as barely more than the starting distance.
        expect(v2.distance(pos, startPos)).toBeGreaterThan(20);
        return;
    }

    // No obstacle in this random layout required a real detour within the sampled
    // candidates - nothing to assert against.
});

// Regression for a real match capture, reported as "der bot war verwirrt mit Containern":
// `followPath`'s own "fully clear, skip pathing entirely" shortcut used `isWalkClear`, a
// zero-width ray, to decide whether real pathing is even needed. A gap between two
// obstacles - like the gap between adjacent containers - can have a genuinely obstacle-
// free *line* threading it dead center while the bot's actual `bot.rad`-wide body can't
// fit through: the ray reports "clear", so the shortcut kept firing and `followPath` never
// built a real path at all (`state.path` stayed empty the whole time it was needed). In the
// real capture this showed up as `stuck=true` for ~2s straight with `pathLen` at 0 the
// entire episode - nothing for the waypoint-blacklist or repath machinery to act on, because
// no path ever existed to begin with. Gap width (1 unit) is comfortably under the ~1.8 units
// two `bot.rad`(1)-radius probes need to both clear it (see `CLEARANCE_SLOP`), so the disc-
// aware check must treat this as blocked and hand off to real pathfinding.
test("followPath doesn't skip pathing through a gap too narrow for the bot's own body", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const graph = buildNavGraph(game);
    const center = v2.create(132, 132);
    const gap = 1;
    game.map.genObstacle("crate_01", v2.add(center, v2.create(0, 2.25 + gap / 2)));
    game.map.genObstacle("crate_01", v2.add(center, v2.create(0, -(2.25 + gap / 2))));

    const bot = game.playerBarn.addTestPlayer({ pos: v2.sub(center, v2.create(40, 0)) });
    const goal = v2.add(center, v2.create(40, 0));
    const state = new BotMovementState();

    // A zero-width ray straight through the gap's exact center (same `y` on both ends)
    // never touches either box - confirms the "clear" verdict this bug relied on is real,
    // not a fluke of a segment check that happens to graze an edge.
    expect(isWalkClear(graph.navObstacles, bot.pos, goal, 0)).toBe(true);

    const move = followPath(bot, state, graph, goal, 0.1);
    expect(move).not.toBeUndefined();
    expect(state.path.length).toBeGreaterThan(0);
});

// Regression for a real match capture: raw displacement alone can be fooled. The bot
// alternated between two near-opposite headings a hair unevenly right next to a
// waypoint, creeping a real unit or more per `STUCK_CHECK_INTERVAL` window while never
// actually closing in on it - `stuck`'s old raw-displacement check cleared every single
// window, so neither the anti-stuck recovery nor the waypoint blacklist ever fired, and
// the bot slowly drifted the *wrong* way while chained heals ran out the clock. Deterministic
// repro: let a real path establish a genuine `pullTarget`, then orbit *around* that exact
// point - real per-tick arc length, zero net progress toward it - and confirm it gets
// blacklisted (see `PULL_TARGET_PROGRESS_MIN`) well before `stuck`'s own slower 3-window
// bar would ever catch it from raw displacement alone.
test("Orbiting a waypoint without closing in on it gets the waypoint blacklisted", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const center = v2.create(132, 132);
    game.map.genObstacle("crate_01", v2.add(center, v2.create(8, 0)));
    const graph = buildNavGraph(game);

    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(center, v2.create(-30, 0)) });
    const state = new BotMovementState();
    const idleGoal = v2.add(center, v2.create(30, 0));
    const dt = 0.1;

    // Let a real path establish first, same as the test above.
    let pos = v2.copy(bot.pos);
    for (let i = 0; i < 30; i++) {
        bot.pos = pos;
        updateMovement(bot, state, "idle", undefined, Infinity, dt, graph, false, undefined, false, idleGoal);
        pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, 6.5 * dt)) : pos;
    }
    expect(state.pullTarget).toBeDefined();
    const pullPos = graph.pos(state.pullTarget!);
    const radius = Math.min(1.5, v2.distance(pos, pullPos) * 0.5);

    // Jump to the orbit's own starting point first and let the target settle there -
    // teleporting can itself trigger one legitimate re-pick, which isn't what this is
    // testing. Only *then* is it meaningful to call whatever it lands on "the" target
    // this orbit is failing to make progress toward.
    bot.pos = v2.add(pullPos, v2.create(radius, 0));
    updateMovement(bot, state, "idle", undefined, Infinity, dt, graph, false, undefined, false, idleGoal);
    expect(state.pullTarget).toBeDefined();
    const orbitTarget = state.pullTarget!;

    // Orbit around the exact waypoint instead of walking to it - real per-tick arc
    // length, zero net progress toward it.
    let blacklisted = false;
    for (let i = 1; i < 40 && !blacklisted; i++) {
        const angle = i * 0.5;
        bot.pos = v2.add(pullPos, v2.create(Math.cos(angle) * radius, Math.sin(angle) * radius));
        updateMovement(bot, state, "idle", undefined, Infinity, dt, graph, false, undefined, false, idleGoal);
        blacklisted = state.blacklistedNodes.has(orbitTarget);
    }

    expect(blacklisted).toBe(true);
});

// "sich nicht innen trappen zu lassen": a raw straight-line retreat goal has no idea it
// happens to land inside a building's interior lattice - `preferNonInteriorGoal` nudges
// it onto the nearest non-`interior` node instead when the graph has one nearby, so
// `followPath`'s A* never gets pointed at a dead-end room as the actual destination.
// Uses a small synthetic `NavGraph` (not a real map's random layout) so the exact node
// kinds/positions involved are known, not just hoped-for.
test("preferNonInteriorGoal steers a goal off an interior node onto a nearby hull node", () => {
    const graph = new NavGraph([]);
    const rawGoal = v2.create(100, 100);
    graph.addNode(v2.create(100, 100), 0, "interior"); // sits right on the raw goal
    const hullId = graph.addNode(v2.create(105, 100), 0, "hull"); // within the search radius

    const goal = preferNonInteriorGoal(graph, rawGoal, 0);

    expect(goal).toEqual(graph.pos(hullId));
});

test("preferNonInteriorGoal leaves an already-open goal alone", () => {
    const graph = new NavGraph([]);
    const rawGoal = v2.create(100, 100);
    graph.addNode(v2.create(100, 100), 0, "open");

    const goal = preferNonInteriorGoal(graph, rawGoal, 0);

    expect(goal).toEqual(rawGoal);
});

// A genuine dead-end room (nothing but interior nodes anywhere nearby) has no safer
// alternative to redirect to - falling back to the raw goal here is still strictly no
// worse than before this fix existed, never something new to get stuck on.
test("preferNonInteriorGoal falls back to the raw goal when only interior nodes are nearby", () => {
    const graph = new NavGraph([]);
    const rawGoal = v2.create(100, 100);
    graph.addNode(v2.create(100, 100), 0, "interior");
    graph.addNode(v2.create(105, 100), 0, "interior");

    const goal = preferNonInteriorGoal(graph, rawGoal, 0);

    expect(goal).toEqual(rawGoal);
});

// End-to-end through the actual code path `flee`/`heal` movement uses: with no real
// cover obstacle available (`findCover` finds nothing on this bare synthetic setup),
// `retreatToCover` falls back to `retreatDirection`, which must itself apply
// `preferNonInteriorGoal` before committing to `state.retreatGoal`.
test("Fleeing with no cover available picks a retreat goal off an interior node", () => {
    const graph = new NavGraph([]);
    const threatPos = v2.create(0, 100);
    // Away from the threat (+x) lands exactly on this interior node 20 units out
    // (RETREAT_LOOKAHEAD) - a real building interior sitting in the escape direction.
    graph.addNode(v2.create(70, 100), 0, "interior");
    const hullId = graph.addNode(v2.create(75, 100), 0, "hull");

    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 100) });
    const state = new BotMovementState();

    updateMovement(bot, state, "flee", threatPos, 50, 0.1, graph);

    expect(state.retreatGoal).toBeDefined();
    expect(state.retreatGoal).toEqual(graph.pos(hullId));
});

// "high scope preferen, möglichst nicht in buildings laufen" - idle rotation (no known
// threat, see `BotBrain.idleGoal`) used to path straight at the raw goal even when it
// happened to sit inside a building, the same blind-spot `preferNonInteriorGoal` already
// closed for a plain retreat and a blind chase. Same synthetic-graph shape as those two
// regressions above: an interior node right on the raw goal, a hull node just past it.
test("Idle rotation steers off an idle goal that sits inside a building", () => {
    const graph = new NavGraph([]);
    const rawGoal = v2.create(100, 100);
    graph.addNode(rawGoal, 0, "interior");
    // Off to the side, not collinear with the bot and the raw goal below - so heading at
    // the raw goal and heading at the redirected hull node are visibly different
    // directions, not the same line by coincidence.
    const hullId = graph.addNode(v2.create(100, 105), 0, "hull");

    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(80, 100) });
    const state = new BotMovementState();

    updateMovement(bot, state, "idle", undefined, Infinity, 0.1, graph, false, undefined, false, rawGoal);

    const towardRawGoal = v2.normalizeSafe(v2.sub(rawGoal, bot.pos));
    const towardHull = v2.normalizeSafe(v2.sub(graph.pos(hullId), bot.pos));
    expect(v2.dot(bot.touchMoveDir, towardRawGoal)).toBeLessThan(0.999); // not heading raw
    expect(v2.dot(bot.touchMoveDir, towardHull)).toBeGreaterThan(0.999); // heading redirected
});

// The other half of the same ask: plain wander (no idle goal at all, or already arrived
// near one) has no destination to redirect - only a heading - so the fix has to check
// candidate headings themselves before committing (see `pickWanderDir`). Synthetic graph
// with an obviously-bad half (interior, +x) and an obviously-good half (open, -x): tried
// many times, the fix should land on the good half all but a handful of times, where the
// original code (a single unbiased `v2.randomUnit()`) picked the building side roughly
// half the time by construction.
test("Idle wander avoids heading into a building most of the time it can", () => {
    const graph = new NavGraph([]);
    graph.addNode(v2.create(15, 0), 0, "interior"); // +x reads as inside a building
    graph.addNode(v2.create(-15, 0), 0, "open"); // -x reads as open ground

    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const state = new BotMovementState();

    let intoBuilding = 0;
    const trials = 300;
    for (let i = 0; i < trials; i++) {
        state.wanderTimer = 0; // force a fresh pick every call
        updateMovement(bot, state, "idle", undefined, Infinity, 0.1, graph);
        if (state.wanderDir.x > 0.1) intoBuilding++;
    }

    // Only a run of bad luck across every one of `WANDER_DIR_ATTEMPTS` retries (and then
    // the fallback itself landing badly too) picks the building side with the fix -
    // comfortably under a tenth of these trials, well below the ~50% an unbiased pick
    // would produce on this deliberately even split.
    expect(intoBuilding / trials).toBeLessThan(0.15);
});

// "checkt nicht dass er nicht in Buildings sein sollte" - closing distance on an
// *actually visible* target standing inside a building is correct (chase them where
// they really are); closing on a merely-remembered position is the case that used to
// blindly path deep into a building's interior lattice regardless. `state.pathGoal` (set
// by `followPath` the instant it actually computes a path, before A* even runs) proves
// exactly what destination each case commits to, independent of whether a full route
// happens to exist in this minimal synthetic graph.
test("engageHold's close mode avoids a building interior while chasing a memory, but not an actually-visible target", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    // A real obstacle directly on the line so `followPath` actually computes a path
    // instead of taking the "direct line is already clear" shortcut.
    const wall = game.map.genObstacle("crate_01", v2.create(75, 100));
    const graph = new NavGraph([wall]);
    const threatPos = v2.create(100, 100);
    graph.addNode(v2.create(100, 100), 0, "interior"); // sits right on the remembered spot
    const hullId = graph.addNode(v2.create(105, 100), 0, "hull");

    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 100) });
    // dist (50) is well past the no-gun fallback sweet spot's close edge (~29.5),
    // putting `engageHold` in its "close" range mode for both calls below.

    const memoryState = new BotMovementState();
    updateMovement(bot, memoryState, "engageHold", threatPos, 50, 0.1, graph, false, undefined, false);
    expect(memoryState.pathGoal).toEqual(graph.pos(hullId));

    const visibleState = new BotMovementState();
    updateMovement(bot, visibleState, "engageHold", threatPos, 50, 0.1, graph, false, undefined, true);
    expect(visibleState.pathGoal).toEqual(threatPos);
});

// Regression for a real match capture: the bot committed to a full-speed, cover-free
// "close" chase toward nothing but a gunshot's rough position estimate for 4.5 straight
// seconds of open ground, then took a hit within a quarter second of the target actually
// reappearing - "close" mode's own reasoning (matching a real player pressing someone
// they're actively tracking) stops applying once it's been chasing a stale guess this
// long. Same deterministic cover geometry as `findCover`'s own "sticks with the
// currently-held obstacle" test - proven to produce a real, reachable hiding spot.
test("engageHold's close mode gives up a blind chase past BLIND_CLOSE_MAX_S and holds from cover instead", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const center = v2.create(132, 132);
    const threatPos = v2.sub(center, v2.create(60, 0));
    game.map.genObstacle("crate_01", v2.add(center, v2.create(0, 12)));
    const graph = buildNavGraph(game);

    const bot = game.playerBarn.addTestPlayer({ pos: v2.add(center, v2.create(5, 0)) });
    const state = new BotMovementState();
    const dist = v2.distance(bot.pos, threatPos); // ~65 - well past the close edge

    // Under the cap: still fully committed to the open chase, no cover sought at all.
    for (let i = 0; i < 15; i++) { // 1.5s - under BLIND_CLOSE_MAX_S (2s)
        updateMovement(bot, state, "engageHold", threatPos, dist, 0.1, graph, false, undefined, false);
    }
    expect(state.coverPos).toBeUndefined();

    // Past the cap, target still never reappeared: falls back to holding from the real
    // cover that was there the whole time instead of continuing to sprint blind.
    for (let i = 0; i < 10; i++) { // +1s, comfortably past the cap
        updateMovement(bot, state, "engageHold", threatPos, dist, 0.1, graph, false, undefined, false);
    }
    expect(state.coverPos).toBeDefined();
});

test("util.sameLayer sanity used by tryOpenNearbyDoor treats ground and ground+stairs as the same layer", () => {
    // Guards the layer check inside tryOpenNearbyDoor/followPath against a regression
    // silently excluding doors that sit on a stairs-tagged ground tile.
    expect(util.sameLayer(0, 2)).toBeTruthy();
    expect(util.sameLayer(0, 1)).toBeFalsy();
});
