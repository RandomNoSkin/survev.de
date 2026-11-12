import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { type Domination, isHardCover, splitIntoTeams } from "../../server/src/game/modes/domination.ts";
import type { Player } from "../../server/src/game/objects/player.ts";
import { ARENA_AFK_KICK_S, ARENA_BOOST_RESIST, ARENA_OUT_OF_COMBAT_HEAL_MULT, ARENA_OUT_OF_COMBAT_S, ARENA_CHALLENGES, ARENA_REVIVE_HEALTH, ARENA_GEAR, ARENA_LEVEL_UNLOCKS, ARENA_PERKS, ARENA_STARTER_ITEMS } from "../../shared/defs/modes/arenaDefs.ts";
import { ARENA_FAST_REVIVE_S } from "../../shared/defs/modes/arenaPerkDefs.ts";
import {
    DOMINATION_CAPTURE_S,
    DOMINATION_MIN_PLAYERS,
    DOMINATION_NEUTRALIZE_S,
    DOMINATION_POINT_INTERVAL_S,
    DOMINATION_RESPAWN_DELAY_S,
    DOMINATION_ABANDON_S,
    DOMINATION_SCORE_LIMIT,
    DOMINATION_START_CLUSTER_RAD,
    dominationMapScale,
    DOMINATION_SPAWN_PROTECTION_S,
} from "../../shared/defs/modes/dominationDefs.ts";
import { GameConfig, GameMode, TeamMode } from "../../shared/gameConfig.ts";
import { GameObjectDefs } from "../../shared/defs/register.ts";
import { arenaFitsSlot, sanitizeArenaLoadout } from "../../shared/utils/arena.ts";
import { ArenaLoadoutAction } from "../../shared/net/arenaLoadoutSelectMsg.ts";
import { ModePhase } from "../../shared/net/modeStandingsMsg.ts";
import * as net from "../../shared/net/net.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/** A Domination game with `perTeam` players in each of the two teams (groups), warmup skipped. */
function domination(perTeam = 2, start = true) {
    const game = createGame(TeamMode.Squad, "domination", GameMode.Domination);
    const rules = game.rules as Domination;
    const groups = [game.playerBarn.addGroup(false, false), game.playerBarn.addGroup(false, false)];
    const ps: Player[] = [];
    for (const group of groups) {
        for (let i = 0; i < perTeam; i++) ps.push(game.playerBarn.addTestPlayer({ group }));
    }
    if (start) {
        rules.startMatch();
        tick(game, DOMINATION_SPAWN_PROTECTION_S + 0.1);
    }
    const red = ps.filter((p) => rules.sideOf(p) === 1);
    const blue = ps.filter((p) => rules.sideOf(p) === 2);
    return { game, rules, ps, red, blue };
}

function tick(game: ReturnType<typeof createGame>, seconds: number) {
    for (let t = 0; t < seconds; t += 0.05) {
        game.update(0.05);
        // (the net sync isn't run here: drop what would have gone out, as it does)
        game.msgsToSend.stream.index = 0;
    }
}

/** The player's socket closes (as when leaving the game). */
function leave(game: ReturnType<typeof createGame>, p: Player) {
    game.playerBarn.socketIdToPlayer.set(p.socketId, p);
    game.handleSocketClose(p.socketId);
}

function moveTo(players: Player[], pos: { x: number; y: number }) {
    for (const p of players) {
        v2.set(p.pos, pos);
        p.game.grid.updateObject(p);
    }
}

/** keep `players` where they stand (test players don't move on their own, but respawns do) */
function kill(victim: Player, killer: Player) {
    victim.damage({
        amount: 1000,
        damageType: GameConfig.DamageType.Player,
        source: killer,
        gameSourceType: killer.activeWeapon,
        dir: v2.create(1, 0),
    });
}

