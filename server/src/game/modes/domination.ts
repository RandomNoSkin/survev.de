import {
    ARENA_BOOST_RESIST,
    ARENA_GEAR,
    ARENA_JUGGERNAUT_M249_KILLS,
    ARENA_REVIVE_HEALTH,
    ARENA_XP,
} from "../../../../shared/defs/modes/arenaDefs";
import {
    ARENA_AIRDROP_TIME_FACTOR,
    ARENA_DEFAULT_STREAKS,
    ARENA_JUGGERNAUTS,
    ARENA_STREAK_ITEMS,
    activeStreakTiers,
    ARENA_STREAKS,
    ARENA_SUPPLY_DROP_LOOT,
    type ArenaStreakKind,
    type ArenaStreakTier,
} from "../../../../shared/defs/modes/arenaStreakDefs";
import * as netMsgs from "../../../../shared/net/net";
import { ARENA_FAST_REVIVE_S, ARENA_INERT_PERKS, ARENA_PERK_DEFS } from "../../../../shared/defs/modes/arenaPerkDefs";
import {
    DOMINATION_ABANDON_S,
    DOMINATION_ASSIST_MIN_DAMAGE,
    DOMINATION_ASSIST_WINDOW_S,
    DOMINATION_CAPTURE_S,
    DOMINATION_COUNTDOWN_S,
    DOMINATION_COUNTDOWNS,
    DOMINATION_COVER_CHECK_RAD,
    DOMINATION_COVER_MIN,
    DOMINATION_FULL_COUNTDOWN_S,
    DOMINATION_GROUP_SPEED,
    DOMINATION_LOADOUT_SWAP_S,
    DOMINATION_MENU_MAX_S,
    DOMINATION_MIN_PLAYERS,
    DOMINATION_NEUTRALIZE_S,
    DOMINATION_POINT_INTERVAL_S,
    DOMINATION_PRIVATE_WAIT_S,
    DOMINATION_RESPAWN_DELAY_S,
    DOMINATION_SCORE_LIMIT,
    DOMINATION_SPAWN_DEPTH,
    DOMINATION_START_CLUSTER_RAD,
    dominationMapScale,
    DOMINATION_SPAWN_PROTECTION_S,
    DOMINATION_SPAWN_SAFE_DIST,
    DOMINATION_TEAM_SIZE,
    DOMINATION_TIME_LIMIT_S,
    DOMINATION_ZONE_MAX_MULTIPLIER,
    DOMINATION_ZONE_RAD,
    DOMINATION_ZONES,
} from "../../../../shared/defs/modes/dominationDefs";
import { GunDefs } from "../../../../shared/defs/gameObjects/gunDefs";
import { GameConfig, type InventoryItem } from "../../../../shared/gameConfig";
import { ArenaLoadoutAction } from "../../../../shared/net/arenaLoadoutSelectMsg";
import type * as net from "../../../../shared/net/net";
import { ObjectType } from "../../../../shared/net/objectSerializeFns";
import { ARENA_ALSO_SECONDARY, ARENA_DEFAULT_LOADOUT, ARENA_PRESET_LOADOUTS, arenaSlotOf } from "../../../../shared/utils/arena";
import { collider } from "../../../../shared/utils/collider";
import { util } from "../../../../shared/utils/util";
import { GameObjectDefs, MapObjectDefs } from "../../../../shared/defs/register";
import type { ObstacleDef } from "../../../../shared/defs/mapObjectsTyping";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
import type { Group } from "../group";
import type { DamageParams } from "../objects/gameObject";
import type { Loot } from "../objects/loot";
import type { Obstacle } from "../objects/obstacle";
import type { Player } from "../objects/player";
import { RespawnRules } from "./respawnRules";

/** The two sides of the map: 1 starts at the low end of the axis, 2 at the high end. */
type Side = 1 | 2;

interface Zone {
    name: string;
    pos: Vec2;
    rad: number;
    /** holding side, 0: nobody */
    owner: Side | 0;
    /** neutral zone: the side taking it; held zone: 0 */
    capTeam: Side | 0;
    /** neutral: how far capTeam is; held: how much the owner still holds (1 = all) */
    progress: number;
    contested: boolean;
    /** enemies of the owner are in it: no points */
    threatened: boolean;
    /** seconds held without a break towards the next point */
    pointTimer: number;
    /** the holder's point multiplier (holders standing in it) */
    mult: number;
}

/** Cover that holds: indestructible, or plated (only armor piercing rounds break it). */
export function isHardCover(type: string): boolean {
    const def = MapObjectDefs.typeToDefSafe(type) as ObstacleDef | undefined;
    return !!def && (!def.destructible || !!def.stonePlated || !!def.armorPlated);
}

/**
 * Two teams out of parties of these sizes: for each party 0 or 1, every team at most
 * `max` players, the two as even as possible (then as few moves as possible: the first
 * party on team 0). Undefined when they don't fit.
 */
export function splitIntoTeams(sizes: number[], max = DOMINATION_TEAM_SIZE): number[] | undefined {
    const total = sizes.reduce((a, b) => a + b, 0);
    let best: number[] | undefined;
    let bestDiff = Infinity;
    // (at most 12 players: a few thousand combinations at most)
    const n = Math.min(sizes.length, 16);
    for (let mask = 0; mask < 1 << n; mask++) {
        if (mask & 1) continue; // the first party on team 0 (mirrors are the same split)
        let a = 0;
        for (let i = 0; i < n; i++) if (mask & (1 << i)) a += sizes[i];
        const b = total - a;
        if (a > max || b > max) continue;
        const diff = Math.abs(a - b);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = sizes.map((_, i) => (i < n && mask & (1 << i) ? 1 : 0));
        }
    }
    return best;
}

/** Throwables of the loadout's kind on every spawn. */
const ARENA_THROWABLES = 3;
/** How many candidate spots a respawn looks at (the one farthest from enemies wins). */
const SPAWN_CANDIDATES = 8;
/** How often the zones are sent while they change (s) - often enough for a smooth ring. */
const ZONE_SEND_INTERVAL = 0.1;

/**
 * Domination (GameMode.Domination): two teams - groups of up to 6, like squads (names,
 * colors, the team panel) - and three zones A / B / C on the line between the team
 * sides. Only one team in a zone takes it - an enemy zone first back to neutral - and
 * every held zone gives its team a point every few seconds while no enemy is in it
 * (dominationDefs.ts). First to the score limit, else the higher score when the clock
 * runs out.
 *
 * Players spawn on their side with their arena loadout (picked from on every respawn),
 * the same armor and heals for everyone; nothing lies on the map but what dead players
 * drop, and a picked up gun replaces the one of its kind (main gun / pistol).
 */
export class Domination extends RespawnRules {
    readonly noWorldLoot = true;
    readonly lootKeepsClip = true;
    readonly calledAirdropTimeFactor = ARENA_AIRDROP_TIME_FACTOR;
    readonly inertPerks = ARENA_INERT_PERKS;
    readonly singleThrowable = true;
    readonly seededMap = true;
    readonly groupSize = DOMINATION_TEAM_SIZE;

    protected readonly settings = {
        respawnDelay: DOMINATION_RESPAWN_DELAY_S,
        spawnProtection: DOMINATION_SPAWN_PROTECTION_S,
        timeLimit: DOMINATION_TIME_LIMIT_S,
        minPlayers: DOMINATION_MIN_PLAYERS,
        countdown: DOMINATION_COUNTDOWN_S,
        fullCountdown: DOMINATION_FULL_COUNTDOWN_S,
        privateWait: DOMINATION_PRIVATE_WAIT_S,
    };

