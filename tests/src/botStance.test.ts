import { expect, test } from "vitest";
import { coverFraction, pickStance } from "../../server/src/game/bot/botStance.ts";
import { buildNavGraph } from "../../server/src/game/bot/nav/navBuilder.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

function openArena() {
    const game = createGame(TeamMode.Solo, "test_normal");
    for (const o of game.map.obstacles) o.dead = true;
    return game;
}

test("A spot in the open has no cover around it", () => {
    const game = openArena();
    const graph = buildNavGraph(game);
    expect(coverFraction(graph, v2.create(132, 132), 0)).toBe(0);
});

test("A spot with a crate beside it has more cover than the open spot it started from", () => {
    const game = openArena();
    const center = v2.create(132, 132);
    game.map.genObstacle("crate_01", v2.add(center, v2.create(5, 0)), 0, 0, 1);
    const graph = buildNavGraph(game);

    const picked = pickStance(graph, center, 0);

    expect(coverFraction(graph, picked, 0)).toBeGreaterThan(coverFraction(graph, center, 0));
});

test("With nothing to hide behind nearby, the stance stays where the bot already is", () => {
    const game = openArena();
    const center = v2.create(132, 132);
    const graph = buildNavGraph(game);

    expect(v2.distance(pickStance(graph, center, 0), center)).toBeLessThan(0.01);
});
