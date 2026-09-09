import { expect, test } from "vitest";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import * as net from "../../shared/net/net.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

function interactInput() {
    const msg = new net.InputMsg();
    msg.inputs = [GameConfig.Input.Interact] as any;
    msg.toMouseDir = v2.create(1, 0);
    msg.touchMoveDir = v2.create(1, 0);
    return msg;
}

test("opening an airdrop reacts immediately and breaks open after the open animation", () => {
    const game = createGame(TeamMode.Solo, "test_normal");
    const player = game.playerBarn.addTestPlayer({});

    const crate = game.map.genObstacle("airdrop_crate_01", v2.copy(player.pos));
    const seqBefore = crate.button.seq;

    player.handleInput(interactInput());

    // the client only learns about the press through onOff/seq — it has to flip on the
    // same tick, otherwise the interaction feels dead for the whole open animation
    expect(crate.button.seq).toBe(seqBefore + 1);
    expect(crate.button.onOff).toBe(true);
    expect(crate.button.canUse).toBe(false);
    expect(crate.dead).toBe(false);

    // still open-ing shortly before the animation is done...
    for (let i = 0; i < 20; i++) game.step(0.1);
    expect(crate.dead).toBe(false);

    // ...and broken open right after `useDelay` (2.5s), not twice that
    for (let i = 0; i < 8; i++) game.step(0.1);
    expect(crate.dead).toBe(true);
});
