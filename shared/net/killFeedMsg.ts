import type { AbstractMsg, BitStream } from "./net";
import { KillFeedMsgType } from "./net";

export class KillFeedMsg implements AbstractMsg {
    player: string = "";
    string: string = "";
    chatType: number = 0;
    type: KillFeedMsgType = KillFeedMsgType.Ping;
    cmd: string = "";
    args: string[] = [];
    

    serialize(s: BitStream) {

        s.writeString(this.player);
        s.writeString(this.string);
        s.writeInt8(this.chatType);
        s.writeUint8(this.type);
        s.writeString(this.cmd);
        s.writeUint8(this.args.length);
        for (let i = 0; i < this.args.length; i++) {
            s.writeString(this.args[i]);
        }
        s.writeBits(0,6)

    }

    deserialize(s: BitStream) {
        this.player = s.readString();
        this.string = s.readString();
        this.chatType = s.readInt8();
        this.type = s.readUint8();
        this.cmd = s.readString();
        const argsLength = s.readUint8();
        this.args = [];
        for (let i = 0; i < argsLength; i++) {
            this.args.push(s.readString());
        }
        s.readBits(6);
    }
}