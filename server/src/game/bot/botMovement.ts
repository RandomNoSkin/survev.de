import type { ObstacleDef } from "../../../../shared/defs/mapObjectsTyping";
import { MapObjectDefs } from "../../../../shared/defs/register.ts";
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
import { hasLineOfSight } from "./botPerception.ts";
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
 *  check. Deliberately smaller than `STUCK_MOVE_THRESHOLD`: this only has to catch
 *  "basically not closing in at all", not demand fast progress. */
const PULL_TARGET_PROGRESS_MIN = 0.5;
/** How many consecutive `STUCK_CHECK_INTERVAL` windows of zero progress it takes before
 *  `BotMovementState.stuck` (the "give up and fight" signal) actually goes true - see
 *  its own doc comment for why this needs real confidence, not a single bad window. */
const STUCK_STREAK_FOR_FIGHT = 3;
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

/** Angles (radians) off "directly behind cover" tried when leaning out to peek - not 0,
 *  which is fully hidden, and not near π, which is fully in the open; these sample the
 *  obstacle's silhouette edge, closest offset first. */
const PEEK_ANGLES = [1.05, -1.05, 1.4, -1.4, 1.75, -1.75];
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
/** How far around a raw straight-line movement goal to look for a non-`interior` node to
 *  redirect to instead - see `preferNonInteriorGoal`. Wide enough to actually find a
 *  nearby hull/open node from just inside a building, not so wide the goal drags
 *  somewhere unrelated to the original destination. */
