import { expect, test } from "vitest";
import { BotBrain } from "../../server/src/game/bot/botBrain.ts";
import { TeamMode, WeaponSlot } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/**
 * "ein wenig predicten können, wo der Gegner sich hinbewegt, um offscreens zu treffen" -
 * `BotBrain.offscreenAimTarget` extrapolates a brief, predicted position from the
 * target's last known spot and its own tracked velocity the instant it leaves the bot's
 * view rectangle, and keeps aiming/firing at that spot as long as an actual, unobstructed
 * line still reaches it - exactly the "still shooting at where they must be, just off my
 * screen" read a good human player has. These drive a full `BotBrain` (perception, aim,
 * movement, firing together) with manual control over `game.now`, the same pattern
 * `botAim.test.ts` uses for its own velocity/timing-sensitive tests.
 */

// "single" fire mode (not "auto"/"burst"): pulses `shootStart` deterministically the
// instant its cooldown clears, with no burst-on/burst-pause cycle of its own to
// confound "did it fire" with "which phase of its own burst rhythm is it in right now".
// A bolt-action's own long range also comfortably covers these tests' ~20-30 unit
// distances, unlike a shotgun's short effective range.
function makeBrainedBot(pos: ReturnType<typeof v2.create>, game: ReturnType<typeof createGame>) {
    const bot = game.playerBarn.addTestPlayer({ pos });
    bot.botDifficulty = "expert";
    bot.botBrain = new BotBrain(bot, "expert", game.botBarn);
    bot.weaponManager.weapons[WeaponSlot.Primary].type = "mosin";
    bot.weaponManager.weapons[WeaponSlot.Primary].ammo = 5;
    bot.weaponManager.weapons[WeaponSlot.Primary].cooldown = 0;
    bot.weaponManager.setCurWeapIndex(WeaponSlot.Primary);
    bot.weaponManager.weapons[WeaponSlot.Primary].cooldown = 0;
    return bot;
}

test("The bot keeps trying to fire at a fast target that just moved offscreen", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    game.now = 0;
    const bot = makeBrainedBot(v2.create(0, 0), game);
    // x stays put (well inside the ~45-unit half-width the whole time) - only y crosses
    // the ~25.3-unit half-height, isolating "left the view rectangle" from any other
    // visibility concern.
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(30, 0) });

    const dt = 0.05;
    const speed = 20; // units/s -> 1 unit/tick, y = i after i ticks

    // 25 ticks of real, steady motion while still visible (y reaches 25, just inside the
    // ~25.3 half-height) - long enough for the velocity estimate (resampled at ~12Hz) to
    // converge close to `speed`, and for a bolt-action's own slow fire rate to have used
    // up its one shot and gone back on cooldown well before the tick under test.
    for (let i = 1; i <= 25; i++) {
        game.now += dt * 1000;
        target.pos = v2.add(target.pos, v2.create(0, speed * dt));
        bot.botBrain!.update(dt);
    }

    // Force the weapon ready right before the tick under test, so this isolates "does
    // the offscreen-prediction gate allow firing" from "did an earlier shot happen to
    // still be on cooldown" - a completely separate concern this test isn't about.
    bot.weaponManager.weapons[bot.weaponManager.curWeapIdx].cooldown = 0;

    // One more tick carries y to 26, past the boundary - now offscreen, but nothing
    // physically blocks a straight line to where it would be.
    game.now += dt * 1000;
    target.pos = v2.add(target.pos, v2.create(0, speed * dt));
    bot.botBrain!.update(dt);

    expect(bot.shootStart).toBe(true);
});

// Regression guard: predicting is meaningless for a target that wasn't actually moving -
// there's nothing to extrapolate toward, just its exact last known spot, which is really
// "keep shooting the last place I saw them" rather than the offscreen-tracking this is
// for. `OFFSCREEN_MIN_SPEED` should keep this from firing at all once truly stationary
// and out of the view rectangle.
test("The bot does not keep firing at a stationary target once it's offscreen", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    game.now = 0;
    const bot = makeBrainedBot(v2.create(0, 0), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(30, 20) }); // visible, not moving

    const dt = 0.05;
    for (let i = 0; i < 10; i++) {
        game.now += dt * 1000;
        bot.botBrain!.update(dt);
    }

    // Force the weapon ready right before the tick under test - same isolation as the
    // positive test above, so a `false` result here unambiguously reflects the
    // prediction gate refusing to fire, not a coincidentally-still-cycling weapon.
    // `shootStart` also needs an explicit reset here: nothing in this direct
    // `botBrain.update()`-only harness ever runs the real `weaponManager.update()` that
    // normally consumes a single-fire pulse the very next tick, so a `true` left over
    // from a shot fired earlier while genuinely visible would otherwise read as a fresh
    // one on the tick under test.
    bot.weaponManager.weapons[bot.weaponManager.curWeapIdx].cooldown = 0;
    bot.shootStart = false;

    // Jump it straight past the view rectangle with no motion at all beforehand -
    // `aim.vel` should have settled near zero over those 10 stationary ticks.
    target.pos = v2.create(30, 40);
    game.now += dt * 1000;
    bot.botBrain!.update(dt);

    expect(bot.shootStart).toBe(false);
    expect(bot.shootHold).toBe(false);
});

// Regression guard: this must only ever "see through" a genuine gap, never a solid wall -
// the same LOS raycast a real bullet would use has to actually reach the predicted spot.
// Bot, wall and target are all colinear along y=0, so once the target passes behind the
// wall, no line from the bot can reach it or anywhere further along that same line -
// including wherever the prediction would extrapolate to.
test("The bot does not fire through a wall at a predicted offscreen position", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    game.now = 0;
    const bot = makeBrainedBot(v2.create(0, 0), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(10, 0) });
    game.map.genObstacle("crate_01", v2.create(20, 0)); // squarely between bot and target's path

    const dt = 0.05;
    const speed = 20;
    for (let i = 0; i < 29; i++) {
        game.now += dt * 1000;
        target.pos = v2.add(target.pos, v2.create(speed * dt, 0));
        bot.botBrain!.update(dt);
    }

    // Same isolation as the other two tests: force the weapon ready and clear any
    // leftover `shootStart` right before the tick under test, so a `false` result
    // unambiguously reflects the LOS gate refusing to fire through the wall.
    bot.weaponManager.weapons[bot.weaponManager.curWeapIdx].cooldown = 0;
    bot.shootStart = false;
    game.now += dt * 1000;
    target.pos = v2.add(target.pos, v2.create(speed * dt, 0));
    bot.botBrain!.update(dt);

    expect(bot.shootStart).toBe(false);
    expect(bot.shootHold).toBe(false);
});
