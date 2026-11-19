import { expect, test } from "vitest";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

test("Accuracy counts a hit once per fired shot, even when it pierces into a second player", () => {
    const game = createGame(TeamMode.Solo, "main");
    const shooter = game.playerBarn.addTestPlayer({});
    const a = game.playerBarn.addTestPlayer({});
    const b = game.playerBarn.addTestPlayer({});
    const hit = (target: typeof a, shotId: number) =>
        target.damage({
            amount: 10,
            source: shooter,
            gameSourceType: "sv98",
            damageType: GameConfig.DamageType.Player,
            dir: v2.create(1, 0),
            shotId,
        });

    hit(a, 1);
    hit(b, 1); // the same shot, pierced into a second player
    expect(shooter.weaponHits.get("sv98")).toBe(1);
    expect(shooter.bulletHits).toBe(1);

    hit(a, 2); // a second shot
    expect(shooter.weaponHits.get("sv98")).toBe(2);

    // an explosive round's blast (no shotId) is no extra hit
    a.damage({ amount: 5, source: shooter, gameSourceType: "sv98", damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0), isExplosion: true });
    expect(shooter.weaponHits.get("sv98")).toBe(2);
});
