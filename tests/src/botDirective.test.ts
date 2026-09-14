import { expect, test } from "vitest";
import { BotBrain } from "../../server/src/game/bot/botBrain.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/**
 * `BotBrain.pickDirective` is private - these drive the whole brain (perception, aim,
 * movement, combat, healing) exactly as `BotBarn` does, the same pattern
 * `botDuel.test.ts` uses, and read the resulting `CombatDirective` off its observable
 * effects: `touchMoveDir` (push charges straight at the threat; holding at range
 * doesn't) and `actionType` (whether a heal is in progress).
 *
 * All on the bare `test_normal` map (no obstacles) so cover-seeking/peeking never
 * enters into it - these are purely about which directive gets picked, not about
 * `findCover`/`updatePeekCycle` (covered by `botMovementNav.test.ts`).
 */

function makeBrainedBot(pos: ReturnType<typeof v2.create>, game: ReturnType<typeof createGame>) {
    const bot = game.playerBarn.addTestPlayer({ pos });
    bot.botDifficulty = "expert";
    bot.botBrain = new BotBrain(bot, "expert", game.botBarn);
    return bot;
}

/** `Game.now` (`performance.now()`-based) is only ever set inside `Game.update()` -
 *  driving a brain directly, as these tests do, never touches it, so without this it
 *  stays `undefined` and every `game.now`-based age check (heal-abort's `justHit`,
 *  `BotBrain.threatPos`'s memory window) silently compares against `NaN`. One
 *  effectively-free real tick is enough to initialize it. */
function primeGameClock(game: ReturnType<typeof createGame>): void {
    game.update(0.001);
}

test("Landing several hits switches the bot from holding to pushing", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    // 25 units: inside the no-gun fallback sweet spot's hold band (see
    // `currentSweetSpot`/`pickRangeMode`), so absent a push this should just hold.
    game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);
    const holding = v2.copy(bot.touchMoveDir);

    // The real path to landing a hit is a live gunfight (`Player.damage()` incrementing
    // `bulletHits` on the shooter); poking the field directly isolates the *directive*
    // decision from needing one.
    bot.bulletHits += 2;
    bot.botBrain!.update(0.05);
    const pushing = v2.copy(bot.touchMoveDir);

    expect(Math.abs(holding.x)).toBeLessThan(0.3); // holding at range: no consistent pull
    expect(bot.touchMoveActive).toBe(true);
    expect(pushing.x).toBeGreaterThan(0.5); // pushing straight at the threat (+x here)
});

test("Push fades back to holding once the hit streak goes cold", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);
    bot.bulletHits += 2;
    bot.botBrain!.update(0.05);
    expect(bot.touchMoveDir.x).toBeGreaterThan(0.5); // pushing

    // Momentum decays at 1/3 per second and the threshold is 2 - a hit streak this old
    // (10s, no further hits) must have long since gone cold.
    for (let i = 0; i < 200; i++) bot.botBrain!.update(0.05);

    expect(Math.abs(bot.touchMoveDir.x)).toBeLessThan(0.3);
});

test("Critically low with no heal item flees instead of holding or pushing", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(100, 50) });
    bot.health = 10; // well under the panic threshold; no heal items given

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.None); // never starts a heal it can't back up
    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.x).toBeLessThan(-0.5); // opening distance, not holding or pushing
});

test("Taking a hit mid-heal aborts the bandage instead of finishing it blind", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(100, 50) });
    bot.health = 20; // low enough to heal even with the enemy visible (see `shouldHeal`)
    bot.invManager.give("bandage", 5);

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);
    expect(bot.actionType).toBe(GameConfig.Action.UseItem);

    // The real path is `Player.damage()`, which also calls `botBrain.onDamaged()`
    // (player.ts, right where damage is applied) - this is that same call.
    bot.damage({
        amount: 5,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(-1, 0),
        source: target,
    });
    bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.None); // aborted, not finished blind
});

test("A bot mid-heal keeps retreating even after landing hits, instead of pushing blind", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(100, 50) });
    bot.health = 20;
    bot.invManager.give("bandage", 5);

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);
    expect(bot.actionType).toBe(GameConfig.Action.UseItem);

    bot.bulletHits += 5; // way past the push threshold
    bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.UseItem); // still healing
    expect(bot.touchMoveDir.x).not.toBeGreaterThan(0.3); // not charging the target either
});
