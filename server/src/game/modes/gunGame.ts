import { GunDefs } from "../../../../shared/defs/gameObjects/gunDefs";
import { GameObjectDefs } from "../../../../shared/defs/register";
import { type GunCategory, gunCategory } from "../../../../shared/defs/gunCategories";
import {
    GUN_GAME_EXCLUDED_GUNS,
    GUN_GAME_IGNORED_LOOT_TIERS,
    GUN_GAME_POOL_MAP,
    GUN_GAME_GEAR,
    GUN_GAME_LADDER_SHAPE,
    GUN_GAME_MELEE,
    GUN_GAME_RESPAWN_DELAY_S,
    GUN_GAME_SPAWN_PROTECTION_S,
    GUN_GAME_TIME_LIMIT_S,
} from "../../../../shared/defs/gunGameDefs";
import { MapDefs } from "../../../../shared/defs/mapDefs";
import { GameConfig, type InventoryItem } from "../../../../shared/gameConfig";
import * as net from "../../../../shared/net/net";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import { v2 } from "../../../../shared/utils/v2";
import type { Game } from "../game";
import type { DamageParams } from "../objects/gameObject";
import type { Player } from "../objects/player";
import type { ModeRules } from "./modeRules";

/**
 * Guns a ladder may draw from, by category: the ones found on GUN_GAME_POOL_MAP's loot
 * tables (minus the catch-all ones), plus the dual version of every pistol found there.
 */
export function gunPool(): Map<GunCategory, string[]> {
    const lootTable = MapDefs[GUN_GAME_POOL_MAP as keyof typeof MapDefs].lootTable as Record<
        string,
        Array<{ name: string; weight: number }>
    >;
    const found = new Set<string>();
    for (const [tier, entries] of Object.entries(lootTable)) {
        if (GUN_GAME_IGNORED_LOOT_TIERS.includes(tier)) continue;
        for (const e of entries) {
            if (e.weight > 0 && GunDefs[e.name]) found.add(e.name);
        }
    }
    for (const type of [...found]) {
        if (gunCategory(type) === "pistol" && GunDefs[`${type}_dual`]) found.add(`${type}_dual`);
    }

    const pool = new Map<GunCategory, string[]>();
    for (const type of found) {
        const def = GunDefs[type] as { noDrop?: boolean; isLauncher?: boolean };
        if (def.noDrop || def.isLauncher || GUN_GAME_EXCLUDED_GUNS.includes(type)) continue;
        const category = gunCategory(type);
        if (category === "special") continue;
        pool.set(category, [...(pool.get(category) ?? []), type]);
    }
    return pool;
}

/**
 * A fresh ladder: per GUN_GAME_LADDER_SHAPE step, `count` guns drawn at random from
 * its categories (none used twice in the ladder), then the melee as the last step.
 */
export function buildGunGameLadder(random: () => number = Math.random): string[] {
    const pool = gunPool();
    const ladder: string[] = [];
    for (const { categories, count } of GUN_GAME_LADDER_SHAPE) {
        const guns = categories.flatMap((c) => pool.get(c) ?? []).filter((g) => !ladder.includes(g));
        for (let i = 0; i < count && guns.length; i++) {
            ladder.push(guns.splice(Math.floor(random() * guns.length), 1)[0]);
        }
    }
    ladder.push(GUN_GAME_MELEE);
    return ladder;
}

/**
 * Gun Game (GameMode.GunGame): every kill moves the killer one step up a ladder of
 * guns drawn at random for this match; a melee kill also moves the victim one step
 * down. Killed players are gone for a moment and respawn - nobody really dies. The
 * first kill made on the last step (the melee) wins; when the time limit runs out the
 * highest step wins.
 */
export class GunGame implements ModeRules {
    readonly skipsGas = true;
    readonly ladder = buildGunGameLadder();

    private levels = new Map<Player, number>();
    /** game clock (s) a hidden player respawns at */
    private respawnAt = new Map<Player, number>();
    /** game clock (s) until which a player takes no damage */
    private protectedUntil = new Map<Player, number>();
    private clock = 0;
    private winner: Player | undefined;
    /** levels changed (or someone joined / left) since the last ModeStandingsMsg */
    private standingsDirty = true;

    constructor(readonly game: Game) {}

    levelOf(player: Player): number {
        return this.levels.get(player) ?? 0;
    }

    get lastLevel(): number {
        return this.ladder.length - 1;
    }

    onJoin(player: Player): void {
        this.levels.set(player, 0);
        this.standingsDirty = true;
        // the ladder decides the weapons; ammo never runs out
        player.addPerk("endless_ammo", false);
        this.giveGear(player);
        this.giveLevelWeapons(player);
    }

    /** Level 3 armor and the scopes (GUN_GAME_GEAR) - the same for everyone. */
    private giveGear(player: Player): void {
        player.helmet = GUN_GAME_GEAR.helmet;
        player.chest = GUN_GAME_GEAR.chest;
        for (const scope of GUN_GAME_GEAR.scopes) player.invManager.set(scope as InventoryItem, 1);
        player.inventoryDirty = true;
        player.setDirty();
    }

    /** Slot 0: the step's gun (none on the melee step); the melee is always carried. */
    private giveLevelWeapons(player: Player): void {
        const wm = player.weaponManager;
        const type = this.ladder[this.levelOf(player)];
        const gun = GunDefs[type] as { maxClip: number } | undefined;
        wm.setWeapon(GameConfig.WeaponSlot.Primary, gun ? type : "", gun ? gun.maxClip : 0);
        wm.setWeapon(GameConfig.WeaponSlot.Secondary, "", 0);
        wm.setWeapon(GameConfig.WeaponSlot.Melee, GUN_GAME_MELEE, 0);
        wm.setWeapon(GameConfig.WeaponSlot.Throwable, "", 0);
        wm.setCurWeapIndex(gun ? GameConfig.WeaponSlot.Primary : GameConfig.WeaponSlot.Melee, true, true, true, false);
        player.weapsDirty = true;
        player.setDirty();
    }

