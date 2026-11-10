import { expect, test } from "vitest";
import { TeamMode, WeaponSlot } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/** A USAS shot to the right with the cursor `aim` away (a barrel 16 units off if
 *  `barrel`): where its shell explodes (x relative to the shooter), and whether a
 *  bullet is still flying afterwards. */
function usasShot(aim: number, barrel = true) {
    const game = createGame(TeamMode.Solo, "test_normal");
    const player = game.playerBarn.addTestPlayer({});
    if (barrel) game.map.genObstacle("barrel_01", v2.add(player.pos, v2.create(16, 0)), player.layer, 0, 1);
    const wm = player.weaponManager;
    wm.setWeapon(WeaponSlot.Primary, "usas", 10);
    wm.setCurWeapIndex(WeaponSlot.Primary);
    player.dir = v2.create(1, 0);
    // the USAS shoots to the cursor (toMouseHit)
    player.toMouseLen = aim;

    const explosions: number[] = [];
    const barn = game.explosionBarn as any;
    const add = barn.addExplosion.bind(barn);
    barn.addExplosion = (type: string, mult: number, pos: { x: number }, ...rest: unknown[]) => {
        if (type === "explosion_usas") explosions.push(pos.x - player.pos.x);
        return add(type, mult, pos, ...rest);
    };
    wm.fireWeapon(false);
    for (let i = 0; i < 30; i++) game.step(1 / 30);
    const stuck = game.bulletBarn.bullets.some((b) => b.active && b.bulletType === "bullet_frag");
    return { explosions, stuck };
}

test("a USAS shot aimed at a barrel explodes at the barrel", () => {
    // the shot hits the barrel's side and bounces with just the bit left to the cursor -
    // that bounced bullet used to stand still forever instead of exploding
    const { explosions, stuck } = usasShot(16);
    expect(stuck).toBe(false);
    expect(explosions).toHaveLength(1);
    // at the barrel (its side is ~1.5 in front of its center at 16)
    expect(Math.abs(explosions[0] - 15)).toBeLessThan(2);
});

test("aimed behind the barrel it bounces off and explodes too", () => {
    const { explosions, stuck } = usasShot(22);
    expect(stuck).toBe(false);
    expect(explosions).toHaveLength(1);
});

test("without anything in the way it explodes at the cursor", () => {
    const { explosions, stuck } = usasShot(12, false);
    expect(stuck).toBe(false);
    expect(explosions).toHaveLength(1);
    expect(Math.abs(explosions[0] - 12)).toBeLessThan(1);
});
