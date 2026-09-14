import { collider } from "../../../../../shared/utils/collider.ts";
import { util } from "../../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../../shared/utils/v2.ts";
import type { Game } from "../../game.ts";
import { buildingContainsPoint, buildNavObstacleList, isWalkClear, pointClear } from "./navGeom.ts";
import { NavGraph } from "./navGraph.ts";

const OPEN_GRID_STEP = 10;
const INTERIOR_GRID_STEP = 8;
const HULL_RING_SPACING = 8;
const HULL_PAD = 3;
const DOOR_PLACEMENT_DIST = 2.6;

const LINK_RADIUS = 15;
const DOOR_LINK_RADIUS = 22;
const STAIR_LINK_RADIUS = 34;
const MAX_LINKS_PER_NODE = 8;

/** Hard ceiling on graph size - the build stops adding new nodes once hit, so a
 *  pathological map degrades gracefully (a smaller, still-usable graph) instead of
 *  consuming unbounded memory. Arena maps land in the hundreds; this only bites on
 *  BR-scale content (M5's problem, not this milestone's). Overridable for tests. */
export const DEFAULT_MAX_NODES = 20_000;

/**
 * Builds a `NavGraph` for `game`'s current map, once. Not incremental (see the BR-scale
 * note on `NavGraph`) - this targets the small arena maps this milestone is scoped to;
 * an incremental version for BR map sizes is M5 work.
 *
 * Samples, in order: an open-field lattice, rings around freestanding obstacles,
 * building hull perimeters, building interiors, door node pairs, and stair node pairs
 * bridging ground/bunker layers - then links everything within radius via
 * `isWalkClear`, so an edge never crosses a real (non-door) obstacle.
 */
