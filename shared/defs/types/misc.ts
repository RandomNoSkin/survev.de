import { TeamMode } from "../../gameConfig";

export enum MapId {
    Main = 0,
    Desert = 1,
    Woods = 2,
    Faction = 3,
    Potato = 4,
    Savannah = 5,
    Halloween = 6,
    Cobalt = 7,
    Birthday = 8,
    Beach = 9,
    Comp = 10,
    Local = 11,
    TwoVsTwo = 12,
    FourVsFour = 13,
    CompSolo = 14,
    CompDuo = 15,
    Scrims = 16,
    /** Sentinel id for matches saved from "Advanced Settings" private lobbies; intentionally has no `MapDefs` entry so XP calculations treat it as 0. */
    Custom = 17,
}

export const TeamModeToString = {
    [TeamMode.Solo]: "solo",
    [TeamMode.Duo]: "duo",
    [TeamMode.Squad]: "squad",
};
