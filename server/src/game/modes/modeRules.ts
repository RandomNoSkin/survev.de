import type { DamageParams } from "../objects/gameObject";
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
    /** Whether the match may start (and its clock run) - instead of the usual "two
     *  players are in" (Gun Game: after its warmup). */
    canStart?(): boolean;
    /** A (non-spectator) player just joined. */
    onJoin?(player: Player): void;
    /** A player's health hit 0. Return true when the mode took care of it - then
     *  `Player.kill()` doesn't run (e.g. a respawn instead of a death). */
    handleDeath?(victim: Player, params: DamageParams): boolean;
    /** The player takes no damage right now (spawn protection, respawn wait). */
    isProtected?(player: Player): boolean;
    /** The player's inputs are ignored right now. */
    blocksInput?(player: Player): boolean;
    /** The player isn't sent to other clients right now. */
    isHidden?(player: Player): boolean;
    /** Every tick. */
    update?(dt: number): void;
    /** Whether the match is over; sends the game over messages itself when it is. */
    checkGameEnd?(): boolean;
    /** Every non-spectator player, best first (end screen + saved match data). */
    ranking?(): Player[];
    /** Who the kill leader display shows, and the number next to them. */
    leader?(): { player: Player; score: number } | undefined;
    /** Game types the clients need for this mode (sent in the JoinedMsg). */
    joinedPayload?(): string[];
}
