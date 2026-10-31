import { describe, expect, test, vi } from "vitest";
import { CHEAT_THRESHOLDS, CheatMonitor, type EspPlayer } from "../../server/src/game/antiCheat.ts";
import { RawMapObjectDefs } from "../../shared/defs/mapObjectDefs.ts";
import type { BuildingDef } from "../../shared/defs/mapObjectsTyping.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

const ROOF = { building: 1 };

function esp(id: number, opts: Partial<EspPlayer> = {}): EspPlayer {
    // zoom 100: everything in these tests is on the screen unless a test says otherwise
    return { __id: id, pos: v2.create(0, 0), dir: v2.create(1, 0), layer: 0, teamId: id, dead: false, insideSmoke: false, lastShotAt: 0, zoom: 100, portrait: false, ...opts };
}

/** Enemy walking a circle of `radius` around the viewer; `aim` decides the viewer's dir. */
function run(opts: {
    hidden: (t: number) => Partial<EspPlayer>;
    aim: (bearing: number, t: number) => number;
    seconds: number;
    radius?: number;
}) {
    const mon = new CheatMonitor({ isMobile: false, name: "Player" });
    const viewer = esp(1);
    const enemy = esp(2);
    const radius = opts.radius ?? 20;
    for (let ms = 0; ms <= opts.seconds * 1000; ms += 50) {
        const bearing = (ms / 1000) * 0.4; // ~23 degrees a second around the viewer
        enemy.pos = v2.create(Math.cos(bearing) * radius, Math.sin(bearing) * radius);
        Object.assign(enemy, opts.hidden(ms));
        const a = opts.aim(bearing, ms);
        viewer.dir = v2.create(Math.cos(a), Math.sin(a));
        mon.onTick(viewer, [viewer, enemy], 1_000_000 + ms);
    }
    return mon;
}

describe("esp_track flags", () => {
    test("following an enemy inside another building", () => {
        const mon = run({ hidden: () => ({ occupiedBuilding: ROOF }), aim: (b) => b, seconds: 30 });
        expect(mon.flagged).toContain("esp_track");
        expect(mon.report()).toMatch(/esp_track/);
    });

    test("following an enemy underground", () => {
        const mon = run({ hidden: () => ({ layer: 1 }), aim: (b) => b, seconds: 30 });
        expect(mon.flagged).toContain("esp_track");
    });
});

/** Viewer with a 1x scope (28 units to the side, ~16.75 up/down); enemy path `at(ms)`. */
function runOffscreen(at: (ms: number) => { x: number; y: number }, aim: (bearing: number, ms: number) => number, seconds: number) {
    const mon = new CheatMonitor({ isMobile: false, name: "Player" });
    const viewer = esp(1, { zoom: 28 });
    const enemy = esp(2);
    for (let ms = 0; ms <= seconds * 1000; ms += 50) {
        const p = at(ms);
        enemy.pos = v2.create(p.x, p.y);
        const a = aim(Math.atan2(p.y, p.x), ms);
        viewer.dir = v2.create(Math.cos(a), Math.sin(a));
        mon.onTick(viewer, [viewer, enemy], 1_000_000 + ms);
    }
    return mon;
}

describe("offscreen", () => {
    test("aiming at an enemy just off the screen, walking straight at you", () => {
        // creeps from 31.5 to 29.5 units to the right: off the screen (28 + 1) all along
        const mon = runOffscreen((ms) => ({ x: 31.5 - ms / 15000, y: 0 }), (b) => b, 30);
        expect(mon.flagged).toContain("offscreen_aim");
        expect(mon.report()).toMatch(/offscreen_aim/);
    });

    test("following an enemy moving along the band just off the screen counts as esp_track", () => {
        const mon = runOffscreen((ms) => ({ x: 30.5, y: Math.sin(ms / 2500) * 15 }), (b) => b, 60);
        expect(mon.flagged).toContain("esp_track");
    });

    test("an enemy camping just off the screen, aim held on them: nothing (you know they're there)", () => {
        const mon = runOffscreen(() => ({ x: 30.5, y: 0 }), (b) => b, 60);
        expect(mon.scores.offscreen_aim).toBe(0);
    });

    test("the same enemy, but on the screen: nothing", () => {
        const mon = runOffscreen((ms) => ({ x: 25, y: Math.sin(ms / 2500) * 12 }), (b) => b, 60);
        expect(mon.scores.offscreen_aim).toBe(0);
        expect(mon.scores.esp_track).toBe(0);
    });

    test("looking around while an enemy is off the screen: nothing", () => {
        const mon = runOffscreen((ms) => ({ x: 30.5, y: Math.sin(ms / 2500) * 15 }), (_b, ms) => ms / 700, 60);
        expect(mon.flagged).toStrictEqual([]);
    });

    test("portrait screens are taller than wide", () => {
        const mon = new CheatMonitor({ isMobile: true, name: "Player" });
        const viewer = esp(1, { zoom: 28, portrait: true });
        const enemy = esp(2, { pos: v2.create(0, 25) });
        for (let ms = 0; ms <= 30_000; ms += 50) {
            viewer.dir = v2.create(0, 1);
            mon.onTick(viewer, [viewer, enemy], ms);
        }
        // 25 up is on a portrait screen (28) - not offscreen
        expect(mon.scores.offscreen_aim).toBe(0);
    });
});

