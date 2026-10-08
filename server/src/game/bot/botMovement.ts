import type { ObstacleDef } from "../../../../shared/defs/mapObjectsTyping";
import { MapObjectDefs } from "../../../../shared/defs/register.ts";
import { GameConfig } from "../../../../shared/gameConfig.ts";
import { ObjectType } from "../../../../shared/net/objectSerializeFns.ts";
import { coldet } from "../../../../shared/utils/coldet.ts";
import { collider } from "../../../../shared/utils/collider.ts";
import { math } from "../../../../shared/utils/math.ts";
import { util } from "../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { GameObject } from "../objects/gameObject.ts";
import type { Obstacle } from "../objects/obstacle.ts";
import type { Player } from "../objects/player.ts";
import { currentSweetSpot } from "./botCombat.ts";
import type { BotTierDef } from "./botDefs.ts";
import { hasBodyLineOfSight } from "./botPerception.ts";
import { findPath } from "./nav/navAStar.ts";
import { isOpenableDoor, isWalkClear, pointClear } from "./nav/navGeom.ts";
import type { NavGraph } from "./nav/navGraph.ts";

type RangeMode = "close" | "retreat" | "hold";

/** What the brain wants movement to do this tick, decided from health, heal
 *  availability and recent combat momentum - see `BotBrain`.
 *  - `idle`: nothing to engage, wander.
 *  - `engageHold`: fight at a sane range - close in if too far, back off if too close,
 *    otherwise use cover and peek instead of standing in the open.
 *  - `push`: winning the exchange *and* the target is hurt enough to be worth
 *    finishing (see `BotBrain.pickDirective`'s `ENEMY_LOW_HEALTH_FRAC`) - charge
 *    straight at the threat instead of holding position. `engageHold` handles closing
 *    distance more cautiously (via cover) for a plain hit streak against a healthy
 *    target - `push` is specifically for finishing a fight already mostly won.
 *  - `heal`: retreat to cover and hunker down to use a heal item.
 *  - `flee`: too hurt to fight and either out of heal items or just got interrupted -
 *    put distance (and cover, if any is nearby) between the bot and the threat.
 *  - `reload`: every gun is dry *and* the bot is actually under fire right now (see
 *    `BotBrain.needsReload`) - put some distance between the bot and the threat while
 *    the reload (already requested regardless, see `updateReload`) finishes, same idea
 *    as `heal` but a shorter, less urgent retreat. Being out of ammo with nobody
 *    shooting just reloads in place under whatever directive otherwise applies. */
export type CombatDirective = "idle" | "engageHold" | "push" | "heal" | "flee" | "reload";

const REPATH_INTERVAL = 0.6;
const REPATH_GOAL_DELTA = 8;
const WAYPOINT_REACHED_DIST = 3;
const MAX_STRING_PULL = 3;
const MAX_PATH_EXPANSIONS = 1500;
const NODE_SEARCH_RADIUS = 40;
const STUCK_CHECK_INTERVAL = 1;
const STUCK_MOVE_THRESHOLD = 1;
/** Minimum real distance closed toward the current path waypoint per stuck-check window
 *  to count as genuine progress - see `stuck`'s "no progress toward the actual target"
 *  check.
 *
 *  Raised from 0.5 after a real match capture: a fleeing bot at critical health (19-21)
 *  slid along something (a wall/container edge the path routed it right against) at
 *  roughly a quarter of normal move speed for over a second - real, nonzero progress the
 *  whole time, so neither this check nor the raw-displacement one ever fired - and took
 *  the hit that finished it during exactly that window. 0.5 was deliberately lenient
 *  ("only has to catch basically not closing in at all, not demand fast progress"), which
 *  is exactly what let a bot crawling at ~2 units/s read as "making progress, nothing to
 *  fix" for as long as it took to die - "retreaten muss schneller und effektiver sein".
 *  2.5 is still well under a full second of normal move speed (~8 units/s even just
 *  along a straight line to the waypoint), so a real detour or a brief slowdown rounding
 *  a corner isn't mistaken for this - it only catches the specific "far slower than
 *  intended for a sustained window" case this capture showed actually happens and costs
 *  real fights. */
const PULL_TARGET_PROGRESS_MIN = 2.5;
/** How many consecutive `STUCK_CHECK_INTERVAL` windows of zero progress it takes before
 *  `BotMovementState.stuck` (the "give up and fight" signal) actually goes true - see
 *  its own doc comment for why this needs real confidence, not a single bad window. */
const STUCK_STREAK_FOR_FIGHT = 3;
/** How long the final move has to have spent reversing almost every tick before counting as
 *  dithering - see `BotMovementState.ditherElapsedS`. Deliberately a small fraction of
 *  `STUCK_CHECK_INTERVAL * STUCK_STREAK_FOR_FIGHT` (the slower detector's own ~3s bar): this
 *  exists specifically to catch the failure *well* before that one would, not to duplicate it. */
const DITHER_REVERSAL_S = 0.3;
/** How close to exactly opposite two consecutive move directions have to be to count as a
 *  reversal for `ditherElapsedS` - matches the real match captures this is for (consecutive
 *  headings 150-180 degrees apart), comfortably past a merely sharp turn. */
const DITHER_REVERSAL_DOT = -0.5;
/** How long a waypoint node stays blacklisted (see `BotMovementState.blacklistedNodes`)
 *  after the bot got stuck failing to make progress toward it - long enough that a
 *  repath genuinely has to route around the dead end instead of just re-discovering the
 *  same "optimal" path back the instant this expires. */
const STUCK_NODE_BLACKLIST_S = 5;

/** How far `findCover` looks for a real hiding spot. Raised from 30 - a bot mid-fight
 *  (holding or pushing) only has a moment to react and should grab whatever's genuinely
 *  close, but a bot that's actually fleeing/healing has the time and every reason to
 *  travel further for a real piece of cover instead of settling for "nothing nearby,
 *  just run in the open" - "der Bot muss ordentlich weg rennen und dafür sorgen, dass
 *  der Gegner ihm nicht folgen kann". Shared by every caller rather than a
 *  directive-specific radius - a wider net never hurts `engageHold`/`push` either, it
 *  just costs one grid query over a bigger (but still cheap, single-bot) area. */
const COVER_SEARCH_RAD = 50;
/** How far a retreat to heal or flee looks for cover. The bot knows the whole map, so it can plan a
 *  walk to a good spot further off - but the nearest workable candidate still wins, so this only
 *  reaches past the usual radius when nothing closer works. */
export const RETREAT_COVER_SEARCH_RAD = 110;
// Distance a cover spot sits past the obstacle's own edge, from the obstacle's center.
// Needs to clear not just a player's collision radius (1) but also the slop
// `COVER_REACHED_DIST` allows when "arriving" - the bot's actual resting position can
// land anywhere within that radius of the ideal spot, and the worst case is landing
// that much closer to the threat. `isBodyHidden` folds both into the point it actually
// checks; this just has to be large enough that some genuinely-hidden margin survives
// past that combined worst case (bot.rad + COVER_REACHED_DIST = 1.75 here), not merely
// clear the obstacle's own edge.
const COVER_BUFFER = 2.75;
// Short enough that cover keeps up with an enemy actually circling around it - a full
// second was long enough for a repositioning threat to walk around a piece of cover
// before the bot ever noticed it had gone stale, leaving it exposed at the old spot.
const COVER_RECOMPUTE_INTERVAL = 0.4;
// Tight on purpose - see the `COVER_BUFFER` comment above. A looser tolerance here
// directly eats into the margin that's supposed to keep the bot's whole body hidden,
// not just the exact ideal point: settling for "close enough" at 1.5 units used to be
// enough slop, by itself, to walk the bot's exposed edge right back into view.
const COVER_REACHED_DIST = 0.75;

/** How close the bot has to already be to `coverPos` before `followPath` and the steering probe
 *  are allowed to ignore the cover obstacle itself as a blocker - see `followPath`'s own doc
 *  comment on `ignore`. Only as close as `COVER_BUFFER` (how far the point sits off the
 *  obstacle's own edge): inside that, the straight line to it is genuinely just grazing that
 *  edge by design. Any farther and the obstacle's bulk can still sit *between* the bot and the
 *  point on its far side - a real match had a bot at 5-6 units ignoring a barrel it had to go
 *  around, pushing into it until the enemy finished it off. That case needs real routing. */
const COVER_APPROACH_IGNORE_DIST = 3;

/** Max turn rate (rad/s) for the raw-steering direction while closing the last stretch
 *  to `coverPos` - see `retreatToCover`'s approach branch. A real match capture showed a
 *  bot visibly vibrate in place for 1.4+ seconds at critical health closing in on its own
 *  cover: `normalizeSafe(coverPos - bot.pos)`, recomputed fresh every tick, is exactly the
 *  kind of direction calculation that amplifies small position noise into large angular
 *  swings once the remaining distance gets small - a few tenths of a unit of ordinary
 *  per-tick movement noise is a much bigger fraction of "2 units left to go" than of "20
 *  units left to go". Every swing also fed `isDirClear`'s local deflection a different
 *  base direction to deflect *from*, compounding rather than damping it. Same turn-rate-
 *  slew technique `updateAim`'s own `aim.dir` already uses for exactly this reason - fast
 *  enough to redirect toward a genuinely new cover pick within a fraction of a second
 *  (half a turn in under 0.4s), slow enough that one noisy tick can't reverse the
 *  commanded direction outright. */
const APPROACH_TURN_RATE = 8;

/** Angles (radians) off "directly behind cover" tried when leaning out to peek - not 0,
 *  which is fully hidden, and not near π, which is fully in the open; these sample the
 *  obstacle's silhouette edge, closest offset first.
 *
 *  Narrowed from [1.05, 1.4, 1.75] - "peaken muss ... weniger Fläche offenbaren". The
 *  smallest angle that actually clears line of sight wins (see `findPeekSpot`'s loop), so
 *  this directly caps how much of the bot's silhouette a peek can expose past the cover's
 *  edge, independent of `PEEK_EXPOSE_MIN/MAX` (how *long* it stays out - deliberately left
 *  alone, see that constant's own note on real trade-rate data). */
const PEEK_ANGLES = [0.75, -0.75, 1.0, -1.0, 1.25, -1.25];
const PEEK_HOLD_MIN = 1.0;
const PEEK_HOLD_MAX = 2.2;
/** Hiding duration used instead of `PEEK_HOLD_MIN/MAX` right after the enemy was
 *  actually visible a moment ago (see `updateMovement`'s `recentlyVisible`) - they
 *  almost certainly just ducked back behind their own cover close by, so there's no
 *  reason to wait out a full, "haven't seen them in a while" hiding window before
 *  leaning back out to check. */
const EAGER_PEEK_HOLD_MIN = 0.3;
const EAGER_PEEK_HOLD_MAX = 0.6;
const PEEK_EXPOSE_MIN = 0.5;
const PEEK_EXPOSE_MAX = 1.0;
const PEEK_RETRY_DELAY = 0.3;
const PEEK_REACHED_DIST = 1;

/** Multiplier on `PEEK_HOLD_MIN/MAX`/`EAGER_PEEK_HOLD_MIN/MAX` from `BotTierDef.aggression`
 *  (see there) - `undefined` (no tier passed at all) is neutral, exactly the originally
 *  tuned pace; a real tier scales from there, 1.6x longer hides at `aggression = 0` down
 *  to 0.7x shorter at `aggression = 1` - a hesitant bot should linger behind cover
 *  noticeably longer between peeks, and a decisive one lean back out sooner, not just aim
 *  differently once it does. */
function peekPaceMult(aggression: number | undefined): number {
    if (aggression === undefined) return 1;
    return math.lerp(aggression, 1.6, 0.7);
}

/** Multiplier on `PEEK_EXPOSE_MIN/MAX` from `aggression` - the opposite direction from
 *  `peekPaceMult`: a decisive bot commits to a peek *longer*, not shorter. Real match
 *  data showed the bot pulling the trigger roughly half as often per minute as a human
 *  opponent despite comparable accuracy - the fixed, tier-independent 0.5-1.0s expose
 *  window was the reason: `PEEK_HOLD`'s own aggression scaling only ever sped up how
 *  *often* a decisive bot leans back out, not how long it stays out once it does, so a
 *  slower single/bolt-action weapon (this matchup's whole loadout) regularly ducked back
 *  to cover before its own `fireDelay` cycled around for a second shot. A real player
 *  peeking a fight that's going well just keeps trading, not retreating on a fixed
 *  clock - `1` (unscaled) at `aggression = 0`, up to roughly double by `aggression = 1`,
 *  and further past that for a tier deliberately pushed past 1 (see `BOT_TIERS.expert`). */
function peekExposeMult(aggression: number | undefined): number {
    if (aggression === undefined) return 1;
    return math.lerp(aggression, 1, 2);
}

/** Multiplier on `COVER_RECOMPUTE_INTERVAL` from `aggression` - same neutral-when-absent
 *  shape as `peekPaceMult`. A more decisive bot re-checks cover against a moving/flanking
 *  enemy well more often than a hesitant one, instead of every tier reacting to
 *  repositioning on the same fixed clock regardless of skill. */
function coverRecomputeMult(aggression: number | undefined): number {
    if (aggression === undefined) return 1;
    return math.lerp(aggression, 1.5, 0.6);
}

/** Chance `rollStrafeCycle` rolls a short, punchy feint instead of a normal-length hold -
 *  0.25 (the original tuned value) when no tier is passed, scaling from 0.1 at
 *  `aggression = 0` up to 0.4 at `aggression = 1`: a decisive bot juke unpredictably more
 *  often, a hesitant one settles into a steadier, more readable strafe. */
function feintChanceFor(aggression: number | undefined): number {
    if (aggression === undefined) return 0.25;
    return math.lerp(aggression, 0.1, 0.4);
}

/** Multiplier on `RETREAT_RECOMPUTE_INTERVAL` - same neutral-when-absent shape as
 *  `coverRecomputeMult`. A fleeing bot only re-aims its retreat goal on this clock
 *  (`retreatDirection`); holding it fixed at the same pace regardless of tier made even
 *  `expert` re-route away from a cutting-off pursuer no faster than `easy` did, which
 *  read as sluggish exactly where a "faster bot" complaint was aimed - see
 *  `BOT_TIERS.expert`'s own note. */
function retreatRecomputeMult(aggression: number | undefined): number {
    if (aggression === undefined) return 1;
    return math.lerp(aggression, 1.4, 0.5);
}

/** How far ahead a plain retreat (mode `retreat`, or `heal`/`flee`/`reload` with no
 *  cover found) picks a concrete destination to path toward, instead of just steering
 *  in the raw "away from the threat" direction. A straight line can walk directly into
 *  a building or a shipping container with no route around it, since it's never
 *  pathfound - routing to a real point via `followPath` fixes that the same way
 *  `close`/`push`/cover-seeking already benefit from nav-graph routing. */
const RETREAT_LOOKAHEAD = 20;
/** Not recomputed every tick - re-deriving "20 units directly away" from the bot's own
 *  constantly-changing position would make the goal drift by roughly as much as the bot
 *  moves each tick, which `followPath`'s own staleness check (`REPATH_GOAL_DELTA`)
 *  would read as "goal changed, repath" almost every tick. A fixed point, refreshed
 *  only occasionally, gives `followPath` something stable to actually path toward. */
const RETREAT_RECOMPUTE_INTERVAL = 1.5;
const RETREAT_GOAL_REACHED_DIST = 4;
/** How close counts as "arrived" at `idleGoal` (a last-known enemy spot, or the map's
 *  center) before falling back to plain wandering in the area - generous, since this is
 *  "get to roughly the right neighborhood", not a precise cover/waypoint arrival. */
const IDLE_GOAL_REACHED_DIST = 10;
/** Distance past `IDLE_GOAL_REACHED_DIST` a bot that's stopped heading toward `idleGoal`
 *  has to drift before it resumes - the other edge of the hysteresis band described on
 *  `BotMovementState.headingToIdleGoal`. Wide enough that ordinary wander drift right
 *  around the reached radius doesn't immediately flip back either. */
const IDLE_GOAL_RESUME_DIST = IDLE_GOAL_REACHED_DIST + 8;
/** How long an idle bot leaves its idle goal alone after a route to it cut through a
 *  building's interior - see `idleRouteCrossesInterior` in `updateMovement`. */
