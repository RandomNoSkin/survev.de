import { describe, expect, test, vi } from "vitest";
import { CheatMonitor } from "../../server/src/game/antiCheat.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import * as net from "../../shared/net/net.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

function input(angle: number, opts: Partial<net.InputMsg> = {}) {
    const msg = new net.InputMsg();
    msg.toMouseDir = v2.create(Math.cos(angle), Math.sin(angle));
    msg.toMouseLen = 30;
    Object.assign(msg, opts);
    return msg;
}

/** Feeds `n` inputs, `dt` ms apart, from `make(i)`. */
function feed(mon: CheatMonitor, n: number, dt: number, make: (i: number) => net.InputMsg, start = 0) {
    for (let i = 0; i < n; i++) mon.onInput(make(i), start + i * dt);
}

/** deterministic noise, so the "human" streams are the same every run */
function rng(seed: number) {
    return () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };
}

describe("flags", () => {
    test("a spinbot", () => {
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        // ~2 turns a second, inputs at 60/s, for 10 seconds
        feed(mon, 600, 16, (i) => input(i * 0.21));
        expect(mon.flagged).toContain("spinbot");
        expect(mon.report()).toMatch(/spinbot/);
    });

    test("touch steering on a desktop client, flipping with the keys", () => {
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        feed(mon, 40, 16, (i) =>
            i % 2
                ? input(0, { touchMoveActive: true, touchMoveLen: 255, touchMoveDir: v2.create(1, 0) })
                : input(0, { moveUp: true }),
        );
        expect(mon.flagged).toContain("touch_desktop");
    });

    test("silent aim: snapping to the target on the shot and straight back", () => {
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        let t = 0;
        for (let shot = 0; shot < 8; shot++) {
            mon.onInput(input(0), (t += 16));
            mon.onInput(input(Math.PI / 2, { shootStart: true }), (t += 16));
            mon.onInput(input(0.02), (t += 16));
            t += 500;
        }
        expect(mon.flagged).toContain("snap_aim");
        expect(mon.report()).toMatch(/8\/8 shots/);
    });
});

describe("flags the trezor client", () => {
    test("by the name it forces on its users", () => {
        const mon = new CheatMonitor({ isMobile: false, name: " Trezor Client " });
        mon.onInput(input(0), 0);
        expect(mon.flagged).toStrictEqual(["cheat_name"]);
    });

    test("silent aim that holds the target until the shot is acked, then jumps back", () => {
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        let t = 0;
        for (let shot = 0; shot < 8; shot++) {
            mon.onInput(input(1), (t += 16));
            // on the target for ~ping + 200 ms, following it a little
            mon.onInput(input(-0.6, { shootStart: true }), (t += 16));
            for (let i = 0; i < 6; i++) mon.onInput(input(-0.6 + i * 0.02), (t += 60));
            mon.onInput(input(1.03), (t += 16));
            t += 700;
        }
        expect(mon.flagged).toContain("snap_aim");
    });

    test("a slow spinbot (1 turn a second)", () => {
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        feed(mon, 900, 16, (i) => input((i * 16 * 2 * Math.PI) / 1000));
        expect(mon.flagged).toContain("spinbot");
    });
});

describe("doesn't flag", () => {
    test("flicking to an enemy, shooting, and now and then flicking back", () => {
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        let t = 0;
        for (let shot = 0; shot < 60; shot++) {
            mon.onInput(input(0), (t += 16));
            mon.onInput(input(2, { shootStart: true }), (t += 16));
            // stays on the target for the follow-up shots
            for (let i = 0; i < 4; i++) mon.onInput(input(2 + i * 0.03, { shootStart: i % 2 === 0 }), (t += 120));
            // every 8th fight ends with a flick back to where they looked before
            if (shot % 8 === 0) mon.onInput(input(0.05), (t += 16));
            t += 1500;
        }
        expect(mon.flagged).toStrictEqual([]);
    });

    test("a human aiming around and flick-shooting", () => {
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        const r = rng(7);
        let angle = 0;
        let t = 0;
        for (let i = 0; i < 6000; i++) {
            const flick = i % 90 === 0;
            // wander, sometimes a big flick that stays where it landed
            angle += flick ? (r() - 0.5) * 3 : (r() - 0.5) * 0.3;
            mon.onInput(input(angle, { shootStart: flick || r() < 0.05, moveUp: r() < 0.5, moveLeft: r() < 0.3 }), (t += 16));
        }
        expect(mon.flagged).toStrictEqual([]);
    });

    test("someone circling the mouse a bit", () => {
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        // one full turn in a second, then it stops
        feed(mon, 60, 16, (i) => input((i / 60) * 2 * Math.PI));
        feed(mon, 200, 16, () => input(0), 1000);
        expect(mon.flagged).toStrictEqual([]);
    });

    test("a mobile player on the touch joystick", () => {
        const mon = new CheatMonitor({ isMobile: true, name: "Player" });
        feed(mon, 2000, 16, (i) =>
            input(i * 0.01, { touchMoveActive: true, touchMoveLen: 255, touchMoveDir: v2.create(Math.cos(i), Math.sin(i)) }),
        );
        expect(mon.flagged).toStrictEqual([]);
    });
});

test("A flagged player ends up in the save_game anti-cheat list, a clean one doesn't", () => {
    const game = createGame(TeamMode.Solo, "main");
    const cheater = game.playerBarn.addTestPlayer({});
    const clean = game.playerBarn.addTestPlayer({});
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
        for (let i = 0; i < 600; i++) {
            vi.advanceTimersByTime(16);
            cheater.handleInput(input(i * 0.21));
            clean.handleInput(input(0.1 + (i % 7) * 0.01));
        }
    } finally {
        vi.useRealTimers();
    }

    const flags = game.antiCheatFlags();
    expect(flags?.flags.map((f) => f.userId)).toStrictEqual([`guest:${cheater.matchDataId}`]);
    expect(flags?.flags[0].note).toMatch(/^auto: spinbot/);
});
