import { ARENA_BOOST_RESIST, ARENA_TAKEDOWN } from "../../shared/defs/modes/arenaDefs.ts";
import { describe, expect, test } from "vitest";
import { GunGame, buildGunGameLadder, gunPool } from "../../server/src/game/modes/gunGame.ts";
import type { Player } from "../../server/src/game/objects/player.ts";
import { gunCategory } from "../../shared/defs/gameObjects/gunCategories.ts";
import {
    GUN_GAME_GEAR,
    GUN_GAME_COUNTDOWN_S,
    GUN_GAME_LADDER_SHAPE,
    GUN_GAME_MELEE,
    GUN_GAME_MIN_PLAYERS,
    GUN_GAME_WARMUP_GUNS,
    GUN_GAME_RESPAWN_DELAY_S,
    GUN_GAME_SPAWN_PROTECTION_S,
    GUN_GAME_TIME_LIMIT_S,
    gunGameMapScale,
} from "../../shared/defs/modes/gunGameDefs.ts";
import { GameConfig, GameMode, TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/** A Gun Game with `players`; `start`: skip the warmup (and the spawn protection after it). */
function gunGame(players = 3, start = true) {
    const game = createGame(TeamMode.Solo, "gungame", GameMode.GunGame);
    const ps = Array.from({ length: players }, () => game.playerBarn.addTestPlayer({}));
    const rules = game.rules as GunGame;
    if (start) {
        rules.startMatch();
        tick(game, GUN_GAME_SPAWN_PROTECTION_S + 0.1);
    }
    return { game, rules, ps };
}

/** `killer` kills `victim` with whatever `killer` holds (or `weapon`). */
function kill(victim: Player, killer: Player, weapon = killer.activeWeapon) {
    victim.damage({
        amount: 1000,
        damageType: GameConfig.DamageType.Player,
        source: killer,
        gameSourceType: weapon,
        dir: v2.create(1, 0),
    });
}

function tick(game: ReturnType<typeof createGame>, seconds: number) {
    for (let t = 0; t < seconds; t += 0.05) game.update(0.05);
}

describe("ladder", () => {
    test("follows the shape, ends with the melee, and differs between matches", () => {
        const a = buildGunGameLadder();
        expect(a.at(-1)).toBe(GUN_GAME_MELEE);
        // each step's gun is of one of that step's categories
        const allowed = GUN_GAME_LADDER_SHAPE.flatMap((s) => Array(s.count).fill(s.categories));
        expect(a.length - 1).toBe(allowed.length);
        a.slice(0, -1).forEach((gun, i) => expect(allowed[i]).toContain(gunCategory(gun)));
        expect(new Set(a).size).toBe(a.length);
        // a different seed draws a different ladder
        let seed = 1;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        const b = buildGunGameLadder(rnd);
        const c = buildGunGameLadder(rnd);
        expect(b).not.toStrictEqual(c);
    });

    test("only guns found on the comp map, duals included - no m9", () => {
        const pool = [...gunPool().values()].flat();
        expect(pool).not.toContain("m9");
        expect(pool).toContain("deagle_dual");
        expect(pool).toContain("ak47");
        for (let i = 0; i < 20; i++) {
            for (const gun of buildGunGameLadder().slice(0, -1)) expect(pool).toContain(gun);
        }
    });

    test("standard games have no rules module", () => {
        expect(createGame(TeamMode.Solo, "main").rules).toBeUndefined();
    });
});

describe("gun game map", () => {
    test("a lobby's map scale grows the map, its objects with the area", () => {
        const Game = createGame(TeamMode.Solo, "main").constructor as any;
        const make = (seed: number, mapScale?: number) => {
            const g = new Game("t", { mapName: "gungame", teamMode: TeamMode.Solo, gameMode: GameMode.GunGame, mapScale }, () => {}, () => {});
            g.map.init(seed);
            return g;
        };
        const count = (g: any) => g.objectRegister.objects.filter(Boolean).length;
        // ~2x the area -> ~2x the objects. One random map varies a lot (a few big buildings
        // with many sub-objects more or less), so: the same seeds for both sizes, summed up
        // over several maps - fixed seeds, the same result every run
        let small = 0;
        let big = 0;
        for (const seed of [11, 22, 33]) {
            const s = make(seed);
            const b = make(seed, 1.4);
            expect(b.map.width).toBeCloseTo(s.map.width * 1.4, 0);
            small += count(s);
            big += count(b);
        }
        expect(big).toBeGreaterThan(small * 1.3);
        // (six maps generated: slow under a full parallel run - more than the default 5 s)
    }, 30_000);

    test("respawns keep their distance to everyone alive", () => {
        const { game, ps } = gunGame(4);
        const minRad = game.map.mapDef.gameMode.minSpawnRad!;
        expect(minRad).toBeGreaterThanOrEqual(35);
        for (let i = 0; i < 20; i++) {
            const pos = game.map.getSpawnPos();
            for (const p of ps) expect(v2.distance(p.pos, pos)).toBeGreaterThanOrEqual(minRad);
        }
    });

    test("respawns land near the fight, not across the map", () => {
        const { game, rules, ps } = gunGame(4);
        const [a, b, c, d] = ps;
        // the others stand together in the middle
        for (const p of [b, c, d]) v2.set(p.pos, v2.add(game.map.center, v2.create(Math.random() * 6, 0)));
        let far = 0;
        for (let i = 0; i < 20; i++) {
            const pos = rules.spawnPos(a);
            const nearest = Math.min(...[b, c, d].map((p) => v2.distance(p.pos, pos)));
            expect(nearest).toBeGreaterThanOrEqual(game.map.mapDef.gameMode.minSpawnRad!);
            if (nearest > 100) far++;
        }
        expect(far).toBeLessThanOrEqual(2);
    });
});

describe("gun game", () => {
    test("joining gives the first gun, the own melee, heals, endless ammo and takedown", () => {
        const { rules, ps } = gunGame(1);
        expect(ps[0].weapons[0].type).toBe(rules.ladder[0]);
        // test players bring no loadout: their fists
        expect(ps[0].weapons[2].type).toBe("fists");
        expect(ps[0].hasPerk("endless_ammo")).toBe(true);
        expect(ps[0].hasPerk("takedown")).toBe(true);
        expect([ps[0].invManager.get("bandage"), ps[0].invManager.get("healthkit")]).toStrictEqual([5, 1]);
        expect([ps[0].helmet, ps[0].chest]).toStrictEqual([GUN_GAME_GEAR.helmet, GUN_GAME_GEAR.chest]);
        expect(["1xscope", "2xscope", "4xscope"].map((s) => ps[0].invManager.get(s as never))).toStrictEqual([1, 1, 1]);
    });

    test("a kill moves the killer up, the victim respawns after a moment with full health", () => {
        const { game, rules, ps } = gunGame();
        const [a, b] = ps;
        kill(b, a);
        expect(rules.levelOf(a)).toBe(1);
        expect(a.weapons[0].type).toBe(rules.ladder[1]);
        expect(a.kills).toBe(1);
        // b didn't really die: hidden, untouchable, no inputs - and watches a
        expect(b.dead).toBe(false);
        expect(rules.isHidden(b)).toBe(true);
        expect(rules.blocksInput(b)).toBe(true);
        expect(b.spectating).toBe(a);
        const hp = b.health;
        kill(b, ps[2]);
        expect(rules.levelOf(ps[2])).toBe(0);
        expect(b.health).toBe(hp);

        tick(game, GUN_GAME_RESPAWN_DELAY_S + 0.1);
        expect(rules.isHidden(b)).toBe(false);
        expect(b.spectating).toBeUndefined();
        expect(b.health).toBe(100);
        // spawn protection, then fair game again
        expect(rules.isProtected(b)).toBe(true);
        tick(game, GUN_GAME_SPAWN_PROTECTION_S + 0.1);
        expect(rules.isProtected(b)).toBe(false);
    });

    test("takedown (the arena's, as in Domination): +10 health, a short damage resistance, a short haste", () => {
        const { rules, ps } = gunGame();
        const [a, b] = ps;
        a.health = 50;
        kill(b, a);
        expect(a.health).toBe(50 + ARENA_TAKEDOWN.health);
        expect(rules.damageReduction(a)).toBeCloseTo(ARENA_BOOST_RESIST.takedown.reduction);
        expect(a.hasteType).toBe(GameConfig.HasteType.Takedown);
    });

    test("anti kill steal: killing yourself costs a step, the last one who hurt you gets the kill", () => {
        const { game, rules, ps } = gunGame();
        const [a, b, c] = ps;
        kill(c, b);
        tick(game, GUN_GAME_RESPAWN_DELAY_S + GUN_GAME_SPAWN_PROTECTION_S + 0.2);
        expect(rules.levelOf(b)).toBe(1);
        // a hurts b, then b blows themselves up
        b.damage({ amount: 10, damageType: GameConfig.DamageType.Player, source: a, gameSourceType: a.activeWeapon, dir: v2.create(1, 0) });
        b.damage({ amount: 1000, damageType: GameConfig.DamageType.Player, source: b, gameSourceType: "frag", dir: v2.create(1, 0) });
        expect(rules.levelOf(b)).toBe(0);
        expect(rules.levelOf(a)).toBe(1);
        expect(a.kills).toBe(1);
        expect(b.spectating).toBe(a);

        // nobody hurt c since the respawn: just the step down
        tick(game, GUN_GAME_RESPAWN_DELAY_S + GUN_GAME_SPAWN_PROTECTION_S + 0.2);
        kill(a, c);
        tick(game, GUN_GAME_RESPAWN_DELAY_S + GUN_GAME_SPAWN_PROTECTION_S + 0.2);
        expect(rules.levelOf(c)).toBe(1);
        c.damage({ amount: 1000, damageType: GameConfig.DamageType.Player, source: c, gameSourceType: "frag", dir: v2.create(1, 0) });
        expect(rules.levelOf(c)).toBe(0);
        // (a was killed by a gun meanwhile - no step down for that)
        expect([rules.levelOf(a), rules.levelOf(b)]).toStrictEqual([1, 0]);
    });

    test("anti kill steal on the last step wins too", () => {
        const { game, rules, ps } = gunGame();
        const [a, b] = ps;
        for (let i = 0; i < rules.lastLevel; i++) {
            kill(b, a);
            tick(game, GUN_GAME_RESPAWN_DELAY_S + GUN_GAME_SPAWN_PROTECTION_S + 0.2);
        }
        expect(rules.levelOf(a)).toBe(rules.lastLevel);
        b.damage({ amount: 10, damageType: GameConfig.DamageType.Player, source: a, gameSourceType: GUN_GAME_MELEE, dir: v2.create(1, 0) });
        b.damage({ amount: 1000, damageType: GameConfig.DamageType.Player, source: b, gameSourceType: "frag", dir: v2.create(1, 0) });
        tick(game, 0.1);
        expect(game.over).toBe(true);
        expect(a.rank).toBe(1);
    });

    test("a melee kill moves the victim down (not below the first step)", () => {
        const { game, rules, ps } = gunGame();
        const [a, b, c] = ps;
        kill(b, a);
        tick(game, GUN_GAME_RESPAWN_DELAY_S + GUN_GAME_SPAWN_PROTECTION_S + 0.2);
        expect(rules.levelOf(a)).toBe(1);
        kill(a, c, "fists");
        expect(rules.levelOf(a)).toBe(0);
        expect(rules.levelOf(c)).toBe(1);
        tick(game, GUN_GAME_RESPAWN_DELAY_S + GUN_GAME_SPAWN_PROTECTION_S + 0.2);
        kill(a, b, GUN_GAME_MELEE);
        expect(rules.levelOf(a)).toBe(0);
    });

    test("a melee kill on the last step wins, and ranks follow the levels", () => {
        const { game, rules, ps } = gunGame();
        const [a, b, c] = ps;
        // a climbs to the melee step
        for (let i = 0; i < rules.lastLevel; i++) {
            kill(b, a);
            tick(game, GUN_GAME_RESPAWN_DELAY_S + GUN_GAME_SPAWN_PROTECTION_S + 0.2);
        }
        expect(rules.levelOf(a)).toBe(rules.lastLevel);
        expect(GUN_GAME_MELEE).toBe("sledgehammer");
        expect(a.activeWeapon).toBe(GUN_GAME_MELEE);
        expect(a.weapons[0].type).toBe("");
        kill(c, b);
        tick(game, GUN_GAME_RESPAWN_DELAY_S + GUN_GAME_SPAWN_PROTECTION_S + 0.2);
        expect(game.over).toBe(false);

        kill(c, a, GUN_GAME_MELEE);
        // ends on its own (no death happened, so only the per-tick check sees it)
        tick(game, 0.1);
        expect(game.over).toBe(true);
        const ranks = game.modeManager.currentRanks();
        expect([ranks.get(a), ranks.get(b), ranks.get(c)]).toStrictEqual([1, 2, 3]);
    });

    test("when time runs out the highest level wins", () => {
        const { game, rules, ps } = gunGame();
        const [a, b, c] = ps;
        kill(a, c);
        kill(b, c);
        tick(game, 0.1);
        expect(game.started).toBe(true);
        game.checkGameOver();
        expect(game.over).toBe(false);
        game.startedTime = GUN_GAME_TIME_LIMIT_S;
        tick(game, 0.1);
        expect(game.over).toBe(true);
        expect(rules.ranking()[0]).toBe(c);
        expect(c.rank).toBe(1);
    });
});

describe("warmup", () => {
    test("until enough players are in: random guns, nothing counts, no clock", () => {
        const { game, rules, ps } = gunGame(3, false);
        const [a, b] = ps;
        expect(rules.running).toBe(false);
        expect(rules.neededPlayers).toBe(GUN_GAME_MIN_PLAYERS);
        const guns = [a.weapons[0].type, a.weapons[1].type];
        expect(guns.filter(Boolean)).toHaveLength(GUN_GAME_WARMUP_GUNS);
        expect(guns[0]).not.toBe(guns[1]);
        tick(game, 30);
        expect(game.started).toBe(false);
        expect(game.startedTime).toBe(0);

        kill(b, a);
        expect(rules.levelOf(a)).toBe(0);
        expect(a.kills).toBe(0);
        // still respawns
        expect(rules.isHidden(b)).toBe(true);
        tick(game, GUN_GAME_RESPAWN_DELAY_S + 0.1);
        expect(rules.isHidden(b)).toBe(false);
        expect(b.health).toBe(100);
        expect(game.over).toBe(false);
    });

    test("enough players: countdown, then a new map for the player count, everyone on step 1, the clock runs", () => {
        const { game, rules, ps } = gunGame(GUN_GAME_MIN_PLAYERS - 1, false);
        tick(game, 1);
        // break things during the warmup
        const crate = game.map.obstacles.find((o) => o.destructible && !o.isWall && !o.parentBuildingId)!;
        crate.damage({ amount: 10000, damageType: GameConfig.DamageType.Player, dir: v2.create(1, 0) });
        expect(crate.dead).toBe(true);
        ps[0].damageDealt = 500;

        expect(rules.running).toBe(false);
        ps.push(game.playerBarn.addTestPlayer({}));
        tick(game, GUN_GAME_COUNTDOWN_S / 2);
        expect(rules.running).toBe(false);
        tick(game, GUN_GAME_COUNTDOWN_S / 2 + 0.2);
        expect(rules.running).toBe(true);
        tick(game, 0.1);
        expect(game.started).toBe(true);

        // the warmup's map is gone, a new one sized for the players in
        expect(crate.destroyed).toBe(true);
        expect(game.map.obstacles.length).toBeGreaterThan(50);
        expect(game.map.obstacles.every((o) => !o.destroyed && !o.dead)).toBe(true);
        expect(game.lootBarn.loots.filter((l) => !l.destroyed)).toHaveLength(0);
        expect(game.map.sizeScale).toBe(gunGameMapScale(ps.length));
        for (const p of ps) {
            expect(p.pos.x).toBeLessThanOrEqual(game.map.width);
            expect(p.pos.y).toBeLessThanOrEqual(game.map.height);
        }
        for (const p of ps) {
            expect(rules.levelOf(p)).toBe(0);
            expect(p.weapons[0].type).toBe(rules.ladder[0]);
            expect(p.weapons[1].type).toBe("");
        }
        expect(ps[0].damageDealt).toBe(0);
    });

    test("players leaving during the countdown: back to waiting", () => {
        const { game, rules, ps } = gunGame(GUN_GAME_MIN_PLAYERS, false);
        tick(game, 1);
        game.playerBarn.removePlayer(ps[0]);
        tick(game, GUN_GAME_COUNTDOWN_S + 1);
        expect(rules.running).toBe(false);
    });

    test("late joiners start on the lowest step", () => {
        const { game, rules, ps } = gunGame(3);
        const [a, b, c] = ps;
        for (const victim of [b, c]) {
            kill(victim, a);
            tick(game, GUN_GAME_RESPAWN_DELAY_S + 0.1);
        }
        kill(a, b);
        tick(game, GUN_GAME_RESPAWN_DELAY_S + GUN_GAME_SPAWN_PROTECTION_S + 0.2);
        kill(a, c);
        // a: 2, b: 1, c: 1
        expect([rules.levelOf(a), rules.levelOf(b), rules.levelOf(c)]).toStrictEqual([2, 1, 1]);
        const late = game.playerBarn.addTestPlayer({});
        expect(rules.levelOf(late)).toBe(1);
        expect(late.weapons[0].type).toBe(rules.ladder[1]);
    });

    test("a big match gets a big map (the object grid has room for it)", () => {
        const { game, rules } = gunGame(18, false);
        const small = game.map.width;
        rules.startMatch();
        expect(game.map.sizeScale).toBe(gunGameMapScale(18));
        expect(game.map.width).toBeCloseTo(small * gunGameMapScale(18), 0);
        tick(game, 1);
    });

    test("a private lobby waits for its own players only", () => {
        const game = createGame(TeamMode.Solo, "gungame", GameMode.GunGame);
        game.expectedPlayers = 3;
        (game as any).isPrivate = true;
        const rules = game.rules as GunGame;
        expect(rules.neededPlayers).toBe(3);
        for (let i = 0; i < 3; i++) game.playerBarn.addTestPlayer({});
        tick(game, GUN_GAME_COUNTDOWN_S + 0.5);
        expect(rules.running).toBe(true);
    });
});
