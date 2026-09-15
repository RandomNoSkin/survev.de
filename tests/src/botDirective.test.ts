import { expect, test } from "vitest";
import { Config } from "../../server/src/config.ts";
import { BotBrain } from "../../server/src/game/bot/botBrain.ts";
import { GameConfig, TeamMode, WeaponSlot } from "../../shared/gameConfig.ts";
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

test("Landing several hits on an already-hurt target switches the bot from holding to pushing", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    // 25 units: inside the no-gun fallback sweet spot's hold band (see
    // `currentSweetSpot`/`pickRangeMode`), so absent a push this should just hold.
    // Health well under ENEMY_LOW_HEALTH_FRAC (0.4) - push only charges into the open
    // for a target that's actually worth finishing, not just any hit streak.
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    target.health = 30;

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);
    const holding = v2.copy(bot.touchMoveDir);

    // The real path to landing a hit is a live gunfight (`Player.damage()` incrementing
    // `bulletHits` on the shooter); poking the field directly isolates the *directive*
    // decision from needing one. PUSH_HIT_THRESHOLD is 3.
    bot.bulletHits += 3;
    bot.botBrain!.update(0.05);
    const pushing = v2.copy(bot.touchMoveDir);

    expect(Math.abs(holding.x)).toBeLessThan(0.3); // holding at range: no consistent pull
    expect(bot.touchMoveActive).toBe(true);
    expect(pushing.x).toBeGreaterThan(0.5); // pushing straight at the threat (+x here)
});

// Regression: landing hits used to be the only condition for `push`, so a bot could
// charge a still-healthy enemy across open ground just because it happened to connect
// a few shots - the "dumb push" complaint. A healthy target keeps the bot on
// `engageHold` (cover-aware) instead, regardless of hit streak.
test("Landing several hits on a healthy target does not trigger a push", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) }); // full health

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);
    bot.bulletHits += 3;
    bot.botBrain!.update(0.05);

    expect(Math.abs(bot.touchMoveDir.x)).toBeLessThan(0.3); // still holding, not pushing
});

test("Push fades back to holding once the hit streak goes cold", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    target.health = 30;

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);
    bot.bulletHits += 3;
    bot.botBrain!.update(0.05);
    expect(bot.touchMoveDir.x).toBeGreaterThan(0.5); // pushing

    // Momentum decays at 1/2 per second and the threshold is 3 - a hit streak this old
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

// The explicit ask: a bot should choose to retreat over attacking once it's low, not
// only once it's nearly dead. `LOW_HEALTH_FRAC_MULT` sits between the panic threshold
// and `shouldHeal`'s own - for `expert` (healThreshold 0.75) that's critical at 37.5%
// and low at 56.25%, so 50% health lands squarely in "low but not critical". With no
// heal item, that alone should be enough to flee - and, since landing hits would
// otherwise trigger `push`, this also proves low health suppresses pushing.
test("Low (but not critical) health with no heal item flees instead of pushing", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    bot.health = 50;
    bot.bulletHits += 5; // would otherwise clear PUSH_HIT_THRESHOLD easily

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.None); // never starts a heal it can't back up
    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.x).toBeLessThan(-0.5); // opening distance, not pushing or holding
});

// Regression: low health *with* a bandage on hand used to fall straight through to
// `engageHold` here, because the only low-health check was `low && noHealItem`. On the
// open `test_normal` map there's no cover to duck behind, so `this.target` never goes
// undefined and `shouldHeal`'s visibility gate (enemy visible, health > 25%) never lets
// up either - the bot would fight on hurt indefinitely with an unused bandage, exactly
// the "wrong combat decision" this map is built to isolate. It should disengage instead,
// the same as having no item at all, so that breaking line of sight can actually happen.
test("Low health with a bandage on hand still flees when it can't safely use it yet", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    bot.health = 50; // low (< 56.25% for expert) but above shouldHeal's 25% override
    bot.invManager.give("bandage", 5);

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.None); // can't safely heal yet - hasn't started
    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.x).toBeLessThan(-0.5); // disengaging, not fighting on hurt
});

