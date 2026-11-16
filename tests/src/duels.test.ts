import { expect, test } from "vitest";
import type { Player } from "../../server/src/game/objects/player.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

function setup() {
    const game = createGame(TeamMode.Solo, "local");
    const add = (id: string) => {
        const p = game.playerBarn.addTestPlayer({});
        p.userId = id;
        // local is an arena mode: no damage before a class is picked
        p.role = "arena1";
        return p;
    };
    return { game, a: add("user-a"), b: add("user-b"), c: add("user-c") };
}
const hit = (target: Player, by: Player, amount = 20) =>
    target.damage({ amount, source: by, gameSourceType: "m870", damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0) });
const kill = (target: Player, by: Player) =>
    target.kill({ source: by, gameSourceType: "m870", damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0) });

test("A clean 1v1 kill in local mode counts as a duel", () => {
    const { game, a, b } = setup();
    hit(b, a);
    hit(a, b);
    kill(b, a);
    expect(game.duels.map((d) => [d.winnerUserId, d.loserUserId])).toStrictEqual([["user-a", "user-b"]]);
});

test("A third player hitting the loser shortly before - no duel", () => {
    const { game, a, b, c } = setup();
    hit(b, c);
    hit(b, a);
    kill(b, a);
    expect(game.duels).toHaveLength(0);
});

test("A third player hitting the winner shortly before - no duel", () => {
    const { game, a, b, c } = setup();
    hit(a, c);
    hit(b, a);
    kill(b, a);
    expect(game.duels).toHaveLength(0);
});

test("Guests don't count", () => {
    const { game, a, b } = setup();
    b.userId = null as never;
    hit(b, a);
    kill(b, a);
    expect(game.duels).toHaveLength(0);
});
