import { expect, test } from "vitest";
import { BotMovementState, isSafeToHeal, updateMovement } from "../../server/src/game/bot/botMovement.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

// A fleeing bot must not spend that tick closing distance into the fight it's trying to
// disengage from. Full cover-seeking needs the nav graph (M3, tested in
// botMovementNav.test.ts); this is the plain "put distance between me and the threat"
// fallback used when no cover is nearby or no nav graph exists yet.
test("updateMovement opens distance instead of chasing on the `flee` directive", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    const threat = v2.create(60, 50);

    const state = new BotMovementState();
    updateMovement(bot, state, "flee", threat, 10, 0.05);

    expect(bot.touchMoveActive).toBe(true);
    // Moving away means a strongly negative x component (the threat is due +x of the bot). The
    // retreat shake leans it sideways by up to ~0.6, so the bar is a little looser than straight back.
    expect(bot.touchMoveDir.x).toBeLessThan(-0.7);
});

// "wenn retreat nicht geht muss er halt wenigstens schießen" - BotBrain.fleeOrFight
// reads `state.stuck` to give up on a retreat that's demonstrably not working. This
// tests the flag's own detection logic in isolation: `bot.pos` is deliberately never
// updated between calls (simulating a real collision blocking every attempted step,
// without needing to engineer actual blocking geometry) while `flee` keeps producing a
// genuine, non-trivial "move away" vector every tick - past several seconds of that
// with zero net progress is exactly what "stuck" means. Calls with `dt` already past
// STUCK_CHECK_INTERVAL (1s) each: the first always measures against the state's
// default, not-yet-real `stuckAnchor` and never counts on its own; `stuck` itself only
// goes true after STUCK_STREAK_FOR_FIGHT (3) consecutive real windows in a row.
test("updateMovement marks the bot stuck after several seconds of trying to move with no progress", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    const threat = v2.create(60, 50);
    const state = new BotMovementState();

    for (let i = 0; i < 4; i++) {
        updateMovement(bot, state, "flee", threat, 10, 1.1);
    }

    expect(state.stuck).toBe(true);
});

// A single bad window (one cover-hop that happened to net little straight-line
// distance, one tick of dodging fire) must not alone flip `stuck` - only a sustained
// run does. This is the regression this fix is actually for: an earlier version fired
// on the very first real window, which was found (via real match analysis) to make the
// bot give up on retreating-to-heal almost immediately during ordinary, working
// retreats - "der Bot heilt fast nie in echten Kämpfen".
test("updateMovement does not mark the bot stuck from a single bad window alone", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    const threat = v2.create(60, 50);
    const state = new BotMovementState();

    updateMovement(bot, state, "flee", threat, 10, 1.1); // stale-anchor window
    updateMovement(bot, state, "flee", threat, 10, 1.1); // one real no-progress window

    expect(state.stuck).toBe(false);
});

// The other half: a bot that's making real progress must never read as stuck, no
// matter how little distance any single tick covers.
test("updateMovement does not mark the bot stuck while actually making progress", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    const threat = v2.create(60, 50);
    const state = new BotMovementState();

    let pos = v2.copy(bot.pos);
    for (let i = 0; i < 3; i++) {
        bot.pos = pos;
        updateMovement(bot, state, "flee", threat, v2.distance(pos, threat), 1.1);
        pos = bot.touchMoveActive ? v2.add(pos, v2.mul(bot.touchMoveDir, 8 * 1.1)) : pos;
    }

    expect(state.stuck).toBe(false);
});

// "der Bot ist bisschen hohl sobald er den Fight verlässt" - idle with an `idleGoal`
// (a last-known enemy spot, or the map's center - see `BotBrain.idleGoal`) heads there
// instead of wandering aimlessly. No `nav` here, so this exercises the direct-line
// fallback specifically.
test("updateMovement heads toward idleGoal instead of wandering when idle", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    const idleGoal = v2.create(100, 50);

    const state = new BotMovementState();
    updateMovement(bot, state, "idle", undefined, Infinity, 0.05, undefined, false, undefined, true, idleGoal);

    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.x).toBeGreaterThan(0.9); // toward idleGoal, +x
});

