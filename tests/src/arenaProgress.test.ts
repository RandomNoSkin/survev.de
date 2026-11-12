import { ARENA_JUGGERNAUT_M249_KILLS } from "../../shared/defs/modes/arenaDefs.ts";
import { ARENA_EXTRA_PERKS, ARENA_STREAK_ITEMS } from "../../shared/defs/modes/arenaStreakDefs.ts";
import { GameObjectDefs } from "../../shared/defs/register.ts";
import { describe, expect, test } from "vitest";
import { ARENA_CHALLENGES, ARENA_LEVEL_UNLOCKS, ARENA_MAX_LEVEL, ARENA_STARTER_ITEMS, arenaXpForLevel } from "../../shared/defs/modes/arenaDefs.ts";
import { ModeStandingsMsg } from "../../shared/net/modeStandingsMsg.ts";
import * as net from "../../shared/net/net.ts";
import {
    ARENA_DEFAULT_LOADOUT,
    arenaLevelFromXp,
    arenaFitsSlot,
    arenaSlotOf,
    arenaUnlocked,
    challengeProgress,
    sanitizeArenaLoadout,
} from "../../shared/utils/arena.ts";

describe("arena progression", () => {
    test("every listed item exists and fits a loadout slot", () => {
        // (kill streak items and Broken Arrow are picked apart, not in a loadout slot)
        const apart = (t: string) => ARENA_STREAK_ITEMS.includes(t) || ARENA_EXTRA_PERKS.includes(t);
        for (const t of [...ARENA_STARTER_ITEMS, ...Object.values(ARENA_LEVEL_UNLOCKS).flat(), ...Object.keys(ARENA_CHALLENGES)]) {
            if (apart(t)) expect(GameObjectDefs.typeToDefSafe(t), t).toBeDefined();
            else expect(arenaSlotOf(t), t).toBeDefined();
        }
        for (const [t, ch] of Object.entries(ARENA_CHALLENGES)) {
            if ("weapon" in ch.with && !apart(ch.with.weapon) && ch.with.weapon !== ARENA_JUGGERNAUT_M249_KILLS) {
                expect(arenaSlotOf(ch.with.weapon), `${t} builds on ${ch.with.weapon}`).toBeDefined();
            }
        }
        expect(arenaSlotOf("p30l")).toBe("pistol");
        expect(arenaSlotOf("deagle_dual")).toBe("pistol");
        expect(arenaSlotOf("hk416")).toBe("primary");
        expect(arenaSlotOf("frag")).toBe("throwable");
        expect(arenaSlotOf("takedown")).toBe("perk");
        expect(arenaSlotOf("bandage")).toBeUndefined();
        // the MP220: a main gun, and a secondary too
        expect(arenaFitsSlot("mp220", "primary")).toBe(true);
        expect(arenaFitsSlot("mp220", "pistol")).toBe(true);
        expect(arenaFitsSlot("m870", "pistol")).toBe(false);
        expect(sanitizeArenaLoadout({ pistol: "mp220" }, new Set(["mp220"])).pistol).toBe("mp220");
    });

    test("level from XP", () => {
        expect(arenaLevelFromXp(0)).toStrictEqual({ level: 1, into: 0, needed: arenaXpForLevel(1) });
        expect(arenaLevelFromXp(arenaXpForLevel(1)).level).toBe(2);
        expect(arenaLevelFromXp(arenaXpForLevel(1) + 10).into).toBe(10);
        expect(arenaLevelFromXp(10_000_000).level).toBe(ARENA_MAX_LEVEL);
    });

    test("unlocks: starters, by level, by challenge", () => {
        const fresh = arenaUnlocked(1, {});
        expect([...fresh].sort()).toStrictEqual([...ARENA_STARTER_ITEMS].sort());
        const lvl4 = arenaUnlocked(4, {});
        for (const t of [...ARENA_LEVEL_UNLOCKS[2], ...ARENA_LEVEL_UNLOCKS[4]]) expect(lvl4.has(t)).toBe(true);
        expect(lvl4.has("m4a1")).toBe(false);
        // m4a1: 150 kills with the M416 - skins of it count
        expect(challengeProgress(ARENA_CHALLENGES.m4a1, { hk416: 100 })).toBe(100);
        expect(arenaUnlocked(1, { hk416: 150 }).has("m4a1")).toBe(true);
        // a category challenge sums its guns
        expect(challengeProgress(ARENA_CHALLENGES.usas, { m870: 100, mp220: 160, mp5: 50 })).toBe(260);
        expect(arenaUnlocked(1, { m870: 100, mp220: 160 }).has("usas")).toBe(true);
    });

    test("a loadout keeps only unlocked items in their own slot", () => {
        const unlocked = arenaUnlocked(1, {});
        expect(sanitizeArenaLoadout({ primary: "ak47", pistol: "hk416", throwable: "mirv", perk: "takedown" }, unlocked)).toStrictEqual(
            ARENA_DEFAULT_LOADOUT,
        );
        const lvl8 = arenaUnlocked(8, {});
        expect(sanitizeArenaLoadout({ primary: "ak47", pistol: "p30l", throwable: "frag", perk: "takedown" }, lvl8).primary).toBe("ak47");
        expect(sanitizeArenaLoadout(undefined, lvl8)).toStrictEqual(ARENA_DEFAULT_LOADOUT);
    });

    test("ModeStandingsMsg carries team scores and zones", () => {
        const msg = new ModeStandingsMsg();
        msg.teamScores = [120, 87];
        msg.scoreLimit = 250;
        msg.zones = [{ pos: { x: 100, y: 120 }, rad: 10, owner: 1, capTeam: 0, progress: 0.5, contested: true, mult: 2 }];
        msg.entries = [{ playerId: 3, score: 7 }];
        const stream = new net.MsgStream(new ArrayBuffer(1024));
        stream.serializeMsg(net.MsgType.ModeStandings, msg);
        const read = new net.MsgStream(stream.getBuffer());
        expect(read.deserializeMsgType()).toBe(net.MsgType.ModeStandings);
        const back = new ModeStandingsMsg();
        back.deserialize(read.getStream());
        expect(back.teamScores).toStrictEqual([120, 87]);
        expect(back.scoreLimit).toBe(250);
        expect(back.zones[0].owner).toBe(1);
        expect(back.zones[0].contested).toBe(true);
        expect(back.zones[0].mult).toBe(2);
        expect(back.zones[0].progress).toBeCloseTo(0.5, 1);
        expect(Math.round(back.zones[0].pos.x)).toBe(100);
    });
});
