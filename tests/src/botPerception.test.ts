import { expect, test } from "vitest";
import { findGrenadeThreat, findVisibleTarget } from "../../server/src/game/bot/botPerception.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/**
 * A real player only sees what fits on their screen - a landscape rectangle - not an
 * omnidirectional radar circle. With no scope equipped (the default, and bots never
 * manage one), zoom clamps to the 45-unit floor in `viewHalfExtentsFor`, giving a
 * 45-unit half-width and a 45/(16/9) = 25.3-unit half-height.
 */

test("A bot's view is a 16:9 rectangle, not a circle: far above is unseen even inside the equivalent circular range", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(100, 100) });
    // 35 units straight up: inside a 45-unit circle, but past the ~25.3-unit rectangle
    // half-height - exactly the case a circular check would get wrong.
    game.playerBarn.addTestPlayer({ pos: v2.create(100, 65) });

    expect(findVisibleTarget(bot)).toBeUndefined();
});

test("A bot's view extends its full width to the side, matching a landscape screen", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 100) });
    // 40 units to the side: well within the 45-unit half-width.
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(40, 100) });

    expect(findVisibleTarget(bot)).toBe(target);
});

// Regression: a bot's spotting range used to be a separately-tuned magnitude clamped to
// a "plausible spotting distance" floor of 90 units, regardless of scope - a real player
// on foot never sees anywhere near that far. That let bots spot (and start engaging)
// targets from roughly twice as far away as a real player reasonably would - the "sees
// farther than a player" complaint. The floor is now much lower (45).
test("A bot can't see a target well past the old, overly generous spotting floor", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 100) });
    // 70 units: inside the old 90-unit floor, well outside the new 45-unit one.
    game.playerBarn.addTestPlayer({ pos: v2.create(70, 100) });

    expect(findVisibleTarget(bot)).toBeUndefined();
});

test("findGrenadeThreat finds a live, explosive-armed throwable about to explode", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    const nadePos = v2.create(55, 50); // 5 units - well inside the danger radius
    game.projectileBarn.addProjectile(
        0,
        "frag",
        nadePos,
        0,
        0,
        v2.create(0, 0),
        1.0, // under GRENADE_REACT_TIME (1.3) - genuinely about to go off
        GameConfig.DamageType.Player,
    );

    expect(findGrenadeThreat(bot)).toEqual(nadePos);
});

// The explicit ask: a bot shouldn't instantly bolt the moment a grenade is merely
// thrown somewhere nearby, several seconds before it could possibly explode - only once
// it's genuinely about to go off (`GRENADE_REACT_TIME`), matching how a real player
// keeps fighting right up until a live nade is actually a threat.
test("findGrenadeThreat ignores a freshly-thrown grenade with plenty of fuse left", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    game.projectileBarn.addProjectile(
        0,
        "frag",
        v2.create(55, 50), // well inside the danger radius
        0,
        0,
        v2.create(0, 0),
        4, // frag's full fuse time - just thrown, nothing to react to yet
        GameConfig.DamageType.Player,
    );

    expect(findGrenadeThreat(bot)).toBeUndefined();
});

test("findGrenadeThreat ignores one too far away to matter", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    game.projectileBarn.addProjectile(
        0,
        "frag",
        v2.create(90, 50), // 40 units - past GRENADE_DANGER_RADIUS
        0,
        0,
        v2.create(0, 0),
        1.0,
        GameConfig.DamageType.Player,
    );

    expect(findGrenadeThreat(bot)).toBeUndefined();
});

// Regression guard: a non-explosive throwable (smoke, decoys, ...) sailing past isn't a
// threat worth juking for - only something with an actual `explosionType` is.
test("findGrenadeThreat ignores a non-explosive throwable like smoke", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(50, 50) });
    game.projectileBarn.addProjectile(
        0,
        "smoke",
        v2.create(55, 50),
        0,
        0,
        v2.create(0, 0),
        1.0,
        GameConfig.DamageType.Player,
    );

    expect(findGrenadeThreat(bot)).toBeUndefined();
});
