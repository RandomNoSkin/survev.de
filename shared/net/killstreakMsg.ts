import type { AbstractMsg, BitStream } from "./net";

/**
 * Server → one client, arena modes: the player's kill streak (see arenaStreakDefs.ts) -
 * sent whenever it changes.
 */
export class KillstreakMsg implements AbstractMsg {
    /** kills in a row right now */
    streak = 0;
    /** the earned, not yet fired bonus (its item type), "" for none */
    ready = "";
    /** the fired bonuses still running (until the death / the empty magazine...) */
    active: string[] = [];
    /** the next tier the player gets (its index in ARENA_STREAKS; switched off ones
     *  skipped), -1: none left */
    next = -1;

    serialize(s: BitStream) {
        s.writeUint8(Math.min(255, this.streak));
        s.writeGameType(this.ready);
        s.writeArray(this.active.slice(0, 7), 3, (t) => s.writeGameType(t));
        s.writeUint8(this.next < 0 ? 255 : this.next);
    }

    deserialize(s: BitStream) {
        this.streak = s.readUint8();
        this.ready = s.readGameType();
        this.active = s.readArray(3, () => s.readGameType());
        const next = s.readUint8();
        this.next = next === 255 ? -1 : next;
    }
}