    zones: Zone[] = [];
    /** side 1 / side 2 */
    scores = [0, 0];
    private winnerSide: Side | 0 = 0;
    /** the sides that had players in this match (a side all gone: the other wins) */
    private sidePlayed = [false, false];
    /** since when (match clock) a side that played has nobody connected, -1: someone's there */
    private sideGoneSince = [-1, -1];
    /** group (teamId) → side, in the order the teams came in (a lobby's first team: side 1) */
    private sides = new Map<number, Side>();
    /** arena XP earned this match */
    private xp = new Map<Player, number>();
    private ownMelee = new Map<Player, string>();
    private zoneSendTicker = 0;
    private zonesChanged = true;
    /** kill streaks: kills in a row, the earned bonus not fired yet, the fired one that runs */
    private streak = new Map<Player, number>();
    private streakReady = new Map<Player, { tier: ArenaStreakTier; item: string }>();
    private streakActive = new Map<Player, Map<ArenaStreakKind, string>>();
    /** what the client last got (KillstreakMsg only on a change) */
    private streakSent = new Map<Player, string>();
    /** changed, the KillstreakMsg still to send (flushStreaks, once a tick) */
    private streakDirty = new Set<Player>();
    /** flares fired: who called which crate where (to fill the crate when it's opened) */
    private calledCrates: Array<{ player: Player; pos: Vec2; supply: boolean }> = [];
    /** a soda / pill's damage resistance: until when (game clock), how much */
    private resist = new Map<Player, { until: number; reduction: number }>();
    /** what each player dropped on their last death (cleared on the next one) */
    private drops = new Map<Player, Loot[]>();
    /** in the loadout menu - not respawning before "Enter game" (or DOMINATION_MENU_MAX_S) */
    private inMenu = new Map<Player, number>();
    /** when each player last got their items, and their shots then (see onLoadoutSelect) */
    private spawned = new Map<Player, { at: number; shots: number }>();
    /** which way the sides lie (x or y), drawn per match */
    private readonly horizontal = Math.random() < 0.5;

    /** the match start only: where each team spawns in a bunch (see onMatchStart) */
    private startSpots = new Map<Side, Vec2>();

    startMatch(): void {
        super.startMatch();
        this.startSpots.clear();
    }

    // ── teams ───────────────────────────────────────────────────────────────

    /** The player's side; new teams take the side with fewer teams on it. */
    sideOf(player: Player): Side {
        const known = this.sides.get(player.teamId);
        if (known) return known;
        const count = (s: Side) => [...this.sides.values()].filter((v) => v === s).length;
        const side: Side = count(1) <= count(2) ? 1 : 2;
        this.sides.set(player.teamId, side);
        return side;
    }

    /**
     * Where a joining player (or party) goes: two groups - the two sides - and every new
     * one into the side with fewer players (a party stays together). Only when neither
     * has room a new group.
     */
    pickGroup(groups: Group[], playerCount: number): Group | undefined {
        // the warmup: every party (and solo) on its own - the teams are built at the start
        if (!this.running) return undefined;
        const sides = groups.filter((g) => !g.isSpectatorGroup);
        if (sides.length < 2) return undefined;
        // players in it (not those who left) plus the slots still reserved for a party on its way
        const load = (g: Group) => g.players.filter((p) => !p.disconnected).length + Math.max(0, g.reservedSlots - g.players.length);
        return sides
            .filter((g) => load(g) + playerCount <= DOMINATION_TEAM_SIZE)
            .sort((a, b) => load(a) - load(b))[0];
    }

    /** Players in a group (not those who left) plus the slots still reserved for a party on its way. */
    private load(g: Group): number {
        return g.players.filter((p) => !p.disconnected && !p.spectator).length + Math.max(0, g.reservedSlots - g.players.length);
    }

    /** The groups that play (not staff spectators, not emptied ones). */
    private playingGroups(): Group[] {
        return this.game.playerBarn.groups.filter((g) => !g.isSpectatorGroup && g.players.some((p) => !p.spectator));
    }

    /**
     * The biggest party that can still join together. The warmup: one that can still be
     * packed with all parties in into two teams (see buildTeams); the match: room on one side.
     */
    partyRoom(): number {
        const groups = this.playingGroups();
        if (!this.running) {
            const sizes = groups.map((g) => this.load(g));
            for (let n = DOMINATION_TEAM_SIZE; n >= 1; n--) if (splitIntoTeams([...sizes, n])) return n;
            return 0;
        }
        if (groups.length < 2) return DOMINATION_TEAM_SIZE;
        return Math.max(0, ...groups.map((g) => DOMINATION_TEAM_SIZE - this.load(g)));
    }

    /**
     * The warmup is over: the two teams out of everyone in. Every party (a warmup group)
     * stays together, the teams as even as can be and at most TEAM_SIZE each - e.g. six
     * solos against a party of six. The two groups become the teams (their teamIds); the
     * clients get everyone's new team with the player infos sent again.
     */
    buildTeams(): void {
        const barn = this.game.playerBarn;
        const parties = this.playingGroups();
        const split = splitIntoTeams(parties.map((g) => this.load(g)))
            // (too many for two full teams - shouldn't happen, matchmaking checks partyRoom)
            ?? splitIntoTeams(parties.map((g) => this.load(g)), Infinity)!;
        const teams: Group[] = [];
        for (const side of [0, 1]) {
            const members = parties.filter((_, i) => split[i] === side);
            if (!members.length) continue;
            // the biggest party's group takes in the others
            members.sort((a, b) => b.players.length - a.players.length);
            const team = members[0];
            for (const party of members.slice(1)) {
                for (const p of [...party.players]) {
                    party.removePlayer(p);
                    team.addPlayer(p);
                }
                // late party members joining with the old group's hash end up in the team
                for (const [hash, g] of barn.groupsByHash) if (g === party) barn.groupsByHash.set(hash, team);
                util.removeFrom(barn.groups, party);
                barn.groupIdAllocator.give(party.id);
            }
            // in id order: the clients map the team's statuses (knocked, health) by
            // index onto their own id-sorted list - merged parties out of order put
            // each teammate's state on someone else's bar top left
            team.players.sort((a, b) => a.__id - b.__id);
            for (const p of team.players) p.teamId = team.id;
            team.reservedSlots = team.players.length;
            team.autoFill = true;
            teams.push(team);
        }
        this.sides = new Map(teams.map((t, i) => [t.id, (i + 1) as Side]));
        // everyone's team and group to every client again
        for (const p of barn.players) {
            if (!barn.newPlayers.includes(p)) barn.newPlayers.push(p);
            if (p.group) p.setGroupStatuses();
        }
        barn.livingPlayers.sort((a, b) => a.teamId - b.teamId);
        this.standingsDirty = true;
    }

    /** The teamId (group) of a side, 0 if nobody plays it. */
    private teamIdOf(side: Side | 0): number {
        if (!side) return 0;
        for (const [teamId, s] of this.sides) if (s === side) return teamId;
        return 0;
    }

    // ── the map's layout ────────────────────────────────────────────────────

    /** The point `t` of the way from side 1's edge to side 2's, `across` the other way. */
    pointAt(t: number, across = 0.5): Vec2 {
        const { width, height } = this.game.map;
        return this.horizontal ? v2.create(t * width, across * height) : v2.create(across * width, t * height);
    }

    /** How far along the axis (0 = side 1's edge, 1 = side 2's) a point lies, and across it. */
    private axisOf(pos: Vec2): { t: number; across: number } {
        const { width, height } = this.game.map;
        return this.horizontal ? { t: pos.x / width, across: pos.y / height } : { t: pos.y / height, across: pos.x / width };
    }

