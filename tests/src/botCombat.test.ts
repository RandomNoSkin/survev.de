import { expect, test } from "vitest";
import {
    BotFireState,
    BotThrowState,
    currentSweetSpot,
    pickHealItem,
    shouldHeal,
    updateFiring,
    updateHeal,
    updateReload,
    updateThrowable,
    updateWeaponSelection,
} from "../../server/src/game/bot/botCombat.ts";
import { BOT_TIERS } from "../../server/src/game/bot/botDefs.ts";
import { GameConfig, TeamMode, WeaponSlot } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/** Equips a slot and makes it active, then clears the cooldown the very first
 *  fists -> gun switch leaves behind, so tests start from a clean baseline instead of
 *  incidentally exercising `setCurWeapIndex`'s switch-delay bookkeeping. */
function equipActive(
    bot: ReturnType<typeof createGame>["playerBarn"]["players"][number],
    slot: number,
    type: string,
    ammo: number,
) {
    bot.weaponManager.weapons[slot].type = type;
    bot.weaponManager.weapons[slot].ammo = ammo;
    bot.weaponManager.weapons[slot].cooldown = 0;
    bot.weaponManager.setCurWeapIndex(slot);
    bot.weaponManager.weapons[slot].cooldown = 0;
}

// Regression: `Player.promoteToRole`/`setWeapon` assign guns into slots without ever
// touching `curWeapIdx` (only a human client's own EquipPrimary input does that), so a
// bot that never explicitly equips would be stuck on melee - walking, never fighting.
test("updateWeaponSelection equips a gun instead of leaving the bot on melee", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    bot.weaponManager.weapons[WeaponSlot.Primary].type = "m870";
    bot.weaponManager.weapons[WeaponSlot.Primary].ammo = 5;
    bot.weaponManager.weapons[WeaponSlot.Primary].cooldown = 0;
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Melee); // the constructor default

    updateWeaponSelection(bot, BOT_TIERS.normal, new BotFireState(), 6);

    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

test("Weapon selection prefers the shotgun up close and the sniper at range", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 5); // shotgun: close sweet spot
    bot.weaponManager.weapons[WeaponSlot.Secondary].type = "mosin"; // bolt-action: far
    bot.weaponManager.weapons[WeaponSlot.Secondary].ammo = 5;
    bot.weaponManager.weapons[WeaponSlot.Secondary].cooldown = 0;
    const fire = new BotFireState();

    updateWeaponSelection(bot, BOT_TIERS.normal, fire, 60);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Secondary);

    // The mosin hasn't fired yet, so it's "committed" (see the commit-until-fired
    // tests below) - simulate that shot landing so the range-preference switch back
    // to the m870 isn't blocked by that guard, which isn't what this test is about.
    fire.firedSinceSwitch = true;

    updateWeaponSelection(bot, BOT_TIERS.normal, fire, 6);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

test("currentSweetSpot never sends a bot chasing a sniper's full falloff range", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "mosin", 5);

    // bullet_mosin.distance is 500 - a bot must not try to stand ~425 units away from
    // its target on a map far smaller than that.
    expect(currentSweetSpot(bot)).toBeLessThanOrEqual(70);
});

// Regression: a loaded gun at the wrong range is still strictly better than an empty
// one at the right range. Before this, `bestRangeSlot` picked purely by range fit, so a
// dry shotgun at close range would win over a loaded sniper even though the shotgun
// can't actually fire - the bot would just stand there useless until its next reload.
test("Weapon selection switches to whatever has ammo over a dry gun at the ideal range", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 0); // dry, and the ideal range fit
    bot.weaponManager.weapons[WeaponSlot.Secondary].type = "mosin"; // loaded, poor range fit
    bot.weaponManager.weapons[WeaponSlot.Secondary].ammo = 5;
    bot.weaponManager.weapons[WeaponSlot.Secondary].cooldown = 0;

    updateWeaponSelection(bot, BOT_TIERS.normal, new BotFireState(), 6); // shotgun range
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Secondary);
});

