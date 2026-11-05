import { GameMode } from "../../../../shared/gameConfig";
import type { Game } from "../game";
import { GunGame } from "./gunGame";
import type { ModeRules } from "./modeRules";

/** The rules module for the game's GameMode; undefined for the standard battle royale. */
export function createModeRules(game: Game): ModeRules | undefined {
    switch (game.gameMode) {
        case GameMode.GunGame:
            return new GunGame(game);
        default:
            return undefined;
    }
}
