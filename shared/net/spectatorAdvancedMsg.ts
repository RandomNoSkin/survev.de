import type { Vec2 } from "../utils/v2";
import { v2 } from "../utils/v2";
import type { AbstractMsg, BitStream } from "./net";

/**
 * Sent from the client to the server while the admin-only advanced spectator
 * mode is active. Tells the server to stream the area around the free camera
 * (instead of around the spectated player) and to include full player status
 * (health/boost for every player) so the client can render ESP / enemy labels.
 *
 * The server only honors this for receivers where `isAdmin && spectator`.
 */
export class SpectatorAdvancedMsg implements AbstractMsg {
    enabled = false;
    freecam = false;
    pos: Vec2 = v2.create(0, 0);
    zoom = 0;

    serialize(s: BitStream) {
        s.writeBoolean(this.enabled);
        s.writeBoolean(this.freecam);
        s.writeVec32(this.pos);
        s.writeFloat32(this.zoom);
    }

    deserialize(s: BitStream) {
        this.enabled = s.readBoolean();
        this.freecam = s.readBoolean();
        this.pos = s.readVec32();
        this.zoom = s.readFloat32();
    }
}