    /** The point mirrored through the map's center - the other side's equal. */
    private mirror(pos: Vec2): Vec2 {
        return v2.create(this.game.map.width - pos.x, this.game.map.height - pos.y);
    }

    /** A ground floor building near `pos` (within `maxDist`) to put a zone into, if any. */
    private buildingNear(pos: Vec2, maxDist: number, taken: Vec2[]): Vec2 | undefined {
        let best: Vec2 | undefined;
        let bestDist = maxDist;
        for (const b of this.game.map.buildings) {
            if (b.layer !== 0 || b.parentStructure) continue;
            const d = v2.distance(b.pos, pos);
            if (d < bestDist && taken.every((t) => v2.distance(t, b.pos) > DOMINATION_ZONE_RAD * 4)) {
                best = b.pos;
                bestDist = d;
            }
        }
        return best ? v2.copy(best) : undefined;
    }

    /**
     * Random zones, fair for both sides: A somewhere in side 1's part, C its mirror
     * through the center (as far from side 2 as A is from side 1), B around the center.
     * A building close by takes a zone (players love fighting over a house).
     */
    private layoutZones(): Vec2[] {
        const rand = (a: number, b: number) => a + Math.random() * (b - a);
        const size = Math.min(this.game.map.width, this.game.map.height);
        // a triangle: A and its mirror C near the axis through the center (the mirror
        // flips them across, so only there are both far from B), B on the middle line
        // off to one side - as far from both team sides, and not in a row with A and C
        const bAcross = 0.5 + (Math.random() < 0.5 ? -1 : 1) * rand(0.2, 0.3);
        const aAcross = 0.5 + rand(-0.07, 0.07);
        const roughB = this.pointAt(0.5, bAcross);
        const roughA = this.pointAt(rand(0.16, 0.3), aAcross);
        const a = this.buildingNear(roughA, 18, []) ?? roughA;
        // C: A's mirror - or a building right by it (still about as fair)
        const c = this.buildingNear(this.mirror(a), 12, [a]) ?? this.mirror(a);
        // B: a building on the middle line, if one is close (keeps it fair)
        const b = this.buildingNear(roughB, 14, [a, c]) ?? roughB;
        // keep them apart (a building pick can pull them together)
        const apart = (p: Vec2, q: Vec2) => v2.distance(p, q) >= size * 0.28;
        if (!apart(a, b) || !apart(b, c)) return [roughA, roughB, this.mirror(roughA)].sort((p, q) => this.axisOf(p).t - this.axisOf(q).t);
        // A is side 1's (the low end), C side 2's
        return this.axisOf(a).t <= this.axisOf(c).t ? [a, b, c] : [c, b, a];
    }

    /** Hard cover (indestructible obstacles, walls) near a zone, else some stones. */
    private ensureCover(pos: Vec2): void {
        const map = this.game.map;
        const area = collider.createCircle(pos, DOMINATION_COVER_CHECK_RAD);
        let cover = 0;
        // (a building's walls are indestructible obstacles too; plated ones - the stones
        // below - only break to armor piercing rounds)
        for (const obj of this.game.grid.intersectCollider(area)) {
            if (obj.__type !== ObjectType.Obstacle || obj.dead || !obj.collidable || obj.layer !== 0) continue;
            if (!isHardCover(obj.type) || v2.distance(obj.pos, pos) > DOMINATION_COVER_CHECK_RAD) continue;
            cover++;
        }
        if (cover >= DOMINATION_COVER_MIN) return;
        // three pieces spread around it - mostly sandbags, some stones; crowded spots
        // (trees, walls) get more tries
        const start = Math.random() * Math.PI * 2;
        for (let i = 0, placed = 0; i < 40 && placed < 3; i++) {
            const angle = i < 3 ? start + (i * Math.PI * 2) / 3 : Math.random() * Math.PI * 2;
            const dist = DOMINATION_ZONE_RAD * (i < 3 ? 0.6 : 0.35 + Math.random() * 0.9);
            const at = v2.add(pos, v2.create(Math.cos(angle) * dist, Math.sin(angle) * dist));
            const roll = Math.random();
            const type = roll < 0.55 ? "sandbags_01" : roll < 0.75 ? "sandbags_02" : "stone_01_indestructible";
            if (!MapObjectDefs.typeToDefSafe(type)) continue;
            // sandbags lie across the way to the zone (their long side is along x at ori 0)
            const ori = Math.abs(Math.cos(angle)) > Math.abs(Math.sin(angle)) ? 1 : 0;
            if (!map.canSpawn(type, at, ori, 1)) continue;
            map.genObstacle(type, at, 0, ori, 1);
            placed++;
        }
    }

    private ensureZones(): void {
        if (this.zones.length) return;
        const spots = this.layoutZones();
        this.zones = DOMINATION_ZONES.map((z, i) => ({
            name: z.name,
            pos: spots[i],
            rad: DOMINATION_ZONE_RAD,
            owner: 0,
            capTeam: 0,
            progress: 0,
            contested: false,
            threatened: false,
            pointTimer: 0,
            mult: 1,
        }));
        for (const z of this.zones) this.ensureCover(z.pos);
    }

    // ── players ─────────────────────────────────────────────────────────────

    teamScore(side: Side): number {
        return Math.floor(this.scores[side - 1] ?? 0);
    }

    private addXp(player: Player, amount: number): void {
        this.xp.set(player, (this.xp.get(player) ?? 0) + amount);
        this.standingsDirty = true;
    }

    arenaXp(player: Player): number {
        return this.xp.get(player) ?? 0;
    }

    onJoin(player: Player): void {
        this.ensureZones();
        this.sideOf(player);
        // the HUD's kill streak box: what's next for this player (their tiers)
        this.streakDirty.add(player);
        this.xp.set(player, this.xp.get(player) ?? 0);
        this.ownMelee.set(player, player.weapons[GameConfig.WeaponSlot.Melee].type || "fists");
        // (where a missing loadout list shows up first: 1 = the join token had none)
        this.game.logger.info(`Domination: ${player.name} joined with ${player.arenaLoadouts.length} arena loadout(s)`);
        if (!player.arenaLoadouts.length) player.arenaLoadouts = ARENA_PRESET_LOADOUTS;
        // on top of the perk slot (the kill streak picks): Broken Arrow
        if (player.arenaStreaks.brokenArrow && !player.hasPerk("broken_arrow")) player.addPerk("broken_arrow", false);
        v2.set(player.pos, this.spawnPos(player));
        this.game.grid.updateObject(player);
        this.giveSpawnItems(player);
        // in the loadout menu until "Enter game": not in the game yet (hidden, no inputs)
        this.respawnAt.set(player, this.clock);
        this.inMenu.set(player, this.clock);
        this.standingsDirty = true;
    }

    /** In the loadout menu: wait for "Enter game", at most DOMINATION_MENU_MAX_S. */
    protected mayRespawn(player: Player): boolean {
        const since = this.inMenu.get(player);
        if (since === undefined) return true;
        if (this.clock - since < DOMINATION_MENU_MAX_S) return false;
        this.inMenu.delete(player);
        return true;
    }

