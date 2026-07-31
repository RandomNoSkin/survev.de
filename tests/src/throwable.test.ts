import { expect, test } from "vitest";
import { GameObjectDefs } from "../../shared/defs/register.ts";
import { GameConfig, TeamMode, WeaponSlot } from "../../shared/gameConfig.ts";
import * as net from "../../shared/net/net.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

function mkInput(inputs: number[]) {
    const msg = new net.InputMsg();
    msg.inputs = inputs as any;
    msg.toMouseDir = v2.create(1, 0);
    msg.touchMoveDir = v2.create(1, 0);
    msg.toMouseLen = 20;
    return msg;
}

test("cooking a throwable with an empty throwable slot doesn't crash the tick", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const player = game.playerBarn.addTestPlayer({});
    const wm = player.weaponManager;

    wm.setWeapon(WeaponSlot.Primary, "m870", 5);
    wm.setCurWeapIndex(WeaponSlot.Primary);

    // state that used to blow up in throwThrowable(): cooking while the throwable slot
    // is empty (invManager.get("") is undefined, so the `amount <= 0` guard didn't fire)
    wm.cookingThrowable = true;
    wm.cookTicker = 5;

    game.step(0.1);

    expect(wm.cookingThrowable).toBe(false);
});

test("cooking with a non-throwable in the throwable slot doesn't crash the tick", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const player = game.playerBarn.addTestPlayer({});
    const wm = player.weaponManager;

    wm.setWeapon(WeaponSlot.Primary, "m870", 5);
    wm.setCurWeapIndex(WeaponSlot.Primary);
    wm.weapons[WeaponSlot.Throwable].type = "m870";
    wm.cookingThrowable = true;
    wm.cookTicker = 5;

    game.step(0.1);

    expect(wm.cookingThrowable).toBe(false);
});

test("an empty active weapon slot recovers to melee instead of crashing", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const player = game.playerBarn.addTestPlayer({});
    const wm = player.weaponManager;

    wm.setWeapon(WeaponSlot.Primary, "m870", 5);
    wm.setCurWeapIndex(WeaponSlot.Primary);
    wm.weapons[WeaponSlot.Primary].type = "";

    game.step(0.1);

    expect(wm.curWeapIdx).toBe(WeaponSlot.Melee);
    expect(wm.activeWeapon).toBe("fists");
});

test("pull the pin then switch away: throwable lands and inventory is consumed", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const player = game.playerBarn.addTestPlayer({});
    const wm = player.weaponManager;

    player.invManager.give("frag", 2);
    wm.setWeapon(WeaponSlot.Throwable, "frag", 0);
    wm.setWeapon(WeaponSlot.Primary, "m870", 5);
    wm.setCurWeapIndex(WeaponSlot.Throwable);

    player.shootStart = true;
    player.shootHold = true;
    game.step(0.1);
    game.step(0.1);
    expect(wm.cookingThrowable).toBe(true);

    player.handleInput(mkInput([GameConfig.Input.EquipPrimary]));
    game.step(0.1);

    expect(wm.cookingThrowable).toBe(false);
    expect(player.invManager.get("frag")).toBe(1);
    expect(wm.weapons[WeaponSlot.Throwable].type).toBe("frag");
});

test("switching away while cooking never animates a throw with a non-throwable equipped", () => {
    // The throw anim's client side effects resolve the active weapon as a throwable, so
    // Anim.Throw while holding a melee/gun crashed every client that saw the player.
    for (const slot of [WeaponSlot.Melee, WeaponSlot.Primary] as const) {
        for (const ticks of [1, 2, 4]) {
            const game = createGame(TeamMode.Solo, "test_normal");
            const player = game.playerBarn.addTestPlayer({});
            const wm = player.weaponManager;

            player.invManager.give("frag", 2);
            wm.setWeapon(WeaponSlot.Throwable, "frag", 0);
            wm.setWeapon(WeaponSlot.Primary, "m870", 5);
            wm.setCurWeapIndex(WeaponSlot.Throwable);

            player.shootStart = true;
            player.shootHold = true;
            for (let i = 0; i < ticks; i++) {
                game.step(0.1);
                player.shootStart = false;
            }

            wm.setCurWeapIndex(slot);

            for (let i = 0; i < 5; i++) {
                const activeDef = GameObjectDefs.typeToDefSafe(wm.activeWeapon);
                if (player.animType === GameConfig.Anim.Throw) {
                    expect(activeDef?.type).toBe("throwable");
                }
                game.step(0.1);
            }
            // the throwable still left the inventory
            expect(player.invManager.get("frag")).toBe(1);
        }
    }
});

test("aborting a cook before cook time doesn't leave the player stuck in the cook anim", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const player = game.playerBarn.addTestPlayer({});
    const wm = player.weaponManager;

    // smoke is not cookable -> the cook anim runs with an Infinity duration
    player.invManager.give("smoke", 2);
    wm.setWeapon(WeaponSlot.Throwable, "smoke", 0);
    wm.setCurWeapIndex(WeaponSlot.Throwable);

    player.shootStart = true;
    player.shootHold = true;
    // short tick so the cook time (0.1s) isn't reached yet
    game.update(0.05);
    expect(wm.cookingThrowable).toBe(true);
    expect(wm.cookTicker).toBeLessThan(GameConfig.player.cookTime);

    // cycle throwables immediately: throw is aborted (cookTicker < cookTime)
    wm.throwThrowable(true);

    expect(wm.cookingThrowable).toBe(false);
    expect(player.animType).toBe(GameConfig.Anim.None);

    // the player can start cooking again
    player.shootStart = true;
    game.update(0.05);
    expect(wm.cookingThrowable).toBe(true);
});

test("back to back loot inputs are not swallowed by a pickup cooldown", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const player = game.playerBarn.addTestPlayer({});

    game.lootBarn.addLoot("9mm", player.pos, player.layer, 10, undefined, 0);
    game.lootBarn.addLoot("9mm", player.pos, player.layer, 10, undefined, 0);
    game.step(0.1);

    const before = player.invManager.get("9mm");

    // two loot presses in the same tick: both have to land
    player.handleInput(mkInput([GameConfig.Input.Loot]));
    player.handleInput(mkInput([GameConfig.Input.Loot]));

    expect(player.invManager.get("9mm")).toBe(before + 20);
});
