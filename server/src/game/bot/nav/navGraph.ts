import { v2, type Vec2 } from "../../../../../shared/utils/v2.ts";
import type { Obstacle } from "../../objects/obstacle.ts";

export type NavKind = "open" | "hull" | "interior" | "door" | "stair";

/**
 * Simple adjacency-list graph: each node keeps its own neighbor/cost arrays. Arena
 * maps top out around ~2,000 nodes (see `navBuilder.ts`), so this is plenty fast for a
 * one-shot build and per-bot A* at that scale - no need for the CSR/typed-array
 * compaction a BR-scale graph (tens of thousands of nodes) would want. That's an M5
 * concern when the graph actually gets big enough to matter; revisit then rather than
 * pay the complexity now for a size class this never hits.
 */
export class NavGraph {
    readonly posX: number[] = [];
    readonly posY: number[] = [];
    readonly layer: number[] = [];
    readonly kind: NavKind[] = [];
    readonly neighbors: number[][] = [];
    readonly costs: number[][] = [];

    /** Obstacle list used to build this graph (doors excluded per `navGeom`), reused at
     *  runtime for string-pulling / "can I go direct" checks so nothing has to refilter
     *  the map's full obstacle list on every bot's every tick. */
    readonly navObstacles: Obstacle[];

    constructor(navObstacles: Obstacle[]) {
        this.navObstacles = navObstacles;
    }

    get nodeCount(): number {
        return this.posX.length;
    }

    addNode(pos: Vec2, layer: number, kind: NavKind): number {
        const id = this.posX.length;
        this.posX.push(pos.x);
        this.posY.push(pos.y);
        this.layer.push(layer);
        this.kind.push(kind);
        this.neighbors.push([]);
        this.costs.push([]);
        return id;
    }

    pos(id: number): Vec2 {
        return v2.create(this.posX[id], this.posY[id]);
    }

    hasEdge(a: number, b: number): boolean {
        return this.neighbors[a].includes(b);
    }

    /** Adds an edge in both directions, skipping it if already present. */
    link(a: number, b: number, cost: number): void {
        if (a === b || this.hasEdge(a, b)) return;
        this.neighbors[a].push(b);
        this.costs[a].push(cost);
        this.neighbors[b].push(a);
        this.costs[b].push(cost);
    }

    /** Every node on `layer` within `maxDist` of `pos`, nearest first, capped at
     *  `maxCount`. Brute-force distance scan - see the class doc comment on why that's
     *  fine at this node-count scale. */
    nearby(pos: Vec2, layer: number, maxDist: number, maxCount: number): number[] {
        const maxDistSqr = maxDist * maxDist;
        const found: { id: number; distSqr: number }[] = [];
        for (let i = 0; i < this.posX.length; i++) {
            if (this.layer[i] !== layer) continue;
            const dx = this.posX[i] - pos.x;
            const dy = this.posY[i] - pos.y;
            const distSqr = dx * dx + dy * dy;
            if (distSqr <= maxDistSqr) found.push({ id: i, distSqr });
        }
        found.sort((a, b) => a.distSqr - b.distSqr);
        return found.slice(0, maxCount).map((f) => f.id);
    }

    /** Nearest node to `pos` on `layer`, or -1 if the graph has none there. */
    nearest(pos: Vec2, layer: number): number {
        let best = -1;
        let bestDistSqr = Infinity;
        for (let i = 0; i < this.posX.length; i++) {
            if (this.layer[i] !== layer) continue;
            const dx = this.posX[i] - pos.x;
            const dy = this.posY[i] - pos.y;
            const distSqr = dx * dx + dy * dy;
            if (distSqr < bestDistSqr) {
                bestDistSqr = distSqr;
                best = i;
            }
        }
        return best;
    }

    stats(): { nodeCount: number; edgeCount: number } {
        let edgeCount = 0;
        for (const n of this.neighbors) edgeCount += n.length;
        return { nodeCount: this.nodeCount, edgeCount: edgeCount / 2 };
    }
}
