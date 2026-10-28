import { MapId } from "../../../../shared/gameConfig.ts";
import { helpers } from "../../helpers";

/** The maps the stats pages filter by (competitive / special modes only) - the player
 *  card filter and the Premium profile stats use the same list. */
export const PLAYER_MAP_IDS: number[] = [
    MapId.Comp,
    MapId.CompSolo,
    MapId.CompDuo,
    MapId.Scrims,
    MapId.TwoVsTwo,
    MapId.FourVsFour,
    MapId.Local,
];

/** Those maps with their display names, in that order. */
export function statsMapOptions(): Array<{ mapId: number; name: string }> {
    const modes = helpers.getGameModes();
    return PLAYER_MAP_IDS.map((mapId) => ({
        mapId,
        name: modes.find((m) => m.mapId === mapId)?.desc.name ?? String(MapId[mapId] ?? mapId),
    }));
}
