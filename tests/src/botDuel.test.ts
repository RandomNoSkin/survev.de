import { expect, test } from "vitest";
import { Config } from "../../server/src/config.ts";
import { BotBrain } from "../../server/src/game/bot/botBrain.ts";
import { TeamMode, WeaponSlot } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/**
 * End-to-end proof that M1 actually works: a fully wired `BotBrain` - perception, aim,
 * movement and combat together, exactly as `BotBarn` drives it in a real game - can
 * find, approach, and kill a target using nothing but the same fields a human's
 * InputMsg would set.
 */
function makeDuelist(
    game: ReturnType<typeof createGame>,
    pos: ReturnType<typeof v2.create>,
) {
    const player = game.playerBarn.addTestPlayer({ pos });
    player.weaponManager.weapons[WeaponSlot.Primary].type = "m870";
    player.weaponManager.weapons[WeaponSlot.Primary].ammo = 5;
    player.weaponManager.weapons[WeaponSlot.Secondary].type = "mosin";
    player.weaponManager.weapons[WeaponSlot.Secondary].ammo = 5;
    player.weaponManager.setCurWeapIndex(WeaponSlot.Primary);
    player.invManager.give("12gauge", 60);
    player.invManager.give("762mm", 20);
    return player;
}

test("An expert bot kills a stationary target within 15 seconds", () => {
    Config.bots.enabled = true;

    // Bare, empty map (no obstacles/buildings) - see testDefs.ts - so this is a pure
    // combat test, not also an implicit test of M1's steering-only obstacle avoidance.
    const game = createGame(TeamMode.Solo, "test_normal");

    const bot = makeDuelist(game, v2.create(50, 50));
    const dummy = makeDuelist(game, v2.create(62, 50)); // 12 units away, never acts

    bot.botDifficulty = "expert";
    bot.botBrain = new BotBrain(bot, "expert", game.botBarn);
    game.botBarn.bots.push(bot);

    game.step(15);

    expect(dummy.dead).toBe(true);
});

/** Ticks (at dt=0.1) an `expert` or `easy` bot takes to kill a stationary dummy armed
 *  only with a single bolt-action rifle, or the tick cap if it never does.
 *
 * Deliberately a rifle duel, not the m870/mosin arena loadout the other test above
 * uses: a shotgun's pellet spread is forgiving of imprecise aim by design (at close
 * range most pellets connect regardless of small aim error), which washes out the
 * very difficulty-tier differences (aimErrorDeg, turnRate, reaction) this test exists
 * to prove. A single precise weapon with tight spread (`mosin.shotSpread: 1`) makes
 * hit-or-miss actually depend on aim quality, and with only one gun equipped
 * quickswitch (a separate mechanic, covered by its own tests in botCombat.test.ts) is
 * not a factor here at all.
 *
 * Both tiers still roll `Math.random()` (aim noise, reaction jitter), so a *single*
 * duel is noisy enough that an unlucky `easy` roll can occasionally out-pace an
 * unlucky `expert` one - see the median over several trials below, not this directly. */
function killStep(difficulty: "easy" | "expert", maxTicks = 150): number {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    const dummy = game.playerBarn.addTestPlayer({ pos: v2.create(90, 50) }); // 40 units
    for (const p of [bot, dummy]) {
        p.weaponManager.weapons[WeaponSlot.Primary].type = "mosin";
        p.weaponManager.weapons[WeaponSlot.Primary].ammo = 5;
        p.weaponManager.setCurWeapIndex(WeaponSlot.Primary);
        p.invManager.give("762mm", 20);
    }
    bot.botDifficulty = difficulty;
    bot.botBrain = new BotBrain(bot, difficulty, game.botBarn);
    game.botBarn.bots.push(bot);

    for (let i = 0; i < maxTicks; i++) {
        game.update(0.1);
        if (dummy.dead) return i;
    }
    return maxTicks;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

test("An easy bot is slower to kill than an expert bot", () => {
    Config.bots.enabled = true;

    const trials = 9;
    const expertMedian = median(Array.from({ length: trials }, () => killStep("expert")));
    const easyMedian = median(Array.from({ length: trials }, () => killStep("easy")));

    expect(expertMedian).toBeLessThan(easyMedian);
});