    protected onMatchStart(players: Player[]): void {
        // the teams: only now (the warmup is everyone against everyone)
        this.buildTeams();
        // the map as it was: what the warmup broke stands again, what it dropped is gone
        // (the same seed - the same map, the zones where they were) - sized for the
        // players in: fewer than a full 6v6, a smaller map (and new zones on it)
        const scale = dominationMapScale(players.length);
        const resized = Math.abs(scale - this.game.map.sizeScale) > 0.001;
        this.game.map.regenerate(this.game.map.seed, resized ? scale : undefined);
        this.clearLoot();
        if (resized) {
            this.zones = [];
            this.ensureZones();
        } else {
            for (const z of this.zones) this.ensureCover(z.pos);
        }
        // the first spawn: each team in a tight bunch around one spot on its side
        this.startSpots.clear();
        for (const side of [1, 2] as Side[]) {
            this.startSpots.set(side, this.game.map.getRandomSpawnPos(
                () => this.pointAt(side === 2 ? 1 - DOMINATION_SPAWN_DEPTH / 2 : DOMINATION_SPAWN_DEPTH / 2, 0.4 + Math.random() * 0.2),
                false,
            ));
        }
        this.scores = [0, 0];
        this.winnerSide = 0;
        for (const z of this.zones) {
            Object.assign(z, { owner: 0, capTeam: 0, progress: 0, contested: false, threatened: false, pointTimer: 0, mult: 1 });
        }
        for (const p of players) this.xp.set(p, 0);
        this.zonesChanged = true;
    }

    /** The arena loadout picked last (see ArenaLoadoutSelectMsg), the same gear for all. */
    protected giveSpawnItems(player: Player): void {
        // spawning: out of the loadout menu
        this.inMenu.delete(player);
        const loadout = player.arenaLoadouts[player.arenaLoadoutIdx] ?? player.arenaLoadouts[0] ?? ARENA_DEFAULT_LOADOUT;
        player.helmet = ARENA_GEAR.helmet;
        player.chest = ARENA_PERK_DEFS[loadout.perk]?.chest ?? ARENA_GEAR.chest;
        player.backpack = ARENA_GEAR.backpack;
        player.invManager.wipeInventory();
        for (const [item, count] of Object.entries(ARENA_GEAR.heals)) player.invManager.set(item as InventoryItem, count);
        for (const scope of ARENA_GEAR.scopes) player.invManager.set(scope as InventoryItem, 1);
        player.scope = ARENA_GEAR.scopes[ARENA_GEAR.scopes.length - 1];

        // the perk slot first (Firepower decides how full the magazines are): one
        // droppable perk (picking up another swaps it)
        for (const perk of [...player.perks]) if (perk.droppable) player.removePerk(perk.type);
        if (loadout.perk) player.addPerk(loadout.perk, true);

        const wm = player.weaponManager;
        for (const [slot, type] of [
            [GameConfig.WeaponSlot.Primary, loadout.primary],
            [GameConfig.WeaponSlot.Secondary, loadout.pistol],
        ] as const) {
            const gun = GunDefs[type];
            wm.setWeapon(slot, gun ? type : "", gun ? wm.getAmmoStats(gun).maxClip : 0);
            // a backpack full of its ammo
            if (gun && player.invManager.isValid(gun.ammo)) {
                player.invManager.set(gun.ammo, player.invManager.getMaxCapacity(gun.ammo));
            }
        }
        wm.setWeapon(GameConfig.WeaponSlot.Melee, this.ownMelee.get(player) ?? "fists", 0);
        if (player.invManager.isValid(loadout.throwable)) {
            player.invManager.set(loadout.throwable, Math.min(ARENA_THROWABLES, player.invManager.getMaxCapacity(loadout.throwable)));
            wm.setWeapon(GameConfig.WeaponSlot.Throwable, loadout.throwable, 0);
        } else {
            wm.setWeapon(GameConfig.WeaponSlot.Throwable, "", 0);
        }
        wm.setCurWeapIndex(GameConfig.WeaponSlot.Primary, true, true, true, false);

        player.boost = 100;
        this.resist.delete(player);
        player.damageHistory.length = 0;
        this.spawned.set(player, { at: this.clock, shots: player.shotsFired });
        player.inventoryDirty = true;
        player.weapsDirty = true;
        player.setDirty();
    }

    /**
     * Another loadout picked: right away if the player hasn't really played since the
     * spawn (the warmup, or just spawned - nothing fired, no damage taken), else on the
     * next spawn.
     */
    onLoadoutSelect(player: Player, action: number): void {
        if (action === ArenaLoadoutAction.Hold) {
            // opened the menu while dead: wait for "Enter game"
            if (this.respawnAt.has(player) && !this.inMenu.has(player)) this.inMenu.set(player, this.clock);
            return;
        }
        if (action === ArenaLoadoutAction.Deploy) {
            // out of the menu: spawn once the respawn time is over (right away when joining)
            this.inMenu.delete(player);
            return;
        }
        if (this.respawnAt.has(player)) return;
        const spawned = this.spawned.get(player);
        const fresh = !!spawned
            && this.clock - spawned.at <= DOMINATION_LOADOUT_SWAP_S
            && player.shotsFired === spawned.shots
            && player.damageHistory.length === 0;
        if (!this.running || fresh) this.giveSpawnItems(player);
    }

    /**
     * Where a player (re)spawns: with no enemies around (and at the match start) on the
     * own side; else where no enemy is close - the farther from them the better, near
     * teammates if possible.
     */
    spawnPos(player: Player, spread = false): Vec2 {
        const map = this.game.map;
        const side = this.sideOf(player);
        const band = () => {
            const depth = Math.random() * DOMINATION_SPAWN_DEPTH;
            return this.pointAt(side === 2 ? 1 - depth : depth, 0.12 + Math.random() * 0.76);
        };
        const live = this.game.playerBarn.livingPlayers.filter((p) => p !== player && !p.disconnected && !this.respawnAt.has(p));
        const enemies = live.filter((p) => p.teamId !== player.teamId);
        const mates = live.filter((p) => p.teamId === player.teamId);
        const start = spread ? this.startSpots.get(side) : undefined;
        if (start) {
            // the match start: close around the team's spot (a bit wider each failed try)
            let tries = 0;
            const near = () => {
                const rad = DOMINATION_START_CLUSTER_RAD + Math.min(20, tries++ * 0.05);
                const angle = Math.random() * Math.PI * 2;
                const dist = Math.sqrt(Math.random()) * rad;
                return v2.add(start, v2.create(Math.cos(angle) * dist, Math.sin(angle) * dist));
            };
            return map.getRandomSpawnPos(near, false, player.group);
        }
        if (spread || !enemies.length) return map.getRandomSpawnPos(band, false, player.group);

        const anywhere = () => v2.create(
            map.shoreInset + 8 + Math.random() * (map.width - 2 * (map.shoreInset + 8)),
            map.shoreInset + 8 + Math.random() * (map.height - 2 * (map.shoreInset + 8)),
        );
        let best: Vec2 | undefined;
        let bestScore = -Infinity;
        for (let i = 0; i < SPAWN_CANDIDATES * 2; i++) {
            // half the candidates on the own side, half anywhere
            const pos = map.getRandomSpawnPos(i % 2 ? anywhere : band, false, player.group);
            let nearestEnemy = Infinity;
            for (const e of enemies) nearestEnemy = Math.min(nearestEnemy, v2.distance(e.pos, pos));
            let nearestMate = Infinity;
            for (const m of mates) nearestMate = Math.min(nearestMate, v2.distance(m.pos, pos));
            // safe first (no enemy close), then far from them, a bit for being near mates
            const score = (nearestEnemy >= DOMINATION_SPAWN_SAFE_DIST ? 1000 : 0)
                + Math.min(nearestEnemy, 150)
                + (nearestMate < 40 ? 20 : 0);
            if (score > bestScore) {
                best = pos;
                bestScore = score;
            }
        }
        return best ?? map.getSpawnPos(player.group);
    }

    // ── deaths ──────────────────────────────────────────────────────────────

