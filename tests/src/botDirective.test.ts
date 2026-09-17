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

// Regression: `push` used to also require a recent hit streak (`pushMomentum` reaching
// `PUSH_HIT_THRESHOLD`) on top of the target being low - real feedback was that this
// held the bot back from finishing an already-hurt target it just hadn't personally
// tagged yet. By the time `pickDirective` reaches the push check, every actual
// disadvantage (own low health, needing to reload) has already returned its own
// directive above - so a visible, badly-hurt target alone is enough, immediately.
test("A visible target dropping below the low-health threshold triggers an immediate push", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    // 25 units: inside the no-gun fallback sweet spot's hold band (see
    // `currentSweetSpot`/`pickRangeMode`), so absent a push this should just hold.
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);
    const holding = v2.copy(bot.touchMoveDir);

    // Health alone drives `push` now, not a hit streak - no `bulletHits` involved.
    target.health = 30;
    bot.botBrain!.update(0.05);
    const pushing = v2.copy(bot.touchMoveDir);

    expect(Math.abs(holding.x)).toBeLessThan(0.3); // holding at range while healthy
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

// With no more momentum/decay involved, `push` is purely reactive to the target's
// current health - it should drop right back to holding the instant the target
// recovers, not linger from whatever used to keep momentum alive for a while.
test("Push reverts to holding once the target's health recovers above the threshold", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    target.health = 30;

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);
    expect(bot.touchMoveDir.x).toBeGreaterThan(0.5); // pushing

    target.health = 100; // no longer worth finishing
    bot.botBrain!.update(0.05);

    expect(Math.abs(bot.touchMoveDir.x)).toBeLessThan(0.3); // back to holding
});

// Regression: a bot only needs to clear the `low` bar (75% of `tier.healThreshold`, not
// the full threshold itself) to push a genuinely low target - an earlier fix for "healed
// and immediately started pushing again while still low" instead required being all the
// way back up to `tier.healThreshold`, which stopped that complaint but overcorrected
// into a bot that rarely pressed an advantage and felt far less dangerous generally (see
// the grace-window test below for the actual, narrower fix).
test("A bot pushes once it's cleared 'low', without needing to be fully healed", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    target.health = 30; // low enough to justify a push
    bot.health = 60; // expert: low bar is 56.25% - cleared, even though healThreshold is 75%

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);

    expect(bot.touchMoveDir.x).toBeGreaterThan(0.5); // pushing
});

// The actual, narrower fix for "healed and immediately pushed while still low": a short
// grace window right after a heal action ends (completed or aborted), not a permanently
// higher health bar. This grace window now keeps the bot actively retreating, not just
// blocking `push` - "retreaten, dann healen, und weiter retreaten". Faking the
// actionType transition directly (rather than simulating a real multi-second bandage)
// isolates the cooldown mechanism itself from the unrelated question of how long a heal
// actually takes.
test("A bot keeps retreating for a grace window right after a heal ends, then pushes once it passes", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    target.health = 30;
    bot.health = 80; // comfortably clear of "low"

    bot.actionType = GameConfig.Action.UseItem;
    bot.botBrain!.update(0.05);
    bot.actionType = GameConfig.Action.None; // the heal ends on this next tick
    bot.botBrain!.update(0.05);
    expect(bot.touchMoveDir.x).toBeLessThan(-0.3); // still retreating, not pushing yet

    for (let i = 0; i < 40; i++) bot.botBrain!.update(0.05); // past POST_HEAL_RETREAT_COOLDOWN_S (1.5s)
    expect(bot.touchMoveDir.x).toBeGreaterThan(0.5); // pushing now that the grace window passed
});

test("A bot back up to tier.healThreshold pushes a low target normally", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    target.health = 30;
    bot.health = 80; // expert healThreshold is 75% - comfortably cleared

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);

    expect(bot.touchMoveDir.x).toBeGreaterThan(0.5); // pushing
});

test("Critically low with no heal item flees instead of holding or pushing", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(85, 50) });
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
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(85, 50) }); // far - safe to start
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
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(85, 50) });
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

// "wenn der heal fast durch ist und er nicht 1 shot low ist kann er auch einfach voll
// durchziehen statt abzubrechen" - a heal that's essentially finished, taken by a bot
// that still isn't in real one-shot danger afterward, is worth just completing instead
// of throwing the whole bandage away for one more hit. Faking the actionType/action.time
// directly (same reasoning as the post-heal grace-window test above) isolates the
// push-through math itself from actually simulating a real multi-second bandage.
test("A nearly-finished heal survives a hit, as long as the bot isn't in one-shot danger", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(85, 50) });
    bot.health = 60; // well above ONE_SHOT_RISK_HEALTH_FRAC (35%) even after this hit

    bot.actionType = GameConfig.Action.UseItem;
    bot.action.duration = 2.5; // a bandage's real useTime
    bot.action.time = bot.action.duration - 0.1; // almost done
    bot.botBrain!.update(0.05);
    expect(bot.actionType).toBe(GameConfig.Action.UseItem);

    bot.damage({
        amount: 5,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(-1, 0),
        source: target,
    });
    bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.UseItem); // pushed through, not aborted
});

