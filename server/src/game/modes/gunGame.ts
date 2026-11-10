import { GunDefs } from "../../../../shared/defs/gameObjects/gunDefs";
import { GameObjectDefs } from "../../../../shared/defs/register";
import { type GunCategory, gunCategory } from "../../../../shared/defs/gunCategories";
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
} from "../../../../shared/defs/gunGameDefs";
import { MapDefs } from "../../../../shared/defs/mapDefs";
import { GameConfig, type InventoryItem } from "../../../../shared/gameConfig";
import { ModePhase } from "../../../../shared/net/modeStandingsMsg";
import * as net from "../../../../shared/net/net";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
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
 * down. Killed players watch their killer for a moment and respawn - nobody really
 * dies. The first kill made on the last step (the sledgehammer) wins; when the time limit runs out the
 * highest step wins.
 *
 * Before that, a warmup: until GUN_GAME_MIN_PLAYERS are in, everyone plays with random
 * guns and nothing counts; then a countdown, a new map sized for the players in,
 * everyone respawns on step 1 and the clock starts. Late joiners start on the lowest step of the match.
 */
export class GunGame implements ModeRules {
    readonly skipsGas = true;
    readonly ladder = buildGunGameLadder();

    private levels = new Map<Player, number>();
    /** the melee each player brought in their loadout - carried until the last step */
    private ownMelee = new Map<Player, string>();
    /** game clock (s) a hidden player respawns at */
    private respawnAt = new Map<Player, number>();
    /** game clock (s) until which a player takes no damage */
    private protectedUntil = new Map<Player, number>();
    private clock = 0;
    private winner: Player | undefined;
    /** levels changed (or someone joined / left) since the last ModeStandingsMsg */
    private standingsDirty = true;
    /** the seconds last sent in a ModeStandingsMsg (resent when they change) */
    private sentSeconds = -1;
    /** the player count last sent (warmup: "3/6") */
    private sentPlayers = -1;

    private phase = ModePhase.Waiting;
    /** Countdown: seconds until the match starts */
    private countdown = 0;
    /** Waiting: seconds with at least two players in (private lobbies start anyway after a while) */
    private waited = 0;

    constructor(readonly game: Game) {}

    /** the match runs (the warmup is over) */
    get running(): boolean {
        return this.phase === ModePhase.Running;
    }

    /** Loot the map generation put down (buildings) - nobody can pick it up here. */
    private clearLoot(): void {
        for (const loot of this.game.lootBarn.loots) if (!loot.destroyed) loot.destroy();
    }
    private lootCleared = false;

    canStart(): boolean {
        return this.running;
    }

    /** non-spectators in the game */
    private activePlayers(): Player[] {
        return this.game.playerBarn.players.filter((p) => !p.spectator && !p.stealth && !p.disconnected);
    }

    /** players the match starts with: GUN_GAME_MIN_PLAYERS, fewer when the game (or a
     *  private lobby) has room for fewer */
    get neededPlayers(): number {
        const max = this.game.config.maxPlayers ?? this.game.map.mapDef.gameMode.maxPlayers;
        let need = Math.min(GUN_GAME_MIN_PLAYERS, max);
        if (this.game.isPrivate && this.game.expectedPlayers > 0) need = Math.min(need, this.game.expectedPlayers);
        return Math.max(2, need);
    }

    private get maxPlayers(): number {
        const max = this.game.config.maxPlayers ?? this.game.map.mapDef.gameMode.maxPlayers;
        return this.game.isPrivate && this.game.expectedPlayers > 0 ? Math.min(max, this.game.expectedPlayers) : max;
    }

    private updateWarmup(dt: number): void {
        const players = this.activePlayers().length;
        // the "3/6" changed
        if (players !== this.sentPlayers) {
            this.sentPlayers = players;
            this.standingsDirty = true;
        }
        if (this.phase === ModePhase.Waiting) {
            this.waited = players >= 2 ? this.waited + dt : 0;
            const privateTimeout = this.game.isPrivate && players >= 2 && this.waited >= GUN_GAME_PRIVATE_WAIT_S;
            if (players >= this.neededPlayers || privateTimeout) {
                this.phase = ModePhase.Countdown;
                this.countdown = GUN_GAME_COUNTDOWN_S;
                this.standingsDirty = true;
            }
            return;
        }
        // Countdown - back to waiting when players leave (a private lobby keeps going)
        if (players < 2 || (!this.game.isPrivate && players < this.neededPlayers)) {
            this.phase = ModePhase.Waiting;
            this.standingsDirty = true;
            return;
        }
        if (players >= this.maxPlayers) this.countdown = Math.min(this.countdown, GUN_GAME_FULL_COUNTDOWN_S);
        this.countdown -= dt;
        if (this.countdown <= 0) this.startMatch();
    }

    /** The warmup is over: a new map sized for the players in, everyone on step 1 and
     *  spread over it, the warmup's kills / damage forgotten. */
    startMatch(): void {
        this.phase = ModePhase.Running;
        this.winner = undefined;
        const players = this.activePlayers();
        // grenades / smoke of the warmup would hang in the air of the new map
        for (const p of this.game.projectileBarn.projectiles) if (!p.destroyed) p.destroy();
        for (const s of this.game.smokeBarn.smokes) if (!s.destroyed) s.destroy();
        this.game.smokeBarn.emitters.length = 0;
        this.game.map.regenerate(undefined, gunGameMapScale(players.length));
        this.clearLoot();
        for (const p of players) {
            this.levels.set(p, 0);
            p.kills = 0;
            p.killedIds = [];
            p.assists = 0;
            p.damageDealt = 0;
            p.damageTaken = 0;
            p.shotsFired = 0;
            p.bulletHits = 0;
            p.weaponDamageDealt.clear();
        }
        for (const p of players) this.respawn(p, true);
        this.standingsDirty = true;
        this.game.playerBarn.killLeaderDirty = true;
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
            this.broadcastKill(victim, params, params.source?.__type === ObjectType.Player && params.source !== victim ? (params.source as Player) : undefined);
            this.hideUntilRespawn(victim, undefined);
            return true;
        }

