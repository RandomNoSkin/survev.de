import { expect, test } from "vitest";
import { findVisibleTarget } from "../../server/src/game/bot/botPerception.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/**
 * A real player only sees what fits on their screen - a landscape rectangle - not an
 * omnidirectional radar circle. With no scope equipped (the default, and bots never
 * manage one), zoom clamps to the 90-unit floor in `viewHalfExtentsFor`, giving a
 * 90-unit half-width and a 90/(16/9) = 50.625-unit half-height.
 */

test("A bot's view is a 16:9 rectangle, not a circle: far above is unseen even inside the old circular range", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(100, 100) });
    // 70 units straight up: inside a 90-unit circle, but past the ~50.6-unit rectangle
    // half-height - exactly the case a circular check would get wrong.
    game.playerBarn.addTestPlayer({ pos: v2.create(100, 30) });

    expect(findVisibleTarget(bot)).toBeUndefined();
});

test("A bot's view extends its full width to the side, matching a landscape screen", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const bot = game.playerBarn.addTestPlayer({ pos: v2.create(0, 100) });
    // 85 units to the side: well within the 90-unit half-width.
    const target = game.playerBarn.addTestPlayer({ pos: v2.create(85, 100) });

    expect(findVisibleTarget(bot)).toBe(target);
});