// Once close enough, there's nothing left to head toward - falls back to the original
// plain wander instead of jittering right on top of `idleGoal` forever. Checked against
// `state.wanderDir` itself (read after the call, since a fresh state's wander timer
// starts at 0 and rerolls on the very first tick) rather than a specific direction,
// which is randomized and not the point of this test.
test("updateMovement falls back to wandering once idleGoal is reached", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    const idleGoal = v2.create(52, 50); // within IDLE_GOAL_REACHED_DIST

    const state = new BotMovementState();
    updateMovement(bot, state, "idle", undefined, Infinity, 0.05, undefined, false, undefined, true, idleGoal);

    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.x).toBeCloseTo(state.wanderDir.x, 5);
    expect(bot.touchMoveDir.y).toBeCloseTo(state.wanderDir.y, 5);
});

// Without an `idleGoal` at all (every pre-existing direct call), behavior must stay the
// original pure wander - this is the backward-compatibility guarantee the optional
// parameter is supposed to provide.
test("updateMovement wanders as before when no idleGoal is given", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });

    const state = new BotMovementState();
    updateMovement(bot, state, "idle", undefined, Infinity, 0.05);

    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.x).toBeCloseTo(state.wanderDir.x, 5);
    expect(bot.touchMoveDir.y).toBeCloseTo(state.wanderDir.y, 5);
});

test("updateMovement chases the threat on `engageHold` when too far", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    const threat = v2.create(100, 50); // far

    const state = new BotMovementState();
    updateMovement(bot, state, "engageHold", threat, 50, 0.05);

    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.x).toBeGreaterThan(0.5); // closing in, +x toward the threat
});

// Regression: without hysteresis, a bot sitting right at its sweet spot flips between
// "close" and "hold" every tick as its own strafing makes `dist` wobble a fraction of a
// unit across the boundary - visibly "vibrating" in place instead of circling. With no
// gun equipped `currentSweetSpot` falls back to 25, so the naive close-in boundary sits
// at 25 + max(2, 25*0.18) = 29.5; dist alternating 30/29 straddles it exactly.
test("Range mode has hysteresis: it does not flicker once committed to closing in", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const threat = v2.create(100, 0);

    const state = new BotMovementState();
    const xSigns: number[] = [];
    for (const dist of [30, 29, 30, 29, 30, 29]) {
        updateMovement(bot, state, "engageHold", threat, dist, 0.05);
        xSigns.push(bot.touchMoveDir.x);
    }

    // "close" mode points strongly toward +x; "hold" (cover/peek, or lateral strafe with
    // no nav graph) never does. A flickering implementation would alternate every entry.
    for (const x of xSigns) expect(x).toBeGreaterThan(0.5);
});

test("Range mode has hysteresis: it does not flicker once committed to backing off", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    // Centre of the map: backing off from a corner is correctly refused (see `keepOffBorder`).
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(game.map.width / 2, game.map.height / 2) });
    const threat = v2.add(bot.pos, v2.create(100, 0));

    const state = new BotMovementState();
    const xSigns: number[] = [];
    // Retreat is capped at MAX_RETREAT_DIST (20), independent of the sweet spot itself
    // (25 - 4.5 = 20.5 uncapped) - see the "never chase a sniper's ideal range by
    // backpedaling into a wall" note on `pickRangeMode`. Naive boundary is therefore
    // exactly 20; 19/20.5 straddles it without ever crossing the exit hysteresis (22).
    for (const dist of [19, 20.5, 19, 20.5, 19, 20.5]) {
        updateMovement(bot, state, "engageHold", threat, dist, 0.05);
        xSigns.push(bot.touchMoveDir.x);
    }

    for (const x of xSigns) expect(x).toBeLessThan(-0.5);
});

