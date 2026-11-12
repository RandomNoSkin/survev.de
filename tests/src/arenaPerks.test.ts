import { describe, expect, test } from "vitest";
import type { Domination } from "../../server/src/game/modes/domination.ts";
import type { Player } from "../../server/src/game/objects/player.ts";
import { GunDefs } from "../../shared/defs/gameObjects/gunDefs.ts";
import { GameObjectDefs } from "../../shared/defs/register.ts";
import { ObjectType } from "../../shared/net/objectSerializeFns.ts";
import { collider } from "../../shared/utils/collider.ts";
import { ARENA_BOOST_RESIST, ARENA_PERKS, ARENA_REVIVE_HEALTH, ARENA_TAKEDOWN } from "../../shared/defs/modes/arenaDefs.ts";
import { ARENA_FAST_REVIVE_S, ARENA_PERK_DEFS } from "../../shared/defs/modes/arenaPerkDefs.ts";
import { DOMINATION_SPAWN_PROTECTION_S } from "../../shared/defs/modes/dominationDefs.ts";
import { GameConfig, GameMode, TeamMode } from "../../shared/gameConfig.ts";
import { arenaSlotOf, arenaUnlockLevel, sanitizeArenaLoadout } from "../../shared/utils/arena.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/**
 * Every arena perk doing what arenaPerkDefs.ts says - played through the game's own
 * mechanics (kills, revives, medical items, bullets, explosions), not just the settings.
 */

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

/** The player spawns with this perk in the loadout's perk slot. */
function withPerk(rules: Domination, p: Player, perk: string) {
    p.arenaLoadouts = [{ primary: "hk416", pistol: "p30l", throwable: "frag", perk }];
    p.arenaLoadoutIdx = 0;
    (rules as unknown as { giveSpawnItems(p: Player): void }).giveSpawnItems(p);
}

function place(players: Player[], pos: { x: number; y: number }) {
    for (const p of players) {
        v2.set(p.pos, pos);
        p.game.grid.updateObject(p);
    }
}

function shoot(victim: Player, shooter: Player, amount: number, extra: object = {}) {
    victim.damage({
        amount,
        damageType: GameConfig.DamageType.Player,
        source: shooter,
        gameSourceType: "hk416",
        dir: v2.create(1, 0),
        ...extra,
    });
}

/** Damage `victim` takes from a hit (health before minus after, from full health). */
function taken(victim: Player, hit: () => void): number {
    victim.health = 100;
    hit();
    return 100 - victim.health;
}

