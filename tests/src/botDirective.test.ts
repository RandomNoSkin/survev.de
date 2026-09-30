import { expect, test, vi } from "vitest";
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

// The user's explicit ask ("muss konsequenter pushen wenn der Gegner low ist") pushed
// this further than the previous fix: a low enemy is now worth pressing even through
// what would otherwise be the post-heal grace window below - waiting out
// `POST_HEAL_RETREAT_COOLDOWN_S` on an already barely-alive target just hands it exactly
// the recovery time it needs. `pickDirective`'s enemy-low push check now runs ahead of
// `postHealRetreatCooldown` for this reason.
test("A low enemy still gets pushed the instant a heal ends, without waiting out the grace window", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    target.health = 30; // low enough to justify pushing through the grace window
    bot.health = 80; // comfortably clear of "low"

    bot.actionType = GameConfig.Action.UseItem;
    bot.botBrain!.update(0.05);
    bot.actionType = GameConfig.Action.None; // the heal ends on this next tick
    bot.botBrain!.update(0.05);

    expect(bot.touchMoveDir.x).toBeGreaterThan(0.5); // pushing immediately, no grace window
});

// The grace window itself still applies when the enemy ISN'T low enough to be worth
// pressing through it - "retreaten, dann healen, und weiter retreaten" remains correct
// for a target that could still fight back. Distinct from the push-through-grace-window
// case above, which only fires once the enemy is actually low. Faking the actionType
// transition directly (rather than simulating a real multi-second bandage) isolates the
// cooldown mechanism itself from the unrelated question of how long a heal actually takes.
test("A bot still retreats for a grace window right after a heal ends when the enemy isn't low", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) }); // full health - not low
    bot.health = 80; // comfortably clear of "low"

    bot.actionType = GameConfig.Action.UseItem;
    bot.botBrain!.update(0.05);
    bot.actionType = GameConfig.Action.None; // the heal ends on this next tick
    bot.botBrain!.update(0.05);
    expect(bot.touchMoveDir.x).toBeLessThan(-0.3); // still retreating, not engaging yet

    for (let i = 0; i < 40; i++) bot.botBrain!.update(0.05); // past POST_HEAL_RETREAT_COOLDOWN_S (1.5s)
    expect(Math.abs(bot.touchMoveDir.x)).toBeLessThan(0.3); // back to holding at range, not still fleeing
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

// Regression, from a decoded real loss: a bot spent 11+ seconds at 10-29% health against
// a relentless pursuer that never let up enough for `shouldHeal`'s normal safety gate to
// pass - passive regen only, no bandage ever actually used, until it was finished off.
// `fleeOrFight`'s own escape valve (fight back once genuinely `stuck`) never covers this:
// the bot was actively moving the whole time, just never gaining separation against a
// same-speed chaser - `stuck` never goes true. Past `DESPERATE_HEAL_S` of that, the bot
// should gamble on healing right where it stands instead of continuing to wait for a
// safety this specific opponent was never going to grant.
test("Critical health past DESPERATE_HEAL_S heals despite a visible, close enemy", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(60, 50) }); // close - never lets up
    bot.health = 30; // critical for expert (< 37.5%), but > shouldHeal's own 25% bar
    bot.invManager.give("bandage", 5);

    // Under the desperate threshold: still refuses, same as the existing "can't safely
    // heal yet" case - fleeing (or holding, if genuinely `stuck`), not healing.
    for (let i = 0; i < 15; i++) bot.botBrain!.update(0.05); // 0.75s, under DESPERATE_HEAL_S
    expect(bot.actionType).toBe(GameConfig.Action.None);

    // Past it: gambles on the bandage right here.
    for (let i = 0; i < 15; i++) bot.botBrain!.update(0.05); // +0.75s, past 1.2s total
    expect(bot.actionType).toBe(GameConfig.Action.UseItem);
});