export function buildNavGraph(game: Game, maxNodes = DEFAULT_MAX_NODES): NavGraph {
    const navObstacles = buildNavObstacleList(game.map.obstacles);
    const graph = new NavGraph(navObstacles);

    const inset = game.map.shoreInset + 4;
    const minX = inset;
    const minY = inset;
    const maxX = game.map.width - inset;
    const maxY = game.map.height - inset;

    const full = () => graph.nodeCount >= maxNodes;

    // --- 1. Open-field lattice --------------------------------------------------
    for (let y = minY; y <= maxY && !full(); y += OPEN_GRID_STEP) {
        for (let x = minX; x <= maxX && !full(); x += OPEN_GRID_STEP) {
            const pos = v2.create(x, y);
            if (pointClear(game, navObstacles, pos, 0)) {
                graph.addNode(pos, 0, "open");
            }
        }
    }

    // --- 2. Rings around freestanding obstacles (trees, rocks, crates - anything
    //        not already part of a building, which gets its own hull treatment) ----
    for (const o of game.map.obstacles) {
        if (full()) break;
        if (o.dead || !o.collidable || o.isDoor || o.isWindow || o.parentBuilding) continue;
        const aabb = collider.toAabb(o.collider);
        const w = aabb.max.x - aabb.min.x;
        const h = aabb.max.y - aabb.min.y;
        if (Math.max(w, h) < 2.5) continue; // too small to need a dedicated ring
        const cx = (aabb.min.x + aabb.max.x) / 2;
        const cy = (aabb.min.y + aabb.max.y) / 2;
        const rx = w / 2 + 1.6;
        const ry = h / 2 + 1.6;
        const count = Math.max(w, h) > 7 ? 8 : 4;
        for (let i = 0; i < count; i++) {
            const a = (i / count) * Math.PI * 2;
            const pos = v2.create(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
            if (pos.x < minX || pos.x > maxX || pos.y < minY || pos.y > maxY) continue;
            if (pointClear(game, navObstacles, pos, o.layer)) {
                graph.addNode(pos, util.toGroundLayer(o.layer), "open");
            }
        }
    }

    // --- 3. Building hulls + 4. interiors ---------------------------------------
    for (const b of game.map.buildings) {
        if (full()) break;
        const hull = buildingHullAabb(b);
        if (!hull) continue;
        const layer = util.toGroundLayer(b.layer);

        // Hull perimeter ring, padded outward.
        const hx0 = hull.min.x - HULL_PAD;
        const hy0 = hull.min.y - HULL_PAD;
        const hx1 = hull.max.x + HULL_PAD;
        const hy1 = hull.max.y + HULL_PAD;
        const perimeter = 2 * (hx1 - hx0 + (hy1 - hy0));
        const ringCount = Math.max(4, Math.round(perimeter / HULL_RING_SPACING));
        for (let i = 0; i < ringCount && !full(); i++) {
            const pos = pointOnRingAabb(i / ringCount, hx0, hy0, hx1, hy1);
            if (pos.x < minX || pos.x > maxX || pos.y < minY || pos.y > maxY) continue;
            if (pointClear(game, navObstacles, pos, layer)) {
                graph.addNode(pos, layer, "hull");
            }
        }

        // Interior lattice, kept only where it's actually inside this building's
        // floor and not blocked by furniture/walls.
        const w = hull.max.x - hull.min.x;
        const h = hull.max.y - hull.min.y;
        if (w < 6 || h < 6) continue; // too small to bother with an interior grid
        for (let y = hull.min.y + 2; y <= hull.max.y - 2 && !full(); y += INTERIOR_GRID_STEP) {
            for (let x = hull.min.x + 2; x <= hull.max.x - 2 && !full(); x += INTERIOR_GRID_STEP) {
                const pos = v2.create(x, y);
                if (!buildingContainsPoint(b, pos)) continue;
                if (pointClear(game, navObstacles, pos, layer)) {
                    graph.addNode(pos, layer, "interior");
                }
            }
        }
    }

    // --- 5. Door node pairs -------------------------------------------------------
    for (const o of game.map.obstacles) {
        if (full()) break;
        if (!o.isDoor) continue;
        const aabb = collider.toAabb(o.collider);
        const cx = (aabb.min.x + aabb.max.x) / 2;
        const cy = (aabb.min.y + aabb.max.y) / 2;
        const w = aabb.max.x - aabb.min.x;
        const h = aabb.max.y - aabb.min.y;
        // Normal to the door's plane: perpendicular to its long axis. A door is a
        // thin rectangle - wide-and-shallow faces along Y, tall-and-narrow along X.
        const normal = w > h ? v2.create(0, 1) : v2.create(1, 0);
        const layer = util.toGroundLayer(o.layer);
        const a = v2.create(cx + normal.x * DOOR_PLACEMENT_DIST, cy + normal.y * DOOR_PLACEMENT_DIST);
        const b = v2.create(cx - normal.x * DOOR_PLACEMENT_DIST, cy - normal.y * DOOR_PLACEMENT_DIST);
        if (a.x < minX || a.x > maxX || a.y < minY || a.y > maxY) continue;
        if (b.x < minX || b.x > maxX || b.y < minY || b.y > maxY) continue;
        const nodeA = graph.addNode(a, layer, "door");
        const nodeB = graph.addNode(b, layer, "door");
        // Force-linked regardless of `isWalkClear` (which would see the closed door
        // itself as a gap it can't judge) - the whole point of these two nodes is to
        // represent "through this doorway".
        graph.link(nodeA, nodeB, v2.distance(a, b));
    }

    // --- 6. Stair node pairs (ground <-> bunker) ----------------------------------
    for (const s of game.map.structures) {
        for (const stair of s.stairs) {
            if (full()) break;
            if (stair.lootOnly) continue;
            const upCenter = aabbCenter(stair.upAabb);
            const downCenter = aabbCenter(stair.downAabb);
            const upNode = graph.addNode(upCenter, 0, "stair");
            const downNode = graph.addNode(downCenter, 1, "stair");
            graph.link(upNode, downNode, v2.distance(upCenter, downCenter) + 2);
        }
    }

    // --- 7. Generic same-layer proximity linking ----------------------------------
    linkByProximity(graph, navObstacles);

    // --- 8. Connectivity safety net ------------------------------------------------
    // Step 7 links by proximity + line-of-sight, which can leave a whole cluster (not
    // just a single node) stranded as its own little island - a building whose hull
    // ring itself sampled poorly, an odd room shape, a stairwell alcove nothing else
    // reached. Rather than special-case doors/stairs, merge every disconnected
    // same-layer component into the main one: find the closest cross-component pair
    // and bridge them. A bot that ends up on a slightly-too-permissive bridge edge
    // recovers via stuck-detection/replanning; a permanently unreachable pocket of the
    // map has no recovery at all, which is the worse failure by far.
    mergeDisconnectedComponents(graph, navObstacles, 0);
    mergeDisconnectedComponents(graph, navObstacles, 1);

    return graph;
}

/** Assigns each node on `layer` a component id via BFS over same-layer edges only
 *  (a cross-layer stair link is irrelevant to whether this layer's own mesh is whole).
 *  Nodes not on `layer` get -1. */
function computeComponents(graph: NavGraph, layer: number): Int32Array {
    const comp = new Int32Array(graph.nodeCount).fill(-1);
    let next = 0;
    for (let i = 0; i < graph.nodeCount; i++) {
        if (graph.layer[i] !== layer || comp[i] !== -1) continue;
        const stack = [i];
        comp[i] = next;
        while (stack.length) {
            const cur = stack.pop()!;
            for (const n of graph.neighbors[cur]) {
                if (graph.layer[n] !== layer || comp[n] !== -1) continue;
                comp[n] = next;
                stack.push(n);
            }
        }
        next++;
    }
    return comp;
}

function mergeDisconnectedComponents(
    graph: NavGraph,
    navObstacles: ReturnType<typeof buildNavObstacleList>,
    layer: number,
): void {
    const comp = computeComponents(graph, layer);
    const nodesByComp = new Map<number, number[]>();
    for (let i = 0; i < graph.nodeCount; i++) {
        if (comp[i] < 0) continue;
        let list = nodesByComp.get(comp[i]);
        if (!list) nodesByComp.set(comp[i], list = []);
        list.push(i);
    }
    if (nodesByComp.size <= 1) return;

    let mainId = -1;
    let mainSize = -1;
    for (const [id, nodes] of nodesByComp) {
        if (nodes.length > mainSize) {
            mainSize = nodes.length;
            mainId = id;
        }
    }
    const mainNodes = nodesByComp.get(mainId)!;

    // Every stray component only needs to reach the main one, not each other - so this
    // bridges each in a single pass against the original main-component node list
    // rather than recomputing components after every merge. The nearest pair is found
    // by distance alone (cheap: no `isWalkClear`); only that single best candidate
    // pays for an actual line-of-sight check, which is what keeps this fast even
    // though it's an O(strayCompSize x mainCompSize) scan per stray component.
    const CANDIDATE_COUNT = 5;
    for (const [id, nodes] of nodesByComp) {
        if (id === mainId) continue;

        // Cheapest possible pass first: pure distance, no `isWalkClear`, to shortlist
        // the nearest handful of cross-component pairs out of what can be a
        // strayCompSize x mainCompSize product.
        const shortlist: { a: number; b: number; distSqr: number }[] = [];
        for (const a of nodes) {
            for (const b of mainNodes) {
                const dx = graph.posX[a] - graph.posX[b];
                const dy = graph.posY[a] - graph.posY[b];
                const distSqr = dx * dx + dy * dy;
                if (shortlist.length < CANDIDATE_COUNT) {
                    shortlist.push({ a, b, distSqr });
                    shortlist.sort((x, y) => x.distSqr - y.distSqr);
                } else if (distSqr < shortlist[CANDIDATE_COUNT - 1].distSqr) {
                    shortlist[CANDIDATE_COUNT - 1] = { a, b, distSqr };
                    shortlist.sort((x, y) => x.distSqr - y.distSqr);
                }
            }
        }
        if (!shortlist.length) continue;

        // Only the shortlist pays for an actual `isWalkClear` line-of-sight check -
        // prefer the nearest one that's clear, and only bridge with a wall-crossing
        // edge as an absolute last resort (an unreachable pocket of the map is worse).
        const clear = shortlist.find((c) => isWalkClear(navObstacles, graph.pos(c.a), graph.pos(c.b), layer));
        const pick = clear ?? shortlist[0];
        graph.link(pick.a, pick.b, Math.sqrt(pick.distSqr));
    }
}

function aabbCenter(aabb: { min: Vec2; max: Vec2 }): Vec2 {
    return v2.create((aabb.min.x + aabb.max.x) / 2, (aabb.min.y + aabb.max.y) / 2);
}

/** `t` in [0,1) around the AABB's perimeter, starting at the top-left corner. */
function pointOnRingAabb(t: number, x0: number, y0: number, x1: number, y1: number): Vec2 {
    const w = x1 - x0;
    const h = y1 - y0;
    const perimeter = 2 * (w + h);
    let d = t * perimeter;
    if (d <= w) return v2.create(x0 + d, y0);
    d -= w;
    if (d <= h) return v2.create(x1, y0 + d);
    d -= h;
    if (d <= w) return v2.create(x1 - d, y1);
    d -= w;
    return v2.create(x0, y1 - d);
}

/** World-space building footprint, preferring the real zoom-in trigger region(s) (the
 *  closest thing to an actual interior boundary) and falling back to the building's
 *  local-space `bounds` translated to world space. */
function buildingHullAabb(b: {
    pos: Vec2;
    bounds: { min: Vec2; max: Vec2 };
    zoomRegions: Array<{ zoomIn?: { min: Vec2; max: Vec2 } }>;
}): { min: Vec2; max: Vec2 } | undefined {
    let min: Vec2 | undefined;
    let max: Vec2 | undefined;
    for (const region of b.zoomRegions) {
        if (!region.zoomIn) continue;
        min = min
            ? v2.create(Math.min(min.x, region.zoomIn.min.x), Math.min(min.y, region.zoomIn.min.y))
            : v2.copy(region.zoomIn.min);
        max = max
            ? v2.create(Math.max(max.x, region.zoomIn.max.x), Math.max(max.y, region.zoomIn.max.y))
            : v2.copy(region.zoomIn.max);
    }
    if (min && max) return { min, max };

    const bw = b.bounds.max.x - b.bounds.min.x;
    const bh = b.bounds.max.y - b.bounds.min.y;
    if (bw < 0.01 || bh < 0.01) return undefined;
    return {
        min: v2.add(b.pos, b.bounds.min),
        max: v2.add(b.pos, b.bounds.max),
    };
}

function linkByProximity(graph: NavGraph, navObstacles: ReturnType<typeof buildNavObstacleList>): void {
    for (let i = 0; i < graph.nodeCount; i++) {
        const kind = graph.kind[i];
        const radius = kind === "stair" ? STAIR_LINK_RADIUS : kind === "door" ? DOOR_LINK_RADIUS : LINK_RADIUS;
        const pos = graph.pos(i);
        const candidates = graph.nearby(pos, graph.layer[i], radius, MAX_LINKS_PER_NODE + 1);
        let added = 0;
        for (const j of candidates) {
            if (j === i || added >= MAX_LINKS_PER_NODE) continue;
            if (graph.hasEdge(i, j)) continue;
            const jPos = graph.pos(j);
            if (!isWalkClear(navObstacles, pos, jPos, graph.layer[i])) continue;
            graph.link(i, j, v2.distance(pos, jPos));
            added++;
        }
    }
}
