import { ARENA_AFK_KICK_S, ARENA_OUT_OF_COMBAT_HEAL_MULT, ARENA_OUT_OF_COMBAT_S } from "../../../../shared/defs/modes/arenaDefs";
import { MapDefs } from "../../../../shared/defs/mapDefs";
import type { MapDef } from "../../../../shared/defs/mapDefs";
import { GameObjectDefs } from "../../../../shared/defs/register";
import { GameConfig } from "../../../../shared/gameConfig";
import { ModePhase } from "../../../../shared/net/modeStandingsMsg";
import * as net from "../../../../shared/net/net";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
import type { Game } from "../game";
import type { DamageParams } from "../objects/gameObject";
import type { Player } from "../objects/player";
import type { ModeRules } from "./modeRules";

/** The timings of a respawn mode. */
export interface RespawnSettings {
    /** seconds a killed player is gone (watching their killer) */
    respawnDelay: number;
    /** seconds after a respawn without damage */
    spawnProtection: number;
    /** match length (s) once the warmup is over */
    timeLimit: number;
    /** warmup: the match starts with this many players (fewer if the game / lobby has room for fewer) */
    minPlayers: number;
    /** seconds from "enough players" to the start, and once the game is full */
    countdown: number;
    fullCountdown: number;
    /** private lobbies start with whoever made it (at least 2) after this long */
    privateWait: number;
}

/**
 * The common part of the modes where nobody really dies (Gun Game, Domination, ...):
 *
 * - a warmup until enough players are in, then a countdown, then the match with its clock
 *   (`ModePhase`; the game only counts as started once the match runs, see canStart)
 * - a killed player is hidden for a moment (no inputs, no damage), watches their killer,
 *   then respawns (spawnPos / giveSpawnItems) with a short spawn protection
 * - the kill feed / kill credit, and the ModeStandingsMsg with phase and clock
 *
 * A mode fills in where players spawn, what they get, what a kill does and who leads.
 */
export abstract class RespawnRules implements ModeRules {
    readonly skipsGas = true;

    protected abstract readonly settings: RespawnSettings;

    /** game clock (s) a hidden player respawns at */
    protected respawnAt = new Map<Player, number>();
    /** game clock (s) until which a player takes no damage */
    protected protectedUntil = new Map<Player, number>();
    protected clock = 0;
    protected phase = ModePhase.Waiting;
    /** Countdown: seconds until the match starts */
    protected countdown = 0;
    /** Waiting: seconds with at least two players in */
    private waited = 0;
    /** something in the standings changed since the last ModeStandingsMsg */
    protected standingsDirty = true;
    private sentSeconds = -1;
    private sentPlayers = -1;
    private lootCleared = false;

    constructor(readonly game: Game) {}

    /** the match runs (the warmup is over) */
    get running(): boolean {
        return this.phase === ModePhase.Running;
    }

    canStart(): boolean {
        return this.running;
    }

    /** the countdown was started by an admin (/skipwaiting): it runs whatever the player count */
    private forced = false;

    /** The warmup is everyone against everyone - teams only count in the match. */
    allowsTeamDamage(): boolean {
        return !this.running;
    }

    skipWaiting(seconds: number): boolean {
        if (this.running) return false;
        this.phase = ModePhase.Countdown;
        this.countdown = seconds;
        this.forced = true;
        this.standingsDirty = true;
        return true;
    }

    /** non-spectators in the game */
    protected activePlayers(): Player[] {
        return this.game.playerBarn.players.filter((p) => !p.spectator && !p.stealth && !p.disconnected);
    }

    private get configMaxPlayers(): number {
        return this.game.config.maxPlayers ?? this.game.map.mapDef.gameMode.maxPlayers;
    }

    /** players the match starts with: settings.minPlayers, fewer when the game (or a
     *  private lobby) has room for fewer */
    get neededPlayers(): number {
        let need = Math.min(this.settings.minPlayers, this.configMaxPlayers);
        if (this.game.isPrivate && this.game.expectedPlayers > 0) need = Math.min(need, this.game.expectedPlayers);
        return Math.max(2, need);
    }

    protected get fullPlayers(): number {
        const max = this.configMaxPlayers;
        return this.game.isPrivate && this.game.expectedPlayers > 0 ? Math.min(max, this.game.expectedPlayers) : max;
    }

    private afkTicker = 0;

