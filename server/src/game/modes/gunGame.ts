import { GunDefs } from "../../../../shared/defs/gameObjects/gunDefs";
import { GameObjectDefs } from "../../../../shared/defs/register";
import { type GunCategory, gunCategory } from "../../../../shared/defs/gameObjects/gunCategories";
import {
    GUN_GAME_COUNTDOWN_S,
    GUN_GAME_EXCLUDED_GUNS,
    GUN_GAME_FULL_COUNTDOWN_S,
    GUN_GAME_MIN_PLAYERS,
    GUN_GAME_PRIVATE_WAIT_S,
    GUN_GAME_WARMUP_GUNS,
    GUN_GAME_IGNORED_LOOT_TIERS,
    GUN_GAME_POOL_MAP,
    GUN_GAME_GEAR,
    GUN_GAME_LADDER_SHAPE,
    gunGameMapScale,
    GUN_GAME_MELEE,
    GUN_GAME_PERKS,
    GUN_GAME_RESPAWN_DELAY_S,
    GUN_GAME_SPAWN_CANDIDATES,
    GUN_GAME_SPAWN_TARGET_DIST,
    GUN_GAME_SPAWN_PROTECTION_S,
    GUN_GAME_TIME_LIMIT_S,
} from "../../../../shared/defs/modes/gunGameDefs";
import { MapDefs } from "../../../../shared/defs/mapDefs";
import { GameConfig, type InventoryItem } from "../../../../shared/gameConfig";
import type * as net from "../../../../shared/net/net";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
import type { DamageParams } from "../objects/gameObject";
import type { Player } from "../objects/player";
import { RespawnRules } from "./respawnRules";

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
 * down. Killed players watch their killer for a moment and respawn - nobody really
 * dies (see RespawnRules). The first kill made on the last step (the sledgehammer)
 * wins; when the time limit runs out the highest step wins.
 *
 * Before that, a warmup: until GUN_GAME_MIN_PLAYERS are in, everyone plays with random
 * guns and nothing counts; then a countdown, a new map sized for the players in,
 * everyone respawns on step 1 and the clock starts. Late joiners start on the lowest
 * step of the match.
 */
export class GunGame extends RespawnRules {
    readonly ladder = buildGunGameLadder();

    protected readonly settings = {
        respawnDelay: GUN_GAME_RESPAWN_DELAY_S,
        spawnProtection: GUN_GAME_SPAWN_PROTECTION_S,
        timeLimit: GUN_GAME_TIME_LIMIT_S,
        minPlayers: GUN_GAME_MIN_PLAYERS,
        countdown: GUN_GAME_COUNTDOWN_S,
        fullCountdown: GUN_GAME_FULL_COUNTDOWN_S,
        privateWait: GUN_GAME_PRIVATE_WAIT_S,
    };

    private levels = new Map<Player, number>();
    /** the melee each player brought in their loadout - carried until the last step */
    private ownMelee = new Map<Player, string>();
    private winner: Player | undefined;

    /** A new map sized for the players in, everyone back on step 1. */
    protected onMatchStart(players: Player[]): void {
        this.winner = undefined;
        this.game.map.regenerate(undefined, gunGameMapScale(players.length));
        this.clearLoot();
        for (const p of players) this.levels.set(p, 0);
    }

    levelOf(player: Player): number {
        return this.levels.get(player) ?? 0;
    }

    get lastLevel(): number {
        return this.ladder.length - 1;
    }

    onJoin(player: Player): void {
        // late joiners start on the lowest step anyone is on
        const others = this.activePlayers().filter((p) => p !== player && this.levels.has(p));
        this.levels.set(player, this.running && others.length ? Math.min(...others.map((p) => this.levelOf(p))) : 0);
        this.standingsDirty = true;
        this.ownMelee.set(player, player.weapons[GameConfig.WeaponSlot.Melee].type || "fists");
        // the ladder decides the weapons; ammo never runs out, kills heal a bit
        for (const perk of GUN_GAME_PERKS) player.addPerk(perk, false);
        this.giveSpawnItems(player);
    }

    protected giveSpawnItems(player: Player): void {
        this.giveGear(player);
        this.giveLevelWeapons(player);
    }

    /** Armor, scopes and heals (GUN_GAME_GEAR) - the same for everyone, refilled on respawn. */
    private giveGear(player: Player): void {
        player.helmet = GUN_GAME_GEAR.helmet;
        player.chest = GUN_GAME_GEAR.chest;
        for (const scope of GUN_GAME_GEAR.scopes) player.invManager.set(scope as InventoryItem, 1);
        for (const [item, count] of Object.entries(GUN_GAME_GEAR.heals)) {
            player.invManager.set(item as InventoryItem, count);
        }
        player.inventoryDirty = true;
        player.setDirty();
    }

