import type { Vec2 } from "../utils/v2.ts";
import type { AbstractMsg, BitStream } from "./net.ts";

/** Where a GameMode's match is (Gun Game: warmup until enough players are in). */
export enum ModePhase {
    /** Warmup: waiting for `needed` players (`players` are in). */
    Waiting,
    /** Enough players: the match starts in `seconds`. */
    Countdown,
    /** The match runs, `seconds` left on its clock. */
    Running,
}

/** A capture zone (Domination's A / B / C). */
export interface ModeZone {
    pos: Vec2;
    rad: number;
    /** holding team (its teamId), 0: nobody */
    owner: number;
    /** neutral zone: the team taking it (teamId; its `progress`); held zone: 0 */
    capTeam: number;
    /** neutral: how far `capTeam` is with taking it; held: how much the owner still holds (1 = all) */
    progress: number;
    /** players of both teams in it */
    contested: boolean;
    /** the holder's point multiplier right now (holders standing in it), 1: none */
    mult: number;
}

/**
 * A GameMode's standings (Gun Game: every player's ladder step), best first, and the
 * match's phase / clock - for team modes also the team scores and the capture zones.
 * Sent to everyone whenever they change (and every second for the clock); the client
 * shows the top of it, where the watched player stands, the warmup / countdown text,
 * the match timer and the zones.
 */
export class ModeStandingsMsg implements AbstractMsg {
    entries: Array<{ playerId: number; score: number }> = [];
    phase = ModePhase.Running;
    players = 0;
    needed = 0;
    /** how many fit in (the game's max players) */
    max = 0;
    seconds = 0;
    /** team modes: the teams (teamIds) and their scores (empty: no teams) */
    teamIds: number[] = [];
    teamScores: number[] = [];
    /** the score a team wins at (0: none) */
    scoreLimit = 0;
    zones: ModeZone[] = [];

    serialize(s: BitStream) {
        /* STRIP_FROM_PROD_CLIENT:START */
        s.writeArray(this.entries, 8, (e) => {
            s.writeUint16(e.playerId);
            s.writeUint8(e.score);
        });
        s.writeUint8(this.phase);
        s.writeUint8(this.players);
        s.writeUint8(this.needed);
        s.writeUint8(this.max);
        s.writeUint16(this.seconds);
        s.writeArray(this.teamIds, 8, (id) => s.writeUint16(id));
        s.writeArray(this.teamScores, 8, (n) => s.writeUint16(Math.max(0, Math.min(65535, Math.floor(n)))));
        s.writeUint16(this.scoreLimit);
        s.writeArray(this.zones, 8, (z) => {
            s.writeMapPos(z.pos);
            s.writeUint8(Math.min(255, Math.round(z.rad)));
            s.writeUint16(z.owner);
            s.writeUint16(z.capTeam);
            s.writeUint8(Math.round(Math.max(0, Math.min(1, z.progress)) * 255));
            s.writeBoolean(z.contested);
            s.writeUint8(Math.max(1, Math.min(255, Math.round(z.mult))));
        });
        /* STRIP_FROM_PROD_CLIENT:END */
    }

    deserialize(s: BitStream) {
        this.entries = s.readArray(8, () => ({
            playerId: s.readUint16(),
            score: s.readUint8(),
        }));
        this.phase = s.readUint8();
        this.players = s.readUint8();
        this.needed = s.readUint8();
        this.max = s.readUint8();
        this.seconds = s.readUint16();
        this.teamIds = s.readArray(8, () => s.readUint16());
        this.teamScores = s.readArray(8, () => s.readUint16());
        this.scoreLimit = s.readUint16();
        this.zones = s.readArray(8, () => ({
            pos: s.readMapPos(),
            rad: s.readUint8(),
            owner: s.readUint16(),
            capTeam: s.readUint16(),
            progress: s.readUint8() / 255,
            contested: s.readBoolean(),
            mult: s.readUint8(),
        }));
    }
}