const IDLE_INTERIOR_ROUTE_COOLDOWN_S = 6;
/** How far around a raw straight-line movement goal to look for a non-`interior` node to
 *  redirect to instead - see `preferNonInteriorGoal`. Wide enough to actually find a
 *  nearby hull/open node from just inside a building, not so wide the goal drags
 *  somewhere unrelated to the original destination. */
const NON_INTERIOR_GOAL_SEARCH_RADIUS = 15;

/** How far ahead a candidate wander heading is checked for landing inside a building -
 *  see `pickWanderDir`. Roughly what a wander leg actually covers before the next
 *  re-pick (`util.random(1, 2.5)` seconds at wander pace), so this is asking "does
 *  committing to this heading for the wander's own natural duration walk me into a
 *  building", not an arbitrarily distant, unrelated point. */
const WANDER_LOOKAHEAD = 15;
/** How many random headings `pickWanderDir` tries before giving up and accepting
 *  whichever one it already has - a bot standing inside a dense cluster of buildings
 *  with no open heading nearby still has to wander *somewhere* rather than freeze. */
const WANDER_DIR_ATTEMPTS = 5;

/** `push` never closes tighter than this, full stop, regardless of weapon. Not just a
 *  style choice: a gun's aim/lead math (`botAim.ts`) works from the *muzzle* position
 *  (`pos + dir * barrelLength`, ~2.5-2.7 units for most guns), so once actual
 *  separation drops below roughly a barrel's length the muzzle point can end up past
 *  the target entirely - the aim vector inverts and the bot freezes aiming the wrong
 *  way, unable to fire, for as long as it stays wedged there. Stopping the approach
 *  with room to spare avoids ever reaching that regime instead of special-casing it
 *  after the fact. */
const PUSH_MIN_DIST = 6;
/** How far past this floor `push` actually closes, as a fraction of the equipped
 *  weapon's own sweet spot - pressing an advantage with a shotgun means walking it down
 *  to melee-adjacent range, but doing the same with a sniper rifle is how a bot with a
 *  70-unit ideal range ends up rushing someone to point-blank instead of just closing
 *  the gap a bit. `Math.max` with `PUSH_MIN_DIST` keeps short-range weapons (where this
 *  fraction alone would land below the aim-math floor above) from doing anything
 *  different than before. */
const PUSH_SWEET_SPOT_FRAC = 0.45;

/** Per-bot movement state, persisted across ticks by the brain. */
export class BotMovementState {
    strafeSign: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    strafeTimer = util.random(0.6, 1.6);
    /** Which way the retreat shake currently leans (+1/-1) and how long until it flips. See `shakeRetreat`. */
    shakeSign: 1 | -1 = 1;
    shakeTimer = 0;
    /** A dodge in progress: seconds left, and which side to step to. Started by the brain on a hit. */
    dodgeTimer = 0;
    dodgeSign: 1 | -1 = 1;
    /** How strongly the current strafe cycle blends in, as a fraction of full speed -
     *  see `rollStrafeCycle`. Rerolled alongside `strafeSign`/`strafeTimer` so the
     *  side-to-side movement varies in punch, not just direction and timing. */
    strafeIntensity = 0.35;
    wanderDir: Vec2 = v2.randomUnit();
    wanderTimer = 0;
    /** Sticky "still heading toward `idleGoal`" flag - see `updateMovement`'s idle
     *  branch's `IDLE_GOAL_REACHED_DIST`/`IDLE_GOAL_RESUME_DIST` hysteresis band. Without
     *  it, a bot arriving from any direction other than dead-on can cross the plain
     *  distance threshold back and forth tick to tick as it moves, flipping between
     *  path-following and picking a fresh random wander direction each time - which,
     *  since those two point in essentially unrelated directions, cancels out net
     *  progress and reads as the bot freezing in place short of its destination. */
    headingToIdleGoal = true;
    /** Seconds before an idle bot may head for its idle goal again after one route was
     *  dropped for cutting through a building's interior - see `IDLE_INTERIOR_ROUTE_COOLDOWN_S`. */
    idleGoalCooldown = 0;
    /** Whether this heading toward the idle goal has already had its route checked for
     *  building interiors - see `idleRouteCrossesInterior`. */
    idleRouteChecked = false;
    /** Whether the walk to the idle goal routes around building interiors - see `updateMovement`. */
    idleAvoidInterior = false;
    /** Which of close/retreat/hold the bot is committed to - see `pickRangeMode`. */
    rangeMode: RangeMode = "hold";
    /** Seconds spent in `close` mode without the target actually being visible - see
     *  `BLIND_CLOSE_MAX_S`. Reset the instant the target is seen again or the mode isn't
     *  `close`. */
    blindCloseElapsedS = 0;
    /** Which side the bot is currently deflecting around an obstacle, so it commits to
     *  one direction instead of re-deciding independently every tick. */
    deflectSign: 1 | -1 = 1;

    /** Remaining nav-graph node ids to walk through, nearest first. Empty when no
     *  path is needed (direct line to the goal is clear) or none was found. */
    path: number[] = [];
    /** The goal position `path` was computed for - a big enough move invalidates it. */
    pathGoal?: Vec2;
    repathCooldown = 0;
    /** Node ids to route around for a while - see the stuck-recovery block in
     *  `updateMovement` (what blacklists one) and `followPath` (what excludes them from
     *  the next search). Value is remaining seconds, ticked down in `followPath` - not
     *  `Game.now`-based like most of this file's other cooldowns, since a test harness
     *  driving `updateMovement` directly (see `botMovementNav.test.ts`) never advances
     *  that clock. */
    blacklistedNodes = new Map<number, number>();

    /** Anti-stuck: if the bot barely moves while following a path, the path is
     *  probably bad (a doorway it failed to open in time, a sampling error) - drop it
     *  and let the next tick request a fresh one. */
    stuckTimer = 0;
    stuckAnchor: Vec2 = v2.create(0, 0);
    /** `pullTarget` and its distance at the start of the current stuck-check window -
     *  see `stuck`'s "no progress toward the actual waypoint" check. A slow, wrong-
     *  direction drift (alternating between two near-opposite headings a hair unevenly,
     *  a real match capture found) can clear `STUCK_MOVE_THRESHOLD` in raw displacement
     *  every single window while never actually closing in on where it's headed - this
     *  catches that case directly instead of trusting raw movement alone. `undefined`
     *  whenever there's no path being followed, or the target changed mid-window (a
     *  real, voluntary re-pick, not evidence of anything stuck). */
    pullTargetAtCheck?: number;
    distToPullTargetAtCheck?: number;
    /** Whether movement genuinely *tried* to go somewhere (a non-trivial `move` vector)
     *  at any point since the last stuck check - see `stuck`. Distinguishes "tried to
     *  move but the position barely changed" (a real obstruction) from "chose to stand
     *  still on purpose" (holding cover, mid-peek-cycle wait, already at a reached
     *  waypoint) - both look identical as *raw position delta* alone, but only the
     *  first one is actually "stuck". */
    triedToMoveSinceCheck = false;
    /** Consecutive `STUCK_CHECK_INTERVAL` windows in a row with zero real progress
     *  despite trying - see `stuck`. A single bad window is cheap and common (cover
     *  hopping to a slightly-further spot mid-retreat can net well under
     *  `STUCK_MOVE_THRESHOLD` for one second without anything actually being wrong);
     *  only a sustained run of them means the retreat itself has failed. */
    stuckStreak = 0;
    /** True once `stuckStreak` has been sustained for `STUCK_STREAK_FOR_FIGHT` windows
     *  in a row - see `BotBrain.fleeOrFight`, which reads this to give up on an
     *  ineffective retreat and fight back instead. Deliberately a much higher bar than
     *  the single-window anti-stuck recovery below (which still fires every window,
     *  cheap and harmless even on a false alarm): abandoning a heal/flee attempt
     *  entirely on one noisy 1-second blip - a normal zigzag while dodging fire, or one
     *  cover-hop netting little straight-line distance - was turning "the retreat is
     *  briefly inefficient" into "give up and fight while still low", which is a much
     *  more expensive mistake than one extra second of retreating that wasn't needed. */
    stuck = false;
    /** Seconds the final chosen move direction has spent reversing almost every tick from the
     *  previous one - see `DITHER_REVERSAL_S`. A real match had a bot pinned in a one-unit gap
     *  between a stone and a tree on the way to its cover, its move flipping between two
     *  near-opposite headings every single tick, for 1.2+ real seconds at 9-11 HP - net zero
     *  progress, no peeking, no dodging, just standing there taking hits ("er hat einfach
     *  getankt"). The displacement-based `stuck`/`stuckStreak` above never caught it: the back-
     *  and-forth canceled out within each 1-second window, under `STUCK_MOVE_THRESHOLD`. This is
     *  a much faster, independent signal of the exact same failure mode, read by
     *  `BotBrain.fleeOrFight` the same way `stuck` is - give up retreating and fight back instead,
     *  long before the slower detector would ever trip. Doesn't touch `stuck`/`stuckStreak`
     *  themselves or their path-repair side effects (blacklisting, `deflectSign` flips) - this is
     *  purely a faster trigger for the same "give up and fight" read, not a replacement. */
    ditherElapsedS = 0;
    /** True once `ditherElapsedS` passes `DITHER_REVERSAL_S` - read by `BotBrain.fleeOrFight`
     *  exactly like `stuck` is, just far sooner. */
    dithering = false;
    /** The final move direction chosen last tick, for `ditherElapsedS`'s reversal check. */
    lastMoveDir?: Vec2;

    /** The path node currently being string-pulled toward - see `followPath`. Node id,
     *  not an index into `path`, so it survives waypoints being shifted off the front. */
    pullTarget?: number;

    /** Cover currently held - see `findCover`. Kept as the obstacle itself, not just
     *  its position, so a live `obstacle.dead` check (every tick, for free) catches it
     *  being shot apart out from under the bot immediately rather than on the next
     *  multi-second recompute. Used for healing, fleeing, and holding a mid-fight
     *  position alike. */
    coverObstacle?: Obstacle;
    coverPos?: Vec2;
    coverRecheck = 0;
    /** Turn-rate-slewed direction while raw-steering toward `coverPos` (no real A* path
     *  needed, see `retreatToCover`'s approach branch) - see `APPROACH_TURN_RATE`'s own
     *  doc comment. `undefined` whenever a real path is doing the steering instead, or no
     *  approach is in progress at all. */
    approachDir?: Vec2;
    /** Consecutive recomputes in a row where `findCover` came back empty despite
     *  `coverObstacle` still being alive - see `COVER_MISS_GRACE`. Reset the moment a
     *  recompute finds *something* again. */
    coverMissStreak = 0;
    /** Whether the bot has actually reached `coverPos` since it was last (re)picked -
     *  see the doc comment on `retreatToCover` for why this matters: once true, control
     *  hands off entirely to the peek cycle instead of re-checking distance to the base
     *  cover point every tick. */
    settledAtCover = false;
    /** Distance to the threat at the moment `settledAtCover` last became true - see
     *  `retreatToCover`'s "threat closing in" check. `undefined` whenever cover isn't
     *  settled (kept in sync with `settledAtCover` resetting to `false`). */
    distAtSettle?: number;
    /** Where the threat was when `settledAtCover` last latched - see the sideways-shift check
     *  in `retreatToCover`. */
    threatAtSettle?: Vec2;
    /** Set once a healing bot has re-picked its cover in place because the enemy has a line on
     *  it - see `retreatToCover`. Cleared as soon as it's no longer exposed. */
    exposedRecheckPending = false;
    /** Seconds since `settledAtCover` last became true - see `retreatToCover`'s "settled
     *  too long" check/`SETTLED_MAX_S`. Reset alongside `distAtSettle`. */
    settledForS = 0;
    /** Whether a heal/flee/reload retreat has already reached its first hiding spot and
     *  is now pushing past it toward real distance - see `retreatToCover`'s "keep
     *  retreating past the first spot" logic. Once true, the approach-`coverPos` check is
     *  skipped for the rest of this push: without it, moving even one step away from the
     *  just-reached `coverPos` (which is exactly what pushing further does) immediately
     *  re-triggers "not yet at `coverPos`", walking the bot straight back to the same
     *  fixed point it just left - a one-tick oscillation that would never make any real
     *  progress toward genuine distance. Reset alongside `settledAtCover`. */
    pushedPastCover = false;

    /** Peek cycle while holding cover mid-fight - see `updatePeekCycle`. `peeking`
     *  false means hiding at `coverPos`; true means leaning out to `peekPos`. */
    peeking = false;
    peekPos?: Vec2;
    peekTimer = 0;

    /** Fixed destination a plain retreat paths toward - see `retreatDirection`. */
    retreatGoal?: Vec2;
    retreatRecheck = 0;
}

const PROBE_DIST = 3;

/** A bot never insists on backing away further than this, regardless of how far a
 *  long-range weapon's own sweet spot is - see the note on `pickRangeMode`. */
const MAX_RETREAT_DIST = 20;
/** `engageHold`'s held distance against a healthy target never sits closer than this,
 *  regardless of how close the equipped weapon's own sweet spot wants to stand - see
 *  the note in `updateMovement`'s `engageHold` branch.
 *
 *  Briefly raised to 22 over a "full shotgun volleys are devastating even at range"
 *  read of `bullet_flechette`'s tight 4-degree spread - reverted back to 15 once a
 *  decoded batch of 40 real human-vs-human 1v1 matches (same arena mode, same
 *  `bullet_flechette`/`bullet_mosin` loadouts) showed real engagement distance sits at
 *  a median of just 14.8 (even the bolt-action mosin's own median was 14.2) - real
 *  players hold this close and win anyway, so backing further off was fighting the
 *  actual meta of this game mode rather than fixing anything. The real lesson from
 *  that data is that surviving close range is a movement/peek problem (breaking the
 *  shooter's tracking), not a "stand further back" one - `SAFE_ENGAGE_DIST` alone was
 *  never going to fix it. */
const SAFE_ENGAGE_DIST = 15;
/** How long `close` mode keeps sprinting straight at a target it can't actually see
 *  before giving up on that specific push and falling back to holding from cover
 *  instead (see the `blindCloseElapsedS` override below `pickRangeMode`). A real match
 *  capture showed the bot commit to a full-speed, cover-free chase toward nothing but a
 *  gunshot's position estimate - which kept drifting as fresh shots landed - for 4.5
 *  *straight* seconds of completely open ground, then took a hit within a quarter
 *  second of the target actually reappearing. `close` mode's whole premise (matching a
 *  real player closing on someone they're actively tracking) stops holding once "someone
 *  I'm tracking" has degraded into "a rough, ageing guess" for this long - a cautious
 *  player would have eased off cover-seeking well before then, not sprinted blind into
 *  whatever's waiting. */
const BLIND_CLOSE_MAX_S = 2;

/**
 * Schmitt-trigger range gate: a bot must clear `[retreatEdge, closeEdge]` to START
 * closing in or backing off, but only needs to return to a narrower inner band to
 * STOP. Without this, a bot sitting near its sweet spot flickers between "close" and
 * "retreat" every single tick as its own strafing causes `dist` to wobble across the
 * boundary, which looks like it's vibrating in place instead of circling.
 *
 * `retreatEdge` is capped at `MAX_RETREAT_DIST` independently of `closeEdge`: a
 * bolt-action rifle's sweet spot (up to 70 units) is a fine reason to *close in* when
 * standing too far away, but backpedaling all the way out to 70 units of separation on
 * a map far smaller than that just walks the bot into the map edge instead of holding
 * a sane firing position. Real players don't keep retreating to maximize their
 * sniper's ideal range either - they hold once the enemy isn't in their face anymore.
 */
function pickRangeMode(
    state: BotMovementState,
    dist: number,
    sweet: number,
    band: number,
): RangeMode {
    const closeEdge = sweet + band;
    const retreatEdge = Math.min(sweet - band, MAX_RETREAT_DIST);
    const hysteresis = Math.max(2, band * 0.4);

    if (state.rangeMode === "close") {
        if (dist <= closeEdge - hysteresis) state.rangeMode = "hold";
    } else if (state.rangeMode === "retreat") {
        if (dist >= retreatEdge + hysteresis) state.rangeMode = "hold";
    } else if (dist > closeEdge) {
        state.rangeMode = "close";
    } else if (dist < retreatEdge) {
        state.rangeMode = "retreat";
    }
    return state.rangeMode;
}