// Regression for a real bug found in manual play: a weapon's sweet spot is a fine
// reason to *close in* when too far away, but backpedaling all the way out to it on a
// map far smaller than that just walks a bot into the map edge - it looks exactly like
// "movement is dumb" to a player, and it's how a duel could run out the clock without
// ever settling into a stable firing position. Uses the no-gun fallback sweet spot (25,
// see `currentSweetSpot`) rather than a real weapon: every real gun's own sweet spot is
// now tuned low enough (see `sweetSpotFor` - recalibrated against real human match data
// on this compact arena, see the mosin-specific tests below) that none of them can
// exceed `MAX_RETREAT_DIST` on their own any more, so the fallback is what still
// actually exercises this cap.
test("A weapon's sweet spot never pulls the bot into retreating past MAX_RETREAT_DIST", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const threat = v2.create(100, 0);

    const state = new BotMovementState();
    // 30 is already past the no-gun fallback's own 29.5-unit close edge - a bot that
    // tries to back off from here instead of closing in is the bug.
    updateMovement(bot, state, "engageHold", threat, 30, 0.05);

    expect(bot.touchMoveDir.x).not.toBeLessThan(-0.5); // must not be retreating
});

// Regression for real feedback that `push` was "too aggressive": it used to close all
// the way down to `PUSH_MIN_DIST` (6 units) regardless of what was equipped, which for
// a long-range weapon meant a bot that was already winning at a sane distance would
// instead rush the enemy down to near-melee range. It should scale with the weapon's
// own sweet spot instead.
test("push holds at a longer range for a long-range weapon instead of rushing to melee", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    // Mosin's own sweet spot is 18 (see `sweetSpotFor` - recalibrated from a
    // theoretical 70 against real human match data on this compact arena), so its
    // push-hold distance is max(PUSH_MIN_DIST, 18*0.45) = 8.1 - closer than it used to
    // be, but still noticeably past a shotgun's own near-melee hold (see the sibling
    // test below).
    const threat = v2.create(7, 0);
    bot.weaponManager.weapons[0].type = "mosin";
    bot.weaponManager.weapons[0].ammo = 5;
    bot.weaponManager.setCurWeapIndex(0);

    const state = new BotMovementState();
    // 7 units is already within the mosin's ~8.1-unit push-hold distance - closing
    // further here, all the way to a shotgun-appropriate range, is the bug. It's still
    // free to move laterally once holding (see the no-cover push-hold test below) - the
    // bug this guards against is specifically closing distance further, not moving at all.
    updateMovement(bot, state, "push", threat, 7, 0.05);

    expect(bot.touchMoveDir.x).not.toBeGreaterThan(0.3); // not still closing in, +x here
});

test("push still closes to near-melee range for a short-range weapon", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const threat = v2.create(20, 0);
    bot.weaponManager.weapons[0].type = "m870"; // shotgun, sweet spot ~10 -> push-hold 6
    bot.weaponManager.weapons[0].ammo = 5;
    bot.weaponManager.setCurWeapIndex(0);

    const state = new BotMovementState();
    updateMovement(bot, state, "push", threat, 20, 0.05);

    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.x).toBeGreaterThan(0.5); // still closing in toward the threat
});

