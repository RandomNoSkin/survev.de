import type { AbstractMsg, BitStream } from "./net";
import { KillFeedMsgType } from "./net";

export class KillFeedMsg implements AbstractMsg {
    player: string = "";
    string: string = "";
    chatType: number = 0;
    type: KillFeedMsgType = KillFeedMsgType.Ping;
    

    serialize(s: BitStream) {

        s.writeString(this.player);
        s.writeString(this.string);
        s.writeInt8(this.chatType);
        s.writeUint8(this.type);
        s.writeBits(0,6)

    }

    deserialize(s: BitStream) {
        this.player = s.readString();
        this.string = s.readString();
        this.chatType = s.readInt8();
        this.type = s.readUint8();
        s.readBits(6);
    }
}