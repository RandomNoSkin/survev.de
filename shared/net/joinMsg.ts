import { type AbstractMsg, type BitStream, Constants } from "./net.ts";

export class JoinMsg implements AbstractMsg {
    protocol = 0;
    matchPriv = "";
    name = "";
    useTouch = false;
    isMobile = false;
    bot = false;
    /** Client setting: only pick up Ghillie suits in-game (keeps the loadout skin). */
    onlyGhilliePickup = true;
    loadout = {
        outfit: "",
        melee: "",
        heal: "",
        boost: "",
        death_effect: "",
        emotes: [] as string[],
    };

    serialize(s: BitStream) {
        // NEVER PUT THIS ANYWHERE ELSE OR CHANGE ITS SIZE!!
        // PROTOCOL VERSION SHOULD ALWAYS BE THE FIRST WITH THE SAME SIZE TO NOT BREAK OLD CLIENTS!!
        s.writeUint32(this.protocol);
        s.writeString(this.matchPriv);

        s.writeString(this.name, Constants.PlayerNameMaxLen);
        s.writeBoolean(this.useTouch);
        s.writeBoolean(this.isMobile);
        s.writeBoolean(this.bot);
        s.writeBoolean(this.onlyGhilliePickup);

        s.writeGameType(this.loadout.outfit);
        s.writeGameType(this.loadout.melee);
        s.writeGameType(this.loadout.heal);
        s.writeGameType(this.loadout.boost);
        s.writeGameType(this.loadout.death_effect);

        s.writeArray(this.loadout.emotes, 8, (emote) => {
            s.writeGameType(emote);
        });
    }

    deserialize(s: BitStream) {
        this.protocol = s.readUint32();
        this.matchPriv = s.readString();

        this.name = s.readString(Constants.PlayerNameMaxLen);
        this.useTouch = s.readBoolean();
        this.isMobile = s.readBoolean();
        this.bot = s.readBoolean();
        this.onlyGhilliePickup = s.readBoolean();

        this.loadout.outfit = s.readGameType();
        this.loadout.melee = s.readGameType();
        this.loadout.heal = s.readGameType();
        this.loadout.boost = s.readGameType();
        this.loadout.death_effect = s.readGameType();

        this.loadout.emotes = s.readArray(8, () => {
            return s.readGameType();
        });
    }
}
