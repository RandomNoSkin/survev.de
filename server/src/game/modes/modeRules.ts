import type { Group } from "../group";
import type { Vec2 } from "../../../../shared/utils/v2";
import type { DamageParams } from "../objects/gameObject";
import type { Obstacle } from "../objects/obstacle";
import type { Player } from "../objects/player";

/**
 * The rules of a non-standard GameMode (Gun Game, later Team Deathmatch, Defuse, ...).
 * A Game has at most one (`Game.rules`, see createModeRules); without one everything
 * runs as the normal battle royale. Every hook is optional - the game code asks
 * `rules?.hook?.(...)` at the few points a mode can change, and keeps its own
 * behaviour when the hook isn't there.
 */
export interface ModeRules {
    /** No gas (and no gas-driven planes / roles) at all. */
    readonly skipsGas?: boolean;
    /** The largest group (team) - default: the team mode's size (Domination: 6). */
    readonly groupSize?: number;
    /** No loot from the world: destroyed obstacles drop nothing (the mode clears what
     *  the map generation put down itself). */
    readonly noWorldLoot?: boolean;
    /** The map is generated from a seed, so `map.regenerate(map.seed)` puts the very
     *  same map back (Domination resets it after the warmup). */
    readonly seededMap?: boolean;
    /** A dropped gun keeps the rounds in its magazine - they don't go into the
     *  backpack, and whoever picks it up gets exactly those (no ammo along with it). */
    readonly lootKeepsClip?: boolean;
    /** Perks whose usual effect is off (the mode gives something else for them) -
     *  Player.hasPerk says no for these. */
    readonly inertPerks?: ReadonlySet<string>;
    /** How long a revive takes (s); undefined: the usual. */
    reviveDuration?(reviver: Player, target: Player): number | undefined;
    /** A knocked player was revived (after the usual revive health). */
    onRevived?(player: Player): void;
    /** Factor on how long medical items take the player (1: the usual). */
    useTimeFactor?(player: Player): number;
    /** A hit that goes through the victim's vest (the arena's Hollow-Points). */
    ignoresVest?(params: DamageParams): boolean;
    /** The kill streak key (Input.UseKillstreak): true when something was fired. */
    useKillstreak?(player: Player): boolean;
    /** The speed holding a weapon gives (default: its def's `speed.equip`). */
    equipSpeed?(player: Player, weapon: string, usual: number): number;
    /** Whether the player may drop this item (default: yes). */
    canDrop?(player: Player, item: string): boolean;
    /** What a destroyed obstacle drops instead of its own loot (a called in crate);
     *  undefined: the usual. */
    obstacleLoot?(obstacle: Obstacle): string[] | undefined;
    /** A player's flare called in a crate at `pos` (supply: the supply flare's). */
    onAirdropCalled?(playerId: number, pos: Vec2, supply: boolean): void;
    /** Called in crates come this much faster (the plane's way and the fall; 1: the usual). */
    readonly calledAirdropTimeFactor?: number;
    /** A knocked player gives up (their interact key): true when the mode took it. */
    giveUp?(player: Player): boolean;
    /** A soda / pill was used on the player (its adrenaline itself is applied as usual). */
    onBoostUsed?(player: Player, item: string): void;
    /** Extra damage reduction (0..1, after armor) the player has right now, for this hit. */
    damageReduction?(player: Player, params: DamageParams): number;
    /** One kind of throwable at a time: picking up another kind drops the ones carried. */
    readonly singleThrowable?: boolean;
    /** The group a joining player (or party of `playerCount`) goes into instead of the
     *  usual auto fill; undefined: a new group (Domination: the side with fewer players). */
    pickGroup?(groups: Group[], playerCount: number): Group | undefined;
    /** The biggest party that can still join together (Domination: room on one side);
     *  matchmaking sends bigger ones to another game. Undefined: no limit. */
    partyRoom?(): number;
    /** Whether the player may pick up this loot at all (default: the map's `pickup`). */
    allowsPickup?(player: Player, lootType: string): boolean;
    /** The gun slot a picked up gun goes into, replacing what's there (the arena: main
     *  guns slot 1, pistols slot 2); undefined: the usual choice. */
    gunPickupSlot?(player: Player, gunType: string): number | undefined;
    /** Whether the match may start (and its clock run) - instead of the usual "two
     *  players are in" (Gun Game: after its warmup). */
    canStart?(): boolean;
    /** A (non-spectator) player just joined. */
    onJoin?(player: Player): void;
    /** A player's health hit 0. Return true when the mode took care of it - then
     *  `Player.kill()` doesn't run (e.g. a respawn instead of a death). */
    handleDeath?(victim: Player, params: DamageParams): boolean;
    /** Teammates may hurt each other right now (a warmup: everyone against everyone). */
    allowsTeamDamage?(): boolean;
    /** An admin skipped the wait for players: the countdown starts, `seconds` long.
     *  False when there's nothing to skip (the match already runs). */
    skipWaiting?(seconds: number): boolean;
    /** The player takes no damage right now (spawn protection, respawn wait). */
    isProtected?(player: Player): boolean;
    /** The player's inputs are ignored right now. */
    blocksInput?(player: Player): boolean;
    /** Dead until the respawn (a respawn mode's wait) - shown as dead to the team. */
    isRespawning?(player: Player): boolean;
    /** The player isn't sent to other clients right now. */
    isHidden?(player: Player): boolean;
    /** How much faster the adrenaline heals the player right now (1: as usual). */
    boostHealFactor?(player: Player): number;
    /** Every tick. */
    update?(dt: number): void;
    /** Whether the match is over; sends the game over messages itself when it is. */
    checkGameEnd?(): boolean;
    /** Every non-spectator player, best first (end screen + saved match data). */
    ranking?(): Player[];
    /** Who the kill leader display shows, and the number next to them. */
    leader?(): { player: Player; score: number } | undefined;
    /** The arena loadout menu (ArenaLoadoutSelectMsg; Player.arenaLoadoutIdx is already set). */
    onLoadoutSelect?(player: Player, action: number): void;
    /** Arena XP the player earned this match (arena modes; saved at the end). */
    arenaXp?(player: Player): number;
    /** Game types the clients need for this mode (sent in the JoinedMsg). */
    joinedPayload?(player?: Player): string[];
}