// Regression, from a decoded real match: a bot at 40% health (low, not critical)
// retreated to heal while the enemy sat at 15% - an easy finish. By the time its own
// heal wrapped up, the enemy had used that exact window to heal all the way back to
// full and won the fight back. Being low myself shouldn't override finishing an enemy
// who's already worse off than I am - only retreating (or healing) hands them the
// recovery time that throws away an already-won fight.
test("Low health still pushes an enemy who's even lower, instead of retreating to heal", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    bot.health = 40; // low (< 56.25% for expert) but not critical (< 37.5%)
    target.health = 15; // worse off than the bot, and under ENEMY_LOW_HEALTH_FRAC (40%)
    bot.invManager.give("bandage", 5); // has a heal item on hand - still shouldn't retreat to use it

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.None); // never starts healing here
    expect(bot.touchMoveDir.x).toBeGreaterThan(0.5); // pushing to finish, not retreating
});

// The mirror case: an enemy who's *also* low but not actually worse off than the bot
// itself (or not low enough to count as a finishable target) should still send the bot
// to heal/flee as normal - this isn't a blanket "ignore my own health if the enemy is
// hurt too" override.
test("Low health still retreats when the enemy isn't clearly worse off", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(75, 50) });
    bot.health = 40;
    target.health = 45; // hurt too, but not worse off than the bot - not a finish
    bot.invManager.give("bandage", 5);

    for (let i = 0; i < 10; i++) bot.botBrain!.update(0.05);

    expect(bot.touchMoveDir.x).toBeLessThan(-0.3); // retreating, not pushing
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
    // 18 units away - dead center of mosin's own ~[14.8, 21.2] hold band (see
    // `sweetSpotFor`), so switching to it here holds in place rather than repositioning.
    game.playerBarn.addTestPlayer({ pos: v2.create(68, 50) });
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

// Real match debug logging caught this exact scenario: the bot preferred melee while
// retreating-to-heal unseen (see `updateWeaponSelection`'s `preferMelee`), then the
// enemy came back into view mid-bandage - `updateWeaponSelection` itself won't touch
// loadout mid-action (fiddling with gear mid-bandage is its own bug), so without this
// abort trigger the bot stayed defenseless on fists for the rest of the heal, unable to
// fire back at all right when it mattered most.
test("A bot stuck on melee mid-heal abandons it and re-arms once the enemy is visible again", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    game.playerBarn.addTestPlayer({ pos: v2.create(65, 50) }); // visible, within FOV
    bot.weaponManager.weapons[WeaponSlot.Primary].type = "m870";
    bot.weaponManager.weapons[WeaponSlot.Primary].ammo = 5;
    bot.weaponManager.setCurWeapIndex(WeaponSlot.Melee);
    bot.health = 20;
    // Faked directly (not via useHealingItem) - same reasoning as the other abort
    // tests: isolates the abort trigger from actually simulating a real bandage.
    bot.actionType = GameConfig.Action.UseItem;

    bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.None); // abandoned the heal
    expect(bot.weaponManager.curWeapIdx).not.toBe(WeaponSlot.Melee); // re-armed
});

// A first fix gated melee-preference on the bot's own *current* visibility check alone
// - a decoded full replay then showed 50 of 51 "on melee" sightings landed within 2s of
// the human actually firing at the bot, since the bot's own FOV is deliberately much
// narrower than what a real player can actually see/track. `recentContact` requires
// `sustainedlyLost` instead - the same multi-second bar `isSafeToHeal` already trusts.
test("A fleeing bot stays armed right after losing sight, only prefers melee once genuinely lost", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(58, 50) });
    bot.weaponManager.weapons[WeaponSlot.Primary].type = "m870";
    bot.weaponManager.weapons[WeaponSlot.Primary].ammo = 5;
    bot.weaponManager.setCurWeapIndex(WeaponSlot.Primary);
    bot.health = 20; // low, no heal item given - forces "flee" (see the "low, no item" test above)

    bot.botBrain!.update(0.05); // spots the target, records lastKnownEnemyPos
    target.pos = v2.create(500, 500); // out of FOV - no longer currently visible

    game.now += 500; // well under SUSTAINED_LOST_MS (2.5s)
    bot.botBrain!.update(0.05);
    expect(bot.weaponManager.curWeapIdx).not.toBe(WeaponSlot.Melee); // too soon to trust it

    game.now += 2500; // now past it - genuinely, sustainedly lost
    bot.botBrain!.update(0.05);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Melee);
});

