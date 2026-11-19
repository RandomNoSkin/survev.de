import type { Loadout } from "../../../../shared/utils/loadout";
import { usersTable } from "./schema";

/** Columns a player list needs to show the player icon they picked in their loadout. */
export const playerIconColumns = {
    loadout: usersTable.loadout,
    loadoutPrivate: usersTable.loadoutPrivate,
};

/** The player icon (an emote type) from the loadout, "" when unset - or when the player
 *  keeps their loadout private (then lists show their initial instead). */
export function playerIcon(r: { loadout: Loadout | null; loadoutPrivate: boolean }): string {
    if (r.loadoutPrivate) return "";
    return r.loadout?.player_icon ?? "";
}
