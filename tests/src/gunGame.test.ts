import { describe, expect, test } from "vitest";
import { GunGame, buildGunGameLadder, gunPool } from "../../server/src/game/modes/gunGame.ts";
import type { Player } from "../../server/src/game/objects/player.ts";
import { gunCategory } from "../../shared/defs/gunCategories.ts";
import {
    GUN_GAME_GEAR,
    GUN_GAME_LADDER_SHAPE,
    GUN_GAME_MELEE,
    GUN_GAME_RESPAWN_DELAY_S,
    GUN_GAME_SPAWN_PROTECTION_S,
    GUN_GAME_TIME_LIMIT_S,
} from "../../shared/defs/gunGameDefs.ts";
import { GameConfig, GameMode, TeamMode } from "../../shared/gameConfig.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

function gunGame(players = 3) {
    const game = createGame(TeamMode.Solo, "gungame", GameMode.GunGame);
    const ps = Array.from({ length: players }, () => game.playerBarn.addTestPlayer({}));
    return { game, rules: game.rules as GunGame, ps };
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
        const make = (mapScale?: number) => {
            const Game = createGame(TeamMode.Solo, "main").constructor as any;
            const g = new Game("t", { mapName: "gungame", teamMode: TeamMode.Solo, gameMode: GameMode.GunGame, mapScale }, () => {}, () => {});
            g.map.init();
            return g;
        };
        const small = make();
        const big = make(1.4);
        expect(big.map.width).toBeCloseTo(small.map.width * 1.4, 0);
        const count = (g: any) => g.objectRegister.objects.filter(Boolean).length;
        // ~2x the area -> ~2x the objects; the random buildings (with many sub-objects) make
        // single maps vary a lot, so only check for a clear increase
        expect(count(big)).toBeGreaterThan(count(small) * 1.2);
    });

    test("respawns keep their distance to everyone alive", () => {
        const { game, ps } = gunGame(4);
        const minRad = game.map.mapDef.gameMode.minSpawnRad!;
        expect(minRad).toBeGreaterThanOrEqual(50);
        for (let i = 0; i < 20; i++) {
            const pos = game.map.getSpawnPos();
            for (const p of ps) expect(v2.distance(p.pos, pos)).toBeGreaterThanOrEqual(minRad);
        }
    });
});

describe("gun game", () => {
    test("joining gives the first gun, the melee and endless ammo", () => {
        const { rules, ps } = gunGame(1);
        expect(ps[0].weapons[0].type).toBe(rules.ladder[0]);
        expect(ps[0].weapons[2].type).toBe(GUN_GAME_MELEE);
        expect(ps[0].hasPerk("endless_ammo")).toBe(true);
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
        // b didn't really die: hidden, untouchable, no inputs
        expect(b.dead).toBe(false);
        expect(rules.isHidden(b)).toBe(true);
        expect(rules.blocksInput(b)).toBe(true);
        const hp = b.health;
        kill(b, ps[2]);
        expect(rules.levelOf(ps[2])).toBe(0);
        expect(b.health).toBe(hp);

        tick(game, GUN_GAME_RESPAWN_DELAY_S + 0.1);
        expect(rules.isHidden(b)).toBe(false);
        expect(b.health).toBe(100);
        // spawn protection, then fair game again
        expect(rules.isProtected(b)).toBe(true);
        tick(game, GUN_GAME_SPAWN_PROTECTION_S + 0.1);
        expect(rules.isProtected(b)).toBe(false);
    });

    test("a melee kill moves the victim down (not below the first step)", () => {
        const { game, rules, ps } = gunGame();
        const [a, b, c] = ps;
        kill(b, a);
        tick(game, GUN_GAME_RESPAWN_DELAY_S + GUN_GAME_SPAWN_PROTECTION_S + 0.2);
        expect(rules.levelOf(a)).toBe(1);
        kill(a, c, GUN_GAME_MELEE);
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
        expect(a.activeWeapon).toBe(GUN_GAME_MELEE);
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