    /** Slot 0: the step's gun (none on the last step); the melee slot: the player's own
     *  melee, the sledgehammer on the last step. */
    private giveLevelWeapons(player: Player): void {
        if (!this.running) {
            this.giveWarmupWeapons(player);
            return;
        }
        const wm = player.weaponManager;
        const type = this.ladder[this.levelOf(player)];
        const gun = GunDefs[type] as { maxClip: number } | undefined;
        wm.setWeapon(GameConfig.WeaponSlot.Primary, gun ? type : "", gun ? gun.maxClip : 0);
        wm.setWeapon(GameConfig.WeaponSlot.Secondary, "", 0);
        wm.setWeapon(GameConfig.WeaponSlot.Melee, gun ? (this.ownMelee.get(player) ?? "fists") : GUN_GAME_MELEE, 0);
        wm.setWeapon(GameConfig.WeaponSlot.Throwable, "", 0);
        wm.setCurWeapIndex(gun ? GameConfig.WeaponSlot.Primary : GameConfig.WeaponSlot.Melee, true, true, true, false);
        player.weapsDirty = true;
        player.setDirty();
    }

    /** Warmup: GUN_GAME_WARMUP_GUNS different random guns from the pool + the own melee. */
    private giveWarmupWeapons(player: Player): void {
        const wm = player.weaponManager;
        const pool = [...gunPool().values()].flat();
        const guns: string[] = [];
        while (guns.length < GUN_GAME_WARMUP_GUNS && pool.length) {
            guns.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
        }
        const slots = [GameConfig.WeaponSlot.Primary, GameConfig.WeaponSlot.Secondary];
        slots.forEach((slot, i) => {
            const gun = GunDefs[guns[i]] as { maxClip: number } | undefined;
            wm.setWeapon(slot, gun ? guns[i] : "", gun ? gun.maxClip : 0);
        });
        wm.setWeapon(GameConfig.WeaponSlot.Melee, this.ownMelee.get(player) ?? "fists", 0);
        wm.setWeapon(GameConfig.WeaponSlot.Throwable, "", 0);
        wm.setCurWeapIndex(GameConfig.WeaponSlot.Primary, true, true, true, false);
        player.weapsDirty = true;
        player.setDirty();
    }

    handleDeath(victim: Player, params: DamageParams): boolean {
        if (this.respawnAt.has(victim)) return true;
        // warmup: only the respawn, nothing counts
        if (!this.running) {
            const source = params.source?.__type === ObjectType.Player && params.source !== victim
                ? (params.source as Player)
                : undefined;
            this.broadcastKill(victim, params, source);
            this.hideUntilRespawn(victim, undefined);
            return true;
        }

        const meleeKill = GameObjectDefs.typeToDefSafe(params.gameSourceType ?? "")?.type === "melee";
        const credit = params.killCreditSource ?? params.source;
        const selfKill = !(credit?.__type === ObjectType.Player && credit !== victim);
        // anti kill steal: killing yourself (own grenade, barrel, ...) costs a step, and
        // the last one who hurt you gets the kill - a full kill, it also wins on the last step
        const { killer, stolen } = this.resolveKiller(victim, params);
        if (selfKill) {
            this.levels.set(victim, Math.max(0, this.levelOf(victim) - 1));
            this.standingsDirty = true;
        }

        if (killer) {
            this.countKill(killer, victim, params);
            if (meleeKill) this.levels.set(victim, Math.max(0, this.levelOf(victim) - 1));
            this.standingsDirty = true;
            if (this.levelOf(killer) >= this.lastLevel && (meleeKill || stolen)) {
                this.winner = killer;
            } else {
                this.levels.set(killer, Math.min(this.lastLevel, this.levelOf(killer) + 1));
                this.giveLevelWeapons(killer);
            }
        }

        this.broadcastKill(victim, params, killer);
        this.hideUntilRespawn(victim, killer);
        return true;
    }

    /** A spot near the fight: of a few candidates (each at least minSpawnRad from
     *  everyone), the one whose nearest opponent is closest to SPAWN_TARGET_DIST; the
     *  match start (`spread`): anywhere. */
    spawnPos(player: Player, spread = false): Vec2 {
        const map = this.game.map;
        if (spread) return map.getSpawnPos();
        const opponents = this.game.playerBarn.livingPlayers.filter(
            (p) => p !== player && !p.disconnected && !this.respawnAt.has(p),
        );
        let best = map.getSpawnPos();
        if (!opponents.length) return best;
        let bestScore = Infinity;
        for (let i = 0; i < GUN_GAME_SPAWN_CANDIDATES; i++) {
            const pos = i === 0 ? best : map.getSpawnPos();
            let nearest = Infinity;
            for (const p of opponents) nearest = Math.min(nearest, v2.distance(p.pos, pos));
            const score = Math.abs(nearest - GUN_GAME_SPAWN_TARGET_DIST);
            if (score < bestScore) {
                best = pos;
                bestScore = score;
            }
        }
        return best;
    }

    protected fillStandings(msg: net.ModeStandingsMsg): void {
        msg.entries = this.ranking()
            .filter((p) => !p.disconnected)
            .slice(0, 255)
            .map((p) => ({ playerId: p.__id, score: this.levelOf(p) + 1 }));
    }

    checkGameEnd(): boolean {
        if (!this.game.started || !this.running) return false;
        if (!this.winner) {
            // the last one left once nobody can join anymore
            const joinTime = this.game.map.mapDef.gameMode.joinTime ?? 60;
            const alone = this.game.playerBarn.livingPlayers.length <= 1 && this.game.startedTime >= joinTime;
            if (!this.timeUp && !alone) return false;
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
