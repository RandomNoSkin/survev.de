import { expect, test } from "vitest";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import type { Player } from "../../server/src/game/objects/player.ts";
import { createGame } from "./gameTestHelpers.ts";

function kill(p: Player, by: Player) {
    p.kill({ damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0), source: by });
}

test("Solo: players joining after a death don't give two dead players the same rank", () => {
    const game = createGame(TeamMode.Solo, "main");
    const players = Array.from({ length: 4 }, () => game.playerBarn.addTestPlayer({}));
    // dies with 4 alive: player.rank 4
    kill(players[0], players[3]);
    // someone joins late: 4 alive again
    players.push(game.playerBarn.addTestPlayer({}));
    // dies with 4 alive: player.rank 4 too
    kill(players[1], players[3]);
    expect(players[0].rank).toBe(players[1].rank);

    const ranks = game.modeManager.currentRanks();
    expect(ranks.get(players[0])).toBe(5);
    expect(ranks.get(players[1])).toBe(4);
    // still alive: not decided yet
    expect(ranks.get(players[2])).toBe(0);
    expect(ranks.get(players[3])).toBe(0);

    kill(players[2], players[3]);
    kill(players[4], players[3]);
    const final = game.modeManager.currentRanks();
    expect(players.map((p) => final.get(p))).toStrictEqual([5, 4, 3, 1, 2]);
});

test("Duo: a dead player shares their team's place, open until the whole team is out", () => {
    const game = createGame(TeamMode.Duo, "main");
    const groupA = game.playerBarn.addGroup(false, false);
    const groupB = game.playerBarn.addGroup(false, false);
    const groupC = game.playerBarn.addGroup(false, false);
    const [a1, a2] = [game.playerBarn.addTestPlayer({ group: groupA }), game.playerBarn.addTestPlayer({ group: groupA })];
    const [b1, b2] = [game.playerBarn.addTestPlayer({ group: groupB }), game.playerBarn.addTestPlayer({ group: groupB })];
    const c1 = game.playerBarn.addTestPlayer({ group: groupC });

    kill(a1, c1);
    expect(game.modeManager.currentRanks().get(a1)).toBe(0);
    kill(a2, c1);
    kill(b1, c1);
    const ranks = game.modeManager.currentRanks();
    expect(ranks.get(a1)).toBe(3);
    expect(ranks.get(a2)).toBe(3);
    expect(ranks.get(b1)).toBe(0);
    kill(b2, c1);
    const final = game.modeManager.currentRanks();
    expect([final.get(b1), final.get(b2), final.get(c1)]).toStrictEqual([2, 2, 1]);
});