// The other explicit ask: *consider* retreating to reload - not retreat unconditionally
// every single time a magazine empties. Out of ammo but nobody's actually shooting is
// exactly the case where reloading in place (which happens regardless, see
// `updateReload`) is the right call - retreating every time a weapon runs dry,
// "makes sense" or not, would mean bots detour away from an easy, safe kill just
// because their gun happened to empty a beat before the enemy went down.
test("An empty gun with nobody shooting at the bot just reloads in place", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    bot.weaponManager.weapons[WeaponSlot.Primary].type = "m870";
    bot.weaponManager.weapons[WeaponSlot.Primary].ammo = 0;
    bot.weaponManager.setCurWeapIndex(WeaponSlot.Primary);

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);

    expect(bot.weaponManager.scheduledReload).toBe(true); // the reload itself still runs
    // Not fleeing - whatever `engageHold` decides otherwise (closing to the empty
    // shotgun's own short ideal range counts as "not fleeing" just as much as holding
    // at it would; either is the opposite of retreating away).
    expect(bot.touchMoveDir.x).toBeGreaterThan(-0.3);
});

// ...but it *does* make sense once the enemy has actually landed a hit recently -
// finishing a reload while genuinely under fire is bad, same reasoning as the
// heal-abort check just above.
test("An empty gun while actually under fire sends the bot retreating to reload", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    bot.weaponManager.weapons[WeaponSlot.Primary].type = "m870";
    bot.weaponManager.weapons[WeaponSlot.Primary].ammo = 0;
    bot.weaponManager.setCurWeapIndex(WeaponSlot.Primary);

    // The real path is `Player.damage()`, which also calls `botBrain.onDamaged()`.
    bot.damage({
        amount: 5,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(-1, 0),
        source: target,
    });

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);

    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.x).toBeLessThan(-0.5); // opening distance while it reloads
    expect(bot.weaponManager.scheduledReload).toBe(true);
});

// A loaded backup gun is a solved problem for `updateWeaponSelection` on its own (see
// botCombat.test.ts) - `needsReload` must not also fire a retreat in that case, since
// there's something to fight with.
test("A dry gun with a loaded backup does not trigger a reload retreat", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    bot.weaponManager.weapons[WeaponSlot.Primary].type = "m870";
    bot.weaponManager.weapons[WeaponSlot.Primary].ammo = 0;
    bot.weaponManager.weapons[WeaponSlot.Secondary].type = "mosin";
    bot.weaponManager.weapons[WeaponSlot.Secondary].ammo = 5;
    bot.weaponManager.setCurWeapIndex(WeaponSlot.Primary);

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);

    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Secondary); // switched to it
    expect(Math.abs(bot.touchMoveDir.x)).toBeLessThan(0.3); // holding at range, not fleeing
});

// Regression: `shouldHeal` (and therefore the `heal` directive) flips true the instant
// health crosses the threshold, before the retreat `updateMovement` kicks off has
// actually gone anywhere - immediately consuming the heal item regardless was visible
// in manual play as bots that started a bandage and cancelled it again right away,
// still standing exactly where the fight was.
test("A bot does not start healing until it has actually created distance from a close threat", () => {
    Config.bots.enabled = true;
    const game = createGame(TeamMode.Solo, "test_normal");

    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.botBarn.bots.push(bot);
    game.playerBarn.addTestPlayer({ pos: v2.create(55, 50) }); // 5 units - too close to heal
    bot.health = 20;
    bot.invManager.give("bandage", 5);

    // Immediately after deciding to heal, distance is still small - must not have
    // started consuming the item yet.
    for (let i = 0; i < 5; i++) game.update(0.1);
    expect(bot.actionType).toBe(GameConfig.Action.None);

    // Give it room to actually retreat (bare map, no cover - a straight-line run) to a
    // safe distance and start healing there.
    let startedHealing = false;
    for (let i = 0; i < 100 && !startedHealing; i++) {
        game.update(0.1);
        if (bot.actionType === GameConfig.Action.UseItem) startedHealing = true;
    }
    expect(startedHealing).toBe(true);
});

test("Healing is not aborted just because the enemy gets close, only when actually hit", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(100, 50) }); // far - safe to start
    bot.health = 20;
    bot.invManager.give("bandage", 5);

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);
    expect(bot.actionType).toBe(GameConfig.Action.UseItem);

    // The enemy closes the distance without landing a hit - a position change, not an
    // action against the bot.
    target.pos = v2.create(55, 50);
    bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.UseItem); // must still be healing
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
    // Low enough to also clear ENEMY_LOW_HEALTH_FRAC, so this specifically isolates
    // heal-priority beating push - not just push never triggering for a healthy target.
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(100, 50) });
    target.health = 30;
    bot.health = 20;
    bot.invManager.give("bandage", 5);

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);
    expect(bot.actionType).toBe(GameConfig.Action.UseItem);

    bot.bulletHits += 5; // way past the push threshold
    bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.UseItem); // still healing
    expect(bot.touchMoveDir.x).not.toBeGreaterThan(0.3); // not charging the target either
});
