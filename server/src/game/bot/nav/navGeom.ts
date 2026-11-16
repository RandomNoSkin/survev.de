import type { Collider } from "../../../../../shared/utils/coldet.ts";
import { coldet } from "../../../../../shared/utils/coldet.ts";
import { collider } from "../../../../../shared/utils/collider.ts";
import { collisionHelpers } from "../../../../../shared/utils/collisionHelpers.ts";
import { util } from "../../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../../shared/utils/v2.ts";
import type { Game } from "../../game.ts";
import type { Building } from "../../objects/building.ts";
import type { Obstacle } from "../../objects/obstacle.ts";

/**
 * Everything below treats an *unlocked* door as passable rather than solid - a bot can
 * open one (`obstacle.interact`), so the nav graph should route straight through a
 * doorway instead of walling it off like a real obstacle. A locked door has no way to
 * be opened, so it stays a hard blocker. `collisionHelpers.intersectSegment*` already
 * checks `dead`/`collidable`/layer/height itself on every call, so the only thing we
 * need to do ourselves is exclude the openable doors from the list we hand it.
 */
export function isOpenableDoor(o: Obstacle): boolean {
    return !!(o.isDoor && o.door && !o.door.locked);
}

export function buildNavObstacleList(allObstacles: Obstacle[]): Obstacle[] {
    return allObstacles.filter((o) => !isOpenableDoor(o));
}

/**
 * Whether a straight line from `from` to `to` is unobstructed on `layer`. `obstacles`
 * should be a list from `buildNavObstacleList` - built once per nav graph, not
 * refiltered on every call.
 */
export function isWalkClear(
    obstacles: Obstacle[],
    from: Vec2,
    to: Vec2,
    layer: number,
): boolean {
    const dist = v2.distance(from, to);
    if (dist < 0.01) return true;
    const dir = v2.mul(v2.sub(to, from), 1 / dist);
    const hitDist = collisionHelpers.intersectSegmentDist(
        obstacles,
        from,
        dir,
        dist,
        0, // height 0: any collidable obstacle counts as a physical blocker here,
        // matching the movement-collision use case rather than the bullet-height one.
        layer,
        false,
    );
    return hitDist >= dist - 0.05;
}

function pointInCollider(pos: Vec2, col: Collider): boolean {
    if (col.type === collider.Type.Circle) {
        return v2.lengthSqr(v2.sub(pos, col.pos)) <= col.rad * col.rad;
    }
    return pos.x >= col.min.x && pos.x <= col.max.x && pos.y >= col.min.y
        && pos.y <= col.max.y;
}

/** Whether `pos` sits on solid ground for `layer`: not overlapping any obstacle in
 *  `navObstacles` and, for the ground layer, not on water. Layer 1 (bunker interiors)
 *  has no water to check - `isOnWater` is a ground-layer concept. */
export function pointClear(
    game: Game,
    navObstacles: Obstacle[],
    pos: Vec2,
    layer: number,
    rad = 0.5,
): boolean {
    if (util.toGroundLayer(layer) === 0 && game.map.isOnWater(pos, layer)) return false;
    const probe = collider.createCircle(pos, rad);
    for (let i = 0; i < navObstacles.length; i++) {
        const o = navObstacles[i];
        if (o.dead || !o.collidable) continue;
        if (!util.sameLayer(o.layer, layer)) continue;
        if (coldet.test(probe, o.collider)) return false;
    }
    return true;
}

/** Whether `pos` is on this building's floor - used to decide which interior-grid
 *  candidates are actually "inside" during nav sampling. Prefers the real floor
 *  surfaces; falls back to the zoom-in trigger region (a reasonable indoor-footprint
 *  proxy) for the rare building with no surfaces defined. */
export function buildingContainsPoint(building: Building, pos: Vec2): boolean {
    for (const surface of building.surfaces) {
        for (const col of surface.colliders) {
            if (pointInCollider(pos, col)) return true;
        }
    }
    if (building.surfaces.length === 0) {
        for (const region of building.zoomRegions) {
            if (region.zoomIn && pointInCollider(pos, region.zoomIn)) return true;
        }
    }
    return false;
}
