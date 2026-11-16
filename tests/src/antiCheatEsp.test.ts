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

describe("offscreen aim with lead / never seen / far band", () => {
    test("an aimbot leading an enemy who strafes off the screen", () => {
        // 40 units out, strafing up/down at 12 u/s; bullets at 100 u/s -> ~0.4 s lead (~7 degrees)
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        const viewer = esp(1, { zoom: 28 });
        const enemy = esp(2);
        for (let ms = 0; ms <= 30_000; ms += 50) {
            const vy = Math.cos(ms / 1500) > 0 ? 12 : -12;
            enemy.pos = v2.create(40, Math.sin(ms / 1500) * 10);
            enemy.moveVel = v2.create(0, vy);
            const lead = 40 / 100;
            const a = Math.atan2(enemy.pos.y + vy * lead, 40);
            viewer.dir = v2.create(Math.cos(a), Math.sin(a));
            mon.onTick(viewer, [viewer, enemy], 1_000_000 + ms, 100);
        }
        expect(mon.flagged).toContain("offscreen_aim");
    });

    test("an enemy the client only knows from the grid cells beyond 45 units still counts", () => {
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        const enemy = esp(2);
        const viewer = esp(1, { zoom: 28, visibleObjects: new Set([enemy]) as never });
        for (let ms = 0; ms <= 30_000; ms += 50) {
            enemy.pos = v2.create(40, 25 - ms / 5000);
            const a = Math.atan2(enemy.pos.y, enemy.pos.x);
            viewer.dir = v2.create(Math.cos(a), Math.sin(a));
            mon.onTick(viewer, [viewer, enemy], 1_000_000 + ms);
        }
        expect(mon.flagged).toContain("offscreen_aim");
    });

    test("an enemy the client doesn't get: nothing", () => {
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        const enemy = esp(2);
        const viewer = esp(1, { zoom: 28, visibleObjects: new Set([{}]) as never });
        for (let ms = 0; ms <= 30_000; ms += 50) {
            enemy.pos = v2.create(31.5 - ms / 15000, 0);
            viewer.dir = v2.create(1, 0);
            mon.onTick(viewer, [viewer, enemy], 1_000_000 + ms);
        }
        expect(mon.summary()).toBeUndefined();
    });

    test("an enemy shown on the map by their role: nothing", () => {
        const mon = runOffscreen((ms) => ({ x: 31.5 - ms / 15000, y: 0 }), (b) => b, 30);
        expect(mon.flagged).toContain("offscreen_aim");
        const mon2 = new CheatMonitor({ isMobile: false, name: "Player" });
        const viewer = esp(1, { zoom: 28 });
        const enemy = esp(2, { mapIndicator: {} });
        for (let ms = 0; ms <= 30_000; ms += 50) {
            enemy.pos = v2.create(31.5 - ms / 15000, 0);
            viewer.dir = v2.create(1, 0);
            mon2.onTick(viewer, [viewer, enemy], 1_000_000 + ms);
        }
        expect(mon2.scores.offscreen_aim).toBe(0);
    });
});

describe("offscreen_hit", () => {
    /** enemy at `pos` (on the screen until `seenUntil` ms), then `hits` hits of `damage`, `everyMs` apart */
    function hits(opts: { pos: { x: number; y: number }; seenUntil?: number; hits: number; damage: number; everyMs: number; lastShotAt?: number }) {
        const mon = new CheatMonitor({ isMobile: false, name: "Player" });
        const viewer = esp(1, { zoom: 28 });
        const enemy = esp(2);
        let now = 1_000_000;
        // a few seconds of ticks before the hits start
        for (let ms = 0; ms <= 6000; ms += 50, now += 50) {
            enemy.pos = ms < (opts.seenUntil ?? -1) ? v2.create(10, 0) : v2.create(opts.pos.x, opts.pos.y);
            mon.onTick(viewer, [viewer, enemy], now);
        }
        enemy.lastShotAt = opts.lastShotAt ?? 0;
        for (let i = 0; i < opts.hits; i++, now += opts.everyMs) {
            mon.onTick(viewer, [viewer, enemy], now);
            mon.onBulletHit(viewer, enemy, opts.damage, now);
        }
        return mon;
    }

    test("two SV-98 hits on an enemy who never was on the screen", () => {
        const mon = hits({ pos: { x: 33, y: 0 }, hits: 2, damage: 80, everyMs: 1500 });
        expect(mon.flagged).toContain("offscreen_hit");
        expect(mon.report()).toMatch(/offscreen_hit \(score 160 dmg, 2 hits\)/);
        expect(mon.summary()!.offscreenHits).toBe(2);
    });

    test("an AK spray landing on an enemy off the screen", () => {
        const mon = hits({ pos: { x: 33, y: 0 }, hits: 8, damage: 13.5, everyMs: 100 });
        expect(mon.flagged).toContain("offscreen_hit");
    });

    test("one lucky blind shot: scores, but no flag", () => {
        const mon = hits({ pos: { x: 33, y: 0 }, hits: 1, damage: 80, everyMs: 0 });
        expect(mon.scores.offscreen_hit).toBe(80);
        expect(mon.flagged).toStrictEqual([]);
    });

    test("an enemy on the screen: nothing", () => {
        const mon = hits({ pos: { x: 25, y: 0 }, hits: 10, damage: 80, everyMs: 500 });
        expect(mon.scores.offscreen_hit).toBe(0);
    });

    test("an enemy who just walked off the screen: nothing", () => {
        // on screen until 4.5 s, hits from 6 s (1.5 s later)
        const mon = hits({ pos: { x: 33, y: 0 }, seenUntil: 4500, hits: 2, damage: 80, everyMs: 500 });
        expect(mon.scores.offscreen_hit).toBe(0);
    });

    test("an enemy who keeps shooting: nothing", () => {
        const mon = hits({ pos: { x: 33, y: 0 }, hits: 10, damage: 80, everyMs: 500, lastShotAt: Number.MAX_SAFE_INTEGER });
        expect(mon.scores.offscreen_hit).toBe(0);
    });

    test("barely off the screen (half a body peeking in): nothing", () => {
        const mon = hits({ pos: { x: 29.5, y: 0 }, hits: 10, damage: 80, everyMs: 500 });
        expect(mon.scores.offscreen_hit).toBe(0);
    });
});