// "wenn er nicht 1 shot low ist kann er auch einfach voll durchziehen statt
// abzubrechen" - a heal is worth just completing through a hit taken mid-way, rather
// than throwing the whole thing away and having to re-expose itself all over again
// starting a new one. Faking the actionType directly (same reasoning as the post-heal
// grace-window test above) isolates the push-through decision itself from actually
// simulating a real multi-second bandage.
test("A heal survives a hit partway through, as long as the bot isn't in one-shot danger", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(85, 50) });
    bot.health = 60; // well above ONE_SHOT_RISK_HEALTH_FRAC (35%) even after this hit

    bot.actionType = GameConfig.Action.UseItem;
    bot.action.duration = 3; // a bandage's real useTime
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

// Regression: an earlier version only allowed pushing through a hit once the heal was
// already almost done (a fixed cutoff, then a fraction of the action's own duration) -
// "cancelt immer noch relativ oft mid heal anstatt kurz voll durchzuziehen" was exactly
// this: an early hit, well before any "nearly done" bar, still aborted even at
// comfortable health. Whether to push through is purely about danger now (see
// `ONE_SHOT_RISK_HEALTH_FRAC`), not when in the heal it happens - re-starting from
// scratch after an abort costs strictly more total exposure either way.
test("A heal survives a hit taken right at the very start, not just near the end", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(85, 50) });
    bot.health = 60;

    bot.actionType = GameConfig.Action.UseItem;
    bot.action.duration = 3;
    bot.action.time = 0.1; // barely started
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

// Genuinely one-shot-able afterward - still worth abandoning regardless of timing,
// since a single follow-up hit could kill outright.
test("A heal still aborts when the bot is in real one-shot danger", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(85, 50) });
    bot.health = 20; // well under ONE_SHOT_RISK_HEALTH_FRAC (35%) after this hit

    bot.actionType = GameConfig.Action.UseItem;
    bot.action.duration = 2.5;
    bot.action.time = bot.action.duration - 0.1; // almost done - still aborts anyway
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

// "wenn er keinen Plan hat wo der Gegner ist soll er healen falls nötig" - having
// nothing combat-related to react to must not suppress healing entirely.
test("A bot with no known enemy at all still heals when hurt, instead of staying idle", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    bot.health = 30; // well under expert's healThreshold (0.75)
    bot.invManager.give("bandage", 5);

    bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.UseItem);
});

// A healthy bot with no known enemy has nothing to heal for either - still idle, not
// accidentally forced into some other directive.
test("A bot with no known enemy and full health stays idle rather than healing", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(50, 50), game);
    bot.invManager.give("bandage", 5);

    bot.botBrain!.update(0.05);

    expect(bot.actionType).toBe(GameConfig.Action.None);
});

// "soll er sich Richtung center map ... navigieren" - the other half of "der Bot ist
// bisschen hohl sobald er den Fight verlässt": with nothing to react to and nowhere
// remembered to check, head for the map's center instead of wandering aimlessly.
test("A bot with no known enemy navigates toward the map center instead of wandering aimlessly", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(10, 10), game);

    bot.botBrain!.update(0.05);

    const center = v2.create(game.map.width / 2, game.map.height / 2);
    const toCenter = v2.normalizeSafe(v2.sub(center, bot.pos));
    expect(bot.touchMoveActive).toBe(true);
    expect(v2.dot(bot.touchMoveDir, toCenter)).toBeGreaterThan(0.9);
});

