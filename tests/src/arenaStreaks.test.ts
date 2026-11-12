import { describe, expect, test } from "vitest";
import type { Domination } from "../../server/src/game/modes/domination.ts";
import type { Player } from "../../server/src/game/objects/player.ts";
import { GunDefs } from "../../shared/defs/gameObjects/gunDefs.ts";
import { ARENA_CHALLENGES, ARENA_GEAR, ARENA_JUGGERNAUT_M249_KILLS, ARENA_STARTER_ITEMS } from "../../shared/defs/modes/arenaDefs.ts";
import { ARENA_AIRDROP_WEAPONS, ARENA_DEFAULT_STREAKS, ARENA_STREAK_DESCRIPTIONS, ARENA_STREAKS, ARENA_SUPPLY_DROP_LOOT } from "../../shared/defs/modes/arenaStreakDefs.ts";
import { DOMINATION_RESPAWN_DELAY_S, DOMINATION_SPAWN_PROTECTION_S } from "../../shared/defs/modes/dominationDefs.ts";
import { GameConfig, GameMode, TeamMode } from "../../shared/gameConfig.ts";
import * as net from "../../shared/net/net.ts";
import { arenaSlotOf, sanitizeArenaStreaks } from "../../shared/utils/arena.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/** Kill streaks (arenaStreakDefs.ts) in Domination. */

function domination(perTeam = 1) {
    const game = createGame(TeamMode.Squad, "domination", GameMode.Domination);
    const rules = game.rules as Domination;
    const groups = [game.playerBarn.addGroup(false, false), game.playerBarn.addGroup(false, false)];
    const ps: Player[] = [];
    for (const group of groups) {
        for (let i = 0; i < perTeam; i++) ps.push(game.playerBarn.addTestPlayer({ group }));
    }
    rules.startMatch();
    tick(game, DOMINATION_SPAWN_PROTECTION_S + 0.1);
    const red = ps.filter((p) => rules.sideOf(p) === 1);
    const blue = ps.filter((p) => rules.sideOf(p) === 2);
    return { game, rules, red, blue };
}

function tick(game: ReturnType<typeof createGame>, seconds: number) {
    for (let t = 0; t < seconds; t += 0.05) {
        game.update(0.05);
        game.msgsToSend.stream.index = 0;
    }
}

function kill(victim: Player, killer: Player) {
    victim.damage({ amount: 1000, damageType: GameConfig.DamageType.Player, source: killer, gameSourceType: killer.activeWeapon, dir: v2.create(1, 0) });
}

/** `n` kills for `killer` in a row (the victim respawns in between). */
function streakOf(game: ReturnType<typeof createGame>, rules: Domination, killer: Player, victim: Player, n: number) {
    for (let i = 0; i < n; i++) {
        kill(victim, killer);
        tick(game, DOMINATION_RESPAWN_DELAY_S + DOMINATION_SPAWN_PROTECTION_S + 0.2);
        expect(rules.isHidden(victim)).toBe(false);
    }
}

/** The last KillstreakMsg the player was sent. */
function lastStreakMsg(p: Player): net.KillstreakMsg | undefined {
    const msgs = (p.msgsToSend as Array<{ type: number; msg: unknown }>).filter((m) => m.type === net.MsgType.Killstreak);
    return msgs[msgs.length - 1]?.msg as net.KillstreakMsg | undefined;
}

const ready = (rules: Domination, p: Player) => (rules as unknown as { streakReady: Map<Player, { item: string }> }).streakReady.get(p)?.item;
/** the running kill streaks' items */
const actives = (rules: Domination, p: Player) => [...((rules as unknown as { streakActive: Map<Player, Map<string, string>> }).streakActive.get(p)?.values() ?? [])];
const active = (rules: Domination, p: Player) => actives(rules, p)[0];

