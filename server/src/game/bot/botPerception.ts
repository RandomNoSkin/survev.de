import type { ExplosionDef } from "../../../../shared/defs/gameObjects/explosionsDefs";
import type { ThrowableDef } from "../../../../shared/defs/gameObjects/throwableDefs";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import { GameConfig } from "../../../../shared/gameConfig.ts";
import { ObjectType } from "../../../../shared/net/objectSerializeFns.ts";
import { collider } from "../../../../shared/utils/collider.ts";
import { collisionHelpers } from "../../../../shared/utils/collisionHelpers.ts";
import { util } from "../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { Game } from "../game.ts";
import type { Obstacle } from "../objects/obstacle.ts";
import type { Player } from "../objects/player.ts";

/** Nearest N candidates get an actual line-of-sight raycast per think. Bounds the
 *  per-bot perception cost regardless of how many enemies are nearby. */
const MAX_LOS_CHECKS = 4;

/** A live grenade landing within this many units is worth actually reacting to - past
 *  the real blast radius of a frag (rad.max 12 in `explosionsDefs.ts`) with margin, not
 *  a tight "only dodge if it would definitely hit" cutoff. */
const GRENADE_DANGER_RADIUS = 16;

/** Position of the nearest live, explosive-armed throwable within `GRENADE_DANGER_RADIUS`,
 *  or undefined if there's nothing worth reacting to. Deliberately not fuse-timer aware -
 *  a bot second-guessing "do I have another second before this goes off" is exactly the
 *  kind of precise math a real player doesn't do either; anyone can see a grenade land
 *  near them and back off without knowing its exact fuse time. Not thrower-aware either:
 *  a grenade doesn't care who threw it, and a bot standing in its own toss's blast
 *  radius is just as dead as standing in an enemy's. */
export function findGrenadeThreat(bot: Player): Vec2 | undefined {
    const game = bot.game;
    let closest: Vec2 | undefined;
    let closestDistSqr = GRENADE_DANGER_RADIUS * GRENADE_DANGER_RADIUS;

    for (const proj of game.projectileBarn.projectiles) {
        if (proj.dead || !util.sameLayer(proj.layer, bot.layer)) continue;
        const def = GameObjectDefs.typeToDefSafe(proj.type) as ThrowableDef | undefined;
        if (!def || def.type !== "throwable" || !def.explosionType) continue;
        // Smoke's `explosionType` ("explosion_smoke") is truthy but deals 0 damage - a
        // real player doesn't dive away from a smoke grenade, so this shouldn't either.
        const explosionDef = GameObjectDefs.typeToDefSafe(def.explosionType) as
            | ExplosionDef
            | undefined;
        if (!explosionDef || explosionDef.damage <= 0) continue;

        const distSqr = v2.lengthSqr(v2.sub(proj.pos, bot.pos));
        if (distSqr < closestDistSqr) {
            closest = proj.pos;
            closestDistSqr = distSqr;
        }
    }
    return closest;
}

/** Half-extents of the rectangle a bot can "see" within, centered on its own position.
 *  A real player's spotting range is bounded by their screen, not a radar circle - the
 *  server itself renders that screen as a 16:9-aspect rectangle for exactly this reason
 *  (`Player.updateVisibleObjects`'s visibility culling: "client zoom tries to keep a
 *  16/9 aspect ratio, mirror it here"). That culling rectangle's own real half-width is
 *  only `zoom + 4` - just ~32 units unscoped - which would be the most accurate number
 *  to use, but bots never manage scopes (no `botLoot` yet - see the M8 plan), so tying
 *  vision strictly to an always-1x-scope player's real screen size would leave them
 *  unable to ever see far enough to use a long-range weapon's own sweet spot at all,
 *  not just correctly-shaped. This still floors/caps the magnitude rather than using the
 *  real culling size directly, but *much* lower than before - real feedback was that
 *  bots noticeably out-spotted an actual player at the old floor (90, which dominated
 *  regardless of scope entirely - even a maxed-out 15x scope's `zoom * 0.35` never beat
 *  it, so scope never actually mattered before either). */
function viewHalfExtentsFor(bot: Player): Vec2 {
    const halfWidth = Math.min(90, Math.max(45, bot.zoom * 0.9));
    return v2.create(halfWidth, halfWidth / (16 / 9));
}

/**
 * Line-of-sight check using the exact same primitive bullets use
 * (`collisionHelpers.intersectSegment`, with the bullet height), so "the bot can see
 * it" and "the bot can hit it" never disagree.
 */
export function hasLineOfSight(game: Game, from: Vec2, to: Vec2, layer: number): boolean {
    const dist = v2.distance(from, to);
    if (dist < 0.01) return true;

    const min = v2.create(Math.min(from.x, to.x) - 1, Math.min(from.y, to.y) - 1);
    const max = v2.create(Math.max(from.x, to.x) + 1, Math.max(from.y, to.y) + 1);
    const objs = game.grid.intersectCollider(collider.createAabb(min, max));

    const obstacles: Obstacle[] = [];
    for (let i = 0; i < objs.length; i++) {
        if (objs[i].__type === ObjectType.Obstacle) obstacles.push(objs[i] as Obstacle);
    }

    const dir = v2.mul(v2.sub(to, from), 1 / dist);
    const hit = collisionHelpers.intersectSegment(
        obstacles,
        from,
        dir,
        dist,
        GameConfig.bullet.height,
        layer,
        false,
    );
    return hit === null;
}

/** Candidate enemies to consider this think. Small games (arena/practice - the whole
 *  point of this branch) just scan every living player; only a crowded BR lobby pays
 *  for a spatial query, mirroring the heuristic GameModeManager already uses. */
function candidateEnemies(bot: Player, range: number): Player[] {
    const game = bot.game;
    if (game.playerBarn.livingPlayers.length <= 16) {
        return game.playerBarn.livingPlayers;
    }
    const objs = game.grid.intersectCollider(collider.createCircle(bot.pos, range));
    const players: Player[] = [];
    for (let i = 0; i < objs.length; i++) {
        if (objs[i].__type === ObjectType.Player) players.push(objs[i] as Player);
    }
    return players;
}

/** Nearest living enemy the bot can currently see, or undefined. */
export function findVisibleTarget(bot: Player): Player | undefined {
    const game = bot.game;
    const half = viewHalfExtentsFor(bot);
    // Coarse pre-filter radius for the spatial query below - the rectangle's own
    // half-diagonal, so no candidate the rectangle could actually contain gets missed.
    const queryRadius = Math.sqrt(half.x * half.x + half.y * half.y);

    const ranked: { player: Player; distSqr: number }[] = [];
    for (const other of candidateEnemies(bot, queryRadius)) {
        if (other === bot || other.dead || other.spectator) continue;
        if (other.teamId === bot.teamId) continue;
        if (!util.sameLayer(bot.layer, other.layer)) continue;

        // Rectangle, not radar circle - a real screen isn't round. Axis-aligned since
        // the camera itself never rotates with aim/facing direction in this game.
        if (
            Math.abs(other.pos.x - bot.pos.x) > half.x
            || Math.abs(other.pos.y - bot.pos.y) > half.y
        ) {
            continue;
        }

        const distSqr = v2.lengthSqr(v2.sub(other.pos, bot.pos));
        ranked.push({ player: other, distSqr });
    }
    ranked.sort((a, b) => a.distSqr - b.distSqr);

    for (let i = 0; i < ranked.length && i < MAX_LOS_CHECKS; i++) {
        const candidate = ranked[i].player;
        if (hasLineOfSight(game, bot.pos, candidate.pos, bot.layer)) return candidate;
    }
    return undefined;
}
