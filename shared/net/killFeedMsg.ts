import { AbstractMsg, BitStream, KillFeedMsgType } from "./net";

export class KillFeedMsg implements AbstractMsg {
    player: string = "";
    string: string = "";
    type: KillFeedMsgType = KillFeedMsgType.Ping;
    

    serialize(s: BitStream) {
        /* STRIP_FROM_PROD_CLIENT:START */
        s.writeString(this.player);
        s.writeString(this.string);
        s.writeUint8(this.type);
        /* STRIP_FROM_PROD_CLIENT:END */
    }

    deserialize(s: BitStream) {
        this.player = s.readString();
        this.string = s.readString();
        this.type = s.readUint8();
    }
}