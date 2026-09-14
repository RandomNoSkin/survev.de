import type { Vec2 } from "../../../../../shared/utils/v2.ts";
import type { NavGraph } from "./navGraph.ts";

/** Binary min-heap over parallel arrays - avoids allocating a heap-node object per
 *  push, which matters once a search visits a few thousand nodes. */
class MinHeap {
    private id: number[] = [];
    private f: number[] = [];

    get size(): number {
        return this.id.length;
    }

    push(nodeId: number, f: number): void {
        this.id.push(nodeId);
        this.f.push(f);
        this.siftUp(this.id.length - 1);
    }

    pop(): number {
        const top = this.id[0];
        const lastId = this.id.pop()!;
        const lastF = this.f.pop()!;
        if (this.id.length > 0) {
            this.id[0] = lastId;
            this.f[0] = lastF;
            this.siftDown(0);
        }
        return top;
    }

    private siftUp(i: number): void {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.f[parent] <= this.f[i]) break;
            this.swap(i, parent);
            i = parent;
        }
    }

    private siftDown(i: number): void {
        const n = this.id.length;
        for (;;) {
            const l = i * 2 + 1;
            const r = i * 2 + 2;
            let smallest = i;
            if (l < n && this.f[l] < this.f[smallest]) smallest = l;
            if (r < n && this.f[r] < this.f[smallest]) smallest = r;
            if (smallest === i) break;
            this.swap(i, smallest);
            i = smallest;
        }
    }

    private swap(a: number, b: number): void {
        [this.id[a], this.id[b]] = [this.id[b], this.id[a]];
        [this.f[a], this.f[b]] = [this.f[b], this.f[a]];
    }
}

/** Extra heuristic cost for a node on a different layer than the goal - biases the
 *  search toward using a stair edge to change layers rather than wandering same-layer
 *  nodes hoping to stumble onto one. */
const LAYER_MISMATCH_PENALTY = 15;

function heuristic(graph: NavGraph, a: number, goalPos: Vec2, goalLayer: number): number {
    const dx = graph.posX[a] - goalPos.x;
    const dy = graph.posY[a] - goalPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return graph.layer[a] === goalLayer ? dist : dist + LAYER_MISMATCH_PENALTY;
}

/**
 * A* from `startNodes` (tries each, since a bot's own position may sit near several
 * candidate entry nodes) to the nearest reachable node in `goalNodes`. Returns the path
 * as a list of node ids (start to goal inclusive), or `null` if no path was found
 * within `maxExpansions`.
 *
 * Allocates fresh scratch per call - fine at the arena-scale node counts this runs
 * against (see `NavGraph`'s doc comment); a BR-scale graph would want the expansion
 * cap and pre-allocated scratch arrays this skips for now.
 */
export function findPath(
    graph: NavGraph,
    startNodes: readonly number[],
    goalNodes: ReadonlySet<number>,
    goalPos: Vec2,
    goalLayer: number,
    maxExpansions: number,
): number[] | null {
    if (!startNodes.length || !goalNodes.size) return null;

    const gScore = new Map<number, number>();
    const cameFrom = new Map<number, number>();
    const visited = new Set<number>();
    const heap = new MinHeap();

    for (const s of startNodes) {
        if (gScore.has(s)) continue;
        gScore.set(s, 0);
        heap.push(s, heuristic(graph, s, goalPos, goalLayer));
    }

    let expansions = 0;
    while (heap.size > 0 && expansions < maxExpansions) {
        const cur = heap.pop();
        if (visited.has(cur)) continue;
        visited.add(cur);
        expansions++;

        if (goalNodes.has(cur)) return reconstruct(cameFrom, cur);

        const neighbors = graph.neighbors[cur];
        const costs = graph.costs[cur];
        const curG = gScore.get(cur)!;
        for (let i = 0; i < neighbors.length; i++) {
            const next = neighbors[i];
            if (visited.has(next)) continue;
            const tentativeG = curG + costs[i];
            if (tentativeG < (gScore.get(next) ?? Infinity)) {
                gScore.set(next, tentativeG);
                cameFrom.set(next, cur);
                heap.push(next, tentativeG + heuristic(graph, next, goalPos, goalLayer));
            }
        }
    }

    return null;
}

function reconstruct(cameFrom: Map<number, number>, goal: number): number[] {
    const path = [goal];
    let cur = goal;
    while (cameFrom.has(cur)) {
        cur = cameFrom.get(cur)!;
        path.push(cur);
    }
    path.reverse();
    return path;
}

/**
 * Numeric-keyed path cache, so repeated requests between roughly the same two points
 * (e.g. a bot re-evaluating its path to a barely-moved target every think tick) don't
 * all pay for a fresh search. Positions are quantized to `cellSize`-unit cells;
 * collisions between distinct point pairs are harmless - worst case a slightly stale
 * path, corrected on the next request once it expires or the bot notices it's stuck.
 */
export class NavPathCache {
    private entries = new Map<number, { path: number[] | null; expiresAtMs: number }>();

    constructor(
        private readonly maxEntries = 256,
        private readonly ttlMs = 5000,
        private readonly cellSize = 4,
    ) {}

    private key(fromX: number, fromY: number, toX: number, toY: number, layer: number): number {
        const q = (v: number) => Math.round(v / this.cellSize) & 0x3ff;
        return (
            (q(fromX) << 22) ^ (q(fromY) << 12) ^ (q(toX) << 2) ^ (layer & 0x3)
        ) >>> 0;
    }

    get(
        fromX: number,
        fromY: number,
        toX: number,
        toY: number,
        layer: number,
        nowMs: number,
    ): number[] | null | undefined {
        const entry = this.entries.get(this.key(fromX, fromY, toX, toY, layer));
        if (!entry || entry.expiresAtMs < nowMs) return undefined;
        return entry.path;
    }

    set(
        fromX: number,
        fromY: number,
        toX: number,
        toY: number,
        layer: number,
        path: number[] | null,
        nowMs: number,
    ): void {
        if (this.entries.size >= this.maxEntries) this.entries.clear();
        this.entries.set(this.key(fromX, fromY, toX, toY, layer), {
            path,
            expiresAtMs: nowMs + this.ttlMs,
        });
    }
}