        const credit = params.killCreditSource ?? params.source;
        let killer = credit?.__type === ObjectType.Player && credit !== victim ? (credit as Player) : undefined;
        const meleeKill = GameObjectDefs.typeToDefSafe(params.gameSourceType ?? "")?.type === "melee";

        // anti kill steal (as in GameModeManager's solo path): killing yourself (own
        // grenade, barrel, ...) costs a step, and the last one who hurt you gets the kill -
        // a full kill, it also wins on the last step
        let stolen = false;
        if (!killer) {
            this.levels.set(victim, Math.max(0, this.levelOf(victim) - 1));
            this.standingsDirty = true;
            const last = victim.lastDamagedBy;
            if (last && last !== victim && !last.disconnected) {
                killer = last;
                stolen = true;
                params.killCreditSource = last;
                params.damageType = GameConfig.DamageType.KillSteal;
            }
        }

        if (killer) {
            killer.kills++;
            killer.killedIds.push(victim.matchDataId);
            if (meleeKill) this.levels.set(victim, Math.max(0, this.levelOf(victim) - 1));
            this.standingsDirty = true;
            if (this.levelOf(killer) >= this.lastLevel && (meleeKill || stolen)) {
                this.winner = killer;
            } else {
                this.levels.set(killer, Math.min(this.lastLevel, this.levelOf(killer) + 1));
                this.giveLevelWeapons(killer);
            }
            // as in Player.kill()
            if (killer.hasPerk("takedown")) {
                killer.health += 25;
                killer.boost += 25;
                killer.giveHaste(GameConfig.HasteType.Takedown, 3);
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

        this.broadcastKill(victim, params, killer);
        this.hideUntilRespawn(victim, killer);
        return true;
    }

    private broadcastKill(victim: Player, params: DamageParams, killer: Player | undefined): void {
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
    }

    /** Gone for a moment: hidden, no inputs, no damage, the camera on the killer - see
     *  update() for the respawn. */
    private hideUntilRespawn(victim: Player, killer: Player | undefined): void {
        this.respawnAt.set(victim, this.clock + GUN_GAME_RESPAWN_DELAY_S);
        if (killer && !killer.disconnected) victim.spectating = killer;
        victim.shootHold = false;
        victim.moveLeft = victim.moveRight = victim.moveUp = victim.moveDown = false;
        victim.cancelAction();
        victim.setDirty();
    }

    /** `spread`: anywhere (the match start) instead of near the fight. */
    private respawn(player: Player, spread = false): void {
        this.respawnAt.delete(player);
        player.spectating = undefined;
        this.protectedUntil.set(player, this.clock + GUN_GAME_SPAWN_PROTECTION_S);
        v2.set(player.pos, spread ? this.game.map.getSpawnPos() : this.spawnPos(player));
        player.layer = 0;
        player.health = 100;
        player.boost = 0;
        player.lastDamagedBy = undefined;
        this.game.grid.updateObject(player);
        this.giveGear(player);
        this.giveLevelWeapons(player);
    }

    /** A spot near the fight: of a few candidates (each at least minSpawnRad from
     *  everyone), the one whose nearest opponent is closest to SPAWN_TARGET_DIST. */
    spawnPos(player: Player): Vec2 {
        const map = this.game.map;
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
        if (!this.lootCleared) {
            this.lootCleared = true;
            this.clearLoot();
        }
        if (!this.running) this.updateWarmup(dt);
        for (const [player, at] of this.respawnAt) {
            if (player.disconnected) {
                this.respawnAt.delete(player);
                player.spectating = undefined;
                continue;
            }
            // the killer left: stop watching them
            if (player.spectating?.disconnected) player.spectating = undefined;
            if (at <= this.clock) this.respawn(player);
        }
        const seconds = this.phaseSeconds();
        if (this.standingsDirty || seconds !== this.sentSeconds) {
            this.standingsDirty = false;
            this.sentSeconds = seconds;
            const msg = new net.ModeStandingsMsg();
            msg.entries = this.ranking()
                .filter((p) => !p.disconnected)
                .slice(0, 255)
                .map((p) => ({ playerId: p.__id, score: this.levelOf(p) + 1 }));
            msg.phase = this.phase;
            msg.players = Math.min(255, this.activePlayers().length);
            msg.needed = Math.min(255, this.neededPlayers);
            msg.seconds = seconds;
            this.game.broadcastMsg(net.MsgType.ModeStandings, msg);
        }
    }

    /** Countdown: seconds to the start; running: seconds left on the clock. */
    private phaseSeconds(): number {
        if (this.phase === ModePhase.Countdown) return Math.max(0, Math.ceil(this.countdown));
        if (this.phase === ModePhase.Running) return Math.max(0, Math.ceil(GUN_GAME_TIME_LIMIT_S - this.game.startedTime));
        return 0;
    }

    checkGameEnd(): boolean {
        if (!this.game.started || !this.running) return false;
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
