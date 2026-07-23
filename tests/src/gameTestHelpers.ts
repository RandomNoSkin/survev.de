import { Config } from "../../server/src/config.ts";
import { Game } from "../../server/src/game/game.ts";
import type { MapDefKey } from "../../shared/defs/mapDefs.ts";
import type { TeamMode } from "../../shared/gameConfig.ts";

export function createGame(teamMode: TeamMode, mapName: MapDefKey) {
    // we dont want vitest spammed with stdout logs so only log warns and errors
    Config.logging.logDate = false;
    Config.logging.debugLogs = false;
    Config.logging.infoLogs = false;
    Config.logging.warnLogs = true;
    Config.logging.errorLogs = true;

    const game = new Game(
        "test",
        { mapName, teamMode },
        () => {},
        () => {},
    );
    // Game.init() is async only because of plugin loading, which the mechanic tests
    // don't need. Run the synchronous essentials here so the game actually ticks:
    // generate the map and flip allowJoin, otherwise Game.update() early-returns
    // (`if (!this.allowJoin) return`) and nothing progresses (revive, bleed, kills...).
    game.map.init();
    game.allowJoin = true;
    return game;
}