// "muss er auch checken dass er mit melee waffe schneller rennt (im normalfall)" -
// `Player.recalculateSpeed` adds `weaponDef.speed.equip` every tick, which is +1 for
// fists but 0 for every gun - a real, permanent speed edge over a pursuer, independent
// of `shotSlowdownTimer`/quickswitch entirely. Worth trading the gun for while the goal
// is putting distance, not winning a fight.
test("A fleeing bot switches to melee for the speed bonus instead of holding its gun", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 5);

    updateWeaponSelection(bot, BOT_TIERS.normal, new BotFireState(), 6, /* isFleeing */ true);

    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Melee);
});

test("A bot that is not fleeing keeps its gun equipped instead of switching to melee", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 5);

    updateWeaponSelection(bot, BOT_TIERS.normal, new BotFireState(), 6, /* isFleeing */ false);

    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

// Regression guard: without a special case, the "not holding a gun" branch (which
// exists to fix a fresh spawn stuck on melee) would immediately switch a fleeing bot
// right back to its gun the very next tick, undoing the switch above before it ever got
// to enjoy the speed bonus for more than a single frame.
test("A fleeing bot stays on melee across repeated ticks instead of flip-flopping back to its gun", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    const fire = new BotFireState();

    updateWeaponSelection(bot, BOT_TIERS.normal, fire, 6, true);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Melee);

    updateWeaponSelection(bot, BOT_TIERS.normal, fire, 6, true);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Melee);
});

// Real match debug logging caught the bot holding fists while the enemy was visible
// and as close as 1-3 units, unable to fire back at all - fleeing is a reason to be
// fast, not a reason to be unarmed *while being watched*. The speed edge only actually
// matters once genuinely disengaging.
test("A fleeing bot keeps its gun equipped with recent contact", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 5);

    updateWeaponSelection(bot, BOT_TIERS.normal, new BotFireState(), 6, /* isFleeing */ true, /* recentContact */ true);

    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

// Melee only becomes fair game once contact is genuinely, sustainedly lost - see
// `recentContact`'s own doc comment for why a decoded full replay showed the bot's own
// *current* visibility check alone wasn't a safe enough proxy for "they can't see me".
test("A fleeing bot switches to melee once contact is genuinely lost", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    const fire = new BotFireState();

    updateWeaponSelection(bot, BOT_TIERS.normal, fire, 6, true, true);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);

    updateWeaponSelection(bot, BOT_TIERS.normal, fire, 6, true, false);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Melee);
});

// And the reverse: contact resuming while already on melee must snap straight back to
// the gun, not wait for `isFleeing` to also change.
test("A fleeing bot on melee re-equips its gun the instant contact resumes", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    const fire = new BotFireState();

    updateWeaponSelection(bot, BOT_TIERS.normal, fire, 6, true, false);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Melee);

    updateWeaponSelection(bot, BOT_TIERS.normal, fire, 6, true, true);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

// Once fleeing ends, the bot needs its gun back - the same "not holding a gun" branch
// that would otherwise fight this feature is exactly what re-equips it once `isFleeing`
// stops being true.
test("A bot re-equips its gun the moment fleeing ends", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    const fire = new BotFireState();

    updateWeaponSelection(bot, BOT_TIERS.normal, fire, 6, true);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Melee);

    updateWeaponSelection(bot, BOT_TIERS.normal, fire, 6, false);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

// The core mechanic, per real-world testing feedback: `recalculateSpeed` applies a
// flat 50% movement penalty for the whole `shotSlowdownTimer` window after ANY shot
// from ANY gun (see the doc comment on `updateWeaponSelection`) - a bolt-action rifle
// leaves you at half speed for up to 1.75s. Switching cancels that instantly, so a
// quickswitch tier does it regardless of range fit or whether it's a "free" switch -
// being able to move is worth more than the marginal DPS a costed switch gives up.
test("Quickswitch tech: switches away to shed the shot slowdown, regardless of range", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.weaponManager.weapons[WeaponSlot.Secondary].type = "mosin";
    bot.weaponManager.weapons[WeaponSlot.Secondary].ammo = 5;
    bot.weaponManager.weapons[WeaponSlot.Secondary].cooldown = 0;
    bot.weaponManager.weapons[WeaponSlot.Primary].cooldown = 0.9; // just fired
    bot.shotSlowdownTimer = 0.9; // ...and is slowed for exactly as long

    // Point-blank - the mosin is a poor range fit here, and the switch isn't free
    // (freeSwitchTimer at its 0 default) - neither matters, avoiding the slowdown does.
    updateWeaponSelection(bot, BOT_TIERS.hard, new BotFireState(), 6);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Secondary);
});

