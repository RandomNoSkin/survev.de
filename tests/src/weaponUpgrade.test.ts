import { expect, test } from "vitest";
import { TeamMode, WeaponSlot } from "../../shared/gameConfig.ts";
import { createGame } from "./gameTestHelpers.ts";

function m249Player(backpackAmmo: number, clipAmmo: number) {
    const game = createGame(TeamMode.Solo, "test_normal");
    const player = game.playerBarn.addTestPlayer({});
    const wm = player.weaponManager;
    wm.setWeapon(WeaponSlot.Primary, "m249", clipAmmo);
    wm.setCurWeapIndex(WeaponSlot.Primary);
    player.invManager.set("556mm", backpackAmmo);
    player.invManager.set("construction_item", 10);
    return { game, player, wm };
}

/** shots fired: the backpack drain, or bullets the gun spawned */
function fire(game: ReturnType<typeof createGame>, wm: any, times: number) {
    let fired = 0;
    for (let i = 0; i < times; i++) {
        const before = game.bulletBarn.newBullets.length + game.bulletBarn.bullets.length;
        wm.weapons[wm.curWeapIdx].cooldown = 0;
        wm.fireWeapon(false);
        if (game.bulletBarn.newBullets.length + game.bulletBarn.bullets.length > before) fired++;
    }
    return fired;
}

test("upgrading the M249 doesn't load a free clip into the backpack-fed M249 [+]", () => {
    const { game, player, wm } = m249Player(0, 30);
    wm.upgradeCurrentWeapon();
    expect(player.weapons[WeaponSlot.Primary].type).toBe("modified_m249");
    // no clip on a backpack-fed gun - the 30 loaded rounds went back into the backpack
    expect(player.weapons[WeaponSlot.Primary].ammo).toBe(0);
    expect(player.invManager.get("556mm")).toBe(30);

    // exactly those 30 shots, then empty
    expect(fire(game, wm, 50)).toBe(30);
    expect(player.invManager.get("556mm")).toBe(0);
});

test("M249 [+] without backpack ammo can't fire, even with rounds stuck in its clip", () => {
    const { game, player, wm } = m249Player(0, 0);
    wm.upgradeCurrentWeapon();
    // an old save / pickup state: rounds in the clip of the backpack-fed gun
    player.weapons[WeaponSlot.Primary].ammo = 100;
    expect(fire(game, wm, 20)).toBe(0);
});
