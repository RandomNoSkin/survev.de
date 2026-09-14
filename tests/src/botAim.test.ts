import { expect, test } from "vitest";
import { BotAimState, updateAim } from "../../server/src/game/bot/botAim.ts";
import { BOT_TIERS } from "../../server/src/game/bot/botDefs.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import { math } from "../../shared/utils/math.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

// `Player.dir` has no turn-rate limit of its own - without one, a bot's aim would snap
// instantly onto a new target, which reads as an aimbot immediately. `updateAim` must
// enforce the tier's turn rate itself.
test("updateAim never turns faster than the tier's turn rate", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    game.now = 0;

    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    // Target is 90 degrees off the bot's current facing.
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(0, 50) });

    const aim = new BotAimState();
    aim.dir = v2.create(1, 0);
    const tier = BOT_TIERS.normal;
    const dt = 1 / 30;

    updateAim(bot, aim, tier, target, dt);

    const turned = Math.abs(math.angleDiff(0, Math.atan2(aim.dir.y, aim.dir.x)));
    expect(turned).toBeLessThanOrEqual(tier.turnRate * dt + 1e-6);
});

test("updateAim blocks firing until the reaction timer elapses", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    game.now = 0;

    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(30, 0) });

    const aim = new BotAimState();
    aim.dir = v2.create(1, 0); // already facing the target - isolates the reaction gate
    // aimErrorDeg: 0 so the fire cone check can't also fail this - only the reaction
    // timer is under test here (aim error/turn rate have their own tests above).
    const tier = { ...BOT_TIERS.normal, aimErrorDeg: 0 };
    const dt = 0.05;

    const first = updateAim(bot, aim, tier, target, dt);
    expect(first.canFire).toBe(false);

    let result = first;
    // Worst-case reactionTimer is tier.reaction * 1.25 - run comfortably past it.
    for (let elapsed = dt; elapsed < tier.reaction * 1.5; elapsed += dt) {
        game.now += dt * 1000;
        result = updateAim(bot, aim, tier, target, dt);
    }
    expect(result.canFire).toBe(true);
});

test("updateAim leads a target moving across the line of fire", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    game.now = 0;

    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(40, 0) });
    bot.weaponManager.weapons[0].type = "ak47";
    bot.weaponManager.weapons[0].ammo = 30;
    bot.weaponManager.setCurWeapIndex(0);

    const aim = new BotAimState();
    aim.dir = v2.create(1, 0);
    const tier = { ...BOT_TIERS.expert, aimErrorDeg: 0 }; // deterministic: no noise

    // Move the target steadily in +y so `vel` has time to build up across resamples
    // (updateAim resamples target velocity at ~12Hz, not every call).
    for (let i = 0; i < 6; i++) {
        game.now += 90;
        target.pos = v2.add(target.pos, v2.create(0, 12 * 0.09));
        updateAim(bot, aim, tier, target, 0.09);
    }

    const trueAngle = Math.atan2(target.pos.y - bot.pos.y, target.pos.x - bot.pos.x);
    const aimAngle = Math.atan2(aim.dir.y, aim.dir.x);
    // Leading must aim ahead of the target's motion (further +y than the target
    // itself), not just track its current position.
    expect(math.angleDiff(trueAngle, aimAngle)).toBeGreaterThan(0);
});

test("updateAim does not lead when the target is stationary", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    game.now = 0;

    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(40, 0) });
    bot.weaponManager.weapons[0].type = "ak47";
    bot.weaponManager.weapons[0].ammo = 30;
    bot.weaponManager.setCurWeapIndex(0);

    const aim = new BotAimState();
    aim.dir = v2.create(1, 0);
    const tier = { ...BOT_TIERS.expert, aimErrorDeg: 0, turnRate: 1000 };

    for (let i = 0; i < 4; i++) {
        game.now += 90;
        updateAim(bot, aim, tier, target, 0.09);
    }

    expect(v2.distance(aim.dir, v2.create(1, 0))).toBeLessThan(0.001);
});
