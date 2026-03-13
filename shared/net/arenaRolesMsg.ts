import { DamageType } from "../gameConfig";
import type { AbstractMsg, BitStream } from "./net";

export class ArenaRolesMsg implements AbstractMsg {
    availableGroupRoles: string[] = [];
    activePlayer = 0;

    serialize(s: BitStream) {
        /* STRIP_FROM_PROD_CLIENT:START */
        s.writeArray(this.availableGroupRoles, 6, (item) => {
            s.writeGameType(item);
        });
        s.writeInt16(this.activePlayer);
        s.writeBits(0,6);
        /* STRIP_FROM_PROD_CLIENT:END */
    }

    deserialize(s: BitStream) {
        this.availableGroupRoles = s.readArray(6, () => {
            return s.readGameType();
        });
        this.activePlayer = s.readInt16();
        s.readBits(6);
    }
}