test("Quickswitch falls back to melee when there's no usable second gun", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "mosin", 0); // fired its last round
    bot.weaponManager.weapons[WeaponSlot.Primary].cooldown = 1.75;
    bot.shotSlowdownTimer = 1.75;

    updateWeaponSelection(bot, BOT_TIERS.expert, new BotFireState(), 40);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Melee);
});

// Parking on the other gun purely to shed slowdown is not a commitment to fight with
// it - the very next tick is free to swap back, unlike a deliberate range-based
// switch (see the commit-until-fired tests below).
test("A slowdown-driven quickswitch does not require firing before switching back", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.weaponManager.weapons[WeaponSlot.Secondary].type = "mosin";
    bot.weaponManager.weapons[WeaponSlot.Secondary].ammo = 5;
    bot.weaponManager.weapons[WeaponSlot.Secondary].cooldown = 0;
    bot.weaponManager.weapons[WeaponSlot.Primary].cooldown = 0.9;
    bot.shotSlowdownTimer = 0.9;
    const fire = new BotFireState();

    updateWeaponSelection(bot, BOT_TIERS.hard, fire, 6);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Secondary);
    expect(fire.firedSinceSwitch).toBe(true);
});

test("Lower tiers do not quickswitch - they accept the slowdown instead", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.weaponManager.weapons[WeaponSlot.Secondary].type = "mosin";
    bot.weaponManager.weapons[WeaponSlot.Secondary].ammo = 5;
    bot.weaponManager.weapons[WeaponSlot.Secondary].cooldown = 0;
    bot.weaponManager.weapons[WeaponSlot.Primary].cooldown = 0.9;
    bot.shotSlowdownTimer = 0.9;

    updateWeaponSelection(bot, BOT_TIERS.normal, new BotFireState(), 6);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

// Regression for a bug found in manual play: a bot could switch to a gun for
// range-preference reasons and switch straight back before ever firing it, because a
// non-free switch-in delay can outlast the other gun's own cooldown clearing again -
// so it would ping-pong between two weapons without ever pulling either trigger. This
// commitment is specific to the *range-based* switch (the slowdown-driven one above is
// deliberately exempt from it).
test("A range-based switch commits to the new weapon until it has actually fired", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "mosin", 5);
    const fire = new BotFireState();
    fire.firedSinceSwitch = false; // simulates having just landed here via some switch

    // Range clearly favors a hypothetical other gun, but there's none equipped, so
    // the tail-end `switchTo(bestRangeSlot(...))` call has nothing to switch to and
    // must simply leave curWeapIdx alone - this is really testing that the guard
    // itself (`if (!fire.firedSinceSwitch) return`) is reached and honored.
    updateWeaponSelection(bot, BOT_TIERS.normal, fire, 6);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
    expect(fire.firedSinceSwitch).toBe(false); // untouched - the guard returned early
});

// The user's own read on the mechanic: quickswitching pays off for a slow shotgun and
// sniper, but not for something already cycling every fraction of a second like an
// automatic weapon - interrupting its burst to "dodge" a slowdown it re-applies on
// every shot anyway would only lose DPS for nothing.
test("Quickswitch never interrupts an automatic weapon's burst", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "ak47", 30); // "auto" fire mode
    bot.weaponManager.weapons[WeaponSlot.Secondary].type = "m870";
    bot.weaponManager.weapons[WeaponSlot.Secondary].ammo = 5;
    bot.weaponManager.weapons[WeaponSlot.Secondary].cooldown = 0;
    bot.weaponManager.weapons[WeaponSlot.Primary].cooldown = 0.2; // mid-burst
    bot.shotSlowdownTimer = 0.2; // ak47 re-applies this every ~0.1s while firing

    updateWeaponSelection(bot, BOT_TIERS.expert, new BotFireState(), 45);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

