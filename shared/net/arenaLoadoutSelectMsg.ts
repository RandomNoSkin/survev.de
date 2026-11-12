import type { AbstractMsg, BitStream } from "./net";

/** What the player does in the arena loadout menu. */
export enum ArenaLoadoutAction {
    /** picked a loadout (the next spawn's - right away if just spawned) */
    Pick,
    /** "Enter game": leave the menu and spawn (now, or once the respawn time is over) */
    Deploy,
    /** opened the menu while dead: don't respawn before Deploy */
    Hold,
}

/** Client → server, arena modes: the loadout menu (see Player.arenaLoadouts). */
export class ArenaLoadoutSelectMsg implements AbstractMsg {
    slot = 0;
    action = ArenaLoadoutAction.Pick;

    serialize(s: BitStream) {
        s.writeUint8(this.slot);
        s.writeUint8(this.action);
    }

    deserialize(s: BitStream) {
        this.slot = s.readUint8();
        this.action = s.readUint8();
    }
}