const NON_INTERIOR_GOAL_SEARCH_RADIUS = 15;

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
    /** Whether the bot has actually reached `coverPos` since it was last (re)picked -
     *  see the doc comment on `retreatToCover` for why this matters: once true, control
     *  hands off entirely to the peek cycle instead of re-checking distance to the base
     *  cover point every tick. */
    settledAtCover = false;
    /** Distance to the threat at the moment `settledAtCover` last became true - see
     *  `retreatToCover`'s "threat closing in" check. `undefined` whenever cover isn't
     *  settled (kept in sync with `settledAtCover` resetting to `false`). */
    distAtSettle?: number;
    /** Seconds since `settledAtCover` last became true - see `retreatToCover`'s "settled
     *  too long" check/`SETTLED_MAX_S`. Reset alongside `distAtSettle`. */
    settledForS = 0;

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
function isBodyHidden(
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
 *  deflection, `followPath`'s direct-vs-routed check, and idle-goal hysteresis. */
export function findCover(
    bot: Player,
    navObstacles: Obstacle[],
    threatPos: Vec2,
    minDistFromThreat = 0,
    preferred?: Obstacle,
): { obstacle: Obstacle; pos: Vec2 } | undefined {
    const layer = util.toGroundLayer(bot.layer);
    const aabb = collider.createAabbExtents(bot.pos, v2.create(COVER_SEARCH_RAD, COVER_SEARCH_RAD));
    const objs = bot.game.grid.intersectCollider(aabb);
    const minDistSqr = minDistFromThreat * minDistFromThreat;

    let best: { obstacle: Obstacle; pos: Vec2; distSqr: number } | undefined;
    let preferredPick: { obstacle: Obstacle; pos: Vec2; distSqr: number } | undefined;
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

        const distSqr = v2.lengthSqr(v2.sub(bot.pos, candidate));
        const entry = { obstacle: o, pos: candidate, distSqr };
        if (!best || distSqr < best.distSqr) best = entry;
        if (o === preferred) preferredPick = entry;
    }

    if (!preferredPick) return best;
    if (!best || best.obstacle === preferred) return preferredPick;
    // Plain distances, not squared - for two picks this close (the whole point is
    // catching near-ties), the squared difference shrinks with their absolute distance
    // from the bot (distSqr_a - distSqr_b = (a-b)(a+b)), so comparing it directly against
    // a squared margin would only tolerate a real difference of a fraction of a unit at
    // any realistic cover range, not the intended `COVER_STICKINESS_MARGIN`.
    const preferredDist = Math.sqrt(preferredPick.distSqr);
    const bestDist = Math.sqrt(best.distSqr);
    return preferredDist - bestDist < COVER_STICKINESS_MARGIN ? preferredPick : best;
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
/** How long settled-at-cover is willing to sit fully still with no threat signal at all
 *  before treating that silence itself as a reason to move again - see the "settled too
 *  long" check below. A real match capture showed a bot camp one exact spot for 7.6
 *  straight seconds chaining multiple heals, getting silently walked up on and killed
 *  the instant the enemy reappeared with no warning - `stillExposed`/`threatClosingIn`
 *  both need *some* signal (a sighting, a heard shot) to fire at all, and a quiet push
 *  simply never produces one until it's already too late. Long enough to comfortably
 *  clear a single bandage/heal-item cycle uninterrupted, short enough that chaining
 *  several in the exact same spot no longer happens for free. */
const SETTLED_MAX_S = 3.5;

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
 *  trying to put real distance between itself and the threat). */
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
): Vec2 {
    if (state.coverObstacle?.dead || state.coverObstacle?.collidable === false) {
        state.coverObstacle = undefined;
        state.coverPos = undefined;
        state.settledAtCover = false;
        state.distAtSettle = undefined;
        state.settledForS = 0;
        state.coverRecheck = 0;
        state.peeking = false;
    }
    state.coverRecheck -= dt;
    if (nav && (!state.coverPos || state.coverRecheck <= 0)) {
        state.coverRecheck = COVER_RECOMPUTE_INTERVAL * coverRecomputeMult(aggression);
        const found = findCover(bot, nav.navObstacles, threatPos, minCoverDist, state.coverObstacle);
        // Only treat this as a genuinely new spot - not just the periodic recompute
        // landing back on essentially the same point - as "un-arrive": resetting
        // `settledAtCover` on every recompute would interrupt an in-progress peek every
        // `COVER_RECOMPUTE_INTERVAL` (0.4s), well inside a single peek's own exposure
        // window, forcing the bot back to `coverPos` before it ever really leaned out.
        if (!found || !state.coverPos || v2.distance(state.coverPos, found.pos) > 0.5) {
            state.settledAtCover = false;
            state.distAtSettle = undefined;
            state.settledForS = 0;
        }
        state.coverObstacle = found?.obstacle;
        state.coverPos = found?.pos;
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
    // instead of either fully hidden or meaningfully exposed.
    if (!state.settledAtCover) {
        if (v2.distance(bot.pos, state.coverPos) > COVER_REACHED_DIST) {
            state.peeking = false;
            const pathDir = nav ? followPath(bot, state, nav, state.coverPos, dt) : undefined;
            return pathDir ?? v2.normalizeSafe(v2.sub(state.coverPos, bot.pos));
        }
        state.settledAtCover = true;
        state.distAtSettle = v2.distance(bot.pos, threatPos);
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
    const stillExposed = hasLineOfSight(bot.game, threatPos, bot.pos, util.toGroundLayer(bot.layer));
    const threatClosingIn = state.distAtSettle !== undefined
        && v2.distance(bot.pos, threatPos) < state.distAtSettle - PUSH_DETECT_MARGIN;
    // A third, independent reason to keep moving even with *no* threat signal at all: a
    // quiet push (no shot fired, no sighting) never trips `stillExposed`/`threatClosingIn`
    // in the first place, since both need some signal to react to - "wird gepusht und
    // stirbt" from a real match capture, camped 7.6 straight seconds chaining heals at
    // one exact spot with zero warning before the enemy reappeared already close enough
    // to finish it. See `SETTLED_MAX_S`'s own doc comment for why this doesn't just
    // interrupt an ordinary single heal.
    const settledTooLong = state.settledForS > SETTLED_MAX_S;
    if (
        !holdAndPeek
        && (stillExposed || threatClosingIn || settledTooLong)
        && v2.distance(bot.pos, threatPos) < minCoverDist * RETREAT_SETTLE_MULT
    ) {
        return retreatDirection(bot, state, nav, threatPos, dt, aggression);
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
): boolean {
    if (sustainedLost) return true;
    if (state.coverPos) return v2.distance(bot.pos, state.coverPos) <= COVER_REACHED_DIST;
    return engageDist >= SAFE_HEAL_DIST;
}

/** Direction to steer toward `goal`, routing through the nav graph when a direct line
 *  is blocked. Returns `undefined` when the direct line is already clear (the caller
 *  steers straight at `goal` itself) or when no usable path exists at all (nav isn't
 *  built yet, or the graph genuinely has nothing nearby) - both cases fall back to the
 *  M1 direct-steering behavior, which is worse but never broken.
 */
export function followPath(
    bot: Player,
    state: BotMovementState,
    graph: NavGraph,
    goal: Vec2,
    dt: number,
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
    const directClear = goalDist < 0.01 || isDirClear(bot, v2.mul(toGoal, 1 / goalDist), goalDist);
    if (!state.path.length && directClear) {
        return undefined;
    }

    state.repathCooldown -= dt;
    const staleGoal = !state.pathGoal || v2.distance(state.pathGoal, goal) > REPATH_GOAL_DELTA;
    if ((!state.path.length || staleGoal) && state.repathCooldown <= 0) {
        state.repathCooldown = REPATH_INTERVAL;
        const startNodes = graph.nearby(bot.pos, layer, NODE_SEARCH_RADIUS, 5);
        const goalNodes = new Set(graph.nearby(goal, layer, NODE_SEARCH_RADIUS, 5));
        const excluded = state.blacklistedNodes.size
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
    const away = v2.normalizeSafe(v2.sub(bot.pos, threatPos));
    if (!nav) return away;

    state.retreatRecheck -= dt;
    if (
        !state.retreatGoal
        || state.retreatRecheck <= 0
        || v2.distance(bot.pos, state.retreatGoal) < RETREAT_GOAL_REACHED_DIST
    ) {
        state.retreatRecheck = RETREAT_RECOMPUTE_INTERVAL * retreatRecomputeMult(aggression);
        const rawGoal = v2.add(bot.pos, v2.mul(away, RETREAT_LOOKAHEAD));
        state.retreatGoal = preferNonInteriorGoal(nav, rawGoal, util.toGroundLayer(bot.layer));
    }

    const pathDir = followPath(bot, state, nav, state.retreatGoal, dt);
    return pathDir ?? away;
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
): void {
    let move = v2.create(0, 0);
    const aggression = tier?.aggression;

    if (directive === "idle" || !threatPos) {
        state.coverObstacle = undefined;
        state.coverPos = undefined;
        state.peeking = false;

        if (!idleGoal) {
            state.headingToIdleGoal = false;
        } else {
            const distToGoal = v2.distance(bot.pos, idleGoal);
            if (state.headingToIdleGoal) {
                if (distToGoal <= IDLE_GOAL_REACHED_DIST) state.headingToIdleGoal = false;
            } else if (distToGoal > IDLE_GOAL_RESUME_DIST) {
                state.headingToIdleGoal = true;
            }
        }
        const headingToGoal = idleGoal && state.headingToIdleGoal;
        if (headingToGoal) {
            const pathDir = nav ? followPath(bot, state, nav, idleGoal, dt) : undefined;
            move = pathDir ?? v2.normalizeSafe(v2.sub(idleGoal, bot.pos));
        } else {
            state.path = [];
            state.wanderTimer -= dt;
            if (state.wanderTimer <= 0) {
                state.wanderTimer = util.random(1, 2.5);
                state.wanderDir = v2.randomUnit();
            }
            move = state.wanderDir;
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
        );
    } else if (directive === "push") {
        const pushHoldDist = Math.max(PUSH_MIN_DIST, currentSweetSpot(bot) * PUSH_SWEET_SPOT_FRAC);

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
            move = retreatToCover(bot, state, nav, threatPos, dt, true, true, 0, 1);
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
            move = retreatToCover(bot, state, nav, threatPos, dt, true, recentlyVisible, 0, aggression);
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

    if (v2.length(move) < 0.01) {
        bot.touchMoveActive = false;
        return;
    }
    move = v2.normalizeSafe(move);

    if (!isDirClear(bot, move, PROBE_DIST, state.coverObstacle)) {
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
            if (isDirClear(bot, preferred, PROBE_DIST, state.coverObstacle)) {
                move = preferred;
                deflected = true;
                break;
            }
            if (isDirClear(bot, other, PROBE_DIST, state.coverObstacle)) {
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

    bot.touchMoveActive = true;
    bot.touchMoveDir = move;
    bot.touchMoveLen = 255;
}