    handleDeath(victim: Player, params: DamageParams): boolean {
        if (this.respawnAt.has(victim)) return true;
        // knocked first while a teammate (or the own Revivify) can get them up again -
        // only in the match (the warmup is everyone against everyone)
        if (this.running && !victim.downed && this.canBeRevived(victim)) {
            victim.down(params);
            return true;
        }
        // dying knocked (finished, bled out, gave up): the one who knocked them gets the kill
        const knocked = victim.downed;
        if (knocked) {
            if (victim.downedBy && victim.downedBy !== victim) params.killCreditSource = victim.downedBy;
            victim.downed = false;
            victim.downedBy = undefined;
        }
        const { killer } = this.resolveKiller(victim, params);
        const enemyKill = killer && killer.teamId !== victim.teamId ? killer : undefined;
        if (this.running && enemyKill) {
            this.countKill(enemyKill, victim, params, !knocked);
            // an air strike's bombs: kills of the strobe that called them (Broken Arrow's challenge)
            if (params.damageType === GameConfig.DamageType.Airstrike) {
                enemyKill.weaponKills.set("strobe", (enemyKill.weaponKills.get("strobe") ?? 0) + 1);
            }
            this.onStreakKill(enemyKill);
            this.addXp(enemyKill, ARENA_XP.kill);
            for (const assister of this.assistersOf(victim, enemyKill)) {
                assister.assists++;
                this.addXp(assister, ARENA_XP.assist);
            }
        }
        this.endStreakActive(victim);
        this.dropLoadout(victim, enemyKill);
        this.streak.set(victim, 0);
        this.streakDirty.add(victim);
        this.broadcastKill(victim, params, enemyKill);
        this.hideUntilRespawn(victim, enemyKill);
        return true;
    }

    /** Someone who could revive them: a teammate up and in the game, or Revivify. */
    private canBeRevived(victim: Player): boolean {
        if (victim.hasPerk("self_revive")) return true;
        return this.game.playerBarn.livingPlayers.some(
            (p) => p !== victim && p.teamId === victim.teamId && !p.downed && !p.disconnected && !this.respawnAt.has(p),
        );
    }

    /** Knocked: give up and respawn (the kill goes to the one who knocked them). */
    giveUp(player: Player): boolean {
        if (!player.downed || this.respawnAt.has(player)) return false;
        this.handleDeath(player, {
            damageType: GameConfig.DamageType.Bleeding,
            source: player.downedBy,
            dir: v2.create(1, 0),
        });
        return true;
    }

    /** Back up: half health and a pill's damage resistance. */
    onRevived(player: Player): void {
        player.health = ARENA_REVIVE_HEALTH;
        this.onBoostUsed(player, "painkiller");
    }

    /** Revivify: medical items take half as long. */
    useTimeFactor(player: Player): number {
        let factor = 1;
        for (const perk of player.perks) factor *= ARENA_PERK_DEFS[perk.type]?.medTimeFactor ?? 1;
        return factor;
    }

    /** Hollow-Points: bullets go through vests. */
    ignoresVest(params: DamageParams): boolean {
        if (params.damageType !== GameConfig.DamageType.Player || params.isExplosion) return false;
        if (!GunDefs[params.gameSourceType ?? ""]) return false;
        const source = params.source;
        if (source?.__type !== ObjectType.Player) return false;
        return (source as Player).perks.some((p) => ARENA_PERK_DEFS[p.type]?.ignoresVest);
    }

    /** Mass Medicate / Revivify: almost instant. */
    reviveDuration(reviver: Player, _target: Player): number | undefined {
        const fast = reviver.perks.some((p) => ARENA_PERK_DEFS[p.type]?.fastRevive);
        return fast ? ARENA_FAST_REVIVE_S : undefined;
    }

    /** Longer with fewer players: 12 → 10 s, 8-10 → 20 s, 4-6 → 30 s, 2 → 50 s. */
    protected countdownFor(players: number): number {
        return (DOMINATION_COUNTDOWNS.find((c) => players >= c.players) ?? DOMINATION_COUNTDOWNS[DOMINATION_COUNTDOWNS.length - 1]).seconds;
    }

    /** A dead player watches a living teammate - the killer (or anyone) only when none is left. */
    protected spectateTarget(victim: Player, killer: Player | undefined): Player | undefined {
        const alive = (p: Player) => p !== victim && !p.disconnected && !p.spectator && !this.respawnAt.has(p);
        const mates = this.game.playerBarn.livingPlayers.filter((p) => alive(p) && p.teamId === victim.teamId);
        if (mates.length) return mates[Math.floor(Math.random() * mates.length)];
        if (killer && alive(killer)) return killer;
        return this.game.playerBarn.livingPlayers.find(alive);
    }

    /** Enemies of the victim (not the killer) who hurt them enough shortly before. */
    private assistersOf(victim: Player, killer: Player): Player[] {
        const since = this.game.startedTime - DOMINATION_ASSIST_WINDOW_S;
        const dealt = new Map<Player, number>();
        for (const d of victim.damageHistory) {
            if (d.time < since || d.source?.__type !== ObjectType.Player) continue;
            const p = d.source as Player;
            if (p === killer || p === victim || p.teamId === victim.teamId) continue;
            dealt.set(p, (dealt.get(p) ?? 0) + d.amount);
        }
        return [...dealt].filter(([, n]) => n >= DOMINATION_ASSIST_MIN_DAMAGE).map(([p]) => p);
    }

    /** A dead player's guns, throwable and perk lie where they fell - the only loot there is. */
    private dropLoadout(victim: Player, killer?: Player): void {
        const lootBarn = this.game.lootBarn;
        const pos = victim.pos;
        const at = () => v2.add(pos, v2.mul(v2.randomUnit(), 0.5));
        // what the last death left (and nobody took) goes now - one pile per player
        for (const old of this.drops.get(victim) ?? []) if (!old.destroyed) old.destroy();
        const drops: Loot[] = [];
        this.drops.set(victim, drops);
        // the killer's perk may want more (Scavenger: the grenades and half the ammo)
        const extra = killer && this.running ? this.victimDropsOf(killer) : undefined;
        if (extra) {
            for (const [item, count] of Object.entries(victim.inventory)) {
                if (count <= 0) continue;
                const type = (GameObjectDefs.typeToDefSafe(item) as { type?: string } | undefined)?.type;
                const n = type === "ammo"
                    ? Math.floor(count * extra.ammoFraction)
                    : type === "throwable" && extra.throwables && !ARENA_STREAK_ITEMS.includes(item)
                      ? count
                      : 0;
                if (n <= 0) continue;
                const loot = lootBarn.addLootWithoutAmmo(item, at(), victim.layer, n);
                if (loot) drops.push(loot);
            }
        }
        // nothing else drops (no throwables either): empty the backpack first, so the loaded rounds of the guns
        // don't overflow it onto the ground when the guns are taken away
        victim.invManager.wipeInventory();
        for (const slot of [GameConfig.WeaponSlot.Primary, GameConfig.WeaponSlot.Secondary]) {
            const type = victim.weapons[slot].type;
            // no ammo next to it - the gun keeps the rounds it had (lootKeepsClip); a kill
            // streak's gun (Juggernaut) goes with its owner
            if (type && !ARENA_STREAK_ITEMS.includes(type)) {
                const loot = lootBarn.addLootWithoutAmmo(type, v2.add(pos, v2.mul(v2.randomUnit(), 0.5)), victim.layer, 1);
                if (loot) {
                    loot.clip = victim.weapons[slot].ammo;
                    drops.push(loot);
                }
            }
            victim.weaponManager.setWeapon(slot, "", 0);
        }
        for (const perk of [...victim.perks]) {
            if (!perk.droppable) continue;
            const loot = lootBarn.addLootWithoutAmmo(perk.type, v2.add(pos, v2.mul(v2.randomUnit(), 0.5)), victim.layer, 1);
            if (loot) drops.push(loot);
            victim.removePerk(perk.type);
        }
    }

