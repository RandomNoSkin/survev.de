import type { AbstractMsg, BitStream } from "./net";

export class JoinFeedMsg implements AbstractMsg {
    name: string = "";
    group1: string[] = [];
    group2: string[] = [];
    

    serialize(s: BitStream) {
        /* STRIP_FROM_PROD_CLIENT:START */
        s.writeString(this.name);
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
        this.group1 = s.readArray(6, () => {
            return s.readString();
        });
        this.group2 = s.readArray(6, () => {
            return s.readString();
        });
    }
}