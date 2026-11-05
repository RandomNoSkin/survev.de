import type { AbstractMsg, BitStream } from "./net.ts";

/**
 * A GameMode's standings (Gun Game: every player's ladder step), best first. Sent to
 * everyone whenever they change; the client shows the top of it and where the watched
 * player stands.
 */
export class ModeStandingsMsg implements AbstractMsg {
    entries: Array<{ playerId: number; score: number }> = [];

    serialize(s: BitStream) {
        /* STRIP_FROM_PROD_CLIENT:START */
        s.writeArray(this.entries, 8, (e) => {
            s.writeUint16(e.playerId);
            s.writeUint8(e.score);
        });
        /* STRIP_FROM_PROD_CLIENT:END */
    }

    deserialize(s: BitStream) {
        this.entries = s.readArray(8, () => ({
            playerId: s.readUint16(),
            score: s.readUint8(),
        }));
    }
}