    /** What the perk of a killer adds to their victim's drops (Scavenger). */
    private victimDropsOf(killer: Player): { throwables: boolean; ammoFraction: number } | undefined {
        for (const perk of killer.perks) {
            const drops = ARENA_PERK_DEFS[perk.type]?.victimDrops;
            if (drops) return drops;
        }
        return undefined;
    }

    /** Adrenaline is always full - a soda / pill gives a few seconds of damage resistance. */
    onBoostUsed(player: Player, item: string): void {
        const r = ARENA_BOOST_RESIST[item];
        if (!r) return;
        const now = this.resist.get(player);
        const until = this.clock + r.seconds;
        this.resist.set(player, {
            until: Math.max(until, now?.until ?? 0),
            reduction: Math.max(r.reduction, now && now.until > this.clock ? now.reduction : 0),
        });
    }

    damageReduction(player: Player, params?: DamageParams): number {
        const r = this.resist.get(player);
        const boost = r && r.until > this.clock ? r.reduction : 0;
        // Flak Jacket: less from explosions (on top of the soda / pill's)
        let explosion = 0;
        if (params?.isExplosion) {
            for (const perk of player.perks) explosion = Math.max(explosion, ARENA_PERK_DEFS[perk.type]?.explosionReduction ?? 0);
        }
        return 1 - (1 - boost) * (1 - explosion);
    }

    /** Loadout items - and ammo / heals a teammate dropped to share. A Juggernaut: nothing. */
    allowsPickup(player: Player, lootType: string): boolean {
        if (this.isJuggernaut(player)) return false;
        const type = (GameObjectDefs.typeToDefSafe(lootType) as { type?: string } | undefined)?.type;
        if (arenaSlotOf(lootType) !== undefined) return true;
        // armor: the supply flare's crate
        return type === "ammo" || type === "heal" || type === "boost" || type === "helmet" || type === "chest";
    }

    // ── kill streaks ────────────────────────────────────────────────────────

    /** The fired kill streaks still running (several at once: a Juggernaut with Eagle Eye...). */
    private actives(player: Player): Map<ArenaStreakKind, string> {
        let m = this.streakActive.get(player);
        if (!m) {
            m = new Map();
            this.streakActive.set(player, m);
        }
        return m;
    }

    private isJuggernaut(player: Player): boolean {
        return !!this.streakActive.get(player)?.has("juggernaut");
    }

    /** The player's item for a tier (their pick); undefined: nothing for them there (Eagle Eye locked). */
    private streakItemFor(player: Player, tier: ArenaStreakTier): string | undefined {
        const s = player.arenaStreaks;
        // switched off in the loadout menu: nothing (the streak goes on to the next one)
        if (s.off?.includes(tier.kind)) return undefined;
        switch (tier.kind) {
            case "airdrop":
                return tier.options.includes(s.airdrop) ? s.airdrop : tier.options[0];
            case "juggernaut":
                return tier.options.includes(s.juggernaut) ? s.juggernaut : tier.options[0];
            case "eagle_eye":
                return s.eagleEye ? tier.options[0] : undefined;
            case "airstrike":
                return tier.options[0];
        }
    }

    /** A kill in a row: a tier reached gives its bonus (a higher one replaces one not fired yet). */
    private onStreakKill(killer: Player): void {
        const n = (this.streak.get(killer) ?? 0) + 1;
        this.streak.set(killer, n);
        // the endless M249 [+] Juggernaut's kills count for Eagle Eye
        if (this.streakActive.get(killer)?.get("juggernaut") === "modified_m249") {
            killer.weaponKills.set(ARENA_JUGGERNAUT_M249_KILLS, (killer.weaponKills.get(ARENA_JUGGERNAUT_M249_KILLS) ?? 0) + 1);
        }
        const tier = ARENA_STREAKS.find((t) => t.kills === n);
        const item = tier && this.streakItemFor(killer, tier);
        if (tier && item) this.streakReady.set(killer, { tier, item });
        this.sendStreak(killer);
    }

    /** The kill streak key: fires the earned bonus - also while another one runs (a Juggernaut too). */
    useKillstreak(player: Player): boolean {
        const ready = this.streakReady.get(player);
        if (!ready || !this.running || player.downed || this.respawnAt.has(player) || player.dead) return false;
        // a second Juggernaut while being one: keep it for later
        if (ready.tier.kind === "juggernaut" && this.isJuggernaut(player)) return false;
        this.streakReady.delete(player);
        this.actives(player).set(ready.tier.kind, ready.item);
        this.applyStreak(player, ready.tier.kind, ready.item);
        // the Juggernaut empties everything - the others running come back on top
        if (ready.tier.kind === "juggernaut") this.reapplyStreaks(player);
        this.sendStreak(player);
        return true;
    }

    /** What a fired kill streak gives. */
    private applyStreak(player: Player, kind: ArenaStreakKind, item: string, equip = true): void {
        const wm = player.weaponManager;
        switch (kind) {
            case "airdrop": {
                // the flare in the melee slot: one shot, then the melee is back
                wm.setWeapon(GameConfig.WeaponSlot.Melee, item, 1);
                if (equip) wm.setCurWeapIndex(GameConfig.WeaponSlot.Melee, true, true, true, false);
                break;
            }
            case "juggernaut": {
                const jug = ARENA_JUGGERNAUTS[item] ?? { endless: false };
                player.cancelAction();
                player.invManager.wipeInventory();
                player.helmet = jug.helmet ?? ARENA_GEAR.helmet;
                player.chest = jug.chest ?? ARENA_GEAR.chest;
                // its gun only - full, nothing to reload with (the endless one never runs dry)
                if (jug.endless && !player.perks.some((p) => p.type === "endless_ammo" && !p.droppable)) player.addPerk("endless_ammo", false);
                const gun = GunDefs[item];
                wm.setWeapon(GameConfig.WeaponSlot.Primary, item, gun ? wm.getAmmoStats(gun).maxClip : 0);
                wm.setWeapon(GameConfig.WeaponSlot.Secondary, "", 0);
                wm.setWeapon(GameConfig.WeaponSlot.Throwable, "", 0);
                wm.setCurWeapIndex(GameConfig.WeaponSlot.Primary, true, true, true, false);
                break;
            }
            case "eagle_eye": {
                player.invManager.set(item as InventoryItem, 1);
                player.scope = item;
                break;
            }
            case "airstrike": {
                player.invManager.set(item as InventoryItem, 1);
                wm.setWeapon(GameConfig.WeaponSlot.Throwable, item, 0);
                if (equip) wm.setCurWeapIndex(GameConfig.WeaponSlot.Throwable, true, true, true, false);
                break;
            }
        }
        player.inventoryDirty = true;
        player.weapsDirty = true;
        player.setDirty();
    }

    /** After the inventory was emptied (a Juggernaut starts / ends): Eagle Eye and an unthrown strobe again. */
    private reapplyStreaks(player: Player): void {
        const m = this.streakActive.get(player);
        if (!m) return;
        for (const kind of ["eagle_eye", "airstrike"] as const) {
            const item = m.get(kind);
            if (item) this.applyStreak(player, kind, item, false);
        }
    }