// The "der bot moved zu einer weird position" ask: `engageHold`'s "hold, no cover
// nearby" fallback used to be pure lateral strafing with nothing at all pulling it back
// toward an acceptable range - left alone across many ticks it just drifts wherever
// strafing happens to carry it (observed live as the bot ending up at an arbitrary,
// unpurposeful distance instead of holding position). No gun equipped -> `currentSweetSpot`
// fallback 25, band 4.5, so the hold band is [20, 29.5].
test("engageHold's no-cover hold pulls back inward once drifted past the outer edge", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(game.map.width / 2, game.map.height / 2) });
    const threat = v2.add(bot.pos, v2.create(35, 0)); // past the 29.5 outer edge

    const state = new BotMovementState();
    state.rangeMode = "hold"; // simulates the one-tick lag right past the edge
    updateMovement(bot, state, "engageHold", threat, 35, 0.05);

    // Pure tangential strafe is perpendicular to the threat direction (dot 0) - any
    // positive dot product here is exactly the inward radial correction.
    const towardThreat = v2.normalizeSafe(v2.sub(threat, bot.pos));
    expect(v2.dot(bot.touchMoveDir, towardThreat)).toBeGreaterThan(0.05);
});

test("engageHold's no-cover hold pulls back outward once drifted past the inner edge", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(game.map.width / 2, game.map.height / 2) });
    const threat = v2.add(bot.pos, v2.create(15, 0)); // inside the 20-unit inner edge

    const state = new BotMovementState();
    state.rangeMode = "hold";
    updateMovement(bot, state, "engageHold", threat, 15, 0.05);

    const towardThreat = v2.normalizeSafe(v2.sub(threat, bot.pos));
    expect(v2.dot(bot.touchMoveDir, towardThreat)).toBeLessThan(-0.05);
});

// A weapon-specific sanity check on top of the no-gun cases above: mosin's own sweet
// spot (18, see `sweetSpotFor`) puts its hold band at roughly [14.8, 21.2] - 18 sits
// dead center, so no radial correction should apply at all.
test("engageHold's no-cover hold applies no pull for a weapon within its own band", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const threat = v2.create(18, 0); // dead center of mosin's own ~[14.8, 21.2] band
    bot.weaponManager.weapons[0].type = "mosin";
    bot.weaponManager.weapons[0].ammo = 5;
    bot.weaponManager.setCurWeapIndex(0);

    const state = new BotMovementState();
    state.rangeMode = "hold";
    updateMovement(bot, state, "engageHold", threat, 18, 0.05);

    const towardThreat = v2.normalizeSafe(v2.sub(threat, bot.pos));
    expect(Math.abs(v2.dot(bot.touchMoveDir, towardThreat))).toBeLessThan(0.05);
});

// The "retreated without ever actually healing" complaint: an equally fast pursuer
// never lets plain distance grow past `SAFE_HEAL_DIST` on its own (a straight chase
// keeps the gap constant), so without this fallback the raw-distance/cover checks alone
// could deny healing forever even after real separation has already happened.
// `sustainedLost` (a real, sustained break in contact - see `BotBrain`'s
// `SUSTAINED_LOST_MS`) overrides both.
test("isSafeToHeal treats a sustained break in contact as safe regardless of distance or cover", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    const state = new BotMovementState();

    expect(isSafeToHeal(bot, state, 3, /* sustainedLost */ true)).toBe(true); // well under SAFE_HEAL_DIST
});

test("isSafeToHeal still requires distance or cover without a sustained break in contact", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    const state = new BotMovementState();

    expect(isSafeToHeal(bot, state, 3, /* sustainedLost */ false)).toBe(false);
});

// Real feedback: a bot pushing a healthy enemy who sat in cover at 8-12 units with a long-range
// weapon just peeked in and out there, never closing in - it held at its push-hold distance even while
// it clearly had the advantage. With a clear health advantage it should close the last few units.
test("push closes to near-melee range with a long-range weapon when it has a clear health advantage", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const threat = v2.create(7.5, 0);
    bot.weaponManager.weapons[0].type = "mosin";
    bot.weaponManager.weapons[0].ammo = 5;
    bot.weaponManager.setCurWeapIndex(0);

    const state = new BotMovementState();
    updateMovement(bot, state, "push", threat, 7.5, 0.05, undefined, false, undefined, true, undefined, false, true);

    expect(bot.touchMoveDir.x).toBeGreaterThan(0.5); // closing in toward the threat, +x here
});