    handleDeath(victim: Player, params: DamageParams): boolean {
        if (this.respawnAt.has(victim)) return true;

        const credit = params.killCreditSource ?? params.source;
        const killer = credit?.__type === ObjectType.Player && credit !== victim ? (credit as Player) : undefined;
        const meleeKill = GameObjectDefs.typeToDefSafe(params.gameSourceType ?? "")?.type === "melee";

        if (killer) {
            killer.kills++;
            killer.killedIds.push(victim.matchDataId);
            if (meleeKill) this.levels.set(victim, Math.max(0, this.levelOf(victim) - 1));
            this.standingsDirty = true;
            if (this.levelOf(killer) >= this.lastLevel && meleeKill) {
                this.winner = killer;
            } else {
                this.levels.set(killer, Math.min(this.lastLevel, this.levelOf(killer) + 1));
                this.giveLevelWeapons(killer);
            }
            this.game.playerBarn.killLeaderDirty = true;
            this.game.logKillFeedEntry({
                ts: Date.now(),
                killerName: killer.name,
                killerUserId: killer.userId ?? "",
                victimName: victim.name,
                victimUserId: victim.userId ?? "",
                weapon: params.gameSourceType ?? params.mapSourceType ?? "unknown",
            });
        }

        const killMsg = new net.KillMsg();
        killMsg.damageType = params.damageType;
        killMsg.itemSourceType = params.gameSourceType ?? "";
        killMsg.mapSourceType = params.mapSourceType ?? "";
        killMsg.targetId = victim.__id;
        killMsg.killed = true;
        if (killer) {
            killMsg.killCreditId = killer.__id;
            killMsg.killerKills = killer.kills;
        }
        if (params.source?.__type === ObjectType.Player) killMsg.killerId = params.source.__id;
        this.game.broadcastMsg(net.MsgType.Kill, killMsg);

        // gone for a moment: hidden, no inputs, no damage - see update() for the respawn
        this.respawnAt.set(victim, this.clock + GUN_GAME_RESPAWN_DELAY_S);
        victim.shootHold = false;
        victim.moveLeft = victim.moveRight = victim.moveUp = victim.moveDown = false;
        victim.cancelAction();
        victim.setDirty();
        return true;
    }

    private respawn(player: Player): void {
        this.respawnAt.delete(player);
        this.protectedUntil.set(player, this.clock + GUN_GAME_SPAWN_PROTECTION_S);
        v2.set(player.pos, this.game.map.getSpawnPos(player.group, player.team));
        player.layer = 0;
        player.health = 100;
        player.boost = 0;
        player.lastDamagedBy = undefined;
        this.game.grid.updateObject(player);
        this.giveGear(player);
        this.giveLevelWeapons(player);
    }

    isProtected(player: Player): boolean {
        return this.respawnAt.has(player) || (this.protectedUntil.get(player) ?? 0) > this.clock;
    }

    blocksInput(player: Player): boolean {
        return this.respawnAt.has(player);
    }

    isHidden(player: Player): boolean {
        return this.respawnAt.has(player);
    }

    update(dt: number): void {
        this.clock += dt;
        for (const [player, at] of this.respawnAt) {
            if (player.disconnected) this.respawnAt.delete(player);
            else if (at <= this.clock) this.respawn(player);
        }
        if (this.standingsDirty) {
            this.standingsDirty = false;
            const msg = new net.ModeStandingsMsg();
            msg.entries = this.ranking()
                .filter((p) => !p.disconnected)
                .slice(0, 255)
                .map((p) => ({ playerId: p.__id, score: this.levelOf(p) + 1 }));
            this.game.broadcastMsg(net.MsgType.ModeStandings, msg);
        }
    }

    checkGameEnd(): boolean {
        if (!this.game.started) return false;
        if (!this.winner) {
            const timeUp = this.game.startedTime >= GUN_GAME_TIME_LIMIT_S;
            // the last one left once nobody can join anymore
            const joinTime = this.game.map.mapDef.gameMode.joinTime ?? 60;
            const alone = this.game.playerBarn.livingPlayers.length <= 1 && this.game.startedTime >= joinTime;
            if (!timeUp && !alone) return false;
            this.winner = this.ranking()[0];
        }
        const winner = this.winner;
        if (!winner) return true;
        winner.rank = 1;
        winner.addGameOverMsg(winner.teamId);
        for (const p of this.game.playerBarn.players) {
            if (p !== winner && !p.spectator) p.addGameOverMsg();
        }
        this.game.modeManager.sendSpectatorsGameOver(winner.teamId);
        return true;
    }

    ranking(): Player[] {
        return this.game.playerBarn.players
            .filter((p) => !p.spectator && !p.stealth)
            .sort((a, b) => {
                if (a === this.winner) return -1;
                if (b === this.winner) return 1;
                return this.levelOf(b) - this.levelOf(a) || b.kills - a.kills;
            });
    }

    leader(): { player: Player; score: number } | undefined {
        const best = this.ranking()[0];
        return best ? { player: best, score: this.levelOf(best) + 1 } : undefined;
    }

    joinedPayload(): string[] {
        return this.ladder;
    }
}
