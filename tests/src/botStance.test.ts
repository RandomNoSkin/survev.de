import { expect, test } from "vitest";
import { coverFraction, coverTowards, enemyCoverAround, pickStance, pickStanceFacing } from "../../server/src/game/bot/botStance.ts";
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

test("Cover an enemy would stand behind counts against a stance", () => {
    const game = openArena();
    const center = v2.create(132, 132);
    game.map.genObstacle("crate_01", v2.add(center, v2.create(2, 0)), 0, 0, 1);
    const graphOpen = buildNavGraph(game);
    const before = enemyCoverAround(graphOpen, center, 0);

    // A crate just beyond where an enemy standing 6 units east of the bot would be.
    game.map.genObstacle("crate_01", v2.add(center, v2.create(7, 0)), 0, 0, 1);
    const graphWithEnemyCover = buildNavGraph(game);

    expect(enemyCoverAround(graphWithEnemyCover, center, 0)).toBeGreaterThan(before);
});

test("With an enemy known, the stance picked has cover on the line to them", () => {
    const game = openArena();
    const center = v2.create(132, 132);
    game.map.genObstacle("crate_01", v2.add(center, v2.create(3, 0)), 0, 0, 1);
    const enemy = v2.add(center, v2.create(12, 0));
    const graph = buildNavGraph(game);

    const picked = pickStanceFacing(graph, center, 0, enemy);

    expect(coverTowards(graph, picked, enemy, 0)).toBe(1);
});

// Real feedback: at the start of a round the idle bot wandered on the spot, because the spots it could
// reach within its short search found no cover - so it never headed for the cover a bit further off.
test("A stance search wide enough finds cover further off than the default radius", () => {
    const game = openArena();
    const center = v2.create(132, 132);
    game.map.genObstacle("crate_01", v2.add(center, v2.create(30, 0)), 0, 0, 1);
    const graph = buildNavGraph(game);

    expect(coverFraction(graph, pickStance(graph, center, 0, 40), 0)).toBeGreaterThan(0);
});