test("An empty clip schedules a reload", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 0);

    updateReload(bot);
    expect(bot.weaponManager.scheduledReload).toBe(true);
});

// Regression: `setCurWeapIndex` resets `scheduledReload` to false (see weaponManager),
// so requesting a reload before weapon selection runs on the same tick would get wiped
// out the instant selection decides to switch guns.
test("A reload request survives a weapon switch on the same tick", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 0); // empty
    bot.weaponManager.weapons[WeaponSlot.Secondary].type = "mosin";
    bot.weaponManager.weapons[WeaponSlot.Secondary].ammo = 5;
    bot.weaponManager.weapons[WeaponSlot.Secondary].cooldown = 0;

    // Correct order: selection first (may switch to the mosin, since the m870 is dry),
    // then reload - for whichever weapon selection actually settled on.
    updateWeaponSelection(bot, BOT_TIERS.normal, new BotFireState(), 6);
    updateReload(bot);

    if (bot.weaponManager.curWeapIdx === WeaponSlot.Primary) {
        expect(bot.weaponManager.scheduledReload).toBe(true);
    } else {
        // Switched to the loaded mosin instead - nothing to reload, and critically,
        // no *stale* reload request left over from before the switch.
        expect(bot.weaponManager.scheduledReload).toBe(false);
    }
});

// Regression for the exact bug reported in manual play: `setCurWeapIndex`
// unconditionally cancels the player's current action, so weapon selection running
// while a heal is in progress would cancel the heal it's supposed to leave alone.
test("Weapon selection does not cancel an in-progress heal", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.weaponManager.weapons[WeaponSlot.Secondary].type = "mosin";
    bot.weaponManager.weapons[WeaponSlot.Secondary].ammo = 5;
    bot.weaponManager.weapons[WeaponSlot.Secondary].cooldown = 0;
    bot.invManager.give("bandage", 5);
    bot.health = 40;

    expect(shouldHeal(bot, BOT_TIERS.normal, false, false)).toBe(true);
    updateHeal(bot, BOT_TIERS.normal, false, false);
    expect(bot.actionType).toBe(GameConfig.Action.UseItem);

    // Even with every reason to want to switch (cooldown high, quickswitch tier, a
    // clearly better range fit available), selection must leave the heal alone.
    bot.weaponManager.weapons[WeaponSlot.Primary].cooldown = 0.9;
    bot.freeSwitchTimer = -1;
    updateWeaponSelection(bot, BOT_TIERS.expert, new BotFireState(), 60);

    expect(bot.actionType).toBe(GameConfig.Action.UseItem);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

test("updateFiring never fires when a teammate stands on the line of fire", () => {
    const game = createGame(TeamMode.Squad, "test_normal");
    const group = game.playerBarn.addGroup(false, false);
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0), group });
    const mate = game.playerBarn.addTestPlayer({ pos: v2.create(20, 0), group });
    const enemy = game.playerBarn.addTestPlayer({ pos: v2.create(40, 0) });

    equipActive(bot, WeaponSlot.Primary, "ak47", 30); // "auto" fire mode -> shootHold
    bot.dirNew = v2.create(1, 0);

    const fire = new BotFireState();
    updateFiring(bot, BOT_TIERS.expert, fire, enemy.pos, 40, /* canFire */ true, 0.05);
    expect(bot.shootHold).toBe(false);

    // Sanity: without the teammate in the way, the same shot is allowed.
    game.playerBarn.removePlayer(mate);
    updateFiring(bot, BOT_TIERS.expert, fire, enemy.pos, 40, true, 0.05);
    expect(bot.shootHold).toBe(true);
});

test("Auto-fire weapons pulse shootHold in bursts, not one continuous hold", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const enemy = game.playerBarn.addTestPlayer({ pos: v2.create(10, 0) });
    equipActive(bot, WeaponSlot.Primary, "ak47", 60);

    const tier = { ...BOT_TIERS.hard, burstMin: 0.1, burstMax: 0.1 };
    const fire = new BotFireState();

    // Fresh engagement must start by firing, not by immediately toggling into a pause.
    updateFiring(bot, tier, fire, enemy.pos, 10, true, 0.05);
    expect(bot.shootHold).toBe(true);

    // Advance past the (fixed, 0.1s) burst window - it must let go of the trigger.
    updateFiring(bot, tier, fire, enemy.pos, 10, true, 0.2);
    expect(bot.shootHold).toBe(false);
});