/** Whether moving `dir` from the bot's position is clear for `dist` units. Ignores
 *  height (0 = "count every collidable obstacle") since this is a physical-blocker
 *  probe. An unlocked door is excluded - same reasoning as the nav graph
 *  (`isOpenableDoor`): a bot walking toward a closed door should approach and open it
 *  (see `tryOpenNearbyDoor`), not swerve around it like a wall. The game's own
 *  movement collision still physically stops the bot right at the door until it's
 *  actually opened - this probe only decides which *direction* to walk, not whether
 *  the door is currently passable.
 *
 *  `ignore` excludes one specific obstacle from the check - used for the obstacle the
 *  bot is currently using as cover. Deliberately walking up to within a couple of units
 *  of that obstacle (to reach `coverPos`/`peekPos`, both placed right at its edge) is
 *  exactly what cover-seeking wants, not something to deflect away from; without this,
 *  this generic probe second-guessed `retreatToCover`'s already-correct approach
 *  direction the moment the bot got close enough to its own cover to matter, deflecting
 *  it sideways and never letting it actually settle within `COVER_REACHED_DIST` - which
 *  looked like "never really goes into cover" and "never peeks" from the outside, since
 *  the peek cycle only starts once cover is actually reached. */
// Real movement collision stops the bot's whole `bot.rad`-radius body, not just its
// center point - a thin zero-width ray straight down `dir` used to read a heading as
// "clear" right past a corner the bot's own body still clipped, so the commanded
// direction and the actual (zero) result disagreed right at that corner. Position
// unchanged next tick means the same heading gets recomputed and, since it's right on
// that knife's edge, sub-unit jitter can flip the same ray test from clear to blocked
// and back - two near-opposite headings (direct vs. the full reverse below) alternating
// every tick with no net progress at all, which is exactly the "vibrating in place at a
// wall corner for several real seconds" bug this is for. Sweeping a `bot.rad` disc
// along the segment instead (one obstacle overlap test per unit of distance) actually
// answers "can my body get through here", not just "is the point directly ahead free".
//
// `CLEARANCE_SLOP` shrinks that probe by a hair rather than using `bot.rad` exactly -
// resting against a wall (the completely ordinary state a bot hugging cover is in most
// of the time) already leaves it right at that boundary, and the collision resolver's
// own push-out (`collision.pen + 0.001` in `Player.update`'s movement step) only
// guarantees a razor-thin positive margin, not a comfortable one - real float noise
// across a multi-obstacle resolve pass regularly lands a hair on the *other* side of
// zero. Without slop, sliding *along* a wall the bot is already touching sweeps the
// probe at that same razor-thin distance for the entire segment, and a few thousandths
// of a unit of residual overlap reads every step of it as blocked - the exact same
// "vibrating in place" symptom this whole function exists to fix, just triggered by
// ordinary wall contact instead of a corner. Kept well under the corner fix's own
// working range (the regression test below still needs an 0.6-unit clip caught) so this
// only forgives genuine resting noise, not a real clip.
const CLEARANCE_SLOP = 0.1;

export function isDirClear(bot: Player, dir: Vec2, dist: number, ignore?: Obstacle): boolean {
    const probeRad = Math.max(0, bot.rad - CLEARANCE_SLOP);
    const aabb = collider.createAabbExtents(bot.pos, v2.create(dist + bot.rad + 1, dist + bot.rad + 1));
    const objs = bot.game.grid.intersectCollider(aabb);
    const obstacles: Obstacle[] = [];
    for (let i = 0; i < objs.length; i++) {
        if (objs[i].__type !== ObjectType.Obstacle) continue;
        const o = objs[i] as Obstacle;
        if (o.dead || !o.collidable || o.isWindow) continue;
        if (!util.sameLayer(o.layer, bot.layer)) continue;
        if (isOpenableDoor(o) || o === ignore) continue;
        obstacles.push(o);
    }
    const steps = Math.ceil(dist);
    for (let s = 1; s <= steps; s++) {
        const probe = collider.createCircle(v2.add(bot.pos, v2.mul(dir, Math.min(s, dist))), probeRad);
        for (let i = 0; i < obstacles.length; i++) {
            if (coldet.test(probe, obstacles[i].collider)) return false;
        }
    }
    return true;
}

/** Opens the nearest closed, unlocked door within interaction range, if any - the same
 *  overlap test `Player.getInteractableObstacles` uses for a human's `Input.Use`. Runs
 *  every tick regardless of movement mode, so a bot opens doors it merely walks past,
 *  not just ones directly on a computed path. */
export function tryOpenNearbyDoor(bot: Player): void {
    const searchRad = bot.rad + 5;
    const objs = bot.game.grid.intersectCollider(collider.createCircle(bot.pos, searchRad));
    for (let i = 0; i < objs.length; i++) {
        const o = objs[i];
        if (o.__type !== ObjectType.Obstacle) continue;
        const obstacle = o as Obstacle;
        if (
            obstacle.dead
            || !obstacle.isDoor
            || !obstacle.door
            || obstacle.door.open
            || obstacle.door.locked
            || !obstacle.door.canUse
            || obstacle.interactionRad <= 0
            || !util.sameLayer(obstacle.layer, bot.layer)
        ) {
            continue;
        }
        if (
            collider.intersectCircle(obstacle.collider, bot.pos, obstacle.interactionRad + bot.rad)
        ) {
            obstacle.interact(bot);
            return;
        }
    }
}

function obstacleRadius(o: Obstacle): number {
    const c = o.collider;
    if (c.type === collider.Type.Circle) return c.rad;
    return v2.distance(c.min, c.max) / 2;
}

/** Whether shooting this obstacle enough (by anyone, not just the bot) makes it explode
 *  - a barrel, a gas stove, ... `findCover` refuses to ever pick one: the whole point of
 *  cover is to stop taking damage, and crouching next to something that can suddenly
 *  deal an AoE hit of its own the moment the enemy puts a few rounds into it is the
 *  opposite of that, even though it genuinely blocks line of sight right up until then. */
function isExplosiveObstacle(o: Obstacle): boolean {
    const def = MapObjectDefs.typeToDef(o.type) as ObstacleDef;
    return !!def.explosion;
}

/** How close a cover *candidate* is allowed to sit to some *other* live explosive
 *  obstacle nearby, not just the one it's actually hiding behind - past
 *  `explosion_barrel`'s own blast radius (12, `explosionsDefs.ts`) with margin. Cover
 *  chosen behind an ordinary crate that happens to be sitting right next to a barrel is
 *  just as much in the blast as cover that picked the barrel itself. */
const BARREL_DANGER_RADIUS = 14;

function nearLiveExplosive(objs: GameObject[], pos: Vec2, layer: number): boolean {
    for (let i = 0; i < objs.length; i++) {
        if (objs[i].__type !== ObjectType.Obstacle) continue;
        const o = objs[i] as Obstacle;
        if (o.dead || !util.sameLayer(o.layer, layer)) continue;
        if (!isExplosiveObstacle(o)) continue;
        if (v2.lengthSqr(v2.sub(pos, o.pos)) < BARREL_DANGER_RADIUS * BARREL_DANGER_RADIUS) {
            return true;
        }
    }
    return false;
}

/** Whether `candidate` stays hidden from `threatPos` as more than just a single point -
 *  real bullets and LOS (`hasLineOfSight`) test against a player's actual collision
 *  circle, not its center. A cover spot whose center is blocked but whose near edge
 *  (the side of the bot's own hitbox closest to the threat) still peeks past the
 *  obstacle's silhouette isn't real cover: the bot can't see out (aim/fire needs a
 *  visible target) but can still be seen and hit, which reads as "stands in cover and
 *  gets shot anyway" - much weaker than actually being hidden, not just as strong.
 *
 *  Checks a point shifted `bot.rad + COVER_REACHED_DIST` toward the threat, not just
 *  `bot.rad`: `retreatToCover` calls this spot "reached" once within `COVER_REACHED_DIST`
 *  of it, so the bot's actual resting position can land that much closer to the threat
 *  than the ideal point - the hidden guarantee has to hold for that worst case too, not
 *  only for standing exactly on the computed spot. */
/** How long a dodge after a hit lasts, and how hard it steps across the enemy's line. */
export const DODGE_DURATION_S = 0.4;
const DODGE_STRENGTH = 1;

/** How hard a retreating bot weaves sideways, as a fraction of its forward move. */
const SHAKE_AMPLITUDE = 0.6;

/**
 * Weaves a bot side to side: the lean flips every 0.15 to 0.45 seconds, quick enough to read as a
 * shake rather than ordinary strafing, so a moving bot is harder to aim at.
 */
function shakeRetreat(state: BotMovementState, move: Vec2, toThreat: Vec2, dt: number): Vec2 {
    state.shakeTimer -= dt;
    if (state.shakeTimer <= 0) {
        state.shakeSign = Math.random() < 0.5 ? 1 : -1;
        state.shakeTimer = util.random(0.15, 0.45);
    }
    return v2.add(move, v2.mul(v2.perp(toThreat), state.shakeSign * SHAKE_AMPLITUDE));
}

/** How far one retreat step looks ahead when checking whether it lands hidden. */
const HIDDEN_STEP_DIST = 2;

/**
 * Picks the step direction for a retreat so the bot stays out of the enemy's line where it can.
 * The planned direction wins if the step lands hidden; otherwise the sideways steps, then the step
 * back the way it came. If none lands hidden, the planned direction stands - nothing is worse than
 * a step that stays exposed, so this only ever improves on it.
 */
export function hiddenStepDirection(
    bot: Player,
    navObstacles: Obstacle[],
    threatPos: Vec2,
    layer: number,
    dir: Vec2,
): Vec2 {
    const side = v2.perp(dir);
    for (const cand of [dir, side, v2.neg(side), v2.neg(dir)]) {
        const landing = v2.add(bot.pos, v2.mul(cand, HIDDEN_STEP_DIST));
        if (isBodyHidden(bot, navObstacles, threatPos, landing, layer)) return cand;
    }
    return dir;
}

export function isBodyHidden(
    bot: Player,
    navObstacles: Obstacle[],
    threatPos: Vec2,
    candidate: Vec2,
    layer: number,
): boolean {
    const towardThreat = v2.normalizeSafe(v2.sub(threatPos, candidate), v2.create(0, 0));
    const worstCase = v2.add(candidate, v2.mul(towardThreat, bot.rad + COVER_REACHED_DIST));
    return !isWalkClear(navObstacles, threatPos, worstCase, layer);
}

/** How much closer a fresh candidate has to be than the currently-held cover obstacle
 *  before `findCover` actually switches to it - see the `preferred` param's own doc
 *  comment for why this exists. */
const COVER_STICKINESS_MARGIN = 5;

/** How many consecutive `COVER_RECOMPUTE_INTERVAL` recomputes `retreatToCover` tolerates
 *  `findCover` finding *nothing at all* for the still-alive obstacle it's currently
 *  holding, before actually giving up on it - see `retreatToCover`. A real match capture
 *  showed the exact same physical cover point (identical coordinates) get found, then
 *  vanish, then get found again, over and over across several seconds: `isBodyHidden`'s
 *  hidden/exposed verdict for a candidate depends only on `threatPos` (the candidate
 *  itself is derived purely from the obstacle's own position, not the bot's), and
 *  `threatPos` - a live, sometimes-estimated read on a moving opponent - can cross that
 *  verdict's boundary and back within a single recompute window without the bot's actual
 *  situation having changed at all. Every one of those blips was, until now, treated
 *  identically to "the enemy really did move somewhere that invalidates this cover":
 *  `settledAtCover` got reset and the bot walked back toward the same spot from scratch,
 *  so the peek cycle - which only ever starts once `settledAtCover` is true - never got a
 *  real chance to run, reading as "reaches cover, then never actually peeks" for the
 *  entire fight. `1` (not higher): a `findCover` miss that repeats past a single
 *  recompute is far more likely a genuine loss of that cover than jitter, and holding a
 *  stale, no-longer-valid spot for several seconds while "generously" tolerating misses
 *  would recreate the exact camping-blind risk `PUSH_DETECT_MARGIN`/`SETTLED_MAX_S` exist
 *  to catch, just through a different door. */
const COVER_MISS_GRACE = 1;

/** How much closer to the threat a *fresh* cover pick is allowed to be than the bot's
 *  own current distance, while fleeing - see `findCover`'s own doc comment on
 *  `avoidInterior`. A small tolerance, not zero: the bot's own position wobbles a little
 *  tick to tick (strafing, local deflection), and a candidate that's only a hair closer
 *  than "current distance" because of that noise is still a perfectly reasonable pick,
 *  not the multi-unit regression this exists to catch. */
const COVER_APPROACH_MARGIN = 3;

/** How many of a pool's nearest-to-bot candidates actually get evaluated for enemy
 *  reachability - see `filterByReachability`. Bounded, not every surviving candidate:
 *  each one costs a real nav-graph A* search in both directions (bot and threat), and a
 *  dense obstacle cluster can turn up a dozen+ otherwise-equal candidates after the
 *  existing hidden/distance filters. Evaluating only the ones already closest to the bot
 *  - which `pickFrom` was going to prefer anyway on plain distance - never discards a
 *  candidate that could actually have won; it only skips spending a search budget on ones
 *  `pickFrom` would have passed over regardless. */
const REACHABILITY_CANDIDATES = 3;
/** How many candidates a retreat checks for reachability - wider than the usual 3, so a safe spot
 *  further back is still found when the nearest few are all ones the enemy reaches as fast. */
const RETREAT_REACHABILITY_CANDIDATES = 8;
/** Expansion budget for each reachability probe - well under `MAX_PATH_EXPANSIONS`
 *  (the bot's own real movement path): this only needs a *relative* comparison between a
 *  handful of nearby candidates on an arena-scale graph, not a guaranteed solve of a
 *  long-range route. Smaller than `followPath`'s own budget also because
 *  `pathCostEstimate` runs an unheaped linear scan for its cheapest open node each step
 *  (see its own doc comment on why it can't reuse `findPath`'s heap-based search as-is) -
 *  fine at this size, not at `MAX_PATH_EXPANSIONS`'s. */
const REACHABILITY_MAX_EXPANSIONS = 150;
/** How much longer the enemy's own nav-graph route to a cover candidate has to be than
 *  the bot's, before that candidate counts as genuinely defensible - see
 *  `filterByReachability`. A candidate the enemy can reach in roughly the same time it
 *  takes the bot (or faster) offers no real window: by the time the bot settles in, the
 *  enemy may already be standing at the exact spot that re-exposes it. "der Bot muss sich
 *  überlegen über welche Wege der Gegner wie schnell erreichbar ist, um die richtige
 *  Deckung zu wählen" - deliberately a first-pass value, not real-match-tuned yet (no
 *  decoded capture of this specific failure mode exists to calibrate against the way
 *  most constants in this file are) - some real margin past plain position/path noise (a
 *  handful of units, the same scale as `COVER_APPROACH_MARGIN`/`COVER_STICKINESS_MARGIN`
 *  above), not a precisely measured number. */
const REACHABILITY_MARGIN = 6;
/** How far a cover point's real walking route may be, relative to the straight line to it,
 *  before the bot counts it as unreachable in practice - see filterByReachability.
 *  Plus COVER_DETOUR_SLACK, so a short point right next to the bot never fails on
 *  grid-sampling granularity alone. */
const COVER_MAX_DETOUR = 2.5;
const COVER_DETOUR_SLACK = 16;
/** How many nav nodes further from the threat than a cover spot must be reachable from it
 *  for the spot to count as having a way out - see hasEscapeRoom. */
const ESCAPE_ROOM_NODES = 4;
/** Graph nodes a hasEscapeRoom search may visit before giving up. */
const ESCAPE_ROOM_SEARCH = 80;
/** How much further from the threat than the spot itself a node has to be to count as
 *  an escape route rather than more of the same pocket. */
const ESCAPE_ROOM_MARGIN = 6;

/** Whether a fleeing bot can keep going from pos - enough graph nodes reachable from there
 *  lead further from the threat. A spot in a corner or a dead-end pocket (a real match: the
 *  bot retreated into the map's edge and was pushed down with nowhere left to go) fails it,
 *  however well hidden. */
