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

/**
 * A GameMode's standings (Gun Game: every player's ladder step), best first, and the
 * match's phase / clock. Sent to everyone whenever they change (and every second for
 * the clock); the client shows the top of it, where the watched player stands, the
 * warmup / countdown text and the match timer.
 */
export class ModeStandingsMsg implements AbstractMsg {
    entries: Array<{ playerId: number; score: number }> = [];
    phase = ModePhase.Running;
    players = 0;
    needed = 0;
    seconds = 0;

    serialize(s: BitStream) {
        /* STRIP_FROM_PROD_CLIENT:START */
        s.writeArray(this.entries, 8, (e) => {
            s.writeUint16(e.playerId);
            s.writeUint8(e.score);
        });
        s.writeUint8(this.phase);
        s.writeUint8(this.players);
        s.writeUint8(this.needed);
        s.writeUint16(this.seconds);
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
        this.seconds = s.readUint16();
    }
}
