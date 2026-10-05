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


/** A live grenade landing within this many units is worth actually reacting to - past
 *  the real blast radius of a frag (rad.max 12 in `explosionsDefs.ts`) with margin, not
 *  a tight "only dodge if it would definitely hit" cutoff. */
const GRENADE_DANGER_RADIUS = 16;

/** Only react once this little fuse time is left, not the instant a grenade is thrown -
 *  a real player keeps fighting/aiming right up until a live nade is genuinely about to
 *  go off, not the moment one is merely visible several seconds out. This also happens
 *  to settle *where* the bot reacts to: a thrown frag's own physics (`projectile.ts`)
 *  bleed off its velocity fast, so by the last second or so of a 4s fuse it has already
 *  landed and stopped sliding - reacting any earlier means chasing its still-arcing,
 *  every-tick-different in-flight position instead of a single settled spot, which is
 *  what actually read as the bot bolting to a "weird", constantly-shifting position. */
const GRENADE_REACT_TIME = 1.3;

/** How far a gunshot is loud enough to hear and roughly place, regardless of line of
 *  sight - a real player reacts to nearby gunfire they can't see the source of, not just
 *  what they can currently see. Well past typical engagement range, since sound carries
 *  further than sightlines do. */
const GUNSHOT_HEARING_RADIUS = 100;

/** The origin of the nearest hostile gunshot fired *this tick*, or undefined if nothing
 *  fired nearby. `game.bulletBarn.newBullets` holds exactly the bullets spawned this
 *  tick (cleared once flushed to clients), and `Bullet.startPos` is where it was fired
 *  from - not `pos`, which is the bullet's own current, travelling position. Deliberately
 *  not gated on layer or line of sight the way `findVisibleTarget`/`hasLineOfSight` are:
 *  a gunshot is heard, not seen, so it should still register through a wall or from a
 *  different floor, just like a real player's ears would catch it. This only ever
 *  produces a rough "something fired over there" position for movement/awareness - never
 *  a precise-enough fix to aim or fire at, which would be hearing through walls in a way
 *  no real player can. */
export function findGunshotHint(bot: Player): Vec2 | undefined {
    const game = bot.game;
    const mates = bot.group?.livingPlayers;
    let closest: Vec2 | undefined;
    let closestDistSqr = GUNSHOT_HEARING_RADIUS * GUNSHOT_HEARING_RADIUS;

    for (const bullet of game.bulletBarn.newBullets) {
        if (bullet.playerId === bot.__id) continue;
        const shooter = game.objectRegister.getById(bullet.playerId);
        if (shooter?.__type === ObjectType.Player && mates?.includes(shooter)) continue;

        const distSqr = v2.lengthSqr(v2.sub(bullet.startPos, bot.pos));
        if (distSqr < closestDistSqr) {
            closest = bullet.startPos;
            closestDistSqr = distSqr;
        }
    }
    return closest;
}

/** Position of the nearest live, explosive-armed throwable within `GRENADE_DANGER_RADIUS`
 *  that's genuinely about to explode (see `GRENADE_REACT_TIME`), or undefined if there's
 *  nothing worth reacting to yet. Not thrower-aware: a grenade doesn't care who threw it,
 *  and a bot standing in its own toss's blast radius is just as dead as standing in an
 *  enemy's. */
export function findGrenadeThreat(bot: Player): Vec2 | undefined {
    const game = bot.game;
    let closest: Vec2 | undefined;
    let closestDistSqr = GRENADE_DANGER_RADIUS * GRENADE_DANGER_RADIUS;

    for (const proj of game.projectileBarn.projectiles) {
        if (proj.dead || !util.sameLayer(proj.layer, bot.layer)) continue;
        if (proj.fuseTime > GRENADE_REACT_TIME) continue;
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

/** Nearest living enemy inside the bot's screen, or undefined. Seeing and shooting are
 *  different things: the server sends every player in the screen rectangle, so a human sees
 *  an enemy behind a crate just as well. Whether a bullet can actually get through is checked
 *  separately, when firing (see `updateFiring`) and when weighing a hit (see `enemyCanHitSoon`). */
export function findVisibleTarget(bot: Player): Player | undefined {
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
    return ranked[0]?.player;
}