describe("kill streaks", () => {
    test("the tiers: 3 / 5 / 7 / 10 kills; the defaults from the start, the rest unlocked like weapons", () => {
        expect(ARENA_STREAKS.map((t) => t.kills)).toStrictEqual([3, 5, 7, 10]);
        for (const item of ["flare_gun", "m134", "strobe"]) expect(ARENA_STARTER_ITEMS).toContain(item);
        expect(ARENA_CHALLENGES.modified_m249.with).toStrictEqual({ weapon: "m134" });
        expect(ARENA_CHALLENGES["8xscope"].with).toStrictEqual({ weapon: ARENA_JUGGERNAUT_M249_KILLS });
        // not in any loadout slot (picked apart), Broken Arrow neither (on top of the perk)
        for (const item of ["flare_gun", "supply_flare_gun", "m134", "modified_m249", "8xscope", "strobe", "broken_arrow"]) {
            expect(arenaSlotOf(item), item).toBeUndefined();
        }
        // picks: only what's unlocked
        const s = sanitizeArenaStreaks({ airdrop: "supply_flare_gun", juggernaut: "modified_m249", airdropWeapon: "awc", brokenArrow: true }, new Set(["flare_gun", "m134"]));
        expect(s).toMatchObject({ airdrop: "flare_gun", juggernaut: "m134", airdropWeapon: "awc", brokenArrow: false, eagleEye: false });
    });

    test("3 kills: the flare is ready; the key puts it in the melee slot, one shot calls the crate, then the melee is back", () => {
        const { game, rules, red, blue } = domination();
        const [r] = red;
        const [b] = blue;
        streakOf(game, rules, r, b, 3);
        expect(ready(rules, r)).toBe("flare_gun");
        expect(lastStreakMsg(r)?.ready).toBe("flare_gun");
        const melee = r.weapons[GameConfig.WeaponSlot.Melee].type;
        expect(rules.useKillstreak(r)).toBe(true);
        expect(r.weapons[GameConfig.WeaponSlot.Melee].type).toBe("flare_gun");
        expect(r.curWeapIdx).toBe(GameConfig.WeaponSlot.Melee);
        // not droppable, no extra speed (a flare normally gives +3)
        expect(rules.canDrop(r, "flare_gun")).toBe(false);
        expect(rules.equipSpeed(r, "flare_gun", 3)).toBe(0);
        expect(rules.equipSpeed(r, "m134", -1.5)).toBe(-1.5);
        // fire it (once the switch delay is over)
        tick(game, 1);
        r.shootStart = true;
        r.shootHold = true;
        tick(game, 0.05);
        r.shootStart = r.shootHold = false;
        tick(game, 0.1);
        expect(r.weapons[GameConfig.WeaponSlot.Melee].type).toBe(melee);
        expect(r.curWeapIdx).toBe(GameConfig.WeaponSlot.Melee);
        expect(active(rules, r)).toBeUndefined();
        // the crate: whose it is is remembered, it holds the picked airdrop weapon
        const calls = (rules as unknown as { calledCrates: Array<{ player: Player }> }).calledCrates;
        expect(calls.map((c) => c.player)).toContain(r);
    });

    test("a higher tier replaces the one not fired; an earned one stays over a death, a fired one ends with it", () => {
        const { game, rules, red, blue } = domination();
        const [r] = red;
        const [b] = blue;
        streakOf(game, rules, r, b, 7);
        expect(ready(rules, r)).toBe("m134");
        // dying keeps the earned one (the streak starts over)
        kill(r, b);
        tick(game, DOMINATION_RESPAWN_DELAY_S + DOMINATION_SPAWN_PROTECTION_S + 0.2);
        expect(ready(rules, r)).toBe("m134");
        expect(lastStreakMsg(r)?.streak).toBe(0);
        // fired, then dead: gone
        expect(rules.useKillstreak(r)).toBe(true);
        expect(active(rules, r)).toBe("m134");
        kill(r, b);
        expect(active(rules, r)).toBeUndefined();
        expect(ready(rules, r)).toBeUndefined();
    });

    test("Juggernaut: a full minigun, level 3 helmet, the usual vest, nothing else - the loadout back once it's empty", () => {
        const { game, rules, red, blue } = domination();
        const [r] = red;
        const [b] = blue;
        streakOf(game, rules, r, b, 7);
        expect(rules.useKillstreak(r)).toBe(true);
        expect(r.weapons[GameConfig.WeaponSlot.Primary].type).toBe("m134");
        expect(r.weapons[GameConfig.WeaponSlot.Primary].ammo).toBe(GunDefs.m134.maxClip);
        expect(r.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("");
        expect(r.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("");
        expect([r.helmet, r.chest]).toStrictEqual(["helmet03", ARENA_GEAR.chest]);
        expect(r.invManager.get("762mm")).toBe(0);
        expect(r.invManager.get("bandage")).toBe(0);
        // no picking up guns / armor, nothing to drop
        expect(rules.allowsPickup(r, "ak47")).toBe(false);
        expect(rules.allowsPickup(r, "helmet03")).toBe(false);
        expect(rules.canDrop(r, "m134")).toBe(false);
        // the magazine empty: the loadout (and its armor) back
        r.weapons[GameConfig.WeaponSlot.Primary].ammo = 0;
        tick(game, 0.1);
        expect(r.weapons[GameConfig.WeaponSlot.Primary].type).toBe("hk416");
        expect([r.helmet, r.chest]).toStrictEqual([ARENA_GEAR.helmet, ARENA_GEAR.chest]);
        expect(active(rules, r)).toBeUndefined();
        // a dead Juggernaut drops no minigun
        streakOf(game, rules, r, b, 0);
    });

    test("the endless M249 [+] Juggernaut: default armor, never runs dry, its kills count for Eagle Eye", () => {
        const { game, rules, red, blue } = domination();
        const [r] = red;
        const [b] = blue;
        r.arenaStreaks = { ...r.arenaStreaks, juggernaut: "modified_m249" };
        streakOf(game, rules, r, b, 7);
        expect(rules.useKillstreak(r)).toBe(true);
        expect(r.weapons[GameConfig.WeaponSlot.Primary].type).toBe("modified_m249");
        expect([r.helmet, r.chest]).toStrictEqual([ARENA_GEAR.helmet, ARENA_GEAR.chest]);
        expect(r.weaponManager.isInfinite(GunDefs.modified_m249)).toBe(true);
        tick(game, 0.5);
        expect(active(rules, r)).toBe("modified_m249");
        streakOf(game, rules, r, b, 1);
        expect(r.weaponKills.get(ARENA_JUGGERNAUT_M249_KILLS)).toBe(1);
        // a dead Juggernaut drops nothing of it
        kill(r, b);
        expect(game.lootBarn.loots.filter((l) => !l.destroyed && l.type === "modified_m249")).toHaveLength(0);
        expect(r.perks.some((p) => p.type === "endless_ammo")).toBe(false);
    });

    test("Eagle Eye (when unlocked): an 8x scope until the death; locked: the tier gives nothing", () => {
        const { game, rules, red, blue } = domination();
        const [r] = red;
        const [b] = blue;
        streakOf(game, rules, r, b, 5);
        // locked: 5 kills give nothing - the airdrop from 3 kills is still the one to fire
        expect(ready(rules, r)).toBe(ARENA_DEFAULT_STREAKS.airdrop);
        const { game: g2, rules: rules2, red: red2, blue: blue2 } = domination();
        const [r2] = red2;
        r2.arenaStreaks = { ...r2.arenaStreaks, eagleEye: true };
        streakOf(g2, rules2, r2, blue2[0], 5);
        expect(ready(rules2, r2)).toBe("8xscope");
        expect(rules2.useKillstreak(r2)).toBe(true);
        expect(r2.scope).toBe("8xscope");
        expect(rules2.canDrop(r2, "8xscope")).toBe(false);
        kill(r2, blue2[0]);
        tick(g2, DOMINATION_RESPAWN_DELAY_S + DOMINATION_SPAWN_PROTECTION_S + 0.2);
        expect(r2.invManager.get("8xscope")).toBe(0);
        void game;
    });

    test("Air Strike: a strobe in the throwable slot, not droppable, not dropped on death", () => {
        const { game, rules, red, blue } = domination();
        const [r] = red;
        const [b] = blue;
        r.arenaStreaks = { ...r.arenaStreaks, eagleEye: true };
        streakOf(game, rules, r, b, 10);
        expect(ready(rules, r)).toBe("strobe");
        expect(rules.useKillstreak(r)).toBe(true);
        expect(r.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("strobe");
        expect(r.invManager.get("strobe")).toBe(1);
        expect(rules.canDrop(r, "strobe")).toBe(false);
        // a Scavenger kill doesn't hand it over either
        b.removePerk("takedown");
        b.addPerk("scavenger", true);
        kill(r, b);
        expect(game.lootBarn.loots.filter((l) => !l.destroyed && l.type === "strobe")).toHaveLength(0);
    });

    test("called in crates: the airdrop holds the caller's pick (full magazine), the supply drop better armor; both come faster", () => {
        const { game, rules, red } = domination();
        const [r] = red;
        r.arenaStreaks = { ...r.arenaStreaks, airdropWeapon: "awc" };
        rules.onAirdropCalled(r.__id, r.pos, false);
        const crate = { type: "airdrop_crate_01", pos: v2.add(r.pos, v2.create(3, 0)) } as never;
        expect(rules.obstacleLoot(crate)).toStrictEqual(["awc"]);
        rules.onAirdropCalled(r.__id, r.pos, true);
        expect(rules.obstacleLoot({ type: "supply_crate_01", pos: r.pos } as never)).toStrictEqual(ARENA_SUPPLY_DROP_LOOT);
        // other obstacles: the usual (nothing in the arena)
        expect(rules.obstacleLoot({ type: "crate_01", pos: r.pos } as never)).toBeUndefined();
        // armor lying around can be picked up (the supply drop's)
        expect(rules.allowsPickup(r, "helmet03")).toBe(true);
        expect(rules.calledAirdropTimeFactor).toBeLessThan(1);
        // the crate opened for real: the gun with a full magazine
        rules.onAirdropCalled(r.__id, r.pos, false);
        const obstacle = game.map.genObstacle("airdrop_crate_01", v2.add(r.pos, v2.create(6, 0)), 0, 0, 1);
        obstacle.kill({ damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0) });
        const gun = game.lootBarn.loots.find((l) => !l.destroyed && l.type === "awc");
        expect(gun?.clip).toBe(GunDefs.awc.maxClip);
    });

    test("Broken Arrow: worn on top of the perk slot when switched on", () => {
        const game = createGame(TeamMode.Squad, "domination", GameMode.Domination);
        const group = game.playerBarn.addGroup(false, false);
        const p = game.playerBarn.addTestPlayer({ group });
        p.arenaStreaks = { ...p.arenaStreaks, brokenArrow: true };
        (game.rules as Domination).onJoin(p);
        expect(p.perks.some((x) => x.type === "broken_arrow" && !x.droppable)).toBe(true);
        expect(p.perks.some((x) => x.type === "takedown" && x.droppable)).toBe(true);
    });

    test("an air strike's kills count as strobe kills (Broken Arrow's challenge)", () => {
        const { rules, red, blue } = domination();
        const [r] = red;
        const [b] = blue;
        b.damage({ amount: 1000, damageType: GameConfig.DamageType.Airstrike, source: r, gameSourceType: "bomb_iron", isExplosion: true, dir: v2.create(1, 0) });
        expect(rules.isHidden(b)).toBe(true);
        expect(r.weaponKills.get("strobe")).toBe(1);
    });

    test("the airdrop weapons all exist as loot; every kill streak item has a description", () => {
        for (const gun of ARENA_AIRDROP_WEAPONS) expect(GunDefs[gun], gun).toBeDefined();
        expect(ARENA_AIRDROP_WEAPONS).toContain(ARENA_DEFAULT_STREAKS.airdropWeapon);
        for (const item of ARENA_STREAKS.flatMap((t) => t.options)) expect(ARENA_STREAK_DESCRIPTIONS[item], item).toBeTruthy();
    });

    test("several at once: Eagle Eye stays through the Juggernaut, the strobe on top of the minigun, and after it", () => {
        const { game, rules, red, blue } = domination();
        const [r] = red;
        const [b] = blue;
        r.arenaStreaks = { ...r.arenaStreaks, eagleEye: true };
        streakOf(game, rules, r, b, 5);
        expect(ready(rules, r)).toBe("8xscope");
        expect(rules.useKillstreak(r)).toBe(true);
        streakOf(game, rules, r, b, 2);
        expect(ready(rules, r)).toBe("m134");
        // the Juggernaut fired with Eagle Eye running: both run
        expect(rules.useKillstreak(r)).toBe(true);
        expect(actives(rules, r).sort()).toStrictEqual(["8xscope", "m134"]);
        expect(r.scope).toBe("8xscope");
        expect(r.weapons[GameConfig.WeaponSlot.Primary].type).toBe("m134");
        streakOf(game, rules, r, b, 3);
        expect(ready(rules, r)).toBe("strobe");
        expect(rules.useKillstreak(r)).toBe(true);
        expect(r.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("strobe");
        // the minigun empty: the loadout back - with the 8x scope and the strobe still there
        r.weapons[GameConfig.WeaponSlot.Primary].ammo = 0;
        tick(game, 0.1);
        expect(r.weapons[GameConfig.WeaponSlot.Primary].type).toBe("hk416");
        expect(r.scope).toBe("8xscope");
        expect(r.invManager.get("8xscope")).toBe(1);
        expect(r.invManager.get("strobe")).toBe(1);
        expect(actives(rules, r).sort()).toStrictEqual(["8xscope", "strobe"]);
        expect(lastStreakMsg(r)?.active.sort()).toStrictEqual(["8xscope", "strobe"]);
    });

    test("switched off tiers give nothing - the streak goes on to the next one, the HUD's next tier skips them", () => {
        const { game, rules, red, blue } = domination();
        const [r] = red;
        const [b] = blue;
        r.arenaStreaks = { ...r.arenaStreaks, eagleEye: true, off: ["airdrop", "eagle_eye"] };
        streakOf(game, rules, r, b, 1);
        // the next one: the Juggernaut (airdrop and Eagle Eye off)
        expect(lastStreakMsg(r)?.next).toBe(ARENA_STREAKS.findIndex((t) => t.kind === "juggernaut"));
        streakOf(game, rules, r, b, 4);
        expect(ready(rules, r)).toBeUndefined();
        streakOf(game, rules, r, b, 2);
        expect(ready(rules, r)).toBe("m134");
        // all off: no next tier
        r.arenaStreaks = { ...r.arenaStreaks, off: ["airdrop", "eagle_eye", "juggernaut", "airstrike"] };
        streakOf(game, rules, r, b, 1);
        expect(lastStreakMsg(r)?.next).toBe(-1);
        // the menu's settings: only real tiers, no doubles
        const clean = sanitizeArenaStreaks({ ...ARENA_DEFAULT_STREAKS, off: ["airstrike", "airstrike", "nope" as never] }, new Set());
        expect(clean.off).toStrictEqual(["airstrike"]);
    });

    test("KillstreakMsg: the next tier round trip", () => {
        for (const next of [-1, 0, 3]) {
            const msg = new net.KillstreakMsg();
            msg.streak = 4;
            msg.ready = "flare_gun";
            msg.active = ["8xscope"];
            msg.next = next;
            const stream = new net.MsgStream(new ArrayBuffer(256));
            stream.serializeMsg(net.MsgType.Killstreak, msg);
            const read = new net.MsgStream(stream.getBuffer());
            expect(read.deserializeMsgType()).toBe(net.MsgType.Killstreak);
            const back = new net.KillstreakMsg();
            back.deserialize(read.getStream());
            expect([back.streak, back.ready, back.active, back.next]).toStrictEqual([4, "flare_gun", ["8xscope"], next]);
        }
    });

    test("a Juggernaut picks up nothing at all", () => {
        const { game, rules, red, blue } = domination();
        const [r] = red;
        streakOf(game, rules, r, blue[0], 7);
        rules.useKillstreak(r);
        for (const item of ["ak47", "bandage", "556mm", "soda", "frag", "takedown", "helmet03"]) {
            expect(rules.allowsPickup(r, item), item).toBe(false);
        }
        expect(rules.canDrop(r, "chest02")).toBe(false);
    });

    test("an opened called in crate is gone right away (no open crate left), its loot where it stood", () => {
        const { game, rules, red } = domination();
        const [r] = red;
        rules.onAirdropCalled(r.__id, r.pos, false);
        const at = v2.add(r.pos, v2.create(6, 0));
        const crate = game.map.genObstacle("airdrop_crate_01", at, 0, 0, 1);
        const before = game.map.obstacles.length;
        crate.kill({ damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0) });
        expect(game.map.obstacles.length).toBe(before);
        expect(game.lootBarn.loots.some((l) => !l.destroyed && l.type === ARENA_DEFAULT_STREAKS.airdropWeapon)).toBe(true);
    });

    test("the kill leader: the most kills", () => {
        const { game, rules, red, blue } = domination();
        expect(rules.leader()).toBeUndefined();
        streakOf(game, rules, red[0], blue[0], 2);
        streakOf(game, rules, blue[0], red[0], 1);
        expect(rules.leader()).toStrictEqual({ player: red[0], score: 2 });
    });
});
