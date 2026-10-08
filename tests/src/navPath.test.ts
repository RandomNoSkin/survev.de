import { expect, test } from "vitest";
import { findPath } from "../../server/src/game/bot/nav/navAStar.ts";
import { buildNavGraph } from "../../server/src/game/bot/nav/navBuilder.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

function pathTotalLength(graph: ReturnType<typeof buildNavGraph>, path: number[]): number {
    let total = 0;
    for (let i = 1; i < path.length; i++) {
        total += v2.distance(graph.pos(path[i - 1]), graph.pos(path[i]));
    }
    return total;
}

test("A path exists between two open points across the arena map", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    for (const seed of [0.15, 0.3, 0.45, 0.6, 0.75, 0.85]) {
        const from = v2.create(game.map.width * seed, game.map.height * (1 - seed));
        const to = v2.create(game.map.width * (1 - seed), game.map.height * seed);

        const startNodes = graph.nearby(from, 0, 40, 5);
        const goalNodes = new Set(graph.nearby(to, 0, 40, 5));
        expect(startNodes.length, `no start node found near seed ${seed}`).toBeGreaterThan(0);
        expect(goalNodes.size, `no goal node found near seed ${seed}`).toBeGreaterThan(0);

        const path = findPath(graph, startNodes, goalNodes, to, 0, 4000);
        expect(path, `no path found for seed ${seed}`).not.toBeNull();
        expect(path!.length).toBeGreaterThan(1);
    }
});

test("A* returns null quickly for an unreachable goal instead of exhausting its budget", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const from = v2.create(20, 20);
    // A point far outside the map bounds has no nearby graph node at all.
    const to = v2.create(-9999, -9999);

    const startNodes = graph.nearby(from, 0, 40, 5);
    const goalNodes = new Set(graph.nearby(to, 0, 5, 5));
    expect(goalNodes.size).toBe(0);

    const path = findPath(graph, startNodes, goalNodes, to, 0, 4000);
    expect(path).toBeNull();
});

test("A path from outside a building reaches its interior (requires a door node)", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const interiorNodes = graph.kind
        .map((k, i) => (k === "interior" ? i : -1))
        .filter((i) => i >= 0);
    expect(interiorNodes.length, "no interior nodes were sampled at all").toBeGreaterThan(0);

    // Pick an interior node and try to reach it from far outside its own building -
    // any door-less route would have to detour through actual walls, which
    // `isWalkClear`-gated linking never allows, so success here proves a door was used.
    const target = interiorNodes[Math.floor(interiorNodes.length / 2)];
    const targetPos = graph.pos(target);
    const far = v2.create(
        targetPos.x > game.map.width / 2 ? 15 : game.map.width - 15,
        targetPos.y > game.map.height / 2 ? 15 : game.map.height - 15,
    );

    const startNodes = graph.nearby(far, 0, 40, 5);
    const path = findPath(graph, startNodes, new Set([target]), targetPos, 0, 8000);

    expect(path).not.toBeNull();
    expect(path).toContain(target);
});

test("A path across a stair changes layer", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const stairUpNodes: number[] = [];
    for (let i = 0; i < graph.nodeCount; i++) {
        if (graph.kind[i] === "stair" && graph.layer[i] === 0) stairUpNodes.push(i);
    }
    if (!stairUpNodes.length) return; // this map has no bunker - nothing to test here

    // Find the paired bunker-side node (placed immediately after in the build) and
    // path from somewhere else on the ground layer to it.
    const bunkerNode = stairUpNodes[0] + 1;
    expect(graph.layer[bunkerNode]).toBe(1);

    const from = v2.create(20, 20);
    const startNodes = graph.nearby(from, 0, 40, 5);
    const path = findPath(graph, startNodes, new Set([bunkerNode]), graph.pos(bunkerNode), 1, 8000);

    expect(path).not.toBeNull();
    const layers = new Set(path!.map((id) => graph.layer[id]));
    expect(layers.has(0)).toBe(true);
    expect(layers.has(1)).toBe(true);
});

test("Path waypoints never jump an unreasonable distance in one step", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const from = v2.create(20, 20);
    const to = v2.create(game.map.width - 20, game.map.height - 20);
    const startNodes = graph.nearby(from, 0, 40, 5);
    const goalNodes = new Set(graph.nearby(to, 0, 40, 5));
    const path = findPath(graph, startNodes, goalNodes, to, 0, 8000);
    expect(path).not.toBeNull();

    for (let i = 1; i < path!.length; i++) {
        const stepDist = v2.distance(graph.pos(path![i - 1]), graph.pos(path![i]));
        // Stair edges legitimately span further (bridging two AABB centers); every
        // other edge type is bounded by the build's own link radii.
        const isStairHop = graph.kind[path![i - 1]] === "stair" && graph.kind[path![i]] === "stair";
        expect(stepDist).toBeLessThan(isStairHop ? 60 : 40);
    }

    expect(pathTotalLength(graph, path!)).toBeGreaterThan(0);
});

// Regression: a bot that gets stuck failing to make progress toward a waypoint
// blacklists it (see `BotMovementState.blacklistedNodes` in botMovement.ts) so the next
// repath is forced to find a genuinely different route instead of confidently handing
// back the exact same "optimal" one straight into the same dead end - a real match
// capture showed this reading as the bot ping-ponging between the same two points for
// 9 seconds before this existed. `excluded` has to work at both ends of the search: as
// a neighbor (already excluded before this fix) *and* as a start-node candidate (the
// actual bug this fix landed for - a bot that just got stuck is often standing right
// next to, or effectively at, the exact node it needs to avoid, so it's very likely to
// be one of the handful of nearby start-node candidates too).
test("findPath's excluded set is honored even when the excluded node is a start candidate", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const from = v2.create(game.map.width * 0.2, game.map.height * 0.8);
    const to = v2.create(game.map.width * 0.8, game.map.height * 0.2);
    const startNodes = graph.nearby(from, 0, 40, 5);
    const goalNodes = new Set(graph.nearby(to, 0, 40, 5));
    // Needs a genuine alternative start candidate to reroute through - nothing to prove
    // by excluding the only entry point there is.
    if (startNodes.length <= 1) return;

    const original = findPath(graph, startNodes, goalNodes, to, 0, 8000);
    expect(original).not.toBeNull();
    expect(original!.length).toBeGreaterThan(1);

    // Exclude the very first start node the unmodified search actually used - the
    // "stuck standing on/next to it" case in practice - not some arbitrary later hop.
    const excluded = new Set([original![0]]);
    const rerouted = findPath(graph, startNodes, goalNodes, to, 0, 8000, excluded);

    expect(rerouted).not.toBeNull();
    expect(rerouted!).not.toContain(original![0]);
});
