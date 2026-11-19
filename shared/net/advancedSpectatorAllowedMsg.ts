import type { AbstractMsg, BitStream } from "./net";

/**
 * Server -> client: whether this player may (now) use advanced spectator. Sent when it
 * changes after joining, e.g. once the last teammate died; JoinedMsg carries the start value.
 */
export class AdvancedSpectatorAllowedMsg implements AbstractMsg {
    allowed = false;

    serialize(s: BitStream) {
        s.writeBoolean(this.allowed);
    }

    deserialize(s: BitStream) {
        this.allowed = s.readBoolean();
    }
}