test("Single-fire weapons pulse shootStart once per shot, not every tick", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const enemy = game.playerBarn.addTestPlayer({ pos: v2.create(10, 0) });
    equipActive(bot, WeaponSlot.Primary, "m870", 5);

    const fire = new BotFireState();
    updateFiring(bot, BOT_TIERS.expert, fire, enemy.pos, 10, true, 0.05);
    expect(bot.shootStart).toBe(true);
    expect(bot.shootHold).toBe(false);
});

test("A hurt, unthreatened bot heals itself", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    bot.invManager.give("bandage", 5);
    bot.health = 40; // below BOT_TIERS.normal.healThreshold (0.5)

    updateHeal(bot, BOT_TIERS.normal, /* hasVisibleEnemy */ false, /* positionSafe */ false);

    expect(bot.actionType).toBe(GameConfig.Action.UseItem);
});

test("A bot does not stop to heal a graze while an enemy is in sight", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    bot.invManager.give("bandage", 5);
    bot.health = 90; // well above the danger zone that overrides caution

    updateHeal(bot, BOT_TIERS.normal, /* hasVisibleEnemy */ true, /* positionSafe */ false);

    expect(bot.actionType).toBe(GameConfig.Action.None);
});

// The explicit ask: a medkit only makes sense when it's actually faster than fully
// healing with bandages *and* the position can absorb that longer, harder-to-abort
// commitment. Missing 60 HP (health 40%, above the critical override below) needs 4
// bandage uses (12s total, `heal: 15`/`useTime: 3`) against the medkit's flat 6s -
// clearly faster, so this isolates the position half of the decision on its own.
test("pickHealItem reaches for the medkit when it's faster and the position is safe", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    bot.invManager.give("bandage", 10);
    bot.invManager.give("healthkit", 2);
    bot.health = 40; // missing 60, above the critical (<=25%) override

    expect(pickHealItem(bot, 0.4, /* positionSafe */ true)).toBe("healthkit");
});

test("pickHealItem sticks with the bandage even when the medkit would be faster, if exposed", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    bot.invManager.give("bandage", 10);
    bot.invManager.give("healthkit", 2);
    bot.health = 40; // same 60-missing case as above - only positionSafe differs

    expect(pickHealItem(bot, 0.4, /* positionSafe */ false)).toBe("bandage");
});

// Missing only 15 HP is a single bandage use (3s) against the medkit's 6s - bandage is
// already faster on its own, so position shouldn't matter here either way.
test("pickHealItem prefers the bandage outright when it isn't actually slower", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    bot.invManager.give("bandage", 10);
    bot.invManager.give("healthkit", 2);
    bot.health = 85; // missing 15

    expect(pickHealItem(bot, 0.85, /* positionSafe */ true)).toBe("bandage");
});

// Critically hurt always grabs the fastest option regardless of position - delaying
// matters more than the exposure window at that point.
test("pickHealItem grabs the medkit at critical health even when exposed", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({});
    bot.invManager.give("bandage", 10);
    bot.invManager.give("healthkit", 2);
    bot.health = 20; // <= 25%, critical override

    expect(pickHealItem(bot, 0.2, /* positionSafe */ false)).toBe("healthkit");
});

// "der bot soll nades nicht benutzen wenn schießen besser ist" - a healthy bot that can
// see its target should always just shoot, never spend the slot on a grenade instead.
// This is the case that used to throw here (a visible, in-range, well-aimed target) and
// deliberately no longer does - see `updateThrowable`'s doc comment for the two cases
// that still legitimately earn the slot.
test("updateThrowable does not throw at a visible target it could just shoot instead", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(20, 0) }); // inside [14,30]
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.invManager.give("frag", 4);

    const throwState = new BotThrowState();
    throwState.cooldown = 0; // otherwise randomized, see BotThrowState

    updateThrowable(
        bot,
        throwState,
        target.pos,
        20,
        /* justLostSight */ false,
        /* isFleeing */ false,
        0.05,
    );

    expect(throwState.active).toBe(false);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

