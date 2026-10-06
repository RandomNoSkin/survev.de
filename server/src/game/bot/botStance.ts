import { collisionHelpers } from "../../../../shared/utils/collisionHelpers.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { NavGraph } from "./nav/navGraph.ts";

/** Rays cast around a spot to see how much of its surroundings are solid cover. */
const STANCE_RAYS = 16;
/** How far each ray reaches: a hit closer than this counts as cover from that direction. */
export const STANCE_REACH = 8;
/** How far from where the bot stands it looks for a better spot. */
const STANCE_SEARCH_RAD = 20;
/** A spot inside a building's interior is a trap if things go wrong, so it scores lower. */
const INTERIOR_PENALTY = 0.25;
/** Each unit of walking to a spot costs this much, so the bot doesn't wander across the map for a
 *  marginally better corner. */
const DISTANCE_PENALTY_PER_UNIT = 0.01;

/** Fraction of directions around `pos` blocked by solid cover within `STANCE_REACH`. A spot with a
 *  wall on every side scores 1, an open field 0. */
export function coverFraction(nav: NavGraph, pos: Vec2, layer: number): number {
    let blocked = 0;
    for (let i = 0; i < STANCE_RAYS; i++) {
        const angle = (i / STANCE_RAYS) * Math.PI * 2;
        const dir = v2.create(Math.cos(angle), Math.sin(angle));
        const hit = collisionHelpers.intersectSegmentDist(
            nav.navObstacles,
            pos,
            dir,
            STANCE_REACH,
            0,
            layer,
            false,
        );
        if (hit < STANCE_REACH - 0.05) blocked++;
    }
    return blocked / STANCE_RAYS;
}

/** The best spot within `STANCE_SEARCH_RAD` of `from` to hold: the most cover around it, a
 *  small penalty for walking there and for a building interior. Returns `from` itself when
 *  nothing nearby is any better. */
export function pickStance(nav: NavGraph, from: Vec2, layer: number): Vec2 {
    let best = from;
    let bestScore = coverFraction(nav, from, layer);
    for (const id of nav.nearby(from, layer, STANCE_SEARCH_RAD, 64)) {
        const pos = nav.pos(id);
        const interior = nav.kind[id] === "interior" ? INTERIOR_PENALTY : 0;
        const score = coverFraction(nav, pos, layer)
            - interior
            - DISTANCE_PENALTY_PER_UNIT * v2.distance(from, pos);
        if (score > bestScore) {
            bestScore = score;
            best = pos;
        }
    }
    return best;
}
