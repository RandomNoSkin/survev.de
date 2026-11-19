import type { DisplayRoleTag } from "../types/user";
import type { AbstractMsg, BitStream } from "./net";
import { decodeRoleTag, encodeRoleTag } from "./roleTagCodec";

export class JoinFeedMsg implements AbstractMsg {
    name: string = "";
    /** The [ADMIN]/[MOD]/[PREM]/[BOT] tag for `name` (single-join case only, not group1/group2). */
    roleTag: DisplayRoleTag = null;
    /** The clan [TAG] for `name` ("" = none) and its CLAN_TAG_COLORS index. */
    clanTag: string = "";
    clanColor: number = 0;
    group1: string[] = [];
    group2: string[] = [];


    serialize(s: BitStream) {
        /* STRIP_FROM_PROD_CLIENT:START */
        s.writeString(this.name);
        s.writeUint8(encodeRoleTag(this.roleTag));
        s.writeString(this.clanTag, 6);
        s.writeUint8(this.clanColor);
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
        this.clanTag = s.readString(6);
        this.clanColor = s.readUint8();
        this.group1 = s.readArray(6, () => {
            return s.readString();
        });
        this.group2 = s.readArray(6, () => {
            return s.readString();
        });
    }
}
