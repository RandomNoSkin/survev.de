import { ARENA_JUGGERNAUT_M249_KILLS, ARENA_WEAPON_BUDGET, ARENA_WEAPON_POINTS } from "../../shared/defs/modes/arenaDefs.ts";
import { ARENA_AIRDROP_WEAPONS, ARENA_EXTRA_PERKS, ARENA_STREAK_ITEMS } from "../../shared/defs/modes/arenaStreakDefs.ts";
import { GunDefs } from "../../shared/defs/gameObjects/gunDefs.ts";
import { GameObjectDefs } from "../../shared/defs/register.ts";
import { describe, expect, test } from "vitest";
import { ARENA_CHALLENGES, ARENA_LEVEL_UNLOCKS, ARENA_MAX_LEVEL, ARENA_STARTER_ITEMS, arenaXpForLevel } from "../../shared/defs/modes/arenaDefs.ts";
import { ModeStandingsMsg } from "../../shared/net/modeStandingsMsg.ts";
import * as net from "../../shared/net/net.ts";
import {
    ARENA_DEFAULT_LOADOUT,
    ARENA_PRESET_LOADOUTS,
    arenaLevelFromXp,
    arenaFitsSlot,
    arenaLoadoutPoints,
    arenaSlotOf,
    arenaUnlocked,
    arenaWeaponBudget,
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
        // every gun with points is a real gun, either slot takes it
        for (const t of Object.keys(ARENA_WEAPON_POINTS)) {
            expect(GunDefs[t], t).toBeDefined();
            expect(arenaFitsSlot(t, "primary"), t).toBe(true);
            expect(arenaFitsSlot(t, "pistol"), t).toBe(true);
        }
        // the airdrop's guns (unless they have points) and the kill streaks' never go into a loadout
        for (const t of [...ARENA_AIRDROP_WEAPONS.filter((g) => ARENA_WEAPON_POINTS[g] === undefined), "m134", "modified_m249", "flare_gun"]) {
            expect(arenaFitsSlot(t, "primary"), t).toBe(false);
        }
        expect(arenaFitsSlot("frag", "throwable")).toBe(true);
        expect(arenaFitsSlot("frag", "primary")).toBe(false);
        expect(arenaSlotOf("takedown")).toBe("perk");
        expect(arenaSlotOf("bandage")).toBeUndefined();
        // the presets fit the budget
        for (const l of ARENA_PRESET_LOADOUTS) expect(arenaLoadoutPoints(l)).toBeLessThanOrEqual(ARENA_WEAPON_BUDGET);
    });

    test("level from XP", () => {
        expect(arenaLevelFromXp(0)).toStrictEqual({ level: 1, into: 0, needed: arenaXpForLevel(1) });
        expect(arenaLevelFromXp(arenaXpForLevel(1)).level).toBe(2);
        expect(arenaLevelFromXp(arenaXpForLevel(1) + 10).into).toBe(10);
        expect(arenaLevelFromXp(10_000_000).level).toBe(ARENA_MAX_LEVEL);
    });

    test("unlocks: every gun and the starters from the start, the rest by level or challenge", () => {
        const fresh = arenaUnlocked(1, {});
        expect([...fresh].sort()).toStrictEqual([...new Set([...ARENA_STARTER_ITEMS, ...Object.keys(ARENA_WEAPON_POINTS)])].sort());
        const lvl4 = arenaUnlocked(4, {});
        for (const t of [...ARENA_LEVEL_UNLOCKS[2], ...ARENA_LEVEL_UNLOCKS[4]]) expect(lvl4.has(t)).toBe(true);
        expect(lvl4.has("quickswitch")).toBe(false);
        // a category challenge sums its items
        expect(challengeProgress(ARENA_CHALLENGES.mirv, { frag: 30, smoke: 5, mp5: 50 })).toBe(35);
        expect(arenaUnlocked(1, { frag: 50 }).has("mirv")).toBe(true);
        expect(arenaUnlocked(1, { strobe: 50 }).has("broken_arrow")).toBe(true);
        // grenades: only by grenade kills, never by level
        const levelItems = Object.values(ARENA_LEVEL_UNLOCKS).flat();
        for (const g of ["smoke", "dynamite", "mirv"]) {
            expect(levelItems, g).not.toContain(g);
            expect(arenaUnlocked(ARENA_MAX_LEVEL, {}).has(g), g).toBe(false);
        }
        expect(arenaUnlocked(1, { frag: 10 }).has("smoke")).toBe(true);
        expect(arenaUnlocked(1, { frag: 24 }).has("dynamite")).toBe(false);
        expect(arenaUnlocked(1, { frag: 25 }).has("dynamite")).toBe(true);
    });

    test("a loadout: unlocked items in their slots, two different guns within the points", () => {
        const unlocked = arenaUnlocked(1, {});
        // a locked throwable / perk: the default's
        expect(sanitizeArenaLoadout({ primary: "hk416", pistol: "p30l", throwable: "mirv", perk: "quickswitch" }, unlocked)).toStrictEqual(
            ARENA_DEFAULT_LOADOUT,
        );
        expect(sanitizeArenaLoadout(undefined, unlocked)).toStrictEqual(ARENA_DEFAULT_LOADOUT);
        // two main guns within the budget
        const two = sanitizeArenaLoadout({ primary: "m870", pistol: "mp5", throwable: "frag", perk: "takedown" }, unlocked);
        expect([two.primary, two.pistol]).toStrictEqual(["m870", "mp5"]);
        // too many points: the main gun stays, the second one goes (the default's pistol)
        const much = sanitizeArenaLoadout({ primary: "m249", pistol: "m1014", throwable: "frag", perk: "takedown" }, unlocked);
        expect(much.primary).toBe("m249");
        expect(arenaLoadoutPoints(much)).toBeLessThanOrEqual(ARENA_WEAPON_BUDGET);
        // the same gun twice: not
        const same = sanitizeArenaLoadout({ primary: "mp5", pistol: "mp5", throwable: "frag", perk: "takedown" }, unlocked);
        expect(same.pistol).not.toBe("mp5");
        // a cleared loadout stays empty (picked again slot by slot); a missing one: the fallback
        const empty = { primary: "", pistol: "", throwable: "", perk: "" };
        expect(sanitizeArenaLoadout(empty, unlocked)).toStrictEqual(empty);
        expect(sanitizeArenaLoadout({ ...empty, primary: "m249" }, unlocked)).toStrictEqual({ ...empty, primary: "m249" });
        // not finished guns: not in a loadout
        for (const g of ["cz600", "m1a1"]) expect(arenaFitsSlot(g, "primary"), g).toBe(false);
        // airdrop guns: never
        expect(sanitizeArenaLoadout({ primary: "awc", pistol: "p30l", throwable: "frag", perk: "takedown" }, unlocked).primary).toBe("hk416");
    });

    test("Quickswitch: +50 points for the two guns", () => {
        expect(arenaWeaponBudget("takedown")).toBe(ARENA_WEAPON_BUDGET);
        expect(arenaWeaponBudget("quickswitch")).toBe(ARENA_WEAPON_BUDGET + 50);
        const unlocked = arenaUnlocked(ARENA_MAX_LEVEL, {});
        const heavy = { primary: "m249", pistol: "m1014", throwable: "frag", perk: "quickswitch" };
        expect(arenaLoadoutPoints(heavy)).toBeGreaterThan(ARENA_WEAPON_BUDGET);
        expect(sanitizeArenaLoadout(heavy, unlocked)).toStrictEqual(heavy);
        // without Quickswitch the same two don't fit
        expect(sanitizeArenaLoadout({ ...heavy, perk: "takedown" }, unlocked).pistol).not.toBe("m1014");
    });

    test("ModeStandingsMsg carries team scores and zones", () => {
        const msg = new ModeStandingsMsg();
        msg.teamScores = [120, 87];
        msg.scoreLimit = 250;
        msg.zones = [
            { pos: { x: 100, y: 120 }, rad: 10, owner: 1, capTeam: 0, progress: 0.5, contested: true, mult: 2, layer: 0 },
            { pos: { x: 50, y: 60 }, rad: 9, owner: 0, capTeam: 2, progress: 0.25, contested: false, mult: 1, layer: 1 },
        ];
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
        expect(back.zones.map((z) => z.layer)).toStrictEqual([0, 1]);
        expect(back.zones[1].capTeam).toBe(2);
    });
});
