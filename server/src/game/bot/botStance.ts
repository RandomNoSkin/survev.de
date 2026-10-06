import { collisionHelpers } from "../../../../shared/utils/collisionHelpers.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { NavGraph } from "./nav/navGraph.ts";

/** Rays cast around a spot to see how much of its surroundings are solid cover. */
const STANCE_RAYS = 16;
/** How far each ray reaches: a hit closer than this counts as cover from that direction. */
export const STANCE_REACH = 8;
/** How far from where the bot stands it looks for a better spot. */
const STANCE_SEARCH_RAD = 20;
/** Bonus for having cover on the line to a known enemy - see `pickStanceFacing`. */
const FACING_COVER_BONUS = 0.5;
/** Directions around the spot where an enemy would stand to shoot at it. */
const ENEMY_RING_DIRS = 8;
/** How far out that ring is: where a shooter would stand, roughly a close-to-mid range fight. */
const ENEMY_RING_DIST = 6;
/** How much the cover an enemy would have around each of those spots counts against a stance. */
const ENEMY_COVER_WEIGHT = 0.5;
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

/** Average cover an enemy standing in a ring around `pos` would have, in every direction. Low means
 *  whichever way the fight comes from, the enemy has nothing to hide behind. */
export function enemyCoverAround(nav: NavGraph, pos: Vec2, layer: number): number {
    let total = 0;
    for (let i = 0; i < ENEMY_RING_DIRS; i++) {
        const angle = (i / ENEMY_RING_DIRS) * Math.PI * 2;
        const shooter = v2.add(pos, v2.mul(v2.create(Math.cos(angle), Math.sin(angle)), ENEMY_RING_DIST));
        total += coverFraction(nav, shooter, layer);
    }
    return total / ENEMY_RING_DIRS;
}

/** How good a spot is to hold: the cover the bot itself gets, minus the cover an enemy would get
 *  around it. */
export function stanceScore(nav: NavGraph, pos: Vec2, layer: number): number {
    return coverFraction(nav, pos, layer) - ENEMY_COVER_WEIGHT * enemyCoverAround(nav, pos, layer);
}

/** Cover standing between `pos` and a known enemy: 1 if a solid obstacle sits on the line to them. */
export function coverTowards(nav: NavGraph, pos: Vec2, enemy: Vec2, layer: number): number {
    const dist = v2.distance(pos, enemy);
    if (dist < 0.01) return 0;
    const dir = v2.mul(v2.sub(enemy, pos), 1 / dist);
    const hit = collisionHelpers.intersectSegmentDist(nav.navObstacles, pos, dir, dist, 0, layer, false);
    return hit < dist - 0.05 ? 1 : 0;
}

/** Like `pickStance`, but with a known enemy position: a spot with cover standing between it and
 *  the bot is worth a bonus, so the bot holds facing its enemy rather than just anywhere sheltered. */
export function pickStanceFacing(nav: NavGraph, from: Vec2, layer: number, enemy: Vec2): Vec2 {
    let best = from;
    let bestScore = stanceScore(nav, from, layer) + FACING_COVER_BONUS * coverTowards(nav, from, enemy, layer);
    for (const id of nav.nearby(from, layer, STANCE_SEARCH_RAD, 64)) {
        const pos = nav.pos(id);
        const interior = nav.kind[id] === "interior" ? INTERIOR_PENALTY : 0;
        const score = stanceScore(nav, pos, layer)
            + FACING_COVER_BONUS * coverTowards(nav, pos, enemy, layer)
            - interior
            - DISTANCE_PENALTY_PER_UNIT * v2.distance(from, pos);
        if (score > bestScore) {
            bestScore = score;
            best = pos;
        }
    }
    return best;
}

/** The best spot within `STANCE_SEARCH_RAD` of `from` to hold: the best `stanceScore`, a small
 *  penalty for walking there and for a building interior. Returns `from` itself when nothing
 *  nearby is any better. */
export function pickStance(nav: NavGraph, from: Vec2, layer: number): Vec2 {
    let best = from;
    let bestScore = stanceScore(nav, from, layer);
    for (const id of nav.nearby(from, layer, STANCE_SEARCH_RAD, 64)) {
        const pos = nav.pos(id);
        const interior = nav.kind[id] === "interior" ? INTERIOR_PENALTY : 0;
        const score = stanceScore(nav, pos, layer)
            - interior
            - DISTANCE_PENALTY_PER_UNIT * v2.distance(from, pos);
        if (score > bestScore) {
            bestScore = score;
            best = pos;
        }
    }
    return best;
}
