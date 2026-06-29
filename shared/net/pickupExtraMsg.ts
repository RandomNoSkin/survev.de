import { DamageType } from "../gameConfig";
import type { AbstractMsg, BitStream } from "./net";

export class PickupExtraMsg implements AbstractMsg {
    modifiedWeapon = "";
    

    serialize(s: BitStream) {
        /* STRIP_FROM_PROD_CLIENT:START */
        s.writeGameType(this.modifiedWeapon);
        /* STRIP_FROM_PROD_CLIENT:END */
    }

    deserialize(s: BitStream) {
        this.modifiedWeapon = s.readGameType();
    }
}