    /** A fired kill streak is over (the fired flare, the empty minigun, the thrown strobe). */
    private endStreak(player: Player, kind: ArenaStreakKind): void {
        const m = this.streakActive.get(player);
        const item = m?.get(kind);
        if (!m || !item) return;
        m.delete(kind);
        if (kind === "juggernaut" && ARENA_JUGGERNAUTS[item]?.endless) {
            if (player.perks.some((p) => p.type === "endless_ammo" && !p.droppable)) player.removePerk("endless_ammo");
        }
        if (kind === "airdrop" && player.weapons[GameConfig.WeaponSlot.Melee].type === item) {
            player.weaponManager.setWeapon(GameConfig.WeaponSlot.Melee, this.ownMelee.get(player) ?? "fists", 0);
        }
        this.sendStreak(player);
    }

    /** The death: every fired kill streak ends (an earned, unfired one stays). */
    private endStreakActive(player: Player): void {
        for (const kind of [...(this.streakActive.get(player)?.keys() ?? [])]) this.endStreak(player, kind);
    }

    /** Every tick: a fired flare, an empty minigun, a thrown strobe end their bonus. */
    private updateStreaks(): void {
        for (const [player, m] of this.streakActive) {
            if (player.dead || player.disconnected || !m.size) continue;
            const wm = player.weaponManager;
            const flare = m.get("airdrop");
            if (flare) {
                const melee = player.weapons[GameConfig.WeaponSlot.Melee];
                if (melee.type !== flare || melee.ammo <= 0) {
                    // fired: the melee back in hand
                    this.endStreak(player, "airdrop");
                    wm.setCurWeapIndex(GameConfig.WeaponSlot.Melee, true, true, true, false);
                }
            }
            const jug = m.get("juggernaut");
            if (jug) {
                const gun = player.weapons[GameConfig.WeaponSlot.Primary];
                const done = gun.type !== jug || (!ARENA_JUGGERNAUTS[jug]?.endless && gun.ammo <= 0);
                if (done && player.actionType !== GameConfig.Action.Reload) {
                    // the loadout back (and its armor) - and what else runs on top
                    this.endStreak(player, "juggernaut");
                    this.giveSpawnItems(player);
                    this.reapplyStreaks(player);
                }
            }
            const strobe = m.get("airstrike");
            if (strobe && player.invManager.get(strobe as InventoryItem) <= 0 && player.weapons[GameConfig.WeaponSlot.Throwable].type !== strobe) {
                this.endStreak(player, "airstrike");
            }
        }
    }

    /** The players whose kill streak changed without a KillstreakMsg yet (see sendStreak). */
    private flushStreaks(): void {
        if (!this.streakDirty.size) return;
        for (const p of this.streakDirty) if (!p.disconnected) this.sendStreak(p);
        this.streakDirty.clear();
    }

    private sendStreak(player: Player): void {
        if (player.bot || player.spectator) return;
        const ready = this.streakReady.get(player)?.item ?? "";
        const active = [...(this.streakActive.get(player)?.values() ?? [])];
        const streak = this.streak.get(player) ?? 0;
        const key = `${streak}|${ready}|${active.join(",")}`;
        if (this.streakSent.get(player) === key) return;
        this.streakSent.set(player, key);
        const msg = new netMsgs.KillstreakMsg();
        msg.streak = streak;
        msg.ready = ready;
        msg.active = active;
        // the next tier this player gets (switched off / locked ones skipped) - the HUD's "x/y"
        const next = activeStreakTiers(player.arenaStreaks).find((t) => t.kills > streak);
        msg.next = next ? ARENA_STREAKS.indexOf(next) : -1;
        player.msgsToSend.push({ type: netMsgs.MsgType.Killstreak, msg });
    }

    /** The kill streak flares give no speed (they sit in the melee slot). */
    equipSpeed(_player: Player, weapon: string, usual: number): number {
        return ARENA_STREAKS[0].options.includes(weapon) ? 0 : usual;
    }

    /** Kill streak items never drop, a Juggernaut drops nothing. */
    canDrop(player: Player, item: string): boolean {
        if (ARENA_STREAK_ITEMS.includes(item)) return false;
        return !this.isJuggernaut(player);
    }

    /** The most kills: the kill leader banner. */
    leader(): { player: Player; score: number } | undefined {
        let best: Player | undefined;
        for (const p of this.activePlayers()) if (p.kills > 0 && (!best || p.kills > best.kills)) best = p;
        return best ? { player: best, score: best.kills } : undefined;
    }

    /** A flare fired: remember whose crate it is. */
    onAirdropCalled(playerId: number, pos: Vec2, supply: boolean): void {
        const player = this.game.objectRegister.getById(playerId) as Player | undefined;
        if (!player || player.__type !== ObjectType.Player) return;
        this.calledCrates.push({ player, pos: v2.copy(pos), supply });
    }

    /** A called in crate opened: the caller's airdrop weapon, or the supply flare's armor. */
    obstacleLoot(obstacle: Obstacle): string[] | undefined {
        const supply = obstacle.type.startsWith("supply_crate");
        if (!supply && !obstacle.type.startsWith("airdrop_crate")) return undefined;
        let best = -1;
        let bestDist = 40;
        this.calledCrates.forEach((c, i) => {
            const d = v2.distance(c.pos, obstacle.pos);
            if (c.supply === supply && d < bestDist) {
                best = i;
                bestDist = d;
            }
        });
        const call = best >= 0 ? this.calledCrates.splice(best, 1)[0] : undefined;
        if (supply) return [...ARENA_SUPPLY_DROP_LOOT];
        return [call?.player.arenaStreaks.airdropWeapon ?? ARENA_DEFAULT_STREAKS.airdropWeapon];
    }

    /**
     * A picked up gun replaces the one of its kind the player carries (main gun /
     * pistol), whichever slot it's in - after a slot swap too, so there are never two
     * main guns; with none of its kind, a free slot.
     */
    gunPickupSlot(player: Player, gunType: string): number | undefined {
        const kind = arenaSlotOf(gunType);
        const slots = [GameConfig.WeaponSlot.Primary, GameConfig.WeaponSlot.Secondary];
        // carried already (an MP220 as the secondary): that one
        // a gun for either slot (the MP220): into the one in hand (main gun / secondary) -
        // a second one too (two only this way: the loadout allows one)
        if (ARENA_ALSO_SECONDARY.includes(gunType) && slots.includes(player.curWeapIdx)) return player.curWeapIdx;
        const exact = slots.find((s) => player.weapons[s].type === gunType);
        if (exact !== undefined) return exact;
        const same = slots.find((s) => player.weapons[s].type && arenaSlotOf(player.weapons[s].type) === kind);
        if (same !== undefined) return same;
        const free = slots.find((s) => !player.weapons[s].type);
        if (free !== undefined) return free;
        return kind === "pistol" ? GameConfig.WeaponSlot.Secondary : GameConfig.WeaponSlot.Primary;
    }

    // ── the zones ───────────────────────────────────────────────────────────

    protected updateMode(dt: number): void {
        this.ensureZones();
        // adrenaline is always full
        for (const p of this.game.playerBarn.livingPlayers) if (p.boost < 100 && !p.downed) p.boost = 100;
        this.flushStreaks();
        if (!this.running) return;
        this.updateStreaks();

        const players = this.game.playerBarn.livingPlayers.filter(
            (p) => !p.disconnected && !p.spectator && !p.downed && !this.respawnAt.has(p) && p.layer === 0,
        );
        for (const zone of this.zones) this.updateZone(zone, players, dt);

        this.zoneSendTicker -= dt;
        if (this.zonesChanged && this.zoneSendTicker <= 0) {
            this.zoneSendTicker = ZONE_SEND_INTERVAL;
            this.zonesChanged = false;
            this.standingsDirty = true;
        }
    }

    /** A side's players in the zone (only on a capture / neutralize - the XP). */
    private inZone(zone: Zone, players: Player[], side: Side): Player[] {
        return players.filter((p) => this.sideOf(p) === side && v2.distance(p.pos, zone.pos) <= zone.rad);
    }

