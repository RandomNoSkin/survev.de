import type { AbstractMsg, BitStream } from "./net";
import { KillFeedMsgType } from "./net";

export class KillFeedMsg implements AbstractMsg {
    player: string = "";
    string: string = "";
    type: KillFeedMsgType = KillFeedMsgType.Ping;
    

    serialize(s: BitStream) {
        console.log("KILLFEED SERIALIZE", this.player, this.string, this.type);

    s.writeString(this.player);
    s.writeString(this.string);
    s.writeUint8(this.type);

    console.log("AFTER SERIALIZE INDEX", s.index, "BYTEINDEX", s.byteIndex);
    }

    deserialize(s: BitStream) {
        this.player = s.readString(16);
        this.string = s.readString(64);
        this.type = s.readUint8();
    }
}