// "vorsichtig last enemy position navigieren" - a recent-ish last-known sighting is a
// better bet than the map's center: the enemy is probably still somewhere near there.
// This bot is at (the default) full health, which alone is reason enough to check - see
// the two tests below for the "only if full health or the enemy was known low" gate.
test("A bot at full health with a recent last-known enemy position heads back there instead of the map center", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(10, 10), game);
    const enemy = game.playerBarn.addTestPlayer({ pos: v2.create(30, 10) });

    bot.botBrain!.update(0.05); // spots the enemy, records lastKnownEnemyPos

    // Past tier.memory (6s for expert), so `threatPos()` itself no longer resolves to
    // it - this is genuinely the "idle, nothing left to react to" case, not a live
    // combat-memory chase - but still well under IDLE_LAST_KNOWN_MEMORY_MS (15s).
    game.now += 8000;
    enemy.dead = true; // remove it as a live target entirely

    bot.botBrain!.update(0.05);

    // Heading toward the last-known spot (30, 10), not the map center (64, 64) - a
    // positive x with near-zero y is the distinguishing signature (the center pull
    // would have a positive y component too, from this starting position).
    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.x).toBeGreaterThan(0.9);
    expect(Math.abs(bot.touchMoveDir.y)).toBeLessThan(0.3);
});

// "natürlich nur wenn er full [health] oder der Gegner low ist" - walking back to a
// remembered enemy position while this bot itself is hurt AND the enemy wasn't known to
// be low is a bad trade (an even fight, but the bot walks in blind after already having
// lost health) - default to the map center instead, same as never having seen anyone.
test("A hurt bot does not walk back to a last-known enemy that wasn't known to be low", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(10, 10), game);
    const enemy = game.playerBarn.addTestPlayer({ pos: v2.create(30, 10) }); // full health

    bot.botBrain!.update(0.05); // spots the enemy at full health, records the snapshot
    bot.health = 60; // hurt, but not low enough to trigger heal/flee on its own
    game.now += 8000;
    enemy.dead = true;

    bot.botBrain!.update(0.05);

    // Heading toward the map center (64, 64), not the last-known spot (30, 10) - from
    // (10, 10) that means a real +y pull the last-known spot alone wouldn't produce.
    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.y).toBeGreaterThan(0.3);
});

// Same hurt bot, but the last-known sighting was of an enemy already low - worth the
// trip regardless, since finishing an already-hurt enemy is a good trade even while
// banged up.
test("A hurt bot still walks back to a last-known enemy that was known to be low", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    primeGameClock(game);
    const bot = makeBrainedBot(v2.create(10, 10), game);
    const enemy = game.playerBarn.addTestPlayer({ pos: v2.create(30, 10) });
    enemy.health = 30; // low enough to clear ENEMY_LOW_HEALTH_FRAC (0.4)

    bot.botBrain!.update(0.05); // spots the enemy while it's already low
    bot.health = 60;
    game.now += 8000;
    enemy.dead = true;

    bot.botBrain!.update(0.05);

    expect(bot.touchMoveActive).toBe(true);
    expect(bot.touchMoveDir.x).toBeGreaterThan(0.9);
    expect(Math.abs(bot.touchMoveDir.y)).toBeLessThan(0.3);
});