describe("esp_track doesn't flag", () => {
    test("following an enemy you can see", () => {
        const mon = run({ hidden: () => ({}), aim: (b) => b, seconds: 60 });
        expect(mon.scores.esp_track).toBe(0);
    });

    test("aiming at the building while they move around inside", () => {
        // static aim: they pass through it now and then, the aim doesn't follow
        const mon = run({ hidden: () => ({ occupiedBuilding: ROOF }), aim: () => 1, seconds: 60 });
        expect(mon.flagged).toStrictEqual([]);
    });

    test("an enemy who keeps shooting from inside", () => {
        const mon = run({ hidden: (t) => ({ occupiedBuilding: ROOF, lastShotAt: 1_000_000 + t }), aim: (b) => b, seconds: 60 });
        expect(mon.scores.esp_track).toBe(0);
    });

    test("an enemy who keeps stepping in and out (under 2 s inside each time)", () => {
        const mon = run({ hidden: (t) => ({ occupiedBuilding: t % 3000 < 1500 ? ROOF : undefined }), aim: (b) => b, seconds: 60 });
        expect(mon.scores.esp_track).toBe(0);
    });

    test("a close enemy (you can hear them)", () => {
        const mon = run({ hidden: () => ({ occupiedBuilding: ROOF }), aim: (b) => b, seconds: 60, radius: 6 });
        expect(mon.scores.esp_track).toBe(0);
    });

    test("a teammate", () => {
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        const viewer = esp(1, { teamId: 5 });
        const mate = esp(2, { teamId: 5, occupiedBuilding: ROOF });
        for (let ms = 0; ms < 30_000; ms += 50) {
            const b = (ms / 1000) * 0.4;
            mate.pos = v2.create(Math.cos(b) * 20, Math.sin(b) * 20);
            viewer.dir = v2.create(Math.cos(b), Math.sin(b));
            mon.onTick(viewer, [viewer, mate], ms);
        }
        expect(mon.scores.esp_track).toBe(0);
    });

    test("in the summary it shows how close a player got", () => {
        // one short tracking run: scores, but far from the threshold
        const mon = run({ hidden: (t) => ({ occupiedBuilding: t < 6000 ? ROOF : undefined }), aim: (b) => b, seconds: 8 });
        const summary = mon.summary()!;
        expect(summary.scores.esp_track).toBeGreaterThan(0);
        expect(summary.maxRatio).toBeLessThan(1);
        expect(summary.maxRatio).toBeCloseTo(summary.scores.esp_track! / CHEAT_THRESHOLDS.esp_track, 1);
    });
});

test("In a real game: tracking an enemy inside a house from outside", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
        const game = createGame(TeamMode.Solo, "main");
        const center = v2.create(game.map.width / 2, game.map.height / 2);
        const house = game.map.genBuilding("house_red_01", center, 0, 0);
        const zoomIn = (RawMapObjectDefs.house_red_01 as BuildingDef).ceiling.zoomRegions[0].zoomIn!;
        const inside = v2.add(house.pos, v2.mul(v2.add(zoomIn.min, zoomIn.max), 0.5));

        const viewer = game.playerBarn.addTestPlayer({});
        const enemy = game.playerBarn.addTestPlayer({});
        viewer.cheatMonitor = new CheatMonitor(viewer);
        viewer.pos = v2.add(inside, v2.create(0, -38));
        for (let i = 0; i < 400; i++) {
            vi.advanceTimersByTime(50);
            // walking around inside, viewer's aim glued to them
            enemy.pos = v2.add(inside, v2.create(Math.sin(i / 20) * 4, Math.cos(i / 25) * 2));
            viewer.dir = v2.normalize(v2.sub(enemy.pos, viewer.pos));
            game.update(0.05);
        }
        expect(enemy.occupiedBuilding).toBe(house);
        expect(viewer.occupiedBuilding).not.toBe(house);
        expect(viewer.cheatMonitor.flagged).toContain("esp_track");
        expect(game.antiCheatFlags()?.scores?.[0].scores.esp_track).toBeGreaterThan(0);
    } finally {
        vi.useRealTimers();
    }
});
