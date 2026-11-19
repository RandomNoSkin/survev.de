import type { AbstractMsg, BitStream } from "./net";

export interface TeamInfoPlayer {
    playerId: number;
    dead: boolean;
    downed: boolean;
    disconnected: boolean;
    health: number;
    boost: number;
    /** primary, secondary, melee, throwable ("" = empty); ammo only matters for guns */
    weapons: Array<{ type: string; ammo: number }>;
    /** the equipped one */
    scope: string;
    /** every scope they carry (subset of TEAM_INFO_SCOPES) */
    scopes: string[];
    helmet: string;
    chest: string;
    backpack: string;
    bandage: number;
    healthkit: number;
    soda: number;
    painkiller: number;
}

/** The scopes the overview can show, lowest first (sent as a bit mask). */
export const TEAM_INFO_SCOPES = ["1xscope", "2xscope", "4xscope", "8xscope", "15xscope"] as const;

/** The healing items the team overview lists, in this order. */
export const TEAM_INFO_HEALS = ["bandage", "healthkit", "soda", "painkiller"] as const;

const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * Server -> client, team modes only: what the player's teammates carry, for the overview
 * next to the big map. The client otherwise only knows teammates' health. Sent at a low
 * rate and only when something changed, never to anyone outside the group.
 */
export class TeamInfoMsg implements AbstractMsg {
    players: TeamInfoPlayer[] = [];

    serialize(s: BitStream) {
        s.writeArray(this.players, 8, (p) => {
            s.writeUint16(p.playerId);
            s.writeBoolean(p.dead);
            s.writeBoolean(p.downed);
            s.writeBoolean(p.disconnected);
            s.writeFloat(p.health, 0, 100, 7);
            s.writeFloat(p.boost, 0, 100, 7);
            for (let i = 0; i < 4; i++) {
                const w = p.weapons[i] ?? { type: "", ammo: 0 };
                s.writeGameType(w.type);
                s.writeUint8(u8(w.ammo));
            }
            s.writeGameType(p.scope);
            for (const scope of TEAM_INFO_SCOPES) s.writeBoolean(p.scopes.includes(scope));
            s.writeGameType(p.helmet);
            s.writeGameType(p.chest);
            s.writeGameType(p.backpack);
            s.writeUint8(u8(p.bandage));
            s.writeUint8(u8(p.healthkit));
            s.writeUint8(u8(p.soda));
            s.writeUint8(u8(p.painkiller));
            s.writeAlignToNextByte();
        });
    }

    deserialize(s: BitStream) {
        this.players = s.readArray(8, () => {
            const p = {
                playerId: s.readUint16(),
                dead: s.readBoolean(),
                downed: s.readBoolean(),
                disconnected: s.readBoolean(),
                health: s.readFloat(0, 100, 7),
                boost: s.readFloat(0, 100, 7),
                weapons: [] as TeamInfoPlayer["weapons"],
                scope: "",
                scopes: [] as string[],
                helmet: "",
                chest: "",
                backpack: "",
                bandage: 0,
                healthkit: 0,
                soda: 0,
                painkiller: 0,
            };
            for (let i = 0; i < 4; i++) p.weapons.push({ type: s.readGameType(), ammo: s.readUint8() });
            p.scope = s.readGameType();
            for (const scope of TEAM_INFO_SCOPES) if (s.readBoolean()) p.scopes.push(scope);
            p.helmet = s.readGameType();
            p.chest = s.readGameType();
            p.backpack = s.readGameType();
            p.bandage = s.readUint8();
            p.healthkit = s.readUint8();
            p.soda = s.readUint8();
            p.painkiller = s.readUint8();
            s.readAlignToNextByte();
            return p;
        });
    }
}
