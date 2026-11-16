import { GameMode, type TeamMode } from "../gameConfig.ts";
import type { AbstractMsg, BitStream } from "./net.ts";

export class JoinedMsg implements AbstractMsg {
    teamMode!: TeamMode;
    playerId = 0;
    started = false;
    emotes: string[] = [];
    isAdmin = false;
    /** Whether this client may use advanced spectator (admin, or any non-prod server). */
    advancedSpectator = false;
    /** Joined as a spectator: the chat offers SPEC (spectators only) and ALL. */
    spectator = false;
    /** The rules of this match (Gun Game, ...). */
    gameMode = GameMode.Standard;
    /** Game types the GameMode needs on the client (Gun Game: the match's weapon ladder). */
    modeTypes: string[] = [];

    serialize(s: BitStream) {
        /* STRIP_FROM_PROD_CLIENT:START */
        s.writeUint8(this.teamMode);
        s.writeUint16(this.playerId);
        s.writeBoolean(this.started);
        s.writeBoolean(this.isAdmin);
        s.writeBoolean(this.advancedSpectator);
        s.writeBoolean(this.spectator);

        s.writeArray(this.emotes, 8, (emote) => {
            s.writeGameType(emote);
        });

        s.writeUint8(this.gameMode);
        s.writeArray(this.modeTypes, 8, (type) => {
            s.writeGameType(type);
        });
        /* STRIP_FROM_PROD_CLIENT:END */
    }

    deserialize(s: BitStream) {
        this.teamMode = s.readUint8();
        this.playerId = s.readUint16();
        this.started = s.readBoolean();
        this.isAdmin = s.readBoolean();
        this.advancedSpectator = s.readBoolean();
        this.spectator = s.readBoolean();

        this.emotes = s.readArray(8, () => {
            return s.readGameType();
        });

        this.gameMode = s.readUint8();
        this.modeTypes = s.readArray(8, () => {
            return s.readGameType();
        });
    }
}
