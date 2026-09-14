import { expect, test } from "vitest";
import { BotMovementState, updateMovement } from "../../server/src/game/bot/botMovement.ts";
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
    // Moving away means a strongly negative x component (the threat is due +x of the bot).
    expect(bot.touchMoveDir.x).toBeLessThan(-0.9);
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
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const threat = v2.create(100, 0);

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

// Regression for a real bug found in manual play: a long-range weapon's sweet spot
// (up to 70 units for a bolt-action rifle) is a fine reason to *close in* when too far
// away, but backpedaling all the way out to it on a map far smaller than that just
// walks a bot into the map edge - it looks exactly like "movement is dumb" to a
// player, and it's how a duel between two bots equipped only with a sniper could run
// out the clock without ever settling into a stable firing position.
test("A long-range weapon's sweet spot never pulls the bot into retreating past MAX_RETREAT_DIST", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const threat = v2.create(100, 0);
    bot.weaponManager.weapons[0].type = "mosin"; // sweet spot 70, per currentSweetSpot
    bot.weaponManager.weapons[0].ammo = 5;
    bot.weaponManager.setCurWeapIndex(0);

    const state = new BotMovementState();
    // Comfortably closer than the mosin's 70-unit sweet spot, but not point-blank -
    // a bot that tries to reach 70 units of separation here is the bug.
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
    const threat = v2.create(20, 0);
    bot.weaponManager.weapons[0].type = "mosin"; // sweet spot 70 -> push-hold ~31.5
    bot.weaponManager.weapons[0].ammo = 5;
    bot.weaponManager.setCurWeapIndex(0);

    const state = new BotMovementState();
    // 20 units is already well inside the mosin's push-hold distance - closing further
    // here, all the way to a shotgun-appropriate range, is the bug.
    updateMovement(bot, state, "push", threat, 20, 0.05);

    expect(bot.touchMoveActive).toBe(false);
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