// Same near-finished heal, but genuinely one-shot-able afterward - still worth
// abandoning even this close to done, since a single follow-up hit could kill outright.
test("A nearly-finished heal still aborts when the bot is in real one-shot danger", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(85, 50) });
    bot.health = 20; // well under ONE_SHOT_RISK_HEALTH_FRAC (35%) after this hit

    bot.actionType = GameConfig.Action.UseItem;
    bot.action.duration = 2.5;
    bot.action.time = bot.action.duration - 0.1; // almost done
    bot.botBrain!.update(0.05);
    expect(bot.actionType).toBe(GameConfig.Action.UseItem);

    bot.damage({
        amount: 5,
        damageType: GameConfig.DamageType.Player,
        dir: v2.create(-1, 0),
        source: target,
    });
    bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.None); // still aborts - real risk
});

test("A bot mid-heal keeps retreating even with a low target, instead of pushing blind", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    // Target low enough to clear ENEMY_LOW_HEALTH_FRAC (which alone would otherwise be
    // enough to push, see `pickDirective`) - this specifically isolates heal-priority
    // beating push via the bot's own low health, not push never triggering at all.
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(85, 50) });
    target.health = 30;
    bot.health = 20;
    bot.invManager.give("bandage", 5);

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.UseItem); // still healing
    expect(bot.touchMoveDir.x).not.toBeGreaterThan(0.3); // not charging the target either
});

// The "granaten besser checken" ask: a live grenade landing nearby overrides whatever
// the fight itself would otherwise have the bot doing, including standing and trading
// shots with a healthy, closer-than-the-grenade target - matching a real player's
// instinct to dive away from a live nade over almost anything else.
test("A nearby live grenade overrides combat movement entirely, even mid-fight", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(65, 50) }); // engaging normally, +x
    // The grenade sits on the opposite side (-x) - dodging it means moving toward +x,
    // the exact opposite of what fleeing the gunfight itself would ever produce, so the
    // sign alone proves the override actually happened rather than coincidentally
    // matching some other retreat.
    game.projectileBarn.addProjectile(
        0,
        "frag",
        v2.create(40, 50),
        0,
        0,
        v2.create(0, 0),
        1.0, // under GRENADE_REACT_TIME - genuinely about to go off
        GameConfig.DamageType.Player,
    );

    bot.botBrain!.update(0.05);

    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.x).toBeGreaterThan(0.5); // away from the grenade, toward +x
});

// A grenade landing mid-heal must cancel the bandage the same way actually getting shot
// does (see `ABORT_HEAL_REACT_MS`) - finishing a heal in place next to a live grenade
// makes the heal itself pointless.
test("A nearby live grenade cancels an in-progress heal", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(90, 50) }); // far enough to heal safely
    bot.health = 20;
    bot.invManager.give("bandage", 5);

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);
    expect(bot.actionType).toBe(GameConfig.Action.UseItem);

    game.projectileBarn.addProjectile(
        0,
        "frag",
        v2.create(55, 50),
        0,
        0,
        v2.create(0, 0),
        1.0, // under GRENADE_REACT_TIME - genuinely about to go off
        GameConfig.DamageType.Player,
    );
    bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.None); // aborted, not finished blind
});

// "der bot muss auch iwie checken in welche richtung der gegner sein könnte anhand von
// schüssen" - a gunshot heard from an enemy the bot has never actually seen still gives
// `threatPos` something to react to (see `findGunshotHint`), not just idle wandering.
// The enemy sits well beyond the view rectangle's ~25.3-unit half-height (never visible)
// but within gunshot hearing range - the bot should engage toward the sound regardless.
test("A bot reacts to a nearby gunshot from an enemy it has never seen", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const enemy = game.playerBarn.addTestPlayer({ pos: v2.create(50, 110) });

    game.bulletBarn.fireBullet({
        playerId: enemy.__id,
        bulletType: "bullet_mac10_modified",
        gameSourceType: "modified_mac10",
        damageType: GameConfig.DamageType.Player,
        pos: v2.copy(enemy.pos),
        dir: v2.create(0, -1),
        layer: enemy.layer,
        damageMult: 1,
        shotFx: true,
        shotOffhand: false,
        lastShot: true,
    });

    bot.botBrain!.update(0.05);

    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.y).toBeGreaterThan(0.5); // engaging toward the sound, +y here
});
