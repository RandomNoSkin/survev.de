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

/** How far a bot can "see" a player, in units. A human's effective spotting range is
 *  governed by scope zoom, so this loosely follows it - bots must not notice someone
 *  from further away than a human reasonably could. */
export function viewRangeFor(bot: Player): number {
    return Math.min(140, Math.max(90, bot.zoom * 0.35));
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
    const range = viewRangeFor(bot);
    const rangeSqr = range * range;

    const ranked: { player: Player; distSqr: number }[] = [];
    for (const other of candidateEnemies(bot, range)) {
        if (other === bot || other.dead || other.spectator) continue;
        if (other.teamId === bot.teamId) continue;
        if (!util.sameLayer(bot.layer, other.layer)) continue;

        const distSqr = v2.lengthSqr(v2.sub(other.pos, bot.pos));
        if (distSqr > rangeSqr) continue;

        ranked.push({ player: other, distSqr });
    }
    ranked.sort((a, b) => a.distSqr - b.distSqr);

    for (let i = 0; i < ranked.length && i < MAX_LOS_CHECKS; i++) {
        const candidate = ranked[i].player;
        if (hasLineOfSight(game, bot.pos, candidate.pos, bot.layer)) return candidate;
    }
    return undefined;
}