describe("arena perks", () => {
    test("every arena perk spawns in the perk slot, droppable, and keeps the player normal size", () => {
        const { rules, red } = domination();
        const [p] = red;
        for (const perk of ARENA_PERKS.filter((x) => arenaSlotOf(x) === "perk")) {
            withPerk(rules, p, perk);
            const slot = p.perks.filter((x) => x.droppable);
            expect(slot.map((x) => x.type), perk).toStrictEqual([perk]);
            expect(p.scale, perk).toBe(1);
            expect(ARENA_PERK_DEFS[perk].description.length, perk).toBeGreaterThan(0);
        }
    });

    test("Takedown: a kill gives +10 health, a short damage resistance and a short burst of speed", () => {
        const { rules, red, blue } = domination();
        const [r] = red;
        const [b] = blue;
        withPerk(rules, r, "takedown");
        r.health = 50;
        expect(rules.damageReduction(r)).toBe(0);
        shoot(b, r, 1000);
        expect(r.kills).toBe(1);
        expect(r.health).toBe(50 + ARENA_TAKEDOWN.health);
        expect(rules.damageReduction(r)).toBeCloseTo(ARENA_BOOST_RESIST.takedown.reduction);
        expect(r.hasteType).toBe(GameConfig.HasteType.Takedown);
    });

    test("Scavenger: the victim also drops their grenades and half their ammo", () => {
        const { game, rules, red, blue } = domination();
        const [r] = red;
        const [b] = blue;
        withPerk(rules, r, "scavenger");
        const ammo = b.invManager.get("556mm");
        shoot(b, r, 1000);
        const lying = game.lootBarn.loots.filter((l) => !l.destroyed);
        expect(lying.find((l) => l.type === "frag")?.count).toBe(3);
        expect(lying.find((l) => l.type === "556mm")?.count).toBe(Math.floor(ammo / 2));
        // without it: neither
        const { game: game2, red: red2, blue: blue2 } = domination();
        shoot(blue2[0], red2[0], 1000);
        const plain = game2.lootBarn.loots.filter((l) => !l.destroyed).map((l) => l.type);
        expect(plain).not.toContain("frag");
        expect(plain).not.toContain("556mm");
    });

    test("Mass Medicate: a revive in a moment; a soda gives nearby teammates the damage resistance too", () => {
        const { game, rules, red, blue } = domination(2);
        const [medic, mate] = red;
        withPerk(rules, medic, "aoe_heal");
        shoot(mate, blue[0], 1000);
        expect(mate.downed).toBe(true);
        place([medic], mate.pos);
        medic.revive(mate);
        expect(medic.action.duration).toBe(ARENA_FAST_REVIVE_S);
        tick(game, ARENA_FAST_REVIVE_S + 0.2);
        expect(mate.downed).toBe(false);

        // a soda for both (fresh resistances first)
        tick(game, ARENA_BOOST_RESIST.painkiller.seconds + 0.2);
        expect(rules.damageReduction(mate, { damageType: 0, dir: v2.create(1, 0) } as never)).toBe(0);
        place([mate], medic.pos);
        medic.useBoostItem("soda");
        tick(game, 3.2);
        expect(rules.damageReduction(medic, { damageType: 0, dir: v2.create(1, 0) } as never)).toBeCloseTo(ARENA_BOOST_RESIST.soda.reduction);
        expect(rules.damageReduction(mate, { damageType: 0, dir: v2.create(1, 0) } as never)).toBeCloseTo(ARENA_BOOST_RESIST.soda.reduction);
    });

    test("Endless Ammo: a reload fills the magazine without taking ammo from the backpack", () => {
        const { rules, red } = domination();
        const [p] = red;
        withPerk(rules, p, "endless_ammo");
        const slot = GameConfig.WeaponSlot.Primary;
        p.weapons[slot].ammo = 0;
        const backpack = p.invManager.get("556mm");
        p.weaponManager.reload(slot);
        expect(p.weapons[slot].ammo).toBe(GunDefs.hk416.maxClip);
        expect(p.invManager.get("556mm")).toBe(backpack);
    });

    test("Firepower: spawns with the extended magazine (and reloads into it)", () => {
        const { rules, red } = domination();
        const [p] = red;
        withPerk(rules, p, "firepower");
        const slot = GameConfig.WeaponSlot.Primary;
        expect(GunDefs.hk416.extendedClip).toBeGreaterThan(GunDefs.hk416.maxClip);
        expect(p.weapons[slot].ammo).toBe(GunDefs.hk416.extendedClip);
        p.weapons[slot].ammo = 0;
        p.weaponManager.reload(slot);
        expect(p.weapons[slot].ammo).toBe(GunDefs.hk416.extendedClip);
    });

    test("Firepower: a dropped gun keeps its big magazine for everyone - without Firepower only until the next reload", () => {
        const { game, rules, red, blue } = domination();
        const [fp] = red;
        const [plain] = blue;
        withPerk(rules, fp, "firepower");
        const slot = GameConfig.WeaponSlot.Primary;
        const big = GunDefs.hk416.extendedClip;
        const normal = GunDefs.hk416.maxClip;
        expect(fp.weapons[slot].ammo).toBe(big);
        // dropped by the Firepower player, picked up by one without
        fp.weaponManager.dropGun(slot);
        const gun = game.lootBarn.loots.find((l) => !l.destroyed && l.type === "hk416")!;
        expect(gun.clip).toBe(big);
        plain.weaponManager.setWeapon(slot, "", 0);
        const backpack = plain.invManager.get("556mm");
        plain.pickupLoot(gun);
        expect(plain.weapons[slot].ammo).toBe(big);
        expect(plain.invManager.get("556mm")).toBe(backpack);
        // a full (over-full) magazine: no reload, nothing taken or given
        plain.weaponManager.setCurWeapIndex(slot);
        plain.weaponManager.tryReload();
        expect(plain.actionType).not.toBe(GameConfig.Action.Reload);
        plain.weaponManager.reload(slot);
        expect(plain.weapons[slot].ammo).toBe(big);
        expect(plain.invManager.get("556mm")).toBe(backpack);
        // shot down below the usual magazine: the reload fills only that
        plain.weapons[slot].ammo = 5;
        plain.weaponManager.reload(slot);
        expect(plain.weapons[slot].ammo).toBe(normal);
        expect(plain.invManager.get("556mm")).toBe(backpack - (normal - 5));

        // and the other way: a Firepower player picks up a normal one - its rounds, then the big reload
        withPerk(rules, plain, "takedown");
        plain.weapons[slot].ammo = 7;
        plain.weaponManager.dropGun(slot);
        const small = game.lootBarn.loots.find((l) => !l.destroyed && l.type === "hk416")!;
        expect(small.clip).toBe(7);
        fp.weaponManager.setWeapon(slot, "", 0);
        fp.pickupLoot(small);
        expect(fp.weapons[slot].ammo).toBe(7);
        fp.weaponManager.reload(slot);
        expect(fp.weapons[slot].ammo).toBe(big);
    });

    test("Windwalk: an enemy bullet flying past gives a burst of speed", () => {
        const { game, rules, red, blue } = domination();
        const [walker] = red;
        const [shooter] = blue;
        withPerk(rules, walker, "windwalk");
        // an open spot: whatever stands there out of the bullet's way
        const spot = game.map.center;
        for (const o of game.grid.intersectCollider(collider.createCircle(spot, 15))) {
            if (o.__type === ObjectType.Obstacle && !o.destroyed) o.destroy();
        }
        place([shooter], spot);
        place([walker], v2.add(spot, v2.create(3, 0)));
        game.bulletBarn.fireBullet({
            bulletType: GunDefs.hk416.bulletType,
            gameSourceType: "hk416",
            pos: v2.add(shooter.pos, v2.create(1.2, 0)),
            dir: v2.create(1, 0),
            layer: 0,
            damageMult: 1,
            damageType: GameConfig.DamageType.Player,
            playerId: shooter.__id,
        });
        tick(game, 0.2);
        expect(walker.hasteType).toBe(GameConfig.HasteType.Windwalk);
    });

    test("Hollow-Points: bullets go through vests (a level 3 vest takes as much as none), helmets still count", () => {
        const { rules, red, blue } = domination();
        const [target] = red;
        const [shooter] = blue;
        target.chest = "chest03";
        const withVest = taken(target, () => shoot(target, shooter, 40));
        target.chest = "";
        const noVest = taken(target, () => shoot(target, shooter, 40));
        expect(withVest).toBeLessThan(noVest);

        withPerk(rules, shooter, "bonus_assault");
        target.chest = "chest03";
        const hollow = taken(target, () => shoot(target, shooter, 40));
        expect(hollow).toBeCloseTo(noVest, 5);
        // no bonus damage of its own here
        expect(shooter.hasPerk("bonus_assault")).toBe(false);
    });

    test("Cast Ironskin: a level 3 vest, no bullet reflection / extra reduction, normal size", () => {
        const { rules, red, blue } = domination();
        const [p] = red;
        withPerk(rules, p, "steelskin");
        expect(p.chest).toBe("chest03");
        expect(p.hasPerk("steelskin")).toBe(false);
        expect(p.scale).toBe(1);
        // exactly what the vest gives, nothing more
        const iron = taken(p, () => shoot(p, blue[0], 40));
        p.removePerk("steelskin");
        const vest = taken(p, () => shoot(p, blue[0], 40));
        expect(iron).toBeCloseTo(vest, 5);
    });

    test("Flak Jacket: 60% less from explosions, nothing less from bullets, normal size", () => {
        const { rules, red, blue } = domination();
        const [p] = red;
        const blast = () => shoot(p, blue[0], 40, { isExplosion: true, gameSourceType: "frag" });
        const bullet = () => shoot(p, blue[0], 40);
        const blastBefore = taken(p, blast);
        const bulletBefore = taken(p, bullet);
        withPerk(rules, p, "flak_jacket");
        expect(p.scale).toBe(1);
        expect(taken(p, blast)).toBeCloseTo(blastBefore * (1 - ARENA_PERK_DEFS.flak_jacket.explosionReduction!), 5);
        expect(taken(p, bullet)).toBeCloseTo(bulletBefore, 5);
    });

    test("Revivify: knocked even alone, up again in a moment, medical items take half as long", () => {
        const { game, rules, red, blue } = domination();
        const [p] = red;
        withPerk(rules, p, "self_revive");
        // nobody to revive them - still knocked, not dead
        shoot(p, blue[0], 1000);
        expect(p.downed).toBe(true);
        expect(rules.isHidden(p)).toBe(false);
        p.revive(p.getPlayerToRevive());
        expect(p.action.duration).toBe(ARENA_FAST_REVIVE_S);
        tick(game, ARENA_FAST_REVIVE_S + 0.2);
        expect(p.downed).toBe(false);
        expect(p.health).toBeGreaterThanOrEqual(ARENA_REVIVE_HEALTH);
        // a bandage: half the time
        p.health = 50;
        p.useHealingItem("bandage");
        expect(p.action.duration).toBeCloseTo((GameObjectDefs.typeToDefSafe("bandage") as { useTime: number }).useTime * 0.5, 5);
    });

    test("Broken Arrow: not for the perk slot - worn on top of it (see arenaStreaks.test.ts)", () => {
        expect(ARENA_PERK_DEFS.broken_arrow.noArenaEffect).toBeFalsy();
        expect(arenaSlotOf("broken_arrow")).toBeUndefined();
    });

    test("Quickswitch (level 18, before Steelskin): two main guns - in the loadout and when picking one up", () => {
        expect(arenaUnlockLevel("quickswitch")).toBe(18);
        expect(arenaUnlockLevel("quickswitch")!).toBeLessThan(arenaUnlockLevel("steelskin")!);
        const all = new Set(["hk416", "ak47", "p30l", "frag", "quickswitch", "takedown"]);
        // with it: a main gun as secondary; without: back to a pistol
        expect(sanitizeArenaLoadout({ primary: "hk416", pistol: "ak47", throwable: "frag", perk: "quickswitch" }, all).pistol).toBe("ak47");
        expect(sanitizeArenaLoadout({ primary: "hk416", pistol: "ak47", throwable: "frag", perk: "takedown" }, all).pistol).not.toBe("ak47");
        // in the match: a main gun replaces the one in hand
        const { rules, red } = domination(1);
        const [r] = red;
        r.addPerk("quickswitch", false);
        r.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Secondary);
        expect(rules.gunPickupSlot(r, "ak47")).toBe(GameConfig.WeaponSlot.Secondary);
    });
});
