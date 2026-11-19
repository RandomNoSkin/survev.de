import type { AbstractMsg, BitStream } from "./net";

/**
 * Server → one client, arena modes: the damage resistance running on the player (a
 * soda / pill, Takedown, a revive - see ARENA_BOOST_RESIST) - sent whenever it starts,
 * changes or is taken away. The client counts the seconds down itself.
 */
export class ArenaResistMsg implements AbstractMsg {
    /** less damage taken (0..1), 0: none */
    reduction = 0;
    /** how long it still runs (s) */
    seconds = 0;

    serialize(s: BitStream) {
        s.writeUint8(Math.max(0, Math.min(100, Math.round(this.reduction * 100))));
        s.writeUint16(Math.max(0, Math.min(65535, Math.round(this.seconds * 10))));
    }

    deserialize(s: BitStream) {
        this.reduction = s.readUint8() / 100;
        this.seconds = s.readUint16() / 10;
    }
}