// "er soll die nades quasi nur benutzen wenn er selbst low ist und rennen muss" - a
// grenade tossed back at the threat while retreating is worth the slot even though the
// bot isn't trying to win the fight outright here.
test("updateThrowable throws to cover a retreat when the bot is fleeing", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const threatPos = v2.create(20, 0); // inside [14,30]
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.invManager.give("frag", 4);

    const throwState = new BotThrowState();
    throwState.cooldown = 0;

    updateThrowable(bot, throwState, threatPos, 20, false, /* isFleeing */ true, 0.05);

    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Throwable);
    expect(bot.weaponManager.weapons[WeaponSlot.Throwable].type).toBe("frag");
    expect(bot.shootStart).toBe(true);
    expect(throwState.active).toBe(true);
    expect(throwState.returnSlot).toBe(WeaponSlot.Primary);
});

// "wirft Granaten manchmal einfach vor sich gegen eine Wand" - an obstacle immediately
// in the throw direction, well short of THROW_MIN_DIST (so it's never legitimately the
// target's own cover), means the grenade would just hit it and drop back at the bot's
// own feet - not worth throwing into at all.
test("updateThrowable does not throw into an obstacle immediately in front of it", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    game.map.genObstacle("crate_01", v2.create(4, 0)); // well inside THROW_CLEARANCE_DIST (6)
    const threatPos = v2.create(20, 0);
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.invManager.give("frag", 4);

    const throwState = new BotThrowState();
    throwState.cooldown = 0;

    updateThrowable(bot, throwState, threatPos, 20, false, /* isFleeing */ true, 0.05);

    expect(throwState.active).toBe(false);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

// Regression for a real match capture: a grenade thrown at a correctly-ranged, visible
// target instead clipped a wall right next to the bot, bounced (`Projectile`'s own
// collision reflects rather than stops), and detonated back on the bot that threw it -
// a self-kill. The old clearance check was a zero-width ray that can graze past a
// corner the thrown projectile's own body (`rad`) still clips, the same gap `isDirClear`
// has its own fix for elsewhere. Geometry picked so the throw direction passes exactly
// `offset` units outside `crate_01`'s corner, within `THROW_CLEARANCE_DIST` (6) of the
// bot: less than frag's `rad` (1) is a real clip the old ray would still miss;
// comfortably more than it is a genuine, uncontested clear throw.
test("updateThrowable refuses a throw that grazes a corner within the projectile's own radius", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const center = v2.create(132, 132);
    game.map.genObstacle("crate_01", center); // AABB spanning center +/- 2.25

    const corner = v2.add(center, v2.create(2.25, -2.25));
    const dir = v2.normalizeSafe(v2.create(1, 1)); // tangent past the corner, not through it
    const outward = v2.normalizeSafe(v2.create(1, -1)); // away from the box, past the corner
    const start = v2.sub(corner, v2.mul(dir, 5)); // 5 units short of the corner along dir

    const grazing = game.playerBarn.addTestPlayer({ pos: v2.add(start, v2.mul(outward, 0.5)) });
    equipActive(grazing, WeaponSlot.Primary, "m870", 5);
    grazing.invManager.give("frag", 4);
    const grazingThrow = new BotThrowState();
    grazingThrow.cooldown = 0;
    updateThrowable(grazing, grazingThrow, v2.add(grazing.pos, v2.mul(dir, 20)), 20, false, true, 0.05);
    expect(grazingThrow.active).toBe(false);

    const wellClear = game.playerBarn.addTestPlayer({ pos: v2.add(start, v2.mul(outward, 1.5)) });
    equipActive(wellClear, WeaponSlot.Primary, "m870", 5);
    wellClear.invManager.give("frag", 4);
    const wellClearThrow = new BotThrowState();
    wellClearThrow.cooldown = 0;
    updateThrowable(wellClear, wellClearThrow, v2.add(wellClear.pos, v2.mul(dir, 20)), 20, false, true, 0.05);
    expect(wellClearThrow.active).toBe(true);
});

