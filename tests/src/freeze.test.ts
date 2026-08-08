import "./testHelpers.ts";
import { expect, test } from "vitest";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

// A freezing bullet (mac10 [+] outside potato mode) used to crash the game process:
// Player never had a `frozenType`, and the player serializer writes it through
// writeGameType while `frozen` is set, where typeToId throws on undefined.

test("Freezing bullet hit serializes", () => {
    const game = createGame(TeamMode.Solo, "test_normal");

    const shooter = game.playerBarn.addTestPlayer({});
    const target = game.playerBarn.addTestPlayer({
        pos: v2.add(shooter.pos, v2.create(3, 0)),
    });
    expect(shooter.teamId).not.toBe(target.teamId);

    game.bulletBarn.fireBullet({
        playerId: shooter.__id,
        bulletType: "bullet_mac10_modified",
        gameSourceType: "modified_mac10",
        damageType: GameConfig.DamageType.Player,
        pos: v2.copy(shooter.pos),
        dir: v2.create(1, 0),
        layer: shooter.layer,
        damageMult: 1,
        shotFx: true,
        shotOffhand: false,
        lastShot: true,
    });

    // Let the bullet travel the 3 units to the target.
    for (let i = 0; i < 10 && !target.frozen; i++) {
        game.bulletBarn.update(1 / 60);
    }

    expect(target.frozen).toBe(true);
    // This is the crash: writeGameType(undefined) -> typeToId asserts.
    expect(() => target.serializeFull()).not.toThrow();
    expect(target.frozenType).toBe("");
});

test("Freeze from an explosion carries its type", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const player = game.playerBarn.addTestPlayer({});

    player.freeze(0, 0.5, 3, "explosion_snowball");

    expect(player.frozenType).toBe("explosion_snowball");
    expect(() => player.serializeFull()).not.toThrow();
});

test("Freeze expiring clears the type", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const player = game.playerBarn.addTestPlayer({});

    player.freeze(0, 0.5, 3, "explosion_snowball");
    player.update(1);

    expect(player.frozen).toBe(false);
    expect(player.frozenType).toBe("");
});