    private updateZone(zone: Zone, players: Player[], dt: number): void {
        // (every tick, per zone: no arrays / strings unless something happens)
        const radSq = zone.rad * zone.rad;
        const count = [0, 0];
        for (const p of players) {
            const dx = p.pos.x - zone.pos.x;
            const dy = p.pos.y - zone.pos.y;
            if (dx * dx + dy * dy <= radSq) count[this.sideOf(p) - 1]++;
        }
        const wasOwner = zone.owner;
        const wasCapTeam = zone.capTeam;
        const wasProgress = Math.round(zone.progress * 100);
        const wasContested = zone.contested;
        const wasMult = zone.mult;

        zone.contested = count[0] > 0 && count[1] > 0;
        zone.threatened = zone.owner > 0 && count[2 - zone.owner] > 0;
        const side: Side | 0 = zone.contested ? 0 : count[0] > 0 ? 1 : count[1] > 0 ? 2 : 0;

        if (side) {
            const speed = count[side - 1] >= 2 ? DOMINATION_GROUP_SPEED : 1;
            if (zone.owner === side) {
                // back to fully held after an attempt to take it
                zone.progress = Math.min(1, zone.progress + (dt * speed) / DOMINATION_NEUTRALIZE_S);
            } else if (zone.owner) {
                zone.progress -= (dt * speed) / DOMINATION_NEUTRALIZE_S;
                if (zone.progress <= 0) {
                    zone.owner = 0;
                    zone.capTeam = side;
                    zone.progress = 0;
                    zone.pointTimer = 0;
                    for (const p of this.inZone(zone, players, side)) this.addXp(p, ARENA_XP.neutralize);
                }
            } else if (zone.capTeam && zone.capTeam !== side) {
                // the other team's half-done capture goes first
                zone.progress -= (dt * speed) / DOMINATION_CAPTURE_S;
                if (zone.progress <= 0) {
                    zone.capTeam = side;
                    zone.progress = 0;
                }
            } else {
                zone.capTeam = side;
                zone.progress += (dt * speed) / DOMINATION_CAPTURE_S;
                if (zone.progress >= 1) {
                    zone.owner = side;
                    zone.capTeam = 0;
                    zone.progress = 1;
                    zone.pointTimer = 0;
                    for (const p of this.inZone(zone, players, side)) this.addXp(p, ARENA_XP.capture);
                }
            }
        }
        // an empty zone: a half-done capture / neutralize stays where it was (only a team
        // in the zone moves it)

        // points for the holder every POINT_INTERVAL_S while no enemy is in it - more with
        // its players standing in it
        zone.mult = zone.owner && !zone.threatened
            ? Math.min(DOMINATION_ZONE_MAX_MULTIPLIER, 1 + count[zone.owner - 1])
            : 1;
        if (zone.owner && !zone.threatened) {
            zone.pointTimer += dt;
            if (zone.pointTimer >= DOMINATION_POINT_INTERVAL_S) {
                zone.pointTimer -= DOMINATION_POINT_INTERVAL_S;
                this.scores[zone.owner - 1] += zone.mult;
                this.standingsDirty = true;
            }
        }

        if (
            wasOwner !== zone.owner || wasCapTeam !== zone.capTeam || wasProgress !== Math.round(zone.progress * 100)
            || wasContested !== zone.contested || wasMult !== zone.mult
        ) {
            this.zonesChanged = true;
        }
    }

    // ── the end ─────────────────────────────────────────────────────────────

    checkGameEnd(): boolean {
        if (!this.game.started || !this.running) return false;
        // a whole team left: after DOMINATION_ABANDON_S the other one wins (a reload is
        // back before that; only a team that played in this match - a lobby that started
        // with one team doesn't end on the spot)
        if (!this.winnerSide) {
            const connected = (s: Side) =>
                this.game.playerBarn.players.some((p) => !p.spectator && !p.disconnected && this.sideOf(p) === s);
            for (const s of [1, 2] as Side[]) {
                const i = s - 1;
                if (connected(s)) {
                    this.sidePlayed[i] = true;
                    this.sideGoneSince[i] = -1;
                } else if (this.sidePlayed[i] && this.sideGoneSince[i] < 0) {
                    this.sideGoneSince[i] = this.clock;
                }
            }
            for (const s of [1, 2] as Side[]) {
                const other: Side = s === 1 ? 2 : 1;
                const since = this.sideGoneSince[s - 1];
                if (since >= 0 && this.clock - since >= DOMINATION_ABANDON_S && connected(other)) this.winnerSide = other;
            }
        }
        if (!this.winnerSide) {
            const [a, b] = [this.teamScore(1), this.teamScore(2)];
            const limit = a >= DOMINATION_SCORE_LIMIT || b >= DOMINATION_SCORE_LIMIT;
            if (!limit && !this.timeUp) return false;
            if (a !== b) {
                this.winnerSide = a > b ? 1 : 2;
            } else {
                // a tie on points: more kills
                const kills = (s: Side) =>
                    this.game.playerBarn.players.filter((p) => !p.spectator && this.sideOf(p) === s).reduce((n, p) => n + p.kills, 0);
                this.winnerSide = kills(1) >= kills(2) ? 1 : 2;
            }
        }
        const winnerTeamId = this.teamIdOf(this.winnerSide);
        for (const p of this.game.playerBarn.players) {
            if (p.spectator) continue;
            const won = this.sideOf(p) === this.winnerSide;
            this.addXp(p, won ? ARENA_XP.win : ARENA_XP.loss);
            if (won) p.rank = 1;
        }
        for (const p of this.game.playerBarn.players) {
            if (!p.spectator) p.addGameOverMsg(winnerTeamId);
        }
        this.game.modeManager.sendSpectatorsGameOver(winnerTeamId);
        return true;
    }

    /** The winning (else leading) team first, inside a team by arena XP earned, then kills. */
    ranking(): Player[] {
        const first: Side = this.winnerSide || (this.teamScore(2) > this.teamScore(1) ? 2 : 1);
        return this.game.playerBarn.players
            .filter((p) => !p.spectator && !p.stealth)
            .sort((a, b) => {
                const ta = this.sideOf(a) === first ? 0 : 1;
                const tb = this.sideOf(b) === first ? 0 : 1;
                return ta - tb || this.arenaXp(b) - this.arenaXp(a) || b.kills - a.kills;
            });
    }

    protected fillStandings(msg: net.ModeStandingsMsg): void {
        this.ensureZones();
        msg.entries = this.ranking()
            .filter((p) => !p.disconnected)
            .slice(0, 255)
            .map((p) => ({ playerId: p.__id, score: Math.min(255, p.kills) }));
        // the clients tell their own team from the enemy by these teamIds
        msg.teamIds = [this.teamIdOf(1), this.teamIdOf(2)];
        msg.teamScores = [this.teamScore(1), this.teamScore(2)];
        msg.scoreLimit = DOMINATION_SCORE_LIMIT;
        msg.zones = this.zones.map((z) => ({
            pos: z.pos,
            rad: z.rad,
            owner: this.teamIdOf(z.owner),
            capTeam: this.teamIdOf(z.capTeam),
            progress: z.progress,
            contested: z.contested,
            mult: z.mult,
        }));
    }

    /** The player's loadouts, flattened (4 types each), for the loadout picker. */
    joinedPayload(player?: Player): string[] {
        const loadouts = player?.arenaLoadouts.length ? player.arenaLoadouts : ARENA_PRESET_LOADOUTS;
        return loadouts.flatMap((l) => [l.primary, l.pistol, l.throwable, l.perk]);
    }
}