// The bait case's whole point is throwing at someone who's specifically NOT in sight -
// an obstacle further away, past the short clearance check but well before the actual
// target, must not block the throw the way one immediately in front does.
test("updateThrowable still throws over/around cover that's further away than the clearance check", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    game.map.genObstacle("crate_01", v2.create(12, 0)); // past THROW_CLEARANCE_DIST (6)
    const threatPos = v2.create(20, 0);
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.invManager.give("frag", 4);

    const throwState = new BotThrowState();
    throwState.cooldown = 0;

    updateThrowable(bot, throwState, threatPos, 20, false, /* isFleeing */ true, 0.05);

    expect(throwState.active).toBe(true);
});

test("updateThrowable hands the weapon slot back to the gun once the throw resolves", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const threatPos = v2.create(20, 0);
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.invManager.give("frag", 4);

    const throwState = new BotThrowState();
    throwState.cooldown = 0;
    updateThrowable(bot, throwState, threatPos, 20, false, true, 0.05);
    expect(throwState.active).toBe(true);

    // Advance real game ticks so `weaponManager.update` actually cooks and releases the
    // throw (`GameConfig.player.cookTime` = 0.1s) - `updateThrowable` itself only sets
    // the input fields, exactly like a human's InputMsg would.
    for (let i = 0; i < 10 && throwState.active; i++) {
        game.update(0.05);
        updateThrowable(bot, throwState, threatPos, 20, false, true, 0.05);
    }

    expect(throwState.active).toBe(false);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

test("updateThrowable does not throw at point-blank range (self-splash risk)", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const threatPos = v2.create(6, 0); // inside blast radius
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.invManager.give("frag", 4);

    const throwState = new BotThrowState();
    throwState.cooldown = 0;
    updateThrowable(bot, throwState, threatPos, 6, false, true, 0.05);

    expect(throwState.active).toBe(false);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

test("updateThrowable does not throw without a grenade in inventory", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const threatPos = v2.create(20, 0);
    equipActive(bot, WeaponSlot.Primary, "m870", 5);

    const throwState = new BotThrowState();
    throwState.cooldown = 0;
    updateThrowable(bot, throwState, threatPos, 20, false, true, 0.05);

    expect(throwState.active).toBe(false);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

test("updateThrowable waits out its own cooldown between throws", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const threatPos = v2.create(20, 0);
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.invManager.give("frag", 4);

    const throwState = new BotThrowState();
    throwState.cooldown = 3; // hasn't elapsed yet

    updateThrowable(bot, throwState, threatPos, 20, false, true, 0.05);

    expect(throwState.active).toBe(false);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});

// The "nades sind useful wenn der Gegner in cover ist um ihn da raus zu baiten" ask: a
// target that just ducked out of sight nearby (justLostSight, mirroring BotBrain's
// recentlyVisible) is exactly when a real player lobs one blind to flush them back out -
// can't shoot what it can't see, so a grenade earns the slot even while healthy.
test("updateThrowable bait-throws at a target's last-known spot right after losing sight of them", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    const lastKnownPos = v2.create(20, 0);
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.invManager.give("frag", 4);

    const throwState = new BotThrowState();
    throwState.cooldown = 0;

    updateThrowable(
        bot,
        throwState,
        lastKnownPos,
        20,
        /* justLostSight */ true,
        /* isFleeing */ false,
        0.05,
    );

    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Throwable);
    expect(throwState.active).toBe(true);
    // Aimed explicitly at the remembered spot, not whatever it was previously facing -
    // updateAim never touches `dir` once there's no live target to track.
    expect(bot.dirNew.x).toBeCloseTo(1, 5);
    expect(bot.dirNew.y).toBeCloseTo(0, 5);
});

test("updateThrowable does not bait-throw at a stale memory (not recently lost)", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 0) });
    equipActive(bot, WeaponSlot.Primary, "m870", 5);
    bot.invManager.give("frag", 4);

    const throwState = new BotThrowState();
    throwState.cooldown = 0;

    updateThrowable(
        bot,
        throwState,
        v2.create(20, 0),
        20,
        /* justLostSight */ false,
        /* isFleeing */ false,
        0.05,
    );

    expect(throwState.active).toBe(false);
    expect(bot.weaponManager.curWeapIdx).toBe(WeaponSlot.Primary);
});