describe("domination", () => {
    test("two even teams, each spawning on its own side with the arena gear", () => {
        const { game, rules, red, blue } = domination(3);
        expect(red).toHaveLength(3);
        expect(blue).toHaveLength(3);
        expect(rules.zones.map((z) => z.name)).toStrictEqual(["A", "B", "C"]);
        // red starts at side 1's edge, blue at side 2's
        const edge1 = rules.pointAt(0);
        const edge2 = rules.pointAt(1);
        for (const p of red) expect(v2.distance(p.pos, edge1)).toBeLessThan(v2.distance(p.pos, edge2));
        for (const p of blue) expect(v2.distance(p.pos, edge2)).toBeLessThan(v2.distance(p.pos, edge1));
        const p = red[0];
        expect([p.helmet, p.chest, p.backpack]).toStrictEqual([ARENA_GEAR.helmet, ARENA_GEAR.chest, ARENA_GEAR.backpack]);
        expect(p.weapons[0].type).toBe("hk416");
        expect(p.weapons[1].type).toBe("p30l");
        expect(p.invManager.get("bandage")).toBe(5);
        expect(p.hasPerk("takedown")).toBe(true);
        expect(game.lootBarn.loots.filter((l) => !l.destroyed)).toHaveLength(0);
    });

    test("standing in a zone takes it; an enemy zone goes neutral first; both teams in it: nothing moves", () => {
        const { game, rules, red, blue } = domination(2);
        const b = rules.zones[1];
        moveTo(red, b.pos);
        moveTo(blue, rules.pointAt(0.95));
        tick(game, DOMINATION_CAPTURE_S / 1.5 + 0.3);
        expect(b.owner).toBe(1);

        // blue comes in too: contested, frozen
        moveTo(blue, b.pos);
        tick(game, 1);
        expect(b.contested).toBe(true);
        expect(b.owner).toBe(1);
        expect(b.progress).toBe(1);

        // red leaves: blue neutralizes, then takes it
        moveTo(red, rules.pointAt(0.05));
        tick(game, DOMINATION_NEUTRALIZE_S / 1.5 + 0.3);
        expect(b.owner).toBe(0);
        expect(b.capTeam).toBe(2);
        tick(game, DOMINATION_CAPTURE_S / 1.5 + 0.3);
        expect(b.owner).toBe(2);
    });

    test("a held zone gives a point every few seconds, not while enemies are in it", () => {
        const { game, rules, red, blue } = domination(1);
        const a = rules.zones[0];
        moveTo(red, a.pos);
        moveTo(blue, rules.pointAt(0.95));
        tick(game, DOMINATION_CAPTURE_S + 0.2);
        expect(a.owner).toBe(1);
        const s0 = rules.teamScore(1);
        tick(game, DOMINATION_POINT_INTERVAL_S - 0.5);
        expect(rules.teamScore(1)).toBe(s0);
        // a holder standing in it: double points
        tick(game, 1);
        expect(rules.teamScore(1)).toBe(s0 + 2);
        expect(a.mult).toBe(2);
        // nobody in it: one point
        moveTo(red, rules.pointAt(0.05));
        const sAway = rules.teamScore(1);
        tick(game, DOMINATION_POINT_INTERVAL_S);
        expect(a.mult).toBe(1);
        expect(rules.teamScore(1)).toBe(sAway + 1);
        moveTo(blue, a.pos);
        const s1 = rules.teamScore(1);
        tick(game, DOMINATION_POINT_INTERVAL_S * 2);
        expect(rules.teamScore(1)).toBe(s1);
    });

    test("the point multiplier: x(1 + holders in the zone), at most x3", () => {
        const { game, rules, red, blue } = domination(3);
        const a = rules.zones[0];
        moveTo(red, a.pos);
        moveTo(blue, rules.pointAt(0.95));
        tick(game, DOMINATION_CAPTURE_S + 0.2);
        expect(a.owner).toBe(1);
        // (the random map may push one out of the zone - count who's really in it)
        const inZone = red.filter((p) => v2.distance(p.pos, a.pos) <= a.rad).length;
        expect(inZone).toBeGreaterThanOrEqual(2);
        expect(a.mult).toBe(Math.min(3, 1 + inZone));
        const s0 = rules.teamScore(1);
        tick(game, DOMINATION_POINT_INTERVAL_S);
        expect(rules.teamScore(1)).toBe(s0 + a.mult);
    });

    test("the score limit ends it, the winning team ranks first", () => {
        const { game, rules, red } = domination(1);
        rules.scores = [DOMINATION_SCORE_LIMIT - 1, 10];
        rules.zones[0].owner = 1;
        rules.zones[0].progress = 1;
        rules.zones[0].pointTimer = DOMINATION_POINT_INTERVAL_S - 0.1;
        moveTo(red, rules.pointAt(0.05));
        tick(game, 0.3);
        expect(game.over).toBe(true);
        expect(red[0].rank).toBe(1);
        expect(game.modeManager.currentRanks().get(red[0])).toBe(1);
        expect(rules.arenaXp(red[0])).toBeGreaterThan(0);
    });

    test("a kill: respawn on the own side after a moment, the victim's guns lie where they died", () => {
        const { game, rules, red, blue } = domination(1);
        const [r] = red;
        const [b] = blue;
        const at = v2.copy(b.pos);
        kill(b, r);
        expect(r.kills).toBe(1);
        expect(rules.isHidden(b)).toBe(true);
        // the guns and the perk - never ammo, no throwables
        const loot = game.lootBarn.loots.filter((l) => !l.destroyed).map((l) => l.type).sort();
        expect(loot).toStrictEqual(["hk416", "p30l", "takedown"]);
        expect(v2.distance(game.lootBarn.loots[0].pos, at)).toBeLessThan(3);
        tick(game, DOMINATION_RESPAWN_DELAY_S + 0.1);
        expect(rules.isHidden(b)).toBe(false);
        expect(b.health).toBe(100);
        // away from the enemy
        expect(v2.distance(b.pos, r.pos)).toBeGreaterThan(30);
        expect(rules.arenaXp(r)).toBeGreaterThan(0);
    });

    test("picking up: a gun replaces the one of its kind - also after a slot swap; nothing but loadout items", () => {
        const { rules, red } = domination(1);
        const [p] = red;
        expect(rules.gunPickupSlot(p, "ak47")).toBe(GameConfig.WeaponSlot.Primary);
        expect(rules.gunPickupSlot(p, "deagle")).toBe(GameConfig.WeaponSlot.Secondary);
        // slots swapped: the main gun sits in slot 2 now - another main gun still replaces it
        const [a, b] = [p.weapons[0].type, p.weapons[1].type];
        p.weaponManager.setWeapon(GameConfig.WeaponSlot.Primary, b, 0);
        p.weaponManager.setWeapon(GameConfig.WeaponSlot.Secondary, a, 0);
        expect(rules.gunPickupSlot(p, "ak47")).toBe(GameConfig.WeaponSlot.Secondary);
        expect(rules.gunPickupSlot(p, "deagle")).toBe(GameConfig.WeaponSlot.Primary);
        // the MP220 (main gun or secondary): into the slot in hand
        p.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Secondary);
        expect(rules.gunPickupSlot(p, "mp220")).toBe(GameConfig.WeaponSlot.Secondary);
        p.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
        expect(rules.gunPickupSlot(p, "mp220")).toBe(GameConfig.WeaponSlot.Primary);
        expect(rules.allowsPickup(p, "ak47")).toBe(true);
        expect(rules.allowsPickup(p, "frag")).toBe(true);
        expect(rules.allowsPickup(p, "takedown")).toBe(true);
        // ammo and heals a teammate dropped to share
        expect(rules.allowsPickup(p, "bandage")).toBe(true);
        expect(rules.allowsPickup(p, "556mm")).toBe(true);
        // armor: the supply flare's crate (better armor)
        expect(rules.allowsPickup(p, "helmet03")).toBe(true);
        expect(rules.allowsPickup(p, "backpack03")).toBe(false);
    });

    test("the loadout picked while waiting is the one of the next spawn (also the match start)", () => {
        const { game, rules, red, blue } = domination(1, false);
        const [p] = red;
        p.arenaLoadouts = [
            { primary: "hk416", pistol: "p30l", throwable: "frag", perk: "takedown" },
            { primary: "ak47", pistol: "deagle", throwable: "smoke", perk: "takedown" },
        ];
        // in the warmup: picked before the start (what ArenaLoadoutSelectMsg does)
        p.arenaLoadoutIdx = 1;
        rules.startMatch();
        expect([p.weapons[0].type, p.weapons[1].type]).toStrictEqual(["ak47", "deagle"]);
        tick(game, DOMINATION_SPAWN_PROTECTION_S + 0.1);
        // after a death
        p.arenaLoadoutIdx = 0;
        kill(p, blue[0]);
        tick(game, DOMINATION_RESPAWN_DELAY_S + 0.1);
        expect([p.weapons[0].type, p.weapons[1].type]).toStrictEqual(["hk416", "p30l"]);
        expect(p.scope).toBe("4xscope");
    });

    test("a loadout picked right after spawning is given at once - not once the player has played", () => {
        const { rules, red } = domination(1);
        const [p] = red;
        p.arenaLoadouts = [
            { primary: "hk416", pistol: "p30l", throwable: "frag", perk: "takedown" },
            { primary: "ak47", pistol: "deagle", throwable: "smoke", perk: "takedown" },
        ];
        p.arenaLoadoutIdx = 1;
        rules.onLoadoutSelect(p, ArenaLoadoutAction.Pick);
        expect(p.weapons[0].type).toBe("ak47");
        // fired a shot: only on the next spawn
        p.shotsFired++;
        p.arenaLoadoutIdx = 0;
        rules.onLoadoutSelect(p, ArenaLoadoutAction.Pick);
        expect(p.weapons[0].type).toBe("ak47");
    });

    test("joining: out of the game (hidden, no inputs) until Enter game", () => {
        const { game, rules, red } = domination(1, false);
        const [p] = red;
        expect(rules.isHidden(p)).toBe(true);
        expect(rules.blocksInput(p)).toBe(true);
        tick(game, 5);
        expect(rules.isHidden(p)).toBe(true);
        rules.onLoadoutSelect(p, ArenaLoadoutAction.Deploy);
        tick(game, 0.1);
        expect(rules.isHidden(p)).toBe(false);
    });

    test("the menu opened while dead holds the respawn until Enter game", () => {
        const { game, rules, red, blue } = domination(1);
        const [p] = red;
        kill(p, blue[0]);
        rules.onLoadoutSelect(p, ArenaLoadoutAction.Hold);
        tick(game, DOMINATION_RESPAWN_DELAY_S + 1);
        expect(rules.isHidden(p)).toBe(true);
        rules.onLoadoutSelect(p, ArenaLoadoutAction.Deploy);
        tick(game, 0.1);
        expect(rules.isHidden(p)).toBe(false);
    });

    test("zones: A and C mirrored through the center (fair), B in the middle, cover around each", () => {
        for (let i = 0; i < 5; i++) {
            const { game, rules } = domination(1);
            const [a, b, c] = rules.zones;
            const mid = game.map.center;
            // C is (about - a building may take it) A's mirror
            expect(v2.distance(v2.create(game.map.width - a.pos.x, game.map.height - a.pos.y), c.pos)).toBeLessThan(15);
            expect(v2.distance(b.pos, mid)).toBeLessThan(game.map.width * 0.38);
            for (const z of rules.zones) {
                const near = game.map.obstacles.filter(
                    (o) => !o.destroyed && !o.dead && o.collidable && isHardCover(o.type) && o.layer === 0 && v2.distance(o.pos, z.pos) <= 20,
                ).length;
                expect(near).toBeGreaterThan(0);
            }
        }
    });

    test("respawns keep away from the enemies", () => {
        const { game, rules, red, blue } = domination(3);
        moveTo(blue, game.map.center);
        const [p] = red;
        for (let i = 0; i < 10; i++) {
            const pos = rules.spawnPos(p);
            expect(v2.distance(pos, game.map.center)).toBeGreaterThan(40);
        }
    });

    test("dead players watch a living teammate - an enemy only when no teammate is left", () => {
        const { game, rules, red, blue } = domination(2);
        const [r1, r2] = red;
        // (a teammate is up: knocked first - giving up makes it a death)
        kill(r1, blue[0]);
        expect(r1.downed).toBe(true);
        rules.giveUp(r1);
        expect(r1.spectating).toBe(r2);
        // the watched mate dies too: nobody of the team left alive - an enemy
        kill(r2, blue[0]);
        tick(game, 0.1);
        expect(r1.spectating && rules.sideOf(r1.spectating)).toBe(rules.sideOf(blue[0]));
    });

    test("zones are spread out, not in a row", () => {
        for (let i = 0; i < 8; i++) {
            const { game, rules } = domination(1);
            const [a, b, c] = rules.zones.map((z) => z.pos);
            const size = game.map.width;
            expect(v2.distance(a, b)).toBeGreaterThan(size * 0.25);
            expect(v2.distance(b, c)).toBeGreaterThan(size * 0.25);
            // B is off the line from A to C
            const ac = v2.sub(c, a);
            const off = Math.abs(ac.x * (b.y - a.y) - ac.y * (b.x - a.x)) / v2.length(ac);
            expect(off).toBeGreaterThan(size * 0.05);
        }
    });

    test("a half-done capture stays when everyone leaves", () => {
        const { game, rules, red, blue } = domination(1);
        const b = rules.zones[1];
        moveTo(blue, rules.pointAt(0.97));
        moveTo(red, b.pos);
        tick(game, 2);
        const p = b.progress;
        expect(p).toBeGreaterThan(0.2);
        moveTo(red, rules.pointAt(0.03));
        tick(game, 10);
        expect(b.progress).toBeCloseTo(p, 5);
        expect(b.capTeam).toBe(1);
    });

    test("the countdown before the match is longer with fewer players", () => {
        const { rules } = domination(1, false);
        const cd = (n: number) => (rules as any).countdownFor(n);
        expect([cd(12), cd(10), cd(8), cd(6), cd(4), cd(2)]).toStrictEqual([10, 20, 20, 30, 30, 50]);
    });

    test("the warmup is everyone against everyone - teammates hurt each other only then", () => {
        const { game, rules, red } = domination(2, false);
        const [a, b] = red;
        for (const p of red) rules.onLoadoutSelect(p, ArenaLoadoutAction.Deploy);
        tick(game, DOMINATION_SPAWN_PROTECTION_S + 0.2);
        const hp = b.health;
        b.damage({ amount: 20, damageType: GameConfig.DamageType.Player, source: a, gameSourceType: a.activeWeapon, dir: v2.create(1, 0) });
        expect(b.health).toBeLessThan(hp);
        rules.startMatch();
        tick(game, DOMINATION_SPAWN_PROTECTION_S + 0.2);
        const hp2 = b.health;
        b.damage({ amount: 20, damageType: GameConfig.DamageType.Player, source: a, gameSourceType: a.activeWeapon, dir: v2.create(1, 0) });
        expect(b.health).toBe(hp2);
    });

    test("/skipwaiting: the countdown starts right away and runs with too few players", () => {
        const { game, rules } = domination(1, false);
        expect(rules.running).toBe(false);
        expect(rules.skipWaiting(10)).toBe(true);
        tick(game, 9);
        expect(rules.running).toBe(false);
        tick(game, 1.2);
        expect(rules.running).toBe(true);
        expect(rules.skipWaiting(10)).toBe(false);
    });

    test("crates drop nothing", () => {
        const { game } = domination(1);
        const crate = game.map.obstacles.find((o) => o.destructible && o.type.startsWith("crate"))
            ?? game.map.genObstacle("crate_01", v2.add(game.map.center, v2.create(30, 30)), 0, 0, 1);
        crate.damage({ amount: 10000, damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0) });
        expect(game.lootBarn.loots.filter((l) => !l.destroyed)).toHaveLength(0);
    });

    test("teams are groups of up to 6, the first team on one side, the second on the other", () => {
        const { game, rules, red, blue } = domination(6);
        expect(game.groupSize).toBe(6);
        expect(red).toHaveLength(6);
        expect(blue).toHaveLength(6);
        expect(new Set(red.map((p) => p.groupId)).size).toBe(1);
        expect(red[0].groupId).not.toBe(blue[0].groupId);
        expect(rules.sideOf(red[0])).not.toBe(rules.sideOf(blue[0]));
    });

    test("a gun keeps the rounds it was dropped with - no ammo to the backpack, none on the ground", () => {
        const { game, red, blue } = domination(1);
        const [r] = red;
        const [b] = blue;
        const primary = GameConfig.WeaponSlot.Primary;
        // dying with 7 rounds in the main gun
        b.weapons[primary].ammo = 7;
        kill(b, r);
        const gun = game.lootBarn.loots.find((l) => !l.destroyed && l.type === "hk416")!;
        expect(gun.clip).toBe(7);

        // dropping by hand: 3 rounds stay in it, the backpack gets nothing
        r.weapons[primary].ammo = 3;
        const ammoBefore = r.invManager.get("556mm");
        r.weaponManager.dropGun(primary);
        expect(r.invManager.get("556mm")).toBe(ammoBefore);
        const dropped = game.lootBarn.loots.find((l) => !l.destroyed && l.type === "hk416" && l !== gun)!;
        expect(dropped.clip).toBe(3);
        r.pickupLoot(dropped);
        expect(r.weapons[primary].type).toBe("hk416");
        expect(r.weapons[primary].ammo).toBe(3);
        expect(r.invManager.get("556mm")).toBe(ammoBefore);

        // a swap on pickup: the one carried lies there with its rounds
        expect(gun.clip).toBe(7);
        r.weapons[primary].ammo = 12;
        const ak = game.lootBarn.addLootWithoutAmmo("ak47", r.pos, 0, 1)!;
        ak.clip = 5;
        r.pickupLoot(ak);
        expect(r.weapons[primary].type).toBe("ak47");
        expect(r.weapons[primary].ammo).toBe(5);
        const swapped = game.lootBarn.loots.find((l) => !l.destroyed && l.type === "hk416" && l !== gun)!;
        expect(swapped.clip).toBe(12);
        const ammo = game.lootBarn.loots.filter((l) => !l.destroyed && GameObjectDefs.typeToDefSafe(l.type)?.type === "ammo");
        expect(ammo).toHaveLength(0);
        expect(r.invManager.get("556mm")).toBe(ammoBefore);
    });

    test("3 throwables of the loadout's kind; another kind picked up replaces them", () => {
        const { game, red } = domination(1);
        const [p] = red;
        expect(p.invManager.get("frag")).toBe(3);
        expect(p.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("frag");
        const mirv = game.lootBarn.addLootWithoutAmmo("mirv", p.pos, 0, 2)!;
        p.pickupLoot(mirv);
        expect(p.invManager.get("mirv")).toBe(2);
        expect(p.invManager.get("frag")).toBe(0);
        expect(p.weapons[GameConfig.WeaponSlot.Throwable].type).toBe("mirv");
        const frags = game.lootBarn.loots.filter((l) => !l.destroyed && l.type === "frag");
        expect(frags.map((l) => l.count)).toStrictEqual([3]);
    });

    test("in the match, joiners go to the side with fewer players, a party where it fits", () => {
        const { game, rules } = domination(1);
        const barn = game.playerBarn;
        const [g1, g2] = barn.groups.filter((g) => !g.isSpectatorGroup);
        g1.reservedSlots = 3;
        expect(rules.pickGroup(barn.groups, 1)).toBe(g2);
        // a party of 5 only fits where there's room for all
        expect(rules.pickGroup(barn.groups, 5)).toBe(g2);
        g2.reservedSlots = 4;
        expect(rules.pickGroup(barn.groups, 5)).toBeUndefined();
    });

    test("teams are built after the warmup: 6 solos against a party of 6", () => {
        const game = createGame(TeamMode.Squad, "domination", GameMode.Domination);
        const rules = game.rules as Domination;
        const join = (count: number) => {
            const tokens = Array.from({ length: count }, (_, n) => ({ token: randomUUID(), userId: null, ip: `10.1.0.${n}` }));
            game.addJoinTokens(tokens as never, true);
            return tokens.map((t) => {
                const msg = new net.JoinMsg();
                msg.matchPriv = t.token;
                msg.name = `P${t.ip}`;
                return game.playerBarn.addPlayer(randomUUID(), msg, t.ip)!;
            });
        };
        // six solos in the warmup: everyone on their own
        const solos = Array.from({ length: 6 }, () => join(1)[0]);
        expect(new Set(solos.map((p) => p.groupId)).size).toBe(6);
        // a party of six still fits (the solos make the other team)
        expect(game.partyRoom).toBe(6);
        const party = join(6);
        expect(game.partyRoom).toBe(0);
        rules.startMatch();
        const soloTeam = new Set(solos.map((p) => p.teamId));
        const partyTeam = new Set(party.map((p) => p.teamId));
        expect(soloTeam.size).toBe(1);
        expect(partyTeam.size).toBe(1);
        expect([...soloTeam][0]).not.toBe([...partyTeam][0]);
        // the groups are the teams now (the team panel, the names), two of them
        for (const p of [...solos, ...party]) expect(p.groupId).toBe(p.teamId);
        expect(game.playerBarn.groups.filter((g) => !g.isSpectatorGroup)).toHaveLength(2);
        expect(rules.sideOf(solos[0])).not.toBe(rules.sideOf(party[0]));
        // the clients learn the new teams
        for (const p of [...solos, ...party]) expect(game.playerBarn.newPlayers).toContain(p);
    });

    test("splitting parties into two teams: even, parties together, at most 6", () => {
        expect(splitIntoTeams([1, 1, 1, 1, 1, 1, 6])?.filter((t) => t === 1).length).toBe(1);
        const s = splitIntoTeams([3, 2, 2, 1])!;
        const sum = (t: number) => [3, 2, 2, 1].reduce((n, size, i) => n + (s[i] === t ? size : 0), 0);
        expect(sum(0)).toBe(4);
        expect(sum(1)).toBe(4);
        expect(splitIntoTeams([6, 6, 1])).toBeUndefined();
    });

    test("the warmup's damage is undone when the match starts: the same map, nothing on the ground", () => {
        // a full 6v6: the map keeps its size (fewer players shrink it - a new layout)
        const { game, rules, red } = domination(6, false);
        const before = game.map.obstacles.filter((o) => !o.destroyed).length;
        const seed = game.map.seed;
        const buildings = game.map.buildings.map((b) => `${b.type}@${b.pos.x.toFixed(2)},${b.pos.y.toFixed(2)}`);
        const crate = game.map.obstacles.find((o) => o.destructible && !o.dead)!;
        crate.damage({ amount: 100000, damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0) });
        expect(crate.dead).toBe(true);
        red[0].dropLoot("bandage", 2);
        rules.startMatch();
        expect(game.map.seed).toBe(seed);
        expect(game.map.buildings.map((b) => `${b.type}@${b.pos.x.toFixed(2)},${b.pos.y.toFixed(2)}`)).toStrictEqual(buildings);
        expect(game.lootBarn.loots.filter((l) => !l.destroyed)).toHaveLength(0);
        expect(game.map.obstacles.filter((o) => !o.destroyed && o.dead)).toHaveLength(0);
        // the same map (give or take the cover pieces put next to the zones)
        expect(Math.abs(game.map.obstacles.filter((o) => !o.destroyed).length - before)).toBeLessThanOrEqual(9);
    });

    test("a second death clears what the first one dropped", () => {
        const { game, rules, red, blue } = domination(1);
        const [r] = red;
        const [b] = blue;
        const lying = () => game.lootBarn.loots.filter((l) => !l.destroyed);
        kill(b, r);
        const first = lying();
        expect(first).toHaveLength(3);
        tick(game, DOMINATION_RESPAWN_DELAY_S + DOMINATION_SPAWN_PROTECTION_S + 0.2);
        expect(rules.isHidden(b)).toBe(false);
        kill(b, r);
        expect(first.every((l) => l.destroyed)).toBe(true);
        expect(lying()).toHaveLength(3);
    });

    test("two MP220s only by picking one up - the loadout takes it once", () => {
        const { game, red } = domination(1);
        const [p] = red;
        p.weaponManager.setWeapon(GameConfig.WeaponSlot.Primary, "mp220", 2);
        p.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Secondary);
        const mp = game.lootBarn.addLootWithoutAmmo("mp220", p.pos, 0, 1)!;
        mp.clip = 2;
        p.pickupLoot(mp);
        expect(p.weapons[GameConfig.WeaponSlot.Primary].type).toBe("mp220");
        expect(p.weapons[GameConfig.WeaponSlot.Secondary].type).toBe("mp220");
        expect(sanitizeArenaLoadout({ primary: "mp220", pistol: "mp220" }, new Set(["mp220", "p30l"])).pistol).not.toBe("mp220");
    });

    test("spawn: 3 sodas and a pill; a soda gives a few seconds of damage resistance", () => {
        const { game, rules, red } = domination(1);
        const [p] = red;
        expect(p.invManager.get("soda")).toBe(3);
        expect(p.invManager.get("painkiller")).toBe(1);
        expect(rules.damageReduction(p)).toBe(0);
        rules.onBoostUsed(p, "soda");
        expect(rules.damageReduction(p)).toBeCloseTo(ARENA_BOOST_RESIST.soda.reduction);
        // the stronger one counts while both run
        rules.onBoostUsed(p, "painkiller");
        expect(rules.damageReduction(p)).toBeCloseTo(ARENA_BOOST_RESIST.painkiller.reduction);
        tick(game, ARENA_BOOST_RESIST.painkiller.seconds + 0.2);
        expect(rules.damageReduction(p)).toBe(0);
        // and it takes less damage meanwhile
        const hit = () => {
            p.health = 100;
            p.damage({ amount: 40, damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0) });
            return 100 - p.health;
        };
        const normal = hit();
        rules.onBoostUsed(p, "soda");
        expect(hit()).toBeCloseTo(normal * (1 - ARENA_BOOST_RESIST.soda.reduction), 3);
    });

    test("Cast Ironskin in the arena: a level 3 vest, not its usual effect", () => {
        const { rules, red } = domination(1);
        const [p] = red;
        p.arenaLoadouts = [{ primary: "hk416", pistol: "p30l", throwable: "frag", perk: "steelskin" }];
        p.arenaLoadoutIdx = 0;
        (rules as any).giveSpawnItems(p);
        expect(p.chest).toBe("chest03");
        expect(p.perks.some((x) => x.type === "steelskin")).toBe(true);
        expect(p.hasPerk("steelskin")).toBe(false);
    });

    test("Scavenger: the victim also drops their grenades and half their ammo", () => {
        const { game, red, blue } = domination(1);
        const [r] = red;
        const [b] = blue;
        r.removePerk("takedown");
        r.addPerk("scavenger", true);
        const ammo = b.invManager.get("556mm");
        kill(b, r);
        const lying = game.lootBarn.loots.filter((l) => !l.destroyed);
        expect(lying.find((l) => l.type === "frag")?.count).toBe(3);
        expect(lying.find((l) => l.type === "556mm")?.count).toBe(Math.floor(ammo / 2));
    });

    test("perks: Takedown and Scavenger from the start, the others by level in their order; P90 and MP220 go as secondary", () => {
        expect(ARENA_STARTER_ITEMS).toContain("takedown");
        expect(ARENA_STARTER_ITEMS).toContain("scavenger");
        const levelOf = (perk: string) => Number(Object.entries(ARENA_LEVEL_UNLOCKS).find(([, items]) => items.includes(perk))?.[0]);
        const order = ["aoe_heal", "endless_ammo", "firepower", "flak_jacket", "windwalk", "self_revive", "steelskin", "bonus_assault"];
        for (let i = 1; i < order.length; i++) expect(levelOf(order[i])).toBeGreaterThan(levelOf(order[i - 1]));
        expect(ARENA_CHALLENGES.broken_arrow).toStrictEqual({ kills: 50, with: { weapon: "strobe" } });
        // every arena perk can be unlocked somehow
        for (const perk of ARENA_PERKS) {
            expect(ARENA_STARTER_ITEMS.includes(perk) || !!levelOf(perk) || !!ARENA_CHALLENGES[perk], perk).toBe(true);
        }
        expect(arenaFitsSlot("p90", "pistol")).toBe(true);
        expect(arenaFitsSlot("p90", "primary")).toBe(true);
    });

    test("knocked while a teammate is up: a revive, or give up for the respawn - the knocker gets the kill", () => {
        const { game, rules, red, blue } = domination(2);
        const [r1, r2] = red;
        const [b] = blue;
        kill(r1, b);
        expect(r1.downed).toBe(true);
        expect(rules.isHidden(r1)).toBe(false);
        expect(b.kills).toBe(0);
        // a revive takes the usual time
        moveTo([r2], r1.pos);
        r2.revive(r1);
        expect(r2.action.duration).toBe(GameConfig.player.reviveDuration);
        r2.cancelAction();
        // giving up: dead, respawning, the knocker has the kill
        expect(rules.giveUp(r1)).toBe(true);
        expect(r1.downed).toBe(false);
        expect(rules.isHidden(r1)).toBe(true);
        expect(b.kills).toBe(1);
        tick(game, DOMINATION_RESPAWN_DELAY_S + 0.2);
        expect(rules.isHidden(r1)).toBe(false);
        expect(r1.downed).toBe(false);
        expect(r1.health).toBe(100);
    });

    test("no teammate up: dead right away; Mass Medicate / Revivify revive almost instantly", () => {
        const { rules, red, blue } = domination(2);
        const [r1, r2] = red;
        const [b1, b2] = blue;
        kill(r1, b1);
        expect(r1.downed).toBe(true);
        kill(r2, b1);
        // the last one up went down: nobody to revive them - dead
        expect(r2.downed).toBe(false);
        expect(rules.isHidden(r2)).toBe(true);
        // a medic revives fast
        b1.removePerk("takedown");
        b1.addPerk("aoe_heal", true);
        kill(b2, r1);
        expect(b2.downed).toBe(true);
        expect(rules.reviveDuration(b1, b2)).toBe(ARENA_FAST_REVIVE_S);
        // Revivify: knocked even alone, and quick to get up
        b2.addPerk("self_revive", true);
        expect(rules.reviveDuration(b2, b2)).toBe(ARENA_FAST_REVIVE_S);
    });

    test("a party of 6 joins through join tokens as one team; the game tells how big a party still fits", () => {
        const game = createGame(TeamMode.Squad, "domination", GameMode.Domination);
        const rules = game.rules as Domination;
        const join = (count: number) => {
            const tokens = Array.from({ length: count }, (_, n) => ({ token: randomUUID(), userId: null, ip: `10.0.0.${n}` }));
            game.addJoinTokens(tokens as never, true);
            return tokens.map((t) => {
                const msg = new net.JoinMsg();
                msg.matchPriv = t.token;
                msg.name = `P${t.ip}`;
                return game.playerBarn.addPlayer(randomUUID(), msg, t.ip)!;
            });
        };
        expect(game.partyRoom).toBe(6);
        const party = join(6);
        expect(party.every((p) => !!p)).toBe(true);
        expect(new Set(party.map((p) => p.groupId)).size).toBe(1);
        // the other side is still free for a party of 6
        expect(game.partyRoom).toBe(6);
        const solo = join(1);
        expect(solo[0].groupId).not.toBe(party[0].groupId);
        expect(rules.sideOf(solo[0])).not.toBe(rules.sideOf(party[0]));
        // a full side and one with a solo: a party of 6 goes to another game
        expect(game.partyRoom).toBe(5);
    });

    test("a revive: half health and a pill's damage resistance; Revivify halves med time; Hollow-Points go through vests", () => {
        const { rules, red, blue } = domination(2);
        const [r1, r2] = red;
        const [b] = blue;
        kill(r1, b);
        expect(r1.downed).toBe(true);
        moveTo([r2], r1.pos);
        r2.revive(r1);
        for (let t = 0; t < GameConfig.player.reviveDuration + 0.5; t += 0.05) r2.game.update(0.05);
        expect(r1.downed).toBe(false);
        // (the always full adrenaline heals a little from there in the ticks after)
        expect(r1.health).toBeGreaterThanOrEqual(ARENA_REVIVE_HEALTH);
        expect(r1.health).toBeLessThan(ARENA_REVIVE_HEALTH + 5);
        expect(rules.damageReduction(r1)).toBeCloseTo(ARENA_BOOST_RESIST.painkiller.reduction);

        expect(rules.useTimeFactor(r2)).toBe(1);
        r2.addPerk("self_revive", true);
        expect(rules.useTimeFactor(r2)).toBe(0.5);

        const shot = { amount: 20, damageType: GameConfig.DamageType.Player, source: b, gameSourceType: "hk416", dir: v2.create(1, 0) };
        expect(rules.ignoresVest(shot)).toBe(false);
        b.removePerk("takedown");
        b.addPerk("bonus_assault", true);
        expect(rules.ignoresVest(shot)).toBe(true);
        // its usual bonus damage is off here
        expect(b.hasPerk("bonus_assault")).toBe(false);
        // not for grenades / melee
        expect(rules.ignoresVest({ ...shot, gameSourceType: "frag", isExplosion: true })).toBe(false);
    });

    test("Flak Jacket: less damage from explosions only, and normal size (Cast Ironskin too)", () => {
        const { rules, red } = domination(1);
        const [p] = red;
        p.removePerk("takedown");
        p.addPerk("flak_jacket", true);
        expect(p.scale).toBe(1);
        expect(p.hasPerk("flak_jacket")).toBe(false);
        const blast = { amount: 50, damageType: GameConfig.DamageType.Player, isExplosion: true, dir: v2.create(1, 0) };
        const bullet = { amount: 50, damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0) };
        expect(rules.damageReduction(p, blast)).toBeCloseTo(0.6);
        expect(rules.damageReduction(p, bullet)).toBe(0);
        p.removePerk("flak_jacket");
        p.addPerk("steelskin", true);
        expect(p.scale).toBe(1);
        expect(Object.values(ARENA_LEVEL_UNLOCKS).flat()).toContain("flak_jacket");
    });

    test("a whole team gone (disconnected): the other team wins after DOMINATION_ABANDON_S", () => {
        const { game, rules, red, blue } = domination(2);
        expect(rules.checkGameEnd()).toBe(false);
        blue[0].disconnected = true;
        expect(rules.checkGameEnd()).toBe(false);
        blue[1].disconnected = true;
        expect(rules.checkGameEnd()).toBe(false);
        tick(game, DOMINATION_ABANDON_S - 2);
        expect(rules.checkGameEnd()).toBe(false);
        tick(game, 3);
        expect(rules.checkGameEnd()).toBe(true);
        expect(red[0].rank).toBe(1);
        expect(rules.ranking()[0].teamId).toBe(red[0].teamId);
    });

    test("a team gone for a moment (a reload) and back: the match goes on", () => {
        const { game, rules, blue } = domination(1);
        blue[0].disconnected = true;
        tick(game, DOMINATION_ABANDON_S - 5);
        expect(rules.checkGameEnd()).toBe(false);
        // back in (the reload: a new player on that side)
        blue[0].disconnected = false;
        tick(game, 1);
        blue[0].disconnected = true;
        tick(game, DOMINATION_ABANDON_S - 5);
        expect(rules.checkGameEnd()).toBe(false);
    });

    test("the match start: each team spawns in a tight bunch, the map sized for the players", () => {
        const { game, red, blue } = domination(3);
        expect(game.map.sizeScale).toBe(dominationMapScale(6));
        expect(game.map.sizeScale).toBeLessThan(1);
        for (const team of [red, blue]) {
            for (const p of team) {
                for (const q of team) expect(v2.distance(p.pos, q.pos)).toBeLessThan(DOMINATION_START_CLUSTER_RAD * 2 + 10);
            }
        }
        // the two bunches far apart
        expect(v2.distance(red[0].pos, blue[0].pos)).toBeGreaterThan(Math.min(game.map.width, game.map.height) * 0.4);
        // the zones on the smaller map
        for (const z of (game.rules as Domination).zones) {
            expect(z.pos.x).toBeLessThan(game.map.width);
            expect(z.pos.y).toBeLessThan(game.map.height);
        }
    });

    test("dominationMapScale: a full 6v6 the map as made, fewer smaller", () => {
        expect(dominationMapScale(12)).toBe(1);
        expect(dominationMapScale(20)).toBe(1);
        expect(dominationMapScale(6)).toBeCloseTo(0.71, 2);
        expect(dominationMapScale(2)).toBe(0.65);
    });

    test("a spectator watching a player who dies: on to the killer, else someone else", () => {
        // one each side: no teammate to revive - a kill is a death
        const { game, rules, red, blue } = domination(1);
        const spec = game.playerBarn.addTestPlayer({ name: "SPEC" });
        game.playerBarn.livingPlayers.splice(game.playerBarn.livingPlayers.indexOf(spec), 1);
        spec.spectator = true;
        spec.dead = true;
        spec.spectating = red[0];
        kill(red[0], blue[0]);
        expect(rules.isRespawning(red[0])).toBe(true);
        expect(spec.spectating).toBe(blue[0]);
        // the watched one leaves: whoever is still in the game (red, back from the respawn)
        blue[0].disconnected = true;
        tick(game, DOMINATION_RESPAWN_DELAY_S + 0.5);
        expect(spec.spectating).toBe(red[0]);
    });

    test("the teams built after the warmup list their players in id order (the clients' status order)", () => {
        const game = createGame(TeamMode.Squad, "domination", GameMode.Domination);
        const rules = game.rules as Domination;
        // parties of different sizes, joined so that merging puts later ids first
        // a solo, a party of 2, a party of 3: the solo and the 2 make a team - the
        // bigger party's group takes the solo in after its own (later ids first)
        for (const size of [1, 2, 3]) {
            const group = game.playerBarn.addGroup(false, false);
            for (let i = 0; i < size; i++) game.playerBarn.addTestPlayer({ group });
        }
        rules.startMatch();
        for (const g of game.playerBarn.groups) {
            const ids = g.players.map((p) => p.__id);
            expect(ids).toStrictEqual([...ids].sort((a, b) => a - b));
        }
    });

    test("waiting to respawn: dead (and 0 health) for the team top left, alive again after", () => {
        const { game, red, blue } = domination(1);
        kill(red[0], blue[0]);
        expect(red[0].modeDead).toBe(true);
        expect(red[0].getPlayerStatus()[0].dead).toBe(true);
        tick(game, 2);
        // the adrenaline doesn't make it look like healing up meanwhile
        expect(red[0].modeDead).toBe(true);
        tick(game, DOMINATION_RESPAWN_DELAY_S);
        expect(red[0].modeDead).toBe(false);
        expect(red[0].getPlayerStatus()[0].dead).toBe(false);
    });

    test("a spectator with everyone waiting to respawn (or in the loadout menu) still watches one of them", () => {
        const { game, rules, red, blue } = domination(1);
        const spec = game.playerBarn.addTestPlayer({ name: "SPEC" });
        game.playerBarn.livingPlayers.splice(game.playerBarn.livingPlayers.indexOf(spec), 1);
        spec.spectator = true;
        spec.dead = true;
        kill(red[0], blue[0]);
        kill(blue[0], red[0]);
        tick(game, 0.1);
        expect([red[0], blue[0]]).toContain(spec.spectating);
        // then the first one back in the game
        tick(game, DOMINATION_RESPAWN_DELAY_S + 0.5);
        expect(rules.isRespawning(spec.spectating!)).toBe(false);
    });

    test("a spectator put on a player before its first update still learns every player in the game", () => {
        const { game, red, blue } = domination(1);
        // the players had their first updates long ago
        for (const p of [red[0], blue[0]]) p.sendMsgs();
        game.msgsToSend.stream.index = 0;
        const spec = game.playerBarn.addTestPlayer({ name: "SPEC" });
        game.playerBarn.livingPlayers.splice(game.playerBarn.livingPlayers.indexOf(spec), 1);
        spec.spectator = true;
        spec.dead = true;
        game.playerBarn.newPlayers.length = 0;
        // the mode puts it on someone right away (before it was ever sent anything)
        tick(game, 0.1);
        expect([red[0], blue[0]]).toContain(spec.spectating);
        // its first update: everyone's player info (the client needs them for the HUD)
        const sent: Array<{ type: number; msg: { playerInfos?: Player[] } }> = [];
        const orig = net.MsgStream.prototype.serializeMsg;
        net.MsgStream.prototype.serializeMsg = function (type: number, msg: never) {
            sent.push({ type, msg });
            return orig.call(this, type, msg);
        };
        try {
            spec.sendMsgs();
        } finally {
            net.MsgStream.prototype.serializeMsg = orig;
        }
        const update = sent.find((m) => m.type === net.MsgType.Update);
        expect(update?.msg.playerInfos).toEqual(expect.arrayContaining([red[0], blue[0]]));
    });

    test("the warmup: one of two leaves - the game goes on waiting (not stopped)", () => {
        const { game, rules, ps } = domination(1, false);
        tick(game, 1);
        leave(game, ps[1]);
        tick(game, 1);
        expect(game.stopped).toBe(false);
        expect(rules.running).toBe(false);
        expect((rules as unknown as { phase: ModePhase }).phase).toBe(ModePhase.Waiting);
    });

    test("the countdown: someone leaves - it starts over at the seconds for the players left; too few: waiting again", () => {
        const { game, rules, ps } = domination(6, false);
        const state = rules as unknown as { phase: ModePhase; countdown: number };
        tick(game, 0.2);
        expect(state.phase).toBe(ModePhase.Countdown);
        tick(game, 4);
        expect(state.countdown).toBeLessThan(7);
        // 11 left: the 8+ players' countdown
        leave(game, ps[0]);
        tick(game, 0.1);
        expect(state.phase).toBe(ModePhase.Countdown);
        expect(state.countdown).toBeGreaterThan(19);
        // below the DOMINATION_MIN_PLAYERS needed: waiting again
        for (const p of ps.slice(1, 12 - DOMINATION_MIN_PLAYERS + 1)) leave(game, p);
        tick(game, 0.1);
        expect(state.phase).toBe(ModePhase.Waiting);
        expect(game.stopped).toBe(false);
    });

    test("AFK in the match: kicked after ARENA_AFK_KICK_S - not while dead / in the menu, not in the warmup", () => {
        const { game, rules, red, blue } = domination(1, false);
        const kicked: Array<{ id: string; reason?: string }> = [];
        game.closeSocket = ((id: string, reason?: string) => kicked.push({ id, reason })) as typeof game.closeSocket;
        const long = Date.now() - (ARENA_AFK_KICK_S + 5) * 1000;
        // the warmup: nobody
        red[0].lastActiveAt = long;
        tick(game, 1.1);
        expect(kicked).toHaveLength(0);
        rules.startMatch();
        tick(game, DOMINATION_SPAWN_PROTECTION_S + 0.2);
        // dead (waiting to respawn): not kicked, the clock starts over
        kill(blue[0], red[0]);
        blue[0].lastActiveAt = long;
        tick(game, 1.1);
        expect(kicked).toHaveLength(0);
        // idle in the match: kicked
        red[0].lastActiveAt = long;
        tick(game, 1.1);
        expect(kicked).toStrictEqual([{ id: red[0].socketId, reason: "kicked_afk" }]);
    });

    test("a custom lobby's match counts for the arena progress only when it started full", () => {
        const { rules } = domination(2);
        expect(rules.startPlayers).toBe(4);
        expect(rules.startedFull).toBe(false);
        const full = domination(6);
        expect(full.rules.startedFull).toBe(true);
    });

    test("out of combat the adrenaline heals faster", () => {
        const { game, rules, red } = domination(1);
        const p = red[0];
        const now = Date.now();
        // just shot / just hit: as usual
        p.lastShotAt = now;
        expect(rules.boostHealFactor(p)).toBe(1);
        p.lastShotAt = 0;
        p.lastEnemyDamageTakenTime = now - 1000;
        expect(rules.boostHealFactor(p)).toBe(1);
        // quiet for a while: faster
        p.lastEnemyDamageTakenTime = now - ARENA_OUT_OF_COMBAT_S * 1000 - 100;
        expect(rules.boostHealFactor(p)).toBe(ARENA_OUT_OF_COMBAT_HEAL_MULT);
        // in the game: more health back over the same time than in combat
        p.health = 40;
        tick(game, 1);
        const quiet = p.health - 40;
        p.health = 40;
        p.lastShotAt = Date.now();
        tick(game, 1);
        const fighting = p.health - 40;
        expect(quiet).toBeGreaterThan(fighting * 1.5);
    });

    test("a match that started with one team only doesn't end on the spot", () => {
        const game = createGame(TeamMode.Squad, "domination", GameMode.Domination);
        const rules = game.rules as Domination;
        const group = game.playerBarn.addGroup(false, false);
        game.playerBarn.addTestPlayer({ group });
        game.playerBarn.addTestPlayer({ group });
        rules.startMatch();
        tick(game, 0.2);
        expect(rules.checkGameEnd()).toBe(false);
    });
});
