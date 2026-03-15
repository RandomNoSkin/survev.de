import type { AbstractMsg, BitStream } from "./net";

export class JoinFeedMsg implements AbstractMsg {
    name: string = "";
    enemieNames: string[] = [];
    

    serialize(s: BitStream) {
        /* STRIP_FROM_PROD_CLIENT:START */
        s.writeString(this.name);
        s.writeArray(this.enemieNames, 6, (item) => {
            s.writeString(item);
        });
        /* STRIP_FROM_PROD_CLIENT:END */
    }

    deserialize(s: BitStream) {
        this.name = s.readString();
        this.enemieNames = s.readArray(6, () => {
            return s.readString();
        });
    }
}