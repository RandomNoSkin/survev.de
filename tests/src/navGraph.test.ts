import { expect, test } from "vitest";
import { buildNavGraph, DEFAULT_MAX_NODES } from "../../server/src/game/bot/nav/navBuilder.ts";
import { isWalkClear } from "../../server/src/game/bot/nav/navGeom.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import { util } from "../../shared/utils/util.ts";
import { createGame } from "./gameTestHelpers.ts";

test("Nav graph builds on the arena map within a sane node/edge budget", () => {
    const game = createGame(TeamMode.Solo, "local");
    const start = performance.now();
    const graph = buildNavGraph(game);
    const buildMs = performance.now() - start;

    const stats = graph.stats();
    expect(stats.nodeCount).toBeGreaterThan(200);
    expect(stats.nodeCount).toBeLessThan(4000);
    expect(stats.edgeCount).toBeGreaterThan(stats.nodeCount); // more than a bare tree
    expect(buildMs).toBeLessThan(2000); // generous CI headroom over the ~150ms target
});

test("Nav graph includes every sampled node kind on a map with buildings and a bunker", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const kinds = new Set(graph.kind);
    expect(kinds.has("open")).toBe(true);
    expect(kinds.has("hull")).toBe(true);
    // "local"'s procedural gen occasionally rolls a building set with zero doors or
    // zero stairs entirely (verified empirically) - these two just confirm sampling
    // fires when the map actually has one, rather than assuming it always does.
    if (game.map.obstacles.some((o) => o.isDoor)) {
        expect(kinds.has("door")).toBe(true);
    }
    if (game.map.structures.some((s) => s.stairs.some((st) => !st.lootOnly))) {
        expect(kinds.has("stair")).toBe(true);
    }
});

test("Nav graph respects a lowered node cap instead of growing unbounded", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game, 50);

    expect(graph.nodeCount).toBeLessThanOrEqual(50);
    expect(DEFAULT_MAX_NODES).toBeGreaterThan(50); // sanity: the real default is much higher
});

test("No edge crosses a real (non-door) collidable obstacle", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    // Sample a broad spread of edges rather than every one, to keep this fast.
    let sampled = 0;
    let violations = 0;
    for (let i = 0; i < graph.nodeCount && sampled < 300; i += 3) {
        const from = graph.pos(i);
        const fromLayer = graph.layer[i];
        for (const j of graph.neighbors[i]) {
            if (j < i) continue; // undirected - check each pair once
            if (graph.kind[i] === "door" && graph.kind[j] === "door") continue; // force-linked through the doorway itself
            if (graph.kind[i] === "stair" && graph.kind[j] === "stair") continue; // force-linked across layers
            if (!isWalkClear(graph.navObstacles, from, graph.pos(j), fromLayer)) violations++;
            sampled++;
            if (sampled >= 300) break;
        }
    }
    expect(sampled).toBeGreaterThan(0); // make sure the loop actually exercised something
    // The connectivity safety net (`mergeDisconnectedComponents`) deliberately allows
    // an occasional wall-crossing bridge edge rather than leave a whole area of the
    // map unreachable - see its doc comment. That's at most a handful of edges out of
    // several thousand; anything beyond a small tolerance means the *normal*
    // isWalkClear-gated linking (step 7) is actually broken, not just topping up a
    // rare gap.
    expect(violations).toBeLessThanOrEqual(5);
});

test("Door nodes sit on opposite sides of the door and are force-linked", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const doorNodes: number[] = [];
    for (let i = 0; i < graph.nodeCount; i++) {
        if (graph.kind[i] === "door") doorNodes.push(i);
    }
    if (!doorNodes.length) return; // this random layout rolled zero doors - nothing to check
    expect(doorNodes.length % 2).toBe(0); // always placed in pairs

    // Every door node's paired partner (placed immediately after it in the build) must
    // be directly linked to it.
    for (let i = 0; i < doorNodes.length; i += 2) {
        const a = doorNodes[i];
        const b = doorNodes[i + 1];
        expect(graph.hasEdge(a, b)).toBe(true);
    }
});

test("Stair nodes bridge ground and bunker layers", () => {
    const game = createGame(TeamMode.Solo, "local");
    const graph = buildNavGraph(game);

    const stairNodes: number[] = [];
    for (let i = 0; i < graph.nodeCount; i++) {
        if (graph.kind[i] === "stair") stairNodes.push(i);
    }
    if (!stairNodes.length) return; // covered by the "includes every kind" test above

    for (let i = 0; i < stairNodes.length; i += 2) {
        const up = stairNodes[i];
        const down = stairNodes[i + 1];
        // util.sameLayer can return a non-boolean falsy/truthy number (see its own
        // `a & 0x2 && b & 0x2` short-circuit) - check truthiness, not strict identity.
        expect(util.sameLayer(graph.layer[up], graph.layer[down])).toBeFalsy();
        expect(graph.hasEdge(up, down)).toBe(true);
    }
});