function hasEscapeRoom(nav: NavGraph, pos: Vec2, threatPos: Vec2, layer: number): boolean {
    const start = nav.nearest(pos, layer);
    // No connections at all means no graph to judge by, not a dead end.
    if (start < 0 || nav.neighbors[start].length === 0) return true;
    const farther = v2.distance(pos, threatPos) + ESCAPE_ROOM_MARGIN;
    const seen = new Set<number>([start]);
    const queue: number[] = [start];
    let found = 0;
    for (let i = 0; i < queue.length && i < ESCAPE_ROOM_SEARCH; i++) {
        const cur = queue[i];
        if (v2.distance(nav.pos(cur), threatPos) > farther) {
            found++;
            if (found >= ESCAPE_ROOM_NODES) return true;
        }
        for (const next of nav.neighbors[cur]) {
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }
    return false;
}

/** Rough nav-graph path-length estimate between two points - used to compare how long
 *  the BOT needs to reach a cover candidate against how long the ENEMY would need to
 *  reach (or flank around to) that same spot, see `filterByReachability`. A fresh,
 *  throwaway search each call, not reusing `followPath`'s own path state - this is pure
 *  comparison between candidates, never actually walked.
 *
 *  Deliberately its own small search, not a call into `findPath`: `findPath` seeds every
 *  node within `NODE_SEARCH_RADIUS` of the start at gScore *zero*, and treats arriving at
 *  any node within that same radius of the goal as "done" - both exactly right for
 *  actually steering a bot (a real nearby node is always a legitimate, similarly-cheap
 *  entry point in a densely-sampled real graph, and the last few units are covered by
 *  ordinary direct movement anyway) but wrong for *measuring* a distance between two
 *  specific points that might themselves sit fairly close together: it can silently let
 *  the search hop through some OTHER node that merely happens to also fall within that
 *  same generous radius of the destination, crediting a real detour's cost as if it were
 *  already "close enough", without ever actually paying for the edges that detour exists
 *  to avoid. Single exact nearest-node matching on both ends, plus the real leftover
 *  distance from/to those nodes added back in, has no such shortcut - the search can only
 *  reach the goal node via the graph's actual edges. Falls back to straight-line distance
 *  when the graph has no node at all on this layer, or no route is found within
 *  `REACHABILITY_MAX_EXPANSIONS` - still a usable (if optimistic) estimate rather than
 *  refusing to score the candidate at all. */
function pathCostEstimate(nav: NavGraph, from: Vec2, to: Vec2, layer: number): number {
    const startNode = nav.nearest(from, layer);
    const goalNode = nav.nearest(to, layer);
    if (startNode < 0 || goalNode < 0) return v2.distance(from, to);
    const leftover = v2.distance(from, nav.pos(startNode)) + v2.distance(nav.pos(goalNode), to);
    if (startNode === goalNode) return leftover;

    const gScore = new Map<number, number>([[startNode, 0]]);
    const visited = new Set<number>();
    for (let expansions = 0; expansions < REACHABILITY_MAX_EXPANSIONS; expansions++) {
        let cur = -1;
        let curG = Infinity;
        for (const [id, g] of gScore) {
            if (!visited.has(id) && g < curG) {
                curG = g;
                cur = id;
            }
        }
        if (cur < 0) break;
        if (cur === goalNode) return leftover + curG;
        visited.add(cur);

        const neighbors = nav.neighbors[cur];
        const costs = nav.costs[cur];
        for (let i = 0; i < neighbors.length; i++) {
            const next = neighbors[i];
            if (visited.has(next)) continue;
            const tentative = curG + costs[i];
            if (tentative < (gScore.get(next) ?? Infinity)) gScore.set(next, tentative);
        }
    }
    return v2.distance(from, to);
}

export type CoverCandidate = { obstacle: Obstacle; pos: Vec2; distSqr: number };

/** Drops any of `candidates`' nearest-to-bot entries (see `REACHABILITY_CANDIDATES`) the
 *  enemy could reach about as fast as the bot, or faster - see `REACHABILITY_MARGIN`.
 *  Straight-line distance from the threat (`approachBaseline`'s own check, in `findCover`
 *  below) already catches a candidate on the wrong side of the threat entirely, but says
 *  nothing about a candidate that's further away in a straight line yet sits right next
 *  to a short, direct route for the enemy to flank around to - exactly the geometry a
 *  building corner or an obstacle cluster creates.
 *
 *  `preferred` (the currently-held obstacle, if any) is always kept in the running
 *  regardless of its own score, and force-included in the evaluated set even if it
 *  wouldn't otherwise make the nearest-`REACHABILITY_CANDIDATES` cut - same reasoning as
 *  `pickFrom`'s own stickiness just below: a held piece of cover that becomes marginally
 *  less defensible by this measure on one recompute isn't a reason to drop it from
 *  consideration outright, only `pickFrom`'s normal distance-based competition should
 *  ever actually unseat it. Returns the single nearest candidate, unfiltered, if
 *  literally nothing clears the bar - the same "something beats nothing" fallback
 *  `findCover` already relies on for its interior-candidates pool. */
export function filterByReachability(
    nav: NavGraph,
    bot: Player,
    threatPos: Vec2,
    layer: number,
    preferred: Obstacle | undefined,
    candidates: CoverCandidate[],
    rankByWalk = false,
    shortlistSize = REACHABILITY_CANDIDATES,
): CoverCandidate[] {
    if (!candidates.length) return candidates;
    const sorted = [...candidates].sort((a, b) => a.distSqr - b.distSqr);
    const shortlist = sorted.slice(0, shortlistSize);
    if (preferred) {
        const preferredEntry = candidates.find((c) => c.obstacle === preferred);
        if (preferredEntry && !shortlist.includes(preferredEntry)) shortlist.push(preferredEntry);
    }
    // The bot's own real walk to each candidate, computed once per candidate. A point behind
    // a wall whose only route in is a long way round (a real match: the bot wedged against
    // a building's wall for seconds, its cover point inside the building) is no cover at
    // all, however far the enemy is from it.
    const walk = new Map<CoverCandidate, number>();
    const walkTo = (entry: CoverCandidate): number => {
        let cost = walk.get(entry);
        if (cost === undefined) {
            cost = pathCostEstimate(nav, bot.pos, entry.pos, layer);
            walk.set(entry, cost);
        }
        return cost;
    };
    const botCanReach = (entry: CoverCandidate): boolean =>
        walkTo(entry) <= v2.distance(bot.pos, entry.pos) * COVER_MAX_DETOUR + COVER_DETOUR_SLACK;
    const usable = (entry: CoverCandidate): boolean =>
        botCanReach(entry) && hasEscapeRoom(nav, entry.pos, threatPos, layer);
    const kept = shortlist.filter((entry) => {
        if (!usable(entry)) return false;
        if (entry.obstacle === preferred) return true;
        const enemyCost = pathCostEstimate(nav, threatPos, entry.pos, layer);
        return enemyCost - walkTo(entry) >= REACHABILITY_MARGIN;
    });
    const fallback = sorted.find(usable);
    const result = kept.length ? kept : fallback ? [fallback] : [];
    if (!rankByWalk) return result;
    // Critical under pressure: the closest cover by straight line isn't necessarily the one
    // the bot reaches first - rank the survivors by the real walk instead, reusing
    // `pickFrom`'s nearest-wins logic on the walk length.
    return result.map((entry) => {
        const walkCost = walkTo(entry);
        return { ...entry, distSqr: walkCost * walkCost };
    });
}

/** Picks the nearest point (to the bot) that sits just past a live, collidable obstacle
 *  as seen from `threatPos` - real cover, not just "away from the enemy". Every
 *  candidate is checked against the *current* state of the obstacle it hides behind
 *  (`dead`/`collidable`), so a piece of cover that gets shot apart is never handed out;
 *  the caller (`updateMovement`) also re-checks that same obstacle every tick it's
 *  held, not just when this is called, so cover dying out from under the bot mid-fight
 *  drops it immediately rather than on the next recompute.
 *
 *  `preferred` (`retreatToCover`'s currently-held `coverObstacle`, if any) - real match
 *  evidence: with two obstacles sitting nearly equidistant from the bot, which one comes
 *  out "nearest" can flip from one recompute to the next as the bot's own position shifts
 *  by fractions of a unit, and at `COVER_RECOMPUTE_INTERVAL`'s pace (well under a tenth
 *  of a second for a high-aggression tier) that read as the bot's retreat direction
 *  reversing almost every tick - stuck oscillating between two cover spots, making real
 *  progress toward neither, for multiple real seconds with a visible target it never
 *  fired at. Still preferring the currently-held obstacle unless something else is
 *  genuinely closer by a real margin, not just a coin-flip's worth, is the same
 *  "commit to a choice, don't re-decide every tick" fix already applied to local-obstacle
 *  deflection, `followPath`'s direct-vs-routed check, and idle-goal hysteresis.
 *
 *  `approachBaseline` (only passed while actually fleeing, not mid-fight peek-cover -
 *  see `retreatToCover`'s own call, which threads through the distance it already had a
 *  moment ago, captured *before* a dead cover obstacle's reset could wipe it) rejects any
 *  candidate closer to the threat than that baseline - a fresh pick that would mean
 *  closing distance just to reach it. A real match capture showed the bot's held cover
 *  obstacle die mid-approach (likely shot apart - the enemy stayed visible the whole
 *  time), and the replacement `findCover` picked next was a *different* obstacle over 25
 *  units away in roughly the threat's own direction - "nearest to the bot" alone says
 *  nothing about which side of the threat that nearest point sits on. The bot then
 *  walked that whole distance in full view, closing from 25 units down to 6 before the
 *  pursuer finished it. `undefined` (never held any cover at all yet this engagement) -
 *  not just "no obstacle currently held", which a same-tick death reset can't tell apart
 *  from a genuine first pick - skips the check entirely: there's nothing to regress
 *  *from* on a real first pick, and a bot simply starting out farther from the threat
 *  than literally every piece of cover nearby is completely ordinary, not a regression.
 *
 *  `avoidInterior` separately gates a second, independent fleeing-only preference:
 *  "Gebäude nur zum Durchlaufen nutzen, nicht zu lange drin bleiben" - a real match
 *  capture showed a fleeing bot commit to a cover candidate that happened to sit on a
 *  building's `interior` lattice, then stall for the better part of a second working
 *  `followPath`/a door to actually reach it while the enemy closed in and finished it -
 *  a building makes a fine thing to run *through* on the way to real distance, a poor
 *  thing to detour *into* and get held up navigating just to hide behind whatever's
 *  sitting in that specific room. Non-interior candidates are preferred as their own
 *  pool whenever any exist at all; interior ones are only ever handed out as a last
 *  resort, exactly the same fallback shape `preferNonInteriorGoal` already uses for a
 *  retreat's raw destination.
 *
 *  `avoidInterior` also gates a third, independent preference: `filterByReachability`
 *  drops the nearest-to-bot candidates the enemy could reach (via its own nav-graph
 *  route, not just straight-line distance) about as fast as the bot, or faster - a
 *  candidate on the far side of a wall from both the bot's actual approach and the
 *  enemy's own straight-line position can still sit right next to a short way around for
 *  the enemy to flank through, which plain "far enough from the threat right now"
 *  (`minDistFromThreat`/`approachBaseline`) never catches on its own.
 *
 *  `noInteriorFallback` turns the interior pool's own "last resort, something beats
 *  nothing" fallback off entirely - a real match capture showed a critically hurt bot,
 *  reacquired by its pursuer mid-flee, commit to the nearest interior pick (the only
 *  candidate left once the open pool was empty near a map edge) and die approaching it,
 *  never actually reaching cover at all. A building is still a perfectly good thing to
 *  retreat *through*, but gambling critical health on navigating into one specifically
 *  (a door, an unfamiliar room) under direct fire is a worse bet than just continuing an
 *  already-working, already-pathfound open retreat (`retreatDirection`, what the caller
 *  falls back to when `findCover` returns nothing at all) - not finding cover here isn't
 *  the same failure as it is for a merely-low, not-yet-critical retreat with time to
 *  spare, which still wants the interior fallback over nothing. */
export function findCover(
    bot: Player,
    navObstacles: Obstacle[],
    threatPos: Vec2,
    minDistFromThreat = 0,
    preferred?: Obstacle,
    avoidInterior?: NavGraph,
    approachBaseline?: number,
    noInteriorFallback = false,
    searchRad = COVER_SEARCH_RAD,
): { obstacle: Obstacle; pos: Vec2 } | undefined {
    const layer = util.toGroundLayer(bot.layer);
    const aabb = collider.createAabbExtents(bot.pos, v2.create(searchRad, searchRad));
    const objs = bot.game.grid.intersectCollider(aabb);
    const minDistSqr = minDistFromThreat * minDistFromThreat;

    const openCandidates: CoverCandidate[] = [];
    const interiorCandidates: CoverCandidate[] = [];

    for (let i = 0; i < objs.length; i++) {
        if (objs[i].__type !== ObjectType.Obstacle) continue;
        const o = objs[i] as Obstacle;
        if (o.dead || !o.collidable || isOpenableDoor(o)) continue;
        if (!util.sameLayer(o.layer, bot.layer)) continue;
        if (isExplosiveObstacle(o)) continue;

        const away = v2.normalizeSafe(v2.sub(o.pos, threatPos), v2.create(0, 0));
        if (v2.length(away) < 0.01) continue; // bot's obstacle sits exactly on the threat - degenerate
        const candidate = v2.add(o.pos, v2.mul(away, obstacleRadius(o) + COVER_BUFFER));

        // Not just hidden - genuinely far from the threat too, when the caller asks for
        // it (healing: a piece of cover 3 units from an active fight is technically
        // "hidden" but still much too close to safely stop and bandage behind).
        if (v2.lengthSqr(v2.sub(candidate, threatPos)) < minDistSqr) continue;
        if (!pointClear(bot.game, navObstacles, candidate, layer, bot.rad)) continue;
        if (!isBodyHidden(bot, navObstacles, threatPos, candidate, layer)) continue; // still exposed
        // Not just excluding a barrel *as* cover - a candidate right next to one is
        // just as much in the blast as picking the barrel itself would be.
        if (nearLiveExplosive(objs, candidate, layer)) continue;
        // See this function's own doc comment on `approachBaseline`.
        if (
            approachBaseline !== undefined
            && o !== preferred
            && v2.distance(candidate, threatPos) < approachBaseline - COVER_APPROACH_MARGIN
        ) {
            continue;
        }

        const distSqr = v2.lengthSqr(v2.sub(bot.pos, candidate));
        const entry = { obstacle: o, pos: candidate, distSqr };
        const nearestNode = avoidInterior?.nearest(candidate, layer) ?? -1;
        const isInterior = nearestNode >= 0 && avoidInterior!.kind[nearestNode] === "interior";
        (isInterior ? interiorCandidates : openCandidates).push(entry);
    }

    const pickFrom = (candidates: CoverCandidate[]): CoverCandidate | undefined => {
        let best: CoverCandidate | undefined;
        let preferredPick: CoverCandidate | undefined;
        for (const entry of candidates) {
            if (!best || entry.distSqr < best.distSqr) best = entry;
            if (entry.obstacle === preferred) preferredPick = entry;
        }
        if (!preferredPick) return best;
        if (!best || best.obstacle === preferred) return preferredPick;
        // Plain distances, not squared - for two picks this close (the whole point is
        // catching near-ties), the squared difference shrinks with their absolute
        // distance from the bot (distSqr_a - distSqr_b = (a-b)(a+b)), so comparing it
        // directly against a squared margin would only tolerate a real difference of a
        // fraction of a unit at any realistic cover range, not the intended
        // `COVER_STICKINESS_MARGIN`.
        const preferredDist = Math.sqrt(preferredPick.distSqr);
        const bestDist = Math.sqrt(best.distSqr);
        return preferredDist - bestDist < COVER_STICKINESS_MARGIN ? preferredPick : best;
    };

    // Reachability only while genuinely fleeing, not mid-fight `holdAndPeek` cover -
    // `avoidInterior` is exactly that signal already (see this function's own doc
    // comment), reused here rather than adding a second near-duplicate flag.
    // A retreat (a wider search than usual) checks more candidates and ranks them by real walk.
    const routeAware = searchRad > COVER_SEARCH_RAD;
    const shortlistSize = routeAware ? RETREAT_REACHABILITY_CANDIDATES : REACHABILITY_CANDIDATES;
    const openPool = avoidInterior
        ? filterByReachability(
            avoidInterior,
            bot,
            threatPos,
            layer,
            preferred,
            openCandidates,
            noInteriorFallback || routeAware,
            shortlistSize,
        )
        : openCandidates;
    const picked = openPool.length
        ? pickFrom(openPool)
        : noInteriorFallback
        ? undefined
        : pickFrom(
            avoidInterior
                ? filterByReachability(
                    avoidInterior,
                    bot,
                    threatPos,
                    layer,
                    preferred,
                    interiorCandidates,
                    noInteriorFallback || routeAware,
                    shortlistSize,
                )
                : interiorCandidates,
        );
    return picked ? { obstacle: picked.obstacle, pos: picked.pos } : undefined;
}

/** A point near `coverObstacle`'s edge, off to one side of "directly behind", that IS
 *  visible from `threatPos` - leaning out around the corner of cover rather than
 *  standing fully in the open. Tries progressively wider angles (`PEEK_ANGLES`);
 *  returns undefined if none clear (thin/oddly-shaped cover, or it died in the
 *  meantime), in which case the caller just keeps hiding. */
function findPeekSpot(
    bot: Player,
    navObstacles: Obstacle[],
    coverObstacle: Obstacle,
    threatPos: Vec2,
): Vec2 | undefined {
    if (coverObstacle.dead || !coverObstacle.collidable) return undefined;
    const layer = util.toGroundLayer(bot.layer);
    const away = v2.normalizeSafe(v2.sub(coverObstacle.pos, threatPos), v2.create(0, 0));
    if (v2.length(away) < 0.01) return undefined;
    const rad = obstacleRadius(coverObstacle) + COVER_BUFFER;

    for (const angle of PEEK_ANGLES) {
        const dir = v2.rotate(away, angle);
        const candidate = v2.add(coverObstacle.pos, v2.mul(dir, rad));
        if (!pointClear(bot.game, navObstacles, candidate, layer, bot.rad)) continue;
        if (!isWalkClear(navObstacles, threatPos, candidate, layer)) continue;
        return candidate;
    }
    return undefined;
}

/** Cycles a bot already at cover between hiding (`coverPos` - LOS to the threat fully
 *  blocked, no shot in or out) and peeking (`peekPos` - a brief lean out that regains
 *  line of sight, long enough to trade shots) instead of just standing at cover
 *  forever. This only owns the movement: perception (`BotBrain.think`) naturally
 *  reacquires the target during the exposed phase and loses it again once back in
 *  hiding, so firing falls out of the existing aim/fire pipeline for free. */
function updatePeekCycle(
    bot: Player,
    state: BotMovementState,
    nav: NavGraph,
    threatPos: Vec2,
    dt: number,
    recentlyVisible: boolean,
    aggression: number | undefined,
): Vec2 {
    state.peekTimer -= dt;
    if (state.peekTimer <= 0) {
        if (state.peeking) {
            state.peeking = false;
            state.peekPos = undefined;
            const pace = peekPaceMult(aggression);
            state.peekTimer = recentlyVisible
                ? util.random(EAGER_PEEK_HOLD_MIN, EAGER_PEEK_HOLD_MAX) * pace
                : util.random(PEEK_HOLD_MIN, PEEK_HOLD_MAX) * pace;
        } else {
            const spot = findPeekSpot(bot, nav.navObstacles, state.coverObstacle!, threatPos);
            if (spot) {
                state.peeking = true;
                state.peekPos = spot;
                state.peekTimer = util.random(PEEK_EXPOSE_MIN, PEEK_EXPOSE_MAX)
                    * peekExposeMult(aggression);
            } else {
                state.peekTimer = PEEK_RETRY_DELAY;
            }
        }
    }

    const dest = state.peeking ? state.peekPos : state.coverPos;
    if (!dest || v2.distance(bot.pos, dest) < PEEK_REACHED_DIST) return v2.create(0, 0);
    return v2.normalizeSafe(v2.sub(dest, bot.pos));
}

/** Minimum plain distance from the threat before it's safe to start healing when no
 *  cover was found to hide behind instead - "create distance, then heal", not "start
 *  healing wherever the `heal` directive happened to be chosen". Also the minimum
 *  distance a piece of cover itself must have from the threat to count while healing
 *  (see `retreatToCover`'s `minCoverDist`) - a spot 3 units from an active fight can be
 *  technically hidden without being remotely safe to stop and bandage behind.
 *
 *  Lowered from 20: real match analysis (god-view track data) against a persistent
 *  opponent on the compact arena map showed distance rarely holding past ~25-30 units
 *  for more than a moment before the chase closes back in - a 20-unit bar was cleared
 *  so rarely in practice that the bot ended up never actually healing at all, just
 *  slowly losing a war of attrition on passive regen alone between bursts. 16 is still
 *  a real gap (past most weapons' effective spray range), just one this specific
 *  matchup can actually reach and hold for the brief window a bandage needs. */
const SAFE_HEAL_DIST = 16;

/** How far a critically hurt bot will walk to reach its cover before healing in place
 *  instead. Real matches showed bots at 13-19 HP walk 17-25 units across open ground to a
 *  cover point (healing only once on it) and die on the way, or while healing short of it,
 *  to an enemy that closed in unseen. A walk this short is still worth it; a longer one
 *  isn't, as long as nothing can currently see the bot. */
const CRITICAL_COVER_WALK_MAX = 8;

/** How close to its cover point a bot has to be to start a heal there - looser than
 *  `COVER_REACHED_DIST`, which is the exact spot a bot never quite stops on. See `isSafeToHeal`. */
const HEAL_START_COVER_DIST = 3;

/** Same idea as `SAFE_HEAL_DIST`, but for retreating to reload instead of to heal - a
 *  shorter distance, since being out of ammo is more urgent to resolve (there's nothing
 *  to fight back with in the meantime) and reloading is generally quicker than healing
 *  up from a real deficit. */
const SAFE_RELOAD_DIST = 12;

/** How much further past its own `minCoverDist` (see `retreatToCover`) a heal/flee/
 *  reload retreat keeps pushing before it's willing to actually stop moving - "der Bot
 *  bleibt einfach hinter Deckung stehen, wo er leicht pushbar ist". The bar to *start*
 *  the heal itself (`isSafeToHeal`) stays exactly `minCoverDist` - unchanged, so healing
 *  still begins the moment real separation exists - but standing rooted at the very
 *  first spot that barely cleared that bar is an easy target the instant a fast pursuer
 *  closes it back in. Scales off `minCoverDist` rather than a flat number so a heal
 *  (which already demanded more separation) also keeps pushing further than a quick
 *  reload does. */
const RETREAT_SETTLE_MULT = 1.75;
/** How much closer the threat has to have gotten since `distAtSettle` was recorded
 *  before settled-at-cover treats it as genuinely closing in, not just position noise
 *  (the bot's own peek-adjacent micro-movement, a `threatPos` fallback swapping to a
 *  slightly different remembered point) - see `retreatToCover`'s "threat closing in"
 *  check. */
const PUSH_DETECT_MARGIN = 4;
/** How far the threat has to have moved round from where a bot settled before its cover is
 *  re-picked against the new angle - see `threatShifted` in `retreatToCover`. */
const THREAT_SHIFT_RECOVER_DIST = 5;
/** How long settled-at-cover is willing to sit fully still with no threat signal at all
 *  before treating that silence itself as a reason to move again - see the "settled too
 *  long" check below. A real match capture showed a bot camp one exact spot for 7.6
 *  straight seconds chaining multiple heals, getting silently walked up on and killed
 *  the instant the enemy reappeared with no warning - `stillExposed`/`threatClosingIn`
 *  both need *some* signal (a sighting, a heard shot) to fire at all, and a quiet push
 *  simply never produces one until it's already too late.
 *
 *  Cut hard from 3.5 down to 1.2 after a second real capture: a bot went completely
 *  still at 46 units' last-known separation, healed blind for 3.39s - just *under* the
 *  old bar - and took a lethal hit the instant the enemy reappeared already at point-
 *  blank range, having closed that entire gap silently the whole time. 3.5 was chosen
 *  to "comfortably clear a single bandage/heal-item cycle uninterrupted" - a mistaken
 *  premise: resuming movement here doesn't touch `actionType` at all, so an in-progress
 *  heal keeps ticking to completion exactly the same whether this fires after 1.2s or
 *  10s (see `Player.cancelAction`'s actual call sites - none of them are movement).
 *  There is no real bandage-completion cost to cutting this down hard, only upside: less
 *  time spent as a stationary, silently-trackable target the instant nothing else is
 *  telling the bot to move. */
const SETTLED_MAX_S = 1.2;

/** Moves toward, then holds at, cover from `threatPos` - shared by healing, fleeing,
 *  reloading, and (with `holdAndPeek`) holding a mid-fight position instead of standing
 *  in the open. `holdAndPeek` cycles peeking out once cover is reached (see
 *  `updatePeekCycle`, `recentlyVisible`); without it the bot just hunkers down
 *  (healing/reloading), or if no cover exists nearby, keeps opening distance (fleeing) -
 *  `holdAndPeek` falls back to plain lateral strafing in that case instead, since
 *  standing still exposed with nothing to hide behind is strictly worse.
 *
 *  `minCoverDist` is how far from the threat a candidate cover spot must itself be to
 *  count (0 for `holdAndPeek`, which is holding an already-acceptable range rather than
 *  trying to put real distance between itself and the threat).
 *
 *  `critical` (never set for `holdAndPeek` - see `findCover`'s own doc comment on
 *  `noInteriorFallback`) refuses the interior-cover fallback: a critically hurt bot with
 *  nothing better nearby should keep running an already-working open retreat rather than
 *  gamble on navigating into an unfamiliar building under direct fire. */
function retreatToCover(
    bot: Player,
    state: BotMovementState,
    nav: NavGraph | undefined,
    threatPos: Vec2,
    dt: number,
    holdAndPeek: boolean,
    recentlyVisible: boolean,
    minCoverDist: number,
    aggression: number | undefined,
    critical: boolean,
): Vec2 {
    // Captured before the death-check below can wipe `coverPos` this same tick - see
    // `findCover`'s own doc comment on `approachBaseline`. Whatever distance the bot
    // already had a moment ago (cover obstacle dead or not) is the right "don't regress
    // below this" baseline for the recompute just below; `undefined` (never held any
    // cover at all yet) means there's nothing to regress *from*, so no constraint.
    const priorSafeDist = state.coverPos ? v2.distance(bot.pos, threatPos) : undefined;

    if (state.coverObstacle?.dead || state.coverObstacle?.collidable === false) {
        state.coverObstacle = undefined;
        state.coverPos = undefined;
        state.settledAtCover = false;
        state.distAtSettle = undefined;
        state.settledForS = 0;
        state.pushedPastCover = false;
        state.approachDir = undefined;
        state.coverRecheck = 0;
        state.coverMissStreak = 0;
        state.peeking = false;
    }
    state.coverRecheck -= dt;
    // Keep the held cover while it still hides the bot: a closer candidate showing up on a re-pick
    // isn't a reason to switch, and switching every recompute walked the bot in circles. Only a cover
    // the threat can now see is re-picked.
    const heldStillHidden = !holdAndPeek && !!nav && !!state.coverPos && !!state.coverObstacle
        && !state.coverObstacle.dead && state.coverObstacle.collidable
        && isBodyHidden(bot, nav.navObstacles, threatPos, state.coverPos, util.toGroundLayer(bot.layer))
        && v2.distance(state.coverPos, threatPos) >= minCoverDist;
    if (heldStillHidden && state.coverRecheck <= 0) {
        state.coverRecheck = COVER_RECOMPUTE_INTERVAL * coverRecomputeMult(aggression);
        state.coverMissStreak = 0; // the held cover is valid again, so any earlier miss is over
    }
    if (nav && (!state.coverPos || (state.coverRecheck <= 0 && !heldStillHidden))) {
        state.coverRecheck = COVER_RECOMPUTE_INTERVAL * coverRecomputeMult(aggression);
        const found = findCover(
            bot,
            nav.navObstacles,
            threatPos,
            minCoverDist,
            state.coverObstacle,
            holdAndPeek ? undefined : nav,
            holdAndPeek ? undefined : priorSafeDist,
            !holdAndPeek && critical,
            holdAndPeek ? COVER_SEARCH_RAD : RETREAT_COVER_SEARCH_RAD,
        );
        if (
            !found
            && state.coverObstacle
            && !state.coverObstacle.dead
            && state.coverObstacle.collidable
            && state.coverMissStreak < COVER_MISS_GRACE
        ) {
            // A single miss on an obstacle that's still perfectly good, physically
            // unchanged cover - see `COVER_MISS_GRACE`. Hold the current spot exactly as
            // if this recompute never happened, rather than treating one blip the same
            // as a genuine loss.
            state.coverMissStreak++;
        } else if (
            // Past the grace period with nothing fresh found: before dropping cover entirely, check
            // whether the obstacle already held is still genuinely hiding the bot, `minCoverDist`
            // aside - a real match had this exact spot dropped (not even switched to something else,
            // just abandoned) purely because an actively chasing threat had closed within
            // `minCoverDist` of it, with the exact same obstacle still just as able to hide the bot.
            // 24 cover-target changes in one match, settled at cover only 29.5% of the time it had
            // one, 7 of 8 big hits landed while still "en route" to a target that kept sliding away
            // before arrival. A threat the bot has genuinely lost its hiding from either way still
            // loses the cover here (that fails `isBodyHidden` too, same as before) - only raw
            // proximity to an otherwise still-hidden spot no longer does.
            !found && state.coverObstacle && !state.coverObstacle.dead && state.coverObstacle.collidable
            && !!state.coverPos
            && isBodyHidden(bot, nav.navObstacles, threatPos, state.coverPos, util.toGroundLayer(bot.layer))
        ) {
            state.coverMissStreak = 0; // still genuinely hidden - the miss was purely about distance
        } else {
            state.coverMissStreak = 0;
            // Only treat this as a genuinely new spot - not just the periodic recompute
            // landing back on essentially the same point - as "un-arrive": resetting
            // `settledAtCover` on every recompute would interrupt an in-progress peek every
            // `COVER_RECOMPUTE_INTERVAL` (0.4s), well inside a single peek's own exposure
            // window, forcing the bot back to `coverPos` before it ever really leaned out.
            if (!found || !state.coverPos || v2.distance(state.coverPos, found.pos) > 0.5) {
                state.settledAtCover = false;
                state.distAtSettle = undefined;
                state.settledForS = 0;
                state.pushedPastCover = false;
                state.approachDir = undefined;
            }
            state.coverObstacle = found?.obstacle;
            state.coverPos = found?.pos;
        }
    }

    if (!state.coverPos) {
        // Holding a mid-fight range with nothing to hide behind: stay put laterally
        // rather than committing to a long pathfound retreat away from an already
        // acceptable distance. A genuine retreat (healing/fleeing/reloading) routes
        // through the nav graph instead of a raw straight line, same reasoning as
        // `close`/`push` - walking directly into a building or a shipping container
        // with no route around it is exactly the "stuck on cover" bug this avoids.
        if (holdAndPeek) {
            const away = v2.normalizeSafe(v2.sub(bot.pos, threatPos));
            return v2.mul(v2.perp(away), state.strafeSign);
        }
        return retreatDirection(bot, state, nav, threatPos, dt, aggression);
    }

    // Approach `coverPos` itself only until first reached - once `settledAtCover`,
    // control hands off entirely to the peek cycle below, which does its own
    // navigation between `coverPos` and `peekPos`. Re-checking distance to `coverPos`
    // on every tick instead (as if the peek cycle didn't exist) is a real bug: a peek
    // walks the bot away from `coverPos` toward `peekPos` on purpose, and this check
    // would immediately see that as "not at cover" and snap it straight back - the
    // peek would never actually get anywhere before reversing, which reads as "barely
    // peeks at all" and leaves the bot lingering right at the cover/peek boundary
    // instead of either fully hidden or meaningfully exposed. Both the approach check
    // and the "far enough yet" push below must stay nested inside `!settledAtCover` for
    // exactly this reason - hoisting the approach check above it was tried once and
    // immediately broke peeking: `state.peeking` steers the bot to `peekPos`, which is
    // more than `COVER_REACHED_DIST` from `coverPos` by design, so an un-nested check
    // read that as "wandered off cover" and routed straight back to it every tick,
    // silently skipping `updatePeekCycle` (and so never touching `peekTimer`) for the
    // rest of the fight.
    if (!state.settledAtCover) {
        // `pushedPastCover` skips the approach check once it's true - see its own doc
        // comment on `BotMovementState`. Never set for `holdAndPeek`, which always
        // settles the instant it reaches its held range regardless of raw distance.
        const distToCover = v2.distance(bot.pos, state.coverPos);
        if (!state.pushedPastCover && distToCover > COVER_REACHED_DIST) {
            state.peeking = false;
            // Only ignore the cover obstacle itself once already close to the point
            // behind it - see `followPath`'s own doc comment on `ignore`. Farther out,
            // the obstacle's bulk can genuinely sit *between* the bot and that point
            // (approaching from the threat's own side of it, say), where routing around
            // it is still exactly correct - only the final couple of units, where the
            // straight line is naturally grazing the obstacle's edge by design, should
            // skip pathing around it entirely.
            const pathDir = nav
                ? followPath(
                    bot,
                    state,
                    nav,
                    state.coverPos,
                    dt,
                    distToCover < COVER_APPROACH_IGNORE_DIST ? state.coverObstacle : undefined,
                )
                : undefined;
            if (pathDir) {
                state.approachDir = undefined; // a real path is doing the steering now
                return pathDir;
            }
            // See `APPROACH_TURN_RATE`'s own doc comment - raw-steering straight at a
            // nearby point gets numerically unstable as the remaining distance shrinks,
            // so this slews toward it at a bounded turn rate instead of snapping to a
            // fresh angle every tick.
            const rawDir = v2.normalizeSafe(v2.sub(state.coverPos, bot.pos));
            if (!state.approachDir) {
                state.approachDir = rawDir;
                return rawDir;
            }
            const curAngle = Math.atan2(state.approachDir.y, state.approachDir.x);
            const goalAngle = Math.atan2(rawDir.y, rawDir.x);
            const maxStep = APPROACH_TURN_RATE * dt;
            const step = math.clamp(math.angleDiff(curAngle, goalAngle), -maxStep, maxStep);
            const newAngle = curAngle + step;
            state.approachDir = v2.create(Math.cos(newAngle), Math.sin(newAngle));
            return state.approachDir;
        }
        // "der bot rennt, beginnt zu healen, und retreated weiter bis zu einer sicheren
        // Position" - reaching the very first spot that merely blocks line of sight
        // isn't itself a reason to stop: moving doesn't cancel an in-progress heal (see
        // `SETTLED_MAX_S`'s own doc comment), so there's no cost to continuing to open
        // real distance while one runs, only upside. `holdAndPeek` (engageHold, mid-
        // fight) settles immediately regardless - it's already holding a deliberately
        // *close* range, not trying to maximize separation.
        const farEnough = holdAndPeek
            || v2.distance(bot.pos, threatPos) >= minCoverDist * RETREAT_SETTLE_MULT;
        if (!farEnough) {
            state.pushedPastCover = true;
            return retreatDirection(bot, state, nav, threatPos, dt, aggression);
        }
        state.settledAtCover = true;
        state.pushedPastCover = false;
        state.approachDir = undefined;
        state.distAtSettle = v2.distance(bot.pos, threatPos);
        state.threatAtSettle = v2.copy(threatPos);
        state.settledForS = 0;
    } else {
        state.settledForS += dt;
    }

    if (holdAndPeek && nav) {
        state.path = [];
        return updatePeekCycle(bot, state, nav, threatPos, dt, recentlyVisible, aggression);
    }
    // Reached cover, but not holding position on purpose (heal/flee/reload) - keep
    // opening distance well past this first merely-safe-enough spot instead of planting
    // here and becoming an easy target the moment the threat closes back in - see
    // `RETREAT_SETTLE_MULT`. Only actually resumes running, though, if this spot isn't
    // doing its one job: still visible from the threat's own position, *or* the threat
    // is closing in regardless - "muss vor allem weiter retreaten wenn der Gegner pusht
    // um die Fertigstellung des Healens zu garantieren". A pushing enemy doesn't have to
    // have already rounded the corner to be a reason to keep moving: a fresh, closer
    // `threatPos` (a gunshot heard through the wall counts, see `BotBrain.threatPos`)
    // means they're advancing on this exact spot even before line of sight is actually
    // reestablished, and standing rooted here waiting for that to happen is exactly the
    // "got caught still healing at point-blank range" failure this is for - sitting
    // still is only safe against a threat that isn't closing the distance. Raw distance
    // alone used to be reason enough to abandon a genuinely-still-working hiding spot,
    // which meant a bot that found and reached real cover well within
    // `minCoverDist * RETREAT_SETTLE_MULT` (an easy thing on a compact arena, where most
    // cover naturally sits closer than that) walked straight back out into the open to
    // chase a distance number instead of actually using the hiding spot it had just
    // secured - "muss dafür sorgen, dass der Gegner ihm nicht folgen kann", not abandon
    // the one thing already accomplishing that the moment it's actually still working.
    // Not cleared via `state.path = []` first: `retreatDirection` (via `followPath`)
    // owns that path state itself, exactly like the "no cover found" branch above
    // already relies on - clearing it here first would throw away a just-computed path
    // before it's ever actually followed.
    const stillExposed = hasBodyLineOfSight(bot.game, threatPos, bot.pos, util.toGroundLayer(bot.layer));
    const threatClosingIn = state.distAtSettle !== undefined
        && v2.distance(bot.pos, threatPos) < state.distAtSettle - PUSH_DETECT_MARGIN;
    // The threat stepping sideways round the cover - same distance, different angle, so
    // `threatClosingIn` never trips - can open a line the cover was blocking.
    const threatShifted = state.threatAtSettle !== undefined
        && v2.distance(threatPos, state.threatAtSettle) > THREAT_SHIFT_RECOVER_DIST;
    // A third, independent reason to keep moving even with *no* threat signal at all: a
    // quiet push (no shot fired, no sighting) never trips `stillExposed`/`threatClosingIn`
    // in the first place, since both need some signal to react to - "wird gepusht und
    // stirbt" from a real match capture, camped 7.6 straight seconds chaining heals at
    // one exact spot with zero warning before the enemy reappeared already close enough
    // to finish it. See `SETTLED_MAX_S`'s own doc comment for why this doesn't just
    // interrupt an ordinary single heal.
    //
    // Deliberately its OWN check, never folded into the `stillExposed`/`threatClosingIn`
    // condition below (which is gated on still being within `minCoverDist *
    // RETREAT_SETTLE_MULT`): a real match capture showed a bot settle at `engageDist` 38 -
    // comfortably past that gate (28 for a heal) - and then sit completely still for a
    // full 3+ seconds with zero signal, never once re-checked, because *no* distance was
    // ever going to let `settledTooLong` past that outer condition. The last-known
    // distance being "far enough" when the bot stopped says nothing about where the enemy
    // actually is by the time `SETTLED_MAX_S` elapses - a hunting enemy closes ground
    // exactly as unseen from 38 units as from 20. This is the whole reason
    // `settledTooLong` exists at all (no signal, ever); gating it on the very distance
    // that produced "no signal" undid it completely the moment a retreat succeeded well
    // enough to clear that bar.
    const settledTooLong = state.settledForS > SETTLED_MAX_S;
    // Mid-heal in cover: finish the heal there. Only being seen (`stillExposed`) is worth
    // breaking off for - running while healing with the enemy merely closing in is what gets
    // the bot caught out in the open.
    const healing = bot.actionType === GameConfig.Action.UseItem;
    // Mid-heal, an enemy pushing closer *and able to see the bot* changes which cover holds -
    // waiting in place for them to walk round it is how a healing bot got finished off. Moving
    // doesn't cancel the heal, so give up this spot and move with the threat; next tick cover is
    // picked against where they are now. An enemy that can't see the bot still doesn't make it run.
    // A sideways shift re-picks cover in place: retreating straight away from the threat walked
    // a bot out of a good cover into open ground. Next tick cover is recomputed against where
    // the threat is now, and a real retreat only happens if it's closing in.
    if (!holdAndPeek && stillExposed && threatShifted && !threatClosingIn) {
        state.settledAtCover = false;
        state.distAtSettle = undefined;
        state.settledForS = 0;
        state.coverRecheck = 0;
        state.path = [];
        return v2.create(0, 0);
    }
    // Mid-heal and in the enemy's line: running off across open ground is what hands them free
    // shots. Re-pick cover in place first (next tick, against where they are now); only if the bot
    // is still exposed then does it retreat below.
    if (!holdAndPeek && healing && stillExposed && nav) {
        if (!state.exposedRecheckPending) {
            state.exposedRecheckPending = true;
            state.coverRecheck = 0;
            return v2.create(0, 0);
        }
    } else {
        state.exposedRecheckPending = false;
    }
    if (!holdAndPeek && stillExposed && (threatClosingIn || threatShifted)) {
        state.settledAtCover = false;
        state.distAtSettle = undefined;
        state.settledForS = 0;
        state.coverRecheck = 0;
        return keepRetreatHidden(bot, state, nav, threatPos, dt, aggression);
    }
    if (!holdAndPeek && settledTooLong && !healing) {
        return keepRetreatHidden(bot, state, nav, threatPos, dt, aggression);
    }
    if (
        !holdAndPeek
        && (stillExposed || (threatClosingIn && !healing))
        && v2.distance(bot.pos, threatPos) < minCoverDist * RETREAT_SETTLE_MULT
    ) {
        return keepRetreatHidden(bot, state, nav, threatPos, dt, aggression);
    }
    // Still in a clear line of fire at any range: the close-range rule above doesn't cover a
    // bot healing out in the open 30 units from the enemy, which stood still and got shot.
    // Moving doesn't cancel the heal, so keep retreating while exposed.
    if (!holdAndPeek && stillExposed) {
        return keepRetreatHidden(bot, state, nav, threatPos, dt, aggression);
    }
    state.path = [];
    return v2.create(0, 0);
}

/** Whether the bot has actually put enough separation between itself and `threatPos` to
 *  safely start a heal action - reached cover (if `retreatToCover` found any), opened up
 *  `SAFE_HEAL_DIST` of plain distance, or gone genuinely unseen for a while
 *  (`sustainedLost`, see `BotBrain`'s `SUSTAINED_LOST_MS`) - an equally fast pursuer never
 *  lets plain distance grow on its own, so without that last check a straight chase could
 *  deny healing forever even after real separation (a corner, a building) has already
 *  been won. Gates *starting* a heal, not continuing one already in progress
 *  (`BotBrain.pickDirective` handles that by reading `actionType` directly) - deciding "I
 *  should heal" and immediately consuming the item regardless of whether the retreat has
 *  actually gone anywhere yet is what made bots visibly start a bandage and cancel it
 *  again on the very next tick, still standing right where the fight was.
 *
 *  `sustainedLost` doubles as `BotBrain`'s `desperateHeal` override (see
 *  `DESPERATE_HEAL_MS`) - both mean the same thing here: treat this as safe regardless
 *  of distance/cover, because the alternative (waiting for real separation that isn't
 *  coming) is worse than the risk. */
export function isSafeToHeal(
    bot: Player,
    state: BotMovementState,
    engageDist: number,
    sustainedLost: boolean,
    critical = false,
    enemyVisible = false,
): boolean {
    if (sustainedLost) return true;
    // Too far to walk to cover while critical and unseen - heal here, see CRITICAL_COVER_WALK_MAX.
    if (
        state.coverPos && critical && !enemyVisible
        && v2.distance(bot.pos, state.coverPos) > CRITICAL_COVER_WALK_MAX
    ) return true;
    // Within `HEAL_START_COVER_DIST` counts as in the cover - a bot always stops a few units
    // short of the exact point, and demanding the exact spot made it re-pick cover instead.
    if (state.coverPos) return v2.distance(bot.pos, state.coverPos) <= HEAL_START_COVER_DIST;
    return engageDist >= SAFE_HEAL_DIST;
}

/** Direction to steer toward `goal`, routing through the nav graph when a direct line
 *  is blocked. Returns `undefined` when the direct line is already clear (the caller
 *  steers straight at `goal` itself) or when no usable path exists at all (nav isn't
 *  built yet, or the graph genuinely has nothing nearby) - both cases fall back to the
 *  M1 direct-steering behavior, which is worse but never broken.
 *
 *  `ignore` (passed by `retreatToCover`'s approach branch as `state.coverObstacle`) keeps
 *  the direct-clear shortcut below from seeing the bot's own held cover obstacle as a
 *  blocker - a real match capture showed a bot settled at cover take a hit, the cover
 *  recompute's own position noise un-arrive it (see the "un-arrive" doc comment on the
 *  recompute block), and the resulting re-approach to a goal point sitting right behind
 *  that exact obstacle read as "blocked" by it, forcing a full nav-graph detour for what
 *  should have been a two-unit direct step - the detour briefly walked the bot *away*
 *  from safety while a visible, closing enemy took it from 48 HP to 7 in under half a
 *  second. Same reasoning `isDirClear`'s own `ignore` param already documents for the
 *  generic local-deflection probe - approaching within a couple of units of the obstacle
 *  a cover point sits behind is the intended destination, not something to route around. */
export function followPath(
    bot: Player,
    state: BotMovementState,
    graph: NavGraph,
    goal: Vec2,
    dt: number,
    ignore?: Obstacle,
    avoidInterior = false,
): Vec2 | undefined {
    const layer = util.toGroundLayer(bot.layer);

    if (state.blacklistedNodes.size) {
        for (const [id, remainingS] of state.blacklistedNodes) {
            if (remainingS - dt <= 0) state.blacklistedNodes.delete(id);
            else state.blacklistedNodes.set(id, remainingS - dt);
        }
    }

    // Only take the "fully clear, skip pathing entirely" shortcut while there's no
    // active path yet - re-asking "is it clear *right now*" every tick once already
    // routing around something is exactly the single-probe-every-tick antipattern
    // fixed elsewhere in this file (see the local-deflection and `headingToIdleGoal`
    // doc comments): right at a corner, whether the straight line to a *distant* goal
    // grazes the obstacle or not can flip from one tick to the next as the bot's own
    // position shifts by fractions of a unit, which flip-flopped `move` between "go
    // straight at the goal" (often straight into the very obstacle just routed around)
    // and the real path direction - two very different directions that canceled each
    // other's progress out, reading as the bot vibrating in place for several real
    // seconds. Once a path exists, only the pruning/repath logic below (with its own
    // cooldowns and staleness check) gets to end it - never a fresh same-tick guess.
    //
    // `isDirClear` (body-width-aware), not `isWalkClear` (a thin ray): a tight cluster
    // of obstacles (a container yard, a real match capture found - "verwirrt mit
    // Containern") can have a genuinely obstacle-free *line* threading the gaps that the
    // bot's actual `bot.rad` body can't fit through cleanly - a thin ray reads that as
    // "clear, no pathing needed", so this shortcut kept firing every tick and handing
    // `move` straight back to raw direct steering, leaving local deflection alone to
    // fight geometry it was never meant to solve by itself (no A* path ever existed to
    // reroute or blacklist a waypoint out of - `pathLen` stayed 0 the entire time stuck).
    // A real corridor this size reads as clear either way; a gap only wide enough for
    // the ray now correctly doesn't.
    const toGoal = v2.sub(goal, bot.pos);
    const goalDist = v2.length(toGoal);
    const directClear = goalDist < 0.01
        || isDirClear(bot, v2.mul(toGoal, 1 / goalDist), goalDist, ignore);
    if (!state.path.length && directClear) {
        return undefined;
    }

    state.repathCooldown -= dt;
    const staleGoal = !state.pathGoal || v2.distance(state.pathGoal, goal) > REPATH_GOAL_DELTA;
    if ((!state.path.length || staleGoal) && state.repathCooldown <= 0) {
        state.repathCooldown = REPATH_INTERVAL;
        const startNodes = graph.nearby(bot.pos, layer, NODE_SEARCH_RADIUS, 5);
        const goalNodes = new Set(graph.nearby(goal, layer, NODE_SEARCH_RADIUS, 5));
        const excluded = avoidInterior
            ? new Set([...state.blacklistedNodes.keys(), ...interiorNodes(graph)])
            : state.blacklistedNodes.size
            ? new Set(state.blacklistedNodes.keys())
            : undefined;
        state.path = startNodes.length && goalNodes.size
            ? findPath(graph, startNodes, goalNodes, goal, layer, MAX_PATH_EXPANSIONS, excluded) ?? []
            : [];
        state.pathGoal = v2.copy(goal);
    }

    if (!state.path.length) return undefined;

    // Reached pruning: drop every waypoint up to and including whichever one is
    // currently being steered toward - `pullTarget` if string-pulling has already
    // committed to one several hops ahead, else the nearest waypoint. Checking only
    // `path[0]` here (as if string-pulling didn't exist) is a real bug: once committed
    // to a further `pullTarget`, the bot converges on and orbits *that* node forever
    // without ever coming near enough to `path[0]` to prune it, since a per-tick step
    // that overshoots a reached target flips `normalize(target - pos)` to point the
    // other way next tick - an undamped limit cycle around the target instead of ever
    // advancing to the next leg.
    const reachId = state.pullTarget ?? state.path[0];
    const reachIdx = state.path.indexOf(reachId);
    if (reachIdx >= 0 && v2.distance(bot.pos, graph.pos(reachId)) < WAYPOINT_REACHED_DIST) {
        state.path.splice(0, reachIdx + 1);
        state.pullTarget = undefined;
    }
    if (!state.path.length) {
        state.pullTarget = undefined;
        return undefined;
    }

    // String-pulling: aim at the furthest waypoint still directly visible, so the bot
    // cuts corners instead of hugging every sampled node exactly.
    //
    // Committed, not re-picked from scratch every tick: right at a concave corner,
    // whether a further waypoint is "directly visible" from the bot's exact position
    // can flip on a sub-unit position change. Recomputing freely turned that into a
    // feedback loop - aim far, step toward it, that step makes the far waypoint no
    // longer visible, aim near instead, step back out, repeat - which froze the bot in
    // place oscillating 180 degrees every tick. Sticking with the current target until
    // it's actually reached or genuinely no longer visible removes the loop.
    const pullIdx = state.pullTarget === undefined ? -1 : state.path.indexOf(state.pullTarget);
    const targetStillGood = pullIdx >= 0
        && isWalkClear(graph.navObstacles, bot.pos, graph.pos(state.path[pullIdx]), layer);

    if (!targetStillGood) {
        let aimIdx = 0;
        const lookahead = Math.min(state.path.length - 1, MAX_STRING_PULL);
        for (let i = 1; i <= lookahead; i++) {
            if (isWalkClear(graph.navObstacles, bot.pos, graph.pos(state.path[i]), layer)) {
                aimIdx = i;
            } else {
                break;
            }
        }
        state.pullTarget = state.path[aimIdx];
    }

    return v2.normalizeSafe(v2.sub(graph.pos(state.pullTarget!), bot.pos));
}

/** Nudges a raw straight-line movement goal off a building's `interior` lattice onto the
 *  nearest `open`/`hull`/`door`/`stair` node instead, when the graph has one nearby - "so
 *  eine Sackgasse nicht als Ziel" (a dead end isn't a destination). A pure straight-line
 *  projection has no idea it happens to land inside a room, and `followPath`'s A* will
 *  happily walk the bot in through a door to reach it even when that building offers
 *  nothing past it - ending a retreat trapped inside a dead-end pocket (or blindly
 *  charging into one chasing a stale memory) is worse than never having moved. Used by
 *  `retreatDirection` (always) and `engageHold`'s "close" mode (only while chasing a
 *  memory, not an actually-visible target - see `updateMovement`'s `targetVisible`).
 *  Deliberately only steers the *destination*, not routing in general: closing in on or
 *  fleeing *through* a building that actually leads somewhere is still fine and
 *  unaffected, since its interior nodes only ever get preferred here when the raw goal
 *  itself would land on one. */
export function preferNonInteriorGoal(nav: NavGraph, rawGoal: Vec2, layer: number): Vec2 {
    const nearest = nav.nearest(rawGoal, layer);
    if (nearest < 0 || nav.kind[nearest] !== "interior") return rawGoal;

    const candidates = nav.nearby(rawGoal, layer, NON_INTERIOR_GOAL_SEARCH_RADIUS, 8);
    for (const id of candidates) {
        if (nav.kind[id] !== "interior") return nav.pos(id);
    }
    return rawGoal;
}

/** Whether the bot's own nearest nav node is a building interior. */
function isInteriorNode(nav: NavGraph, bot: Player): boolean {
    const id = nav.nearest(bot.pos, util.toGroundLayer(bot.layer));
    return id >= 0 && nav.kind[id] === "interior";
}

/** Whether an idle walk from here to `goal` can avoid building interiors entirely (see
 *  `followPath`'s `avoidInterior`). Already inside a building it's always fine - leaving
 *  one has to cross its interior anyway. */
function idleRouteAvoidingInterior(nav: NavGraph, bot: Player, goal: Vec2): boolean {
    if (isInteriorNode(nav, bot)) return true;
    const layer = util.toGroundLayer(bot.layer);
    const from = nav.nearest(bot.pos, layer);
    const to = nav.nearest(goal, layer);
    if (from < 0 || to < 0) return false;
    if (nav.kind[to] === "interior") return false;
    if (to === from) return true;
    const route = findPath(
        nav,
        [from],
        new Set([to]),
        goal,
        layer,
        MAX_PATH_EXPANSIONS,
        interiorNodes(nav),
    );
    return route !== null;
}

/** Every building-interior node id in the graph - the `excluded` set for an interior-free
 *  path search. */
function interiorNodes(nav: NavGraph): Set<number> {
    const set = new Set<number>();
    for (let id = 0; id < nav.kind.length; id++) {
        if (nav.kind[id] === "interior") set.add(id);
    }
    return set;
}

/** A random heading for idle wander that, tried first, doesn't walk straight into a
 *  building - "high scope preferen, möglichst nicht in buildings laufen". Unlike
 *  `preferNonInteriorGoal` (steers a *destination* that already happens to sit on an
 *  interior node), plain wander has no destination at all to steer - just a heading - so
 *  the only way to keep it out of a building is to check candidate headings themselves
 *  before committing to one, same "closest/first-viable-option wins" shape as
 *  `findPeekSpot`. Without `nav` (steering fallback, no graph built), the wander is
 *  purely direct-steering anyway and has no notion of buildings to avoid in the first
 *  place - falls back to the original uniform-random heading unchanged. */
function pickWanderDir(bot: Player, nav: NavGraph | undefined): Vec2 {
    const first = v2.randomUnit();
    if (!nav) return first;

    const layer = util.toGroundLayer(bot.layer);
    let dir = first;
    for (let i = 0; i < WANDER_DIR_ATTEMPTS; i++) {
        const lookahead = v2.add(bot.pos, v2.mul(dir, WANDER_LOOKAHEAD));
        const nearest = nav.nearest(lookahead, layer);
        if (nearest < 0 || nav.kind[nearest] !== "interior") return dir;
        dir = v2.randomUnit();
    }
    return first; // every attempt landed in a building - wander has to go somewhere
}

/** Inset from the map edge the bot's own retreat logic keeps its goals and steering off. */
const BORDER_INSET = 2;
/** How close to an edge counts as being against it, for `keepOffBorder`. */
const AGAINST_BORDER_DIST = 4;

/** Removes any component of `dir` that would push the bot further out through a map edge
 *  it's already against. If nothing is left (fleeing straight into a corner), steers toward
 *  the map centre instead. Without this, a retreat away from a threat pinned a bot against
 *  the right-hand border for several seconds in a real match. */
function keepOffBorder(bot: Player, dir: Vec2): Vec2 {
    const { width, height } = bot.game.map;
    let x = dir.x;
    let y = dir.y;
    if (bot.pos.x >= width - AGAINST_BORDER_DIST && x > 0) x = 0;
    if (bot.pos.x <= AGAINST_BORDER_DIST && x < 0) x = 0;
    if (bot.pos.y >= height - AGAINST_BORDER_DIST && y > 0) y = 0;
    if (bot.pos.y <= AGAINST_BORDER_DIST && y < 0) y = 0;
    if (x === dir.x && y === dir.y) return dir;
    const kept = v2.create(x, y);
    if (v2.length(kept) > 0.01) return v2.normalizeSafe(kept);
    return v2.normalizeSafe(v2.sub(v2.create(width / 2, height / 2), bot.pos));
}

/** Clamps a point to just inside the map, so a retreat goal can't sit past the edge. */
function clampToMap(bot: Player, p: Vec2): Vec2 {
    const { width, height } = bot.game.map;
    return v2.create(
        math.clamp(p.x, BORDER_INSET, width - BORDER_INSET),
        math.clamp(p.y, BORDER_INSET, height - BORDER_INSET),
    );
}

/** A settled retreat step, nudged so it stays out of the enemy's line where it can (see `hiddenStepDirection`). */
function keepRetreatHidden(
    bot: Player,
    state: BotMovementState,
    nav: NavGraph | undefined,
    threatPos: Vec2,
    dt: number,
    aggression: number | undefined,
): Vec2 {
    const dir = retreatDirection(bot, state, nav, threatPos, dt, aggression);
    if (!nav) return dir;
    return hiddenStepDirection(bot, nav.navObstacles, threatPos, util.toGroundLayer(bot.layer), dir);
}

/** Direction to retreat in, routed through the nav graph instead of a raw straight
 *  line - see `RETREAT_LOOKAHEAD`. Without `nav`, falls back to the plain "away from
 *  the threat" direction, same as before (worse around buildings, never broken). */
function retreatDirection(
    bot: Player,
    state: BotMovementState,
    nav: NavGraph | undefined,
    threatPos: Vec2,
    dt: number,
    aggression: number | undefined,
): Vec2 {
    const away = keepOffBorder(bot, v2.normalizeSafe(v2.sub(bot.pos, threatPos)));
    if (!nav) return away;

    state.retreatRecheck -= dt;
    if (
        !state.retreatGoal
        || state.retreatRecheck <= 0
        || v2.distance(bot.pos, state.retreatGoal) < RETREAT_GOAL_REACHED_DIST
    ) {
        state.retreatRecheck = RETREAT_RECOMPUTE_INTERVAL * retreatRecomputeMult(aggression);
        const rawGoal = clampToMap(bot, v2.add(bot.pos, v2.mul(away, RETREAT_LOOKAHEAD)));
        state.retreatGoal = preferNonInteriorGoal(nav, rawGoal, util.toGroundLayer(bot.layer));
    }

    const pathDir = followPath(bot, state, nav, state.retreatGoal, dt);
    return keepOffBorder(bot, pathDir ?? away);
}

/** Rerolls the lateral strafe cycle - sign, hold duration, *and* how hard it blends in
 *  - all together, instead of just flipping direction on a fixed timer. A flat interval
 *  reads as a metronome (real players don't juke on a schedule); mixing in occasional
 *  short, punchier feints among the more common longer holds breaks that regularity up
 *  without changing the average strength much. Shared by `push` and `engageHold` so
 *  both move with the same organic cadence instead of two independently-tuned ones.
 *  `aggression` (see `BotTierDef`) scales how often the short feint comes up at all -
 *  see `feintChanceFor`. */
function rollStrafeCycle(state: BotMovementState, aggression: number | undefined): void {
    state.strafeSign = (state.strafeSign * -1) as 1 | -1;
    if (Math.random() < feintChanceFor(aggression)) {
        state.strafeTimer = util.random(0.25, 0.55);
        state.strafeIntensity = util.random(0.35, 0.55);
    } else {
        state.strafeTimer = util.random(0.7, 1.9);
        state.strafeIntensity = util.random(0.2, 0.38);
    }
}

/**
 * Drives movement from the brain's `CombatDirective` plus a threat position - see the
 * type doc for what each directive means. `threatPos` need not be the *currently
 * visible* target: the brain passes a remembered last-known position while it's
 * momentarily out of sight (behind cover, mid-peek-cycle, ...), which is what lets
 * `engageHold`'s cover/peek behavior survive losing line of sight on purpose without
 * collapsing back to wandering.
 *
 * `nav` is optional: undefined until `BotBarn` finishes building the graph (or if bots
 * are running before it exists at all), in which case this behaves like plain direct
 * steering - worse around buildings and without cover-seeking, but never broken.
 *
 * `recentlyVisible` - the target was actually seen within the last moment, even though
 * it isn't right now - shortens the next hiding window in `engageHold`'s peek cycle
 * (see `EAGER_PEEK_HOLD_MIN/MAX`): almost always means the bot's own peek just ended
 * with the enemy peeking too, not genuinely losing track of them, so there's no reason
 * to wait out a full "haven't seen them in a while" hold before checking again.
 *
 * `tier` - optional so every existing direct call (all the movement-layer unit tests)
 * keeps exercising the originally tuned pace exactly; `BotBrain` always passes the real
 * tier, which scales peek/re-cover/strafe pacing by `tier.aggression` - see
 * `peekPaceMult`/`coverRecomputeMult`/`feintChanceFor`.
 *
 * `targetVisible` - whether `threatPos` is the *currently* visible target, not a
 * remembered/heard-shot fallback. Defaults `true` so every existing direct call (which
 * always passes a real, "trustworthy" position) keeps closing distance exactly as
 * before; `BotBrain` passes `!!this.target`. `engageHold`'s "close" mode uses this to
 * avoid pathing deep into a building's interior while chasing a stale memory - see
 * `preferNonInteriorGoal`. Chasing an *actually* visible target into a building it's
 * really standing in is unaffected either way.
 *
 * `idleGoal` - where to actually head while idle (no known threat at all), instead of
 * just wandering aimlessly - see `BotBrain.idleGoal` (a recent last-known enemy spot, or
 * the map's center). Optional so every existing direct call keeps the original pure
 * wander behavior unchanged; `BotBrain` always passes one.
 */
export function updateMovement(
    bot: Player,
    state: BotMovementState,
    directive: CombatDirective,
    threatPos: Vec2 | undefined,
    dist: number,
    dt: number,
    nav?: NavGraph,
    recentlyVisible = false,
    tier?: BotTierDef,
    targetVisible = true,
    idleGoal?: Vec2,
    critical = false,
    clearAdvantage = false,
): void {
    let move = v2.create(0, 0);
    const aggression = tier?.aggression;

    if (directive === "idle" || !threatPos) {
        state.coverObstacle = undefined;
        state.coverPos = undefined;
        state.peeking = false;

        // "high scope preferen, möglichst nicht in buildings laufen" - with no threat to
        // actually react to, there's no reason for idle rotation to walk into a building
        // that just happens to contain the raw goal (a last-known enemy spot, or the
        // map's center - see `BotBrain.idleGoal`), trading a good sightline for a dead
        // end. Same treatment `preferNonInteriorGoal` already gives a blind chase
        // (`engageHold`'s "close" mode) and a plain retreat - nudge the destination onto a
        // nearby open/hull node instead, never touching the raw goal itself so a route
        // that genuinely leads through a building on the way there is unaffected.
        const effectiveIdleGoal = idleGoal && nav
            ? preferNonInteriorGoal(nav, idleGoal, util.toGroundLayer(bot.layer))
            : idleGoal;

        state.idleGoalCooldown = Math.max(0, state.idleGoalCooldown - dt);
        if (!effectiveIdleGoal) {
            state.headingToIdleGoal = false;
        } else {
            const distToGoal = v2.distance(bot.pos, effectiveIdleGoal);
            if (state.headingToIdleGoal) {
                if (distToGoal <= IDLE_GOAL_REACHED_DIST) {
                    state.headingToIdleGoal = false;
                    state.idleRouteChecked = false;
                } else if (!state.idleRouteChecked) {
                    // With no threat, the walk to the idle goal shouldn't go through a building's
                    // interior - the real match had the bot idle inside one while the enemy walked
                    // up. So it routes around buildings instead (see `followPath`'s
                    // `avoidInterior`), and only gives the goal up for a while when no such route
                    // exists. Checked once per heading (the bot starts out already heading, so the
                    // transition below never sees it).
                    state.idleRouteChecked = true;
                    state.path = [];
                    if (nav && !idleRouteAvoidingInterior(nav, bot, effectiveIdleGoal)) {
                        state.headingToIdleGoal = false;
                        state.idleGoalCooldown = IDLE_INTERIOR_ROUTE_COOLDOWN_S;
                    } else {
                        state.idleAvoidInterior = !!nav && !isInteriorNode(nav, bot);
                    }
                }
            } else if (distToGoal > IDLE_GOAL_RESUME_DIST && state.idleGoalCooldown <= 0) {
                state.headingToIdleGoal = true;
                state.idleRouteChecked = false;
            }
        }
        const headingToGoal = effectiveIdleGoal && state.headingToIdleGoal;
        if (headingToGoal) {
            const pathDir = nav
                ? followPath(bot, state, nav, effectiveIdleGoal, dt, undefined, state.idleAvoidInterior)
                : undefined;
            move = pathDir ?? v2.normalizeSafe(v2.sub(effectiveIdleGoal, bot.pos));
        } else {
            state.path = [];
            state.wanderTimer -= dt;
            if (state.wanderTimer <= 0) {
                state.wanderTimer = util.random(1, 2.5);
                state.wanderDir = pickWanderDir(bot, nav);
            }
            // Same map-border rule as the retreats: a wander heading never pushes straight into an edge.
            move = keepOffBorder(bot, state.wanderDir);
        }
    } else if (directive === "heal" || directive === "flee") {
        move = retreatToCover(
            bot,
            state,
            nav,
            threatPos,
            dt,
            false,
            recentlyVisible,
            SAFE_HEAL_DIST,
            aggression,
            critical,
        );
    } else if (directive === "reload") {
        move = retreatToCover(
            bot,
            state,
            nav,
            threatPos,
            dt,
            false,
            recentlyVisible,
            SAFE_RELOAD_DIST,
            aggression,
            false,
        );
    } else if (directive === "push") {
        // With a clear health advantage the bot closes all the way to near-melee range instead of holding at
        // its weapon's push-hold distance: holding back is only right when it doesn't have the edge.
        const pushHoldDist = clearAdvantage
            ? PUSH_MIN_DIST
            : Math.max(PUSH_MIN_DIST, currentSweetSpot(bot) * PUSH_SWEET_SPOT_FRAC);

        state.strafeTimer -= dt;
        if (state.strafeTimer <= 0) rollStrafeCycle(state, aggression);

        if (dist > pushHoldDist) {
            // Still closing - any cover state left over from a previous directive
            // doesn't apply mid-charge, so drop it rather than let a stale `coverPos`
            // from before the push leak into the hold below once it arrives.
            state.coverObstacle = undefined;
            state.coverPos = undefined;
            state.peeking = false;
            const toThreat = v2.normalizeSafe(v2.sub(threatPos, bot.pos));
            const pathDir = nav ? followPath(bot, state, nav, threatPos, dt) : undefined;
            move = pathDir ?? toThreat;
            // A dead-straight charge is easy to punish - blend in a little strafe so
            // pushing still juke a bit instead of running face-first at the muzzle.
            if (!state.path.length) {
                move = v2.add(move, v2.mul(v2.perp(toThreat), state.strafeSign * state.strafeIntensity));
            }
        } else {
            // Close enough to press the advantage without overcommitting - hold here
            // and keep firing rather than closing further (see `pushHoldDist`), but
            // from cover when there's any nearby, exactly like `engageHold`'s own hold
            // does. Pressing an advantage in the open with nothing to duck behind if it
            // goes wrong was the "plays too open even while pushing" complaint - a
            // pushing bot is still close to a live gunfight, not somewhere standing
            // still in plain view is ever actually safe.
            //
            // Forced `true`/`1`, not the tick's real `recentlyVisible`/`aggression`:
            // reaching `push` at all already means the target is genuinely low and worth
            // finishing (see `BotBrain.pickDirective`'s `ENEMY_LOW_HEALTH_FRAC`) - that's
            // a reason to keep leaning back out and firing at every opportunity, the same
            // eager cadence `recentlyVisible` already grants a peek that *just* ended
            // (`EAGER_PEEK_HOLD_MIN/MAX`), regardless of tier or whether this exact peek
            // happens to qualify. Using the normal, cautious hold pacing here was giving
            // a nearly-finished target real breathing room to heal or turn the fight
            // back around between peeks - it read as the bot's own offense going soft
            // right when it should be pressing hardest.
            move = retreatToCover(bot, state, nav, threatPos, dt, true, true, 0, 1, false);
        }
    } else {
        // engageHold: close distance if too far, back off if too close, otherwise hold
        // from cover (with peeking) instead of standing in the open at a stable range.
        // Reaching this directive already means the target isn't low enough to finish
        // (see `BotBrain.pickDirective` - `push` handles that case instead), so this is
        // always "hold against a healthy enemy", never "close in for the kill". A
        // shotgun's own sweet spot is close enough that holding there verbatim pins the
        // bot at near-melee range with no room to open distance if it suddenly goes low
        // itself - floor the held distance at `SAFE_ENGAGE_DIST` so backing off is
        // always still a real option, regardless of what's equipped.
        const toThreat = v2.normalizeSafe(v2.sub(threatPos, bot.pos));
        const sweet = Math.max(currentSweetSpot(bot), SAFE_ENGAGE_DIST);
        const band = Math.max(2, sweet * 0.18);

        state.strafeTimer -= dt;
        if (state.strafeTimer <= 0) rollStrafeCycle(state, aggression);

        const rawMode = pickRangeMode(state, dist, sweet, band);
        if (rawMode === "close" && !targetVisible) {
            state.blindCloseElapsedS += dt;
        } else {
            state.blindCloseElapsedS = 0;
        }
        // Only downgrades this tick's actual behavior, not `state.rangeMode` itself -
        // the underlying hysteresis keeps tracking "close" so a real sighting resumes
        // pressing immediately, without needing to re-clear `closeEdge` from scratch.
        const mode = rawMode === "close" && state.blindCloseElapsedS > BLIND_CLOSE_MAX_S
            ? "hold"
            : rawMode;
        if (mode === "close") {
            state.coverObstacle = undefined;
            state.coverPos = undefined;
            state.peeking = false;
            // Chasing an actually-visible target into whatever building it's really
            // standing in is correct - chasing a merely-remembered position (they may
            // well have moved on already) headfirst into a building's cluttered
            // interior lattice is the "checkt nicht dass er nicht in Buildings sein
            // sollte" complaint: worth avoiding unless the target is genuinely there
            // right now. See `preferNonInteriorGoal`.
            const chaseGoal = nav && !targetVisible
                ? preferNonInteriorGoal(nav, threatPos, util.toGroundLayer(bot.layer))
                : threatPos;
            const pathDir = nav ? followPath(bot, state, nav, chaseGoal, dt) : undefined;
            move = pathDir ?? toThreat;
        } else if (mode === "retreat") {
            state.coverObstacle = undefined;
            state.coverPos = undefined;
            state.peeking = false;
            move = retreatDirection(bot, state, nav, threatPos, dt, aggression);
        } else {
            move = retreatToCover(
                bot,
                state,
                nav,
                threatPos,
                dt,
                true,
                recentlyVisible,
                0,
                aggression,
                false,
            );
            // No cover anywhere nearby: `retreatToCover` falls back to pure lateral
            // strafing with no radial component at all, which has nothing keeping it
            // near an acceptable range - left alone, it drifts wherever strafing happens
            // to carry it until it wanders far enough to re-trigger a mode flip, which
            // reads as the bot ending up at an arbitrary, unpurposeful spot rather than
            // holding a stable position. Blend in a gentle correction back inward once
            // it's drifted past the *same effective edges* `pickRangeMode` itself uses
            // to decide "hold" in the first place - not `sweet +/- band` directly, which
            // for a long-range weapon can sit well past `MAX_RETREAT_DIST` and would
            // otherwise fight to drag the bot back out to a range `pickRangeMode`
            // deliberately gave up on reaching.
            if (!state.coverPos) {
                const holdCloseEdge = sweet + band;
                const holdRetreatEdge = Math.min(sweet - band, MAX_RETREAT_DIST);
                let radial = 0;
                if (dist > holdCloseEdge) {
                    radial = Math.min(1, (dist - holdCloseEdge) / sweet) * 0.5;
                } else if (dist < holdRetreatEdge) {
                    radial = -Math.min(1, (holdRetreatEdge - dist) / sweet) * 0.5;
                }
                if (radial !== 0) move = v2.add(move, v2.mul(toThreat, radial));
            }
        }
        // Blend in strafe even while closing/opening distance, so approach/retreat
        // isn't a dead-straight line - the second biggest "feels human" lever after
        // aim turn rate. Only for close/retreat: `hold`'s cover/peek cycle already has
        // its own deliberate micro-movement, and blending lateral strafe on top of a
        // peek step just walks the bot back into its own cover.
        if ((mode === "close" || mode === "retreat") && !state.path.length) {
            move = v2.add(move, v2.mul(v2.perp(toThreat), state.strafeSign * state.strafeIntensity));
        }
    }

    tryOpenNearbyDoor(bot);

    // Anti-stuck: barely moving for a full second *while genuinely trying to* means
    // whatever movement decided this tick isn't actually working - a bad path (a door
    // it didn't open in time, a stale waypoint), or a spot near a building/container
    // cluster where local deflection alone (below) can't find a way through. Not just
    // path-following: plain direct steering (a raw retreat direction, lateral strafing
    // near cover with nothing to route through) can get stuck against complex geometry
    // exactly the same way, and had no recovery at all before this - forcing a fresh
    // path/retreat goal next tick and trying the *other* deflection side are cheap
    // enough to always do together. `triedToMoveSinceCheck` is what keeps this from
    // misreading a deliberate, chosen stand-still (holding cover, mid-peek-cycle wait)
    // as the same thing - see `stuck`'s own doc comment.
    state.triedToMoveSinceCheck ||= v2.length(move) >= 0.01;
    state.stuckTimer += dt;
    if (state.stuckTimer >= STUCK_CHECK_INTERVAL) {
        // Raw displacement alone can be fooled: a real match capture found the bot
        // alternating between two near-opposite headings a hair unevenly, creeping a
        // real unit or more per window in the *wrong* direction - clearing
        // `STUCK_MOVE_THRESHOLD` every single check while never actually closing in on
        // `pullTarget`. Only counts when the same waypoint was the goal for the *whole*
        // window (a fresh, voluntary re-pick isn't evidence of anything stuck) and a nav
        // graph is actually in play.
        const sameTargetAllWindow = nav
            && state.pullTarget !== undefined
            && state.pullTarget === state.pullTargetAtCheck
            && state.distToPullTargetAtCheck !== undefined;
        const noRealProgress = sameTargetAllWindow
            && state.distToPullTargetAtCheck! - v2.distance(bot.pos, nav!.pos(state.pullTarget!))
                < PULL_TARGET_PROGRESS_MIN;
        const stuckThisWindow = state.triedToMoveSinceCheck
            && (v2.distance(bot.pos, state.stuckAnchor) < STUCK_MOVE_THRESHOLD || noRealProgress);
        state.stuckStreak = stuckThisWindow ? state.stuckStreak + 1 : 0;
        state.stuck = state.stuckStreak >= STUCK_STREAK_FOR_FIGHT;
        if (stuckThisWindow) {
            state.path = [];
            state.repathCooldown = 0;
            state.retreatRecheck = 0;
            state.deflectSign = (state.deflectSign * -1) as 1 | -1;
            // Blacklist the exact waypoint that wasn't reachable (see
            // `BotMovementState.blacklistedNodes`/`STUCK_NODE_BLACKLIST_S`) - repathing
            // alone just rediscovers the identical "optimal" route straight back into
            // the same dead end (a gap too narrow to fit through, a doorway the nav
            // graph doesn't actually clear), which is exactly what turned into the bot
            // ping-ponging between the same two points for 9 real seconds in a decoded
            // match capture, `stuck` never even tripping because each individual swing
            // stayed just under `STUCK_MOVE_THRESHOLD`. Reacting on the same single bad
            // window as the deflect-side flip above, not waiting for `stuck`'s own
            // higher (3-window) bar: blacklisting is cheap and short-lived (5s) even on
            // a false alarm, while every extra second stuck here is a real cost in a
            // 15-60s match `stuck`'s slower bar was never tuned to react fast about.
            if (state.pullTarget !== undefined) {
                state.blacklistedNodes.set(state.pullTarget, STUCK_NODE_BLACKLIST_S);
            }
        }
        state.stuckTimer = 0;
        state.stuckAnchor = v2.copy(bot.pos);
        state.triedToMoveSinceCheck = false;
        state.pullTargetAtCheck = state.pullTarget;
        state.distToPullTargetAtCheck = nav && state.pullTarget !== undefined
            ? v2.distance(bot.pos, nav.pos(state.pullTarget))
            : undefined;
    }

    if (state.dodgeTimer > 0 && threatPos) {
        state.dodgeTimer -= dt;
        // Only in the open, with no cover to get to: mid-approach or settled, a sidestep just hands the
        // enemy a fresh line on a spot the bot was working to hold.
        if (!state.settledAtCover && !state.coverPos) {
            const toThreat = v2.normalizeSafe(v2.sub(threatPos, bot.pos), v2.create(1, 0));
            const side = v2.mul(v2.perp(toThreat), state.dodgeSign * DODGE_STRENGTH);
            move = v2.add(v2.mul(move, 0.3), side);
        }
    }
    // In combat with no cover to get to, weave side to side (see `shakeRetreat`): a steady approach
    // is what gets a bot into cover, so a bot heading for cover doesn't lean.
    const combat = directive === "engageHold" || directive === "push" || directive === "flee"
        || directive === "heal" || directive === "reload";
    // A dodge in progress owns the move; the weave waits for it to finish.
    if (combat && threatPos && state.coverPos === undefined && state.dodgeTimer <= 0) {
        const toThreat = v2.normalizeSafe(v2.sub(threatPos, bot.pos), v2.create(1, 0));
        move = shakeRetreat(state, move, toThreat, dt);
    }
    if (v2.length(move) < 0.01) {
        bot.touchMoveActive = false;
        return;
    }
    move = v2.normalizeSafe(move);

    // Same rule as the approach's own `followPath` above: a bot still well short of its cover point
    // has to steer around the cover obstacle, not straight through it.
    const approachingCover = !!state.coverPos && !state.settledAtCover
        && v2.distance(bot.pos, state.coverPos) >= COVER_APPROACH_IGNORE_DIST;
    const probeIgnore = approachingCover ? undefined : state.coverObstacle;
    if (!isDirClear(bot, move, PROBE_DIST, probeIgnore)) {
        // Prefer whichever side the bot was already deflecting toward, so it commits
        // to going around an obstacle instead of re-picking a side independently every
        // tick (which, right at an obstacle's edge, can flip left/right each tick and
        // look like the bot is stuck vibrating against the wall). Tried at increasingly
        // wide angles before giving up: a single obstacle rarely needs more than a
        // 60-degree nudge, but a tight cluster (several containers, a building corner
        // right next to a fence) can box in anything narrower - see the "stuck on
        // buildings/containers" bug this is for.
        const angles = [Math.PI / 3, (2 * Math.PI) / 3];
        let deflected = false;
        for (const angle of angles) {
            const preferred = v2.rotate(move, state.deflectSign * angle);
            const other = v2.rotate(move, -state.deflectSign * angle);
            if (isDirClear(bot, preferred, PROBE_DIST, probeIgnore)) {
                move = preferred;
                deflected = true;
                break;
            }
            if (isDirClear(bot, other, PROBE_DIST, probeIgnore)) {
                // Use the other side for *this tick only* - flipping `deflectSign`
                // itself here was the bug (see above): right at a concave corner,
                // whichever side reads as clear can toggle from one tick to the next
                // as the bot's position shifts by fractions of a unit, so permanently
                // recommitting to "other" every time `preferred` briefly fails turned
                // into exactly the "re-picking a side every tick" limit cycle this
                // whole preference scheme was meant to prevent - the bot would vibrate
                // in place near a corner for several real seconds doing net-zero
                // progress. `deflectSign` itself now only ever changes from the
                // deliberate once-a-second stuck check below, which is a real signal
                // that the current side genuinely isn't working - not a same-tick
                // guess based on a single probe.
                move = other;
                deflected = true;
                break;
            }
        }
        if (!deflected) move = v2.neg(move); // fully boxed in - back off rather than push into it
    }

    // See `BotMovementState.ditherElapsedS`'s own doc comment: a much faster, independent read on
    // the exact same "retreat isn't going anywhere" failure the slower, displacement-based `stuck`
    // above exists for - only tracked for an actual retreat (flee/heal), not every directive's own,
    // often deliberately zig-zagging movement (strafing, dodging, shaking).
    if (directive === "flee" || directive === "heal") {
        const reversed = !!state.lastMoveDir && v2.dot(move, state.lastMoveDir) < DITHER_REVERSAL_DOT;
        state.ditherElapsedS = reversed
            ? state.ditherElapsedS + dt
            : Math.max(0, state.ditherElapsedS - dt);
        state.dithering = state.ditherElapsedS > DITHER_REVERSAL_S;
        state.lastMoveDir = v2.copy(move);
    } else {
        state.ditherElapsedS = 0;
        state.dithering = false;
        state.lastMoveDir = undefined;
    }

    bot.touchMoveActive = true;
    bot.touchMoveDir = move;
    bot.touchMoveLen = 255;
}
