import type { RoleTag } from "../types/user";
import type { AbstractMsg, BitStream } from "./net";
import { decodeRoleTag, encodeRoleTag } from "./roleTagCodec";

export class JoinFeedMsg implements AbstractMsg {
    name: string = "";
    /** The [ADMIN]/[MOD]/[PREM] tag for `name` (single-join case only, not group1/group2). */
    roleTag: RoleTag = null;
    group1: string[] = [];
    group2: string[] = [];


    serialize(s: BitStream) {
        /* STRIP_FROM_PROD_CLIENT:START */
        s.writeString(this.name);
        s.writeUint8(encodeRoleTag(this.roleTag));
        s.writeArray(this.group1, 6, (item) => {
            s.writeString(item);
        });
        s.writeArray(this.group2, 6, (item) => {
            s.writeString(item);
        });
        /* STRIP_FROM_PROD_CLIENT:END */
    }

    deserialize(s: BitStream) {
        this.name = s.readString();
        this.roleTag = decodeRoleTag(s.readUint8());
        this.group1 = s.readArray(6, () => {
            return s.readString();
        });
        this.group2 = s.readArray(6, () => {
            return s.readString();
        });
    }
}