    /** the players (not bots) in when the match started */
    startPlayers = 0;

    /** A custom lobby's match counts for the arena progress only full: as many players
     *  at the start as the mode's public game holds (no farming with a friend / an alt). */
    get startedFull(): boolean {
        const def = (MapDefs as Record<string, MapDef>)[this.game.config.mapName];
        return this.startPlayers >= (def?.gameMode.maxPlayers ?? Infinity);
    }

    /** the players in when the countdown last looked (fewer now: it starts over) */
    private countdownPlayers = 0;

    private updateWarmup(dt: number): void {
        const players = this.activePlayers().length;
        if (players !== this.sentPlayers) {
            this.sentPlayers = players;
            this.standingsDirty = true;
        }
        if (this.phase === ModePhase.Waiting) {
            this.waited = players >= 2 ? this.waited + dt : 0;
            const privateTimeout = this.game.isPrivate && players >= 2 && this.waited >= this.settings.privateWait;
            if (players >= this.neededPlayers || privateTimeout) {
                this.phase = ModePhase.Countdown;
                this.countdown = this.countdownFor(players);
                this.countdownPlayers = players;
                this.standingsDirty = true;
            }
            return;
        }
        // Countdown - back to waiting when players leave (a private lobby keeps going, and
        // an admin's /skipwaiting too)
        if (!this.forced && (players < 2 || (!this.game.isPrivate && players < this.neededPlayers))) {
            this.phase = ModePhase.Waiting;
            this.standingsDirty = true;
            return;
        }
        // someone left: the countdown starts over at what fits the players still in
        // (an admin's /skipwaiting keeps its own)
        if (players < this.countdownPlayers && !this.forced) {
            this.countdown = this.countdownFor(players);
            this.standingsDirty = true;
        }
        this.countdownPlayers = players;
        if (players >= this.fullPlayers) this.countdown = Math.min(this.countdown, this.settings.fullCountdown);
        // more players in: the countdown gets shorter (never longer)
        this.countdown = Math.min(this.countdown, this.countdownFor(players));
        this.countdown -= dt;
        if (this.countdown <= 0) this.startMatch();
    }

    /**
     * The warmup is over. Modes put their own start in onMatchStart (new map, reset
     * levels...) - then everyone respawns with the warmup's kills / damage forgotten.
     */
    startMatch(): void {
        this.phase = ModePhase.Running;
        const players = this.activePlayers();
        // grenades / smoke of the warmup
        for (const p of this.game.projectileBarn.projectiles) if (!p.destroyed) p.destroy();
        for (const s of this.game.smokeBarn.smokes) if (!s.destroyed) s.destroy();
        this.game.smokeBarn.emitters.length = 0;
        this.onMatchStart(players);
        for (const p of players) {
            p.kills = 0;
            p.killedIds = [];
            p.assists = 0;
            p.damageDealt = 0;
            p.damageTaken = 0;
            p.shotsFired = 0;
            p.bulletHits = 0;
            p.weaponDamageDealt.clear();
            p.weaponKills.clear();
        }
        for (const p of players) this.respawn(p, true);
        // the match starts: everyone's AFK clock with it (the warmup doesn't count)
        const now = Date.now();
        for (const p of players) p.lastActiveAt = now;
        this.startPlayers = players.filter((p) => !p.bot).length;
        this.standingsDirty = true;
        this.game.playerBarn.killLeaderDirty = true;
    }

    /** The countdown from "enough players" to the start for this many players. */
    protected countdownFor(_players: number): number {
        return this.settings.countdown;
    }

    /** Right when the match starts, before everyone respawns. */
    protected onMatchStart(_players: Player[]): void {}

    /** Loot the map generation put down (buildings) - these modes have no world loot. */
    protected clearLoot(): void {
        for (const loot of this.game.lootBarn.loots) if (!loot.destroyed) loot.destroy();
    }

    // ── deaths ──────────────────────────────────────────────────────────────

    /**
     * Who gets the kill: the kill credit / source - or, for a self-kill (own grenade,
     * barrel...), the last player who hurt the victim (anti kill steal, as in
     * GameModeManager's solo path; then `stolen`).
     */
    protected resolveKiller(victim: Player, params: DamageParams): { killer?: Player; stolen: boolean } {
        const credit = params.killCreditSource ?? params.source;
        if (credit?.__type === ObjectType.Player && credit !== victim) {
            return { killer: credit as Player, stolen: false };
        }
        const last = victim.lastDamagedBy;
        if (last && last !== victim && !last.disconnected) {
            params.killCreditSource = last;
            params.damageType = GameConfig.DamageType.KillSteal;
            return { killer: last, stolen: true };
        }
        return { stolen: false };
    }