// "er hätte sofort nach der Nade anfangen healen und weglaufen sollen" - a covering
// grenade throw (`updateThrowable`, triggered by `isFleeing`) and a heal can turn
// eligible on the exact same tick, since a bot forced to flee often ends up at exactly
// a throwable-range distance right when it's also newly safe to heal. `update()` now
// attempts the heal *before* `updateThrowable` for this reason - see the reordering's
// own doc comment in botBrain.ts. `BotThrowState`'s initial cooldown is
// `util.random(2, 5)`; mocking `Math.random` to 0 pins it at exactly 2 seconds, so the
// throw's own gate (`cooldown -= dt`, then `if (cooldown > 0) return`) first lets a
// throw through on the 40th `update(0.05)` call - reliable given the fixed dt step,
// verified against float drift directly above. Health starts at 45 (low enough to keep
// `isFleeing` - and so the throw's cooldown ticking down - true throughout, but not low
// enough to pass `shouldHeal`'s own visible-enemy gate) and only drops to a heal-eligible
// 20 right before that 40th call, so nothing but this exact tick could have started the
// heal - a real "just took a hit" moment landing on the same tick the grenade was about
// to go out.
test("A heal that becomes safe on the same tick a covering grenade would fire starts the heal, not the throw", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
        const game = createGame(TeamMode.Solo, "test_normal");
        primeGameClock(game);
        const bot = makeBrainedBot(v2.create(0, 0), game);
        game.playerBarn.addTestPlayer({ pos: v2.create(20, 0) }); // inside throw range [14,30]
        bot.invManager.give("frag", 4);
        bot.invManager.give("bandage", 5);
        bot.health = 45; // low (keeps isFleeing true) but not low enough for shouldHeal yet

        let c = 2;
        for (let i = 0; i < 40; i++) c -= 0.05;
        expect(c).toBeLessThanOrEqual(0); // sanity: confirms the 40th call is the right one

        for (let i = 0; i < 39; i++) bot.botBrain!.update(0.05);
        expect(bot.actionType).toBe(GameConfig.Action.None); // not eligible yet - still refused

        bot.health = 20; // a hit lands - now critical and past shouldHeal's 25% bar
        bot.botBrain!.update(0.05); // the 40th call - both the heal and the throw want this tick

        expect(bot.actionType).toBe(GameConfig.Action.UseItem);
        expect(bot.weaponManager.cookingThrowable).toBe(false);
        expect(bot.weaponManager.curWeapIdx).not.toBe(WeaponSlot.Throwable);
    } finally {
        vi.restoreAllMocks();
    }
});

// "das macht nur Sinn wenn der Gegner hinter Cover healt" wired end-to-end through the
// full brain: once the enemy has been genuinely, sustainedly out of sight for a while
// (`sustainedlyLost`, not just the instant-after-losing-sight bait window) a healthy bot
// with nothing else driving it to throw still lobs one at their last-known spot - by this
// point they're very likely holding still behind cover healing, not mid-peek-cycle.
// `game.now += 3000` clears *both* `SUSTAINED_LOST_MS` (2.5s) and `RECENTLY_VISIBLE_MS`
// (1.2s), isolating this from the bait-throw case; staying healthy the whole time
// isolates it from `isFleeing` too - nothing but the enemy's own sustained absence could
// have triggered this throw.
test("A healthy bot throws a grenade at a sustainedly-lost target's last-known spot", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // pins BotThrowState's cooldown at util.random(2,5)'s floor, 2s
    try {
        const game = createGame(TeamMode.Solo, "test_normal");
        primeGameClock(game);
        const bot = makeBrainedBot(v2.create(50, 50), game);
        const target = game.playerBarn.addTestPlayer({ pos: v2.create(70, 50) }); // 20 units - inside [14, 30]
        bot.weaponManager.weapons[WeaponSlot.Primary].type = "m870";
        bot.weaponManager.weapons[WeaponSlot.Primary].ammo = 5;
        bot.weaponManager.setCurWeapIndex(WeaponSlot.Primary);
        bot.invManager.give("frag", 4);

        bot.botBrain!.update(0.05); // spots the target, records its last-known position
        target.pos = v2.create(500, 500); // well out of FOV - no longer currently visible

        game.now += 3000;

        let threw = false;
        for (let i = 0; i < 45 && !threw; i++) { // clears the pinned 2s throw cooldown
            bot.botBrain!.update(0.05);
            threw = bot.weaponManager.curWeapIdx === WeaponSlot.Throwable;
        }

        expect(threw).toBe(true);
        expect(bot.health).toBe(100); // confirms this isn't the isFleeing case
    } finally {
        vi.restoreAllMocks();
    }
});