    /** The bookkeeping of a kill: counters, kills per weapon, takedown, kill feed. */
    protected countKill(killer: Player, victim: Player, params: DamageParams, countWeapon = true): void {
        killer.kills++;
        killer.killedIds.push(victim.matchDataId);
        // per weapon (the arena challenges) - as Player.kill() does for a normal death
        // (not after a knock: Player.down() counted it for the downer's weapon already)
        const weapon = params.gameSourceType ?? params.mapSourceType ?? "";
        const weaponType = (GameObjectDefs.typeToDefSafe(weapon) as { type?: string } | undefined)?.type;
        if (countWeapon && weapon && (weaponType === "gun" || weaponType === "melee" || weaponType === "throwable")) {
            killer.weaponKills.set(weapon, (killer.weaponKills.get(weapon) ?? 0) + 1);
        }
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
            weapon: weapon || "unknown",
        });
    }

    protected broadcastKill(victim: Player, params: DamageParams, killer: Player | undefined): void {
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
    protected hideUntilRespawn(victim: Player, killer: Player | undefined): void {
        this.respawnAt.set(victim, this.clock + this.settings.respawnDelay);
        const target = this.spectateTarget(victim, killer);
        if (target) victim.spectating = target;
        // spectators watching the victim: on to the killer (else someone else)
        for (const spec of [...victim.spectators]) {
            if (spec.spectator) spec.spectating = this.spectatorTarget(spec, killer);
        }
        victim.shootHold = false;
        victim.moveLeft = victim.moveRight = victim.moveUp = victim.moveDown = false;
        victim.cancelAction();
        victim.setDirty();
        // the team top left: dead until the respawn
        this.statusChanged(victim);
    }

    /** The team's bars top left (and the map dots) get the player's state again. */
    private statusChanged(player: Player): void {
        player.playerStatusDirty = true;
        player.setGroupStatuses();
    }

    /** Whom a dead player watches until the respawn: the killer (Gun Game), else nobody. */
    protected spectateTarget(_victim: Player, killer: Player | undefined): Player | undefined {
        return killer && !killer.disconnected && !this.respawnAt.has(killer) ? killer : undefined;
    }

    /** In the match: whoever did nothing for ARENA_AFK_KICK_S is kicked (the place is
     *  free again - someone can join in). Dead / in the loadout menu doesn't count. */
    private kickAfk(): void {
        const now = Date.now();
        for (const p of this.game.playerBarn.players) {
            if (p.spectator || p.bot || p.disconnected || p.dead) continue;
            // waiting to respawn / picking a loadout: no inputs to send - starts over after
            if (this.respawnAt.has(p)) {
                p.lastActiveAt = now;
                continue;
            }
            if (now - p.lastActiveAt < ARENA_AFK_KICK_S * 1000) continue;
            this.game.logger.info(`AFK kick: ${p.name} (${p.userId ?? "guest"})`);
            this.game.closeSocket(p.socketId, "kicked_afk");
            // (the socket close does the rest; in tests there is none)
            p.lastActiveAt = now;
        }
    }

    /**
     * Whom a (real) spectator watches next: the killer if one is about, else any other
     * player in the game right now (not one waiting to respawn) - undefined: nobody.
     */
    protected spectatorTarget(spec: Player, killer: Player | undefined): Player | undefined {
        const playing = (p: Player) => !p.spectator && !p.stealth && !p.disconnected && !p.dead && !this.respawnAt.has(p);
        if (killer && killer !== spec && playing(killer)) return killer;
        const others = this.game.playerBarn.livingPlayers.filter((p) => p !== spec && playing(p));
        if (others.length) return others[Math.floor(Math.random() * others.length)];
        // nobody in the game right now (all waiting to respawn / in the loadout menu):
        // still one of them - a spectator watching themselves has no HUD to show
        const anyone = this.game.playerBarn.players.filter((p) => p !== spec && !p.spectator && !p.stealth && !p.disconnected);
        return anyone.length ? anyone[Math.floor(Math.random() * anyone.length)] : undefined;
    }

    /** Waiting to respawn. */
    isRespawning(player: Player): boolean {
        return this.respawnAt.has(player);
    }

    // ── spawning ────────────────────────────────────────────────────────────

    /** Where a player respawns; `spread`: the match start (anywhere their side may). */
    abstract spawnPos(player: Player, spread?: boolean): Vec2;
    /** What a player has on every (re)spawn - armor, weapons, heals. */
    protected abstract giveSpawnItems(player: Player): void;

    protected respawn(player: Player, spread = false): void {
        this.respawnAt.delete(player);
        player.spectating = undefined;
        this.protectedUntil.set(player, this.clock + this.settings.spawnProtection);
        v2.set(player.pos, this.spawnPos(player, spread));
        player.layer = 0;
        // up again (a knocked player who died, or one still knocked at the match start)
        player.downed = false;
        player.downedBy = undefined;
        player.downedCount = 0;
        player.cancelAction();
        player.health = 100;
        player.boost = 0;
        player.lastDamagedBy = undefined;
        this.game.grid.updateObject(player);
        this.giveSpawnItems(player);
        this.statusChanged(player);
    }

    /** Every arena mode: out of combat (no shot, no enemy damage dealt / taken for a
     *  while) the adrenaline heals faster. */
    boostHealFactor(player: Player): number {
        const now = Date.now();
        const last = Math.max(player.lastShotAt, player.lastDamageDealtTime ?? 0, player.lastEnemyDamageTakenTime ?? 0);
        return now - last >= ARENA_OUT_OF_COMBAT_S * 1000 ? ARENA_OUT_OF_COMBAT_HEAL_MULT : 1;
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

    // ── every tick ──────────────────────────────────────────────────────────

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
            // the watched player left / is gone too: someone else (or nobody)
            const watched = player.spectating;
            if (watched && (watched.disconnected || this.respawnAt.has(watched))) {
                player.spectating = this.spectateTarget(player, undefined);
            }
            if (at <= this.clock && this.mayRespawn(player)) this.respawn(player);
        }
        this.afkTicker -= dt;
        if (this.running && this.afkTicker <= 0) {
            this.afkTicker = 1;
            this.kickAfk();
        }
        // spectators whose player is gone (left, waiting to respawn) or who watch nobody yet
        for (const spec of this.game.playerBarn.players) {
            if (!spec.spectator || spec.disconnected) continue;
            const watched = spec.spectating;
            if (watched && !watched.disconnected && !this.respawnAt.has(watched)) continue;
            const next = this.spectatorTarget(spec, undefined);
            // (watching one waiting to respawn: only a better one replaces them)
            if (next && next !== watched && (!watched || watched.disconnected || !this.respawnAt.has(next))) spec.spectating = next;
        }
        this.updateMode(dt);
        const seconds = this.phaseSeconds();
        if (this.standingsDirty || seconds !== this.sentSeconds) {
            this.standingsDirty = false;
            this.sentSeconds = seconds;
            const msg = new net.ModeStandingsMsg();
            msg.phase = this.phase;
            msg.players = Math.min(255, this.activePlayers().length);
            msg.needed = Math.min(255, this.neededPlayers);
            msg.max = Math.min(255, this.fullPlayers);
            msg.seconds = seconds;
            this.fillStandings(msg);
            this.game.broadcastMsg(net.MsgType.ModeStandings, msg);
        }
    }

    /** Whether a player whose respawn time is up may respawn now (a mode may hold them back). */
    protected mayRespawn(_player: Player): boolean {
        return true;
    }

    /** The mode's own per-tick logic (after the respawns). */
    protected updateMode(_dt: number): void {}

    /** The mode's part of the ModeStandingsMsg (entries, team scores, zones...). */
    protected abstract fillStandings(msg: net.ModeStandingsMsg): void;

    /** Countdown: seconds to the start; running: seconds left on the clock. */
    protected phaseSeconds(): number {
        if (this.phase === ModePhase.Countdown) return Math.max(0, Math.ceil(this.countdown));
        if (this.phase === ModePhase.Running) {
            return Math.max(0, Math.ceil(this.settings.timeLimit - this.game.startedTime));
        }
        return 0;
    }

    /** The match clock ran out. */
    protected get timeUp(): boolean {
        return this.game.started && this.running && this.game.startedTime >= this.settings.timeLimit;
    }

    abstract checkGameEnd(): boolean;
}
