import { z } from "zod";
import { MapId, TeamMode } from "../gameConfig.ts";

//
// Match History
//

/**
 * sent by the client when to teammode filter is selected
 */
export const ALL_TEAM_MODES = 7;
export const zMatchHistoryRequest = z.object({
    slug: z.string(),
    offset: z.number(),
    count: z.number(),
    teamModeFilter: z.union([
        z.literal(TeamMode.Solo),
        z.literal(TeamMode.Duo),
        z.literal(TeamMode.Squad),
        z.literal(ALL_TEAM_MODES),
    ]),
});

export type MatchHistoryParams = z.infer<typeof zMatchHistoryRequest>;

export type MatchHistory = {
    guid: string;
    region: string;
    map_id: number;
    team_mode: number;
    team_count: number;
    team_total: number;
    end_time: string | Date;
    time_alive: number;
    rank: number;
    kills: number;
    team_kills: number;
    damage_dealt: number;
    damage_taken: number;
};
export type MatchHistoryResponse = MatchHistory[];

//
// Match Data
//
export const zMatchDataRequest = z.object({
    gameId: z.string(),
});

export type MatchDataRequest = z.infer<typeof zMatchDataRequest>;
export type MatchDataResponse = MatchData[];

export type MatchData = {
    slug: string | null;
    username: string;
    player_id: number;
    team_id: number;
    time_alive: number;
    rank: number;
    died: boolean;
    kills: number;
    damage_dealt: number;
    damage_taken: number;
    killer_id: number;
    killed_ids: number[];
    /** Non-default cosmetics this player had equipped for the match ([] when private). */
    equipped_cosmetics: string[];
    role: string;
};

//
// User Stats
//
export const ALL_MAPS = "-1";
const VALID_MAP_IDS = Object.values(MapId)
    .filter((id) => typeof id === "number")
    .map((id) => id.toString()) as [string, ...string[]];

export const zUserStatsRequest = z.object({
    interval: z.enum(["daily", "weekly", "alltime"]),
    slug: z.string().min(1),
    mapIdFilter: z.enum([ALL_MAPS, ...VALID_MAP_IDS]),
});

export type UserStatsRequest = z.infer<typeof zUserStatsRequest>;

export type UserStatsResponse = {
    slug: string;
    username: string;
    player_icon: string;
    banned: boolean;
    wins: number;
    kills: number;
    games: number;
    kpg: string;
    modes: Mode[];
};

export interface Mode {
    teamMode: number;
    games: number;
    wins: number;
    kills: number;
    winPct: string;
    mostKills: number;
    mostDamage: number;
    kpg: string;
    avgDamage: number;
    avgTimeAlive: number;
}

//
// Leaderboard
//
const teamModeMap = {
    solo: TeamMode.Solo,
    duo: TeamMode.Duo,
    squad: TeamMode.Squad,
};

export const zLeaderboardsRequest = z.object({
    interval: z.enum(["daily", "weekly", "alltime"]),
    mapId: z.enum(VALID_MAP_IDS).transform((v) => Number(v)),
    type: z.enum(["most_kills", "most_damage_dealt", "kpg", "kills", "wins"]),
    teamMode: z.enum(["solo", "duo", "squad"]).transform((mode) => teamModeMap[mode]),
});

export type LeaderboardResponse =
    & {
        val: number;
        region: string;
        /**
         * not used
         */
        active?: boolean;
        /**
         * required for all types except most_kills & win_streak
         */
        games?: number;
    }
    & (
        | {
            slug: string | null;
            username: string;
        }
        | {
            slugs: (string | null)[];
            usernames: string[];
        }
    );

export type LeaderboardRequest = z.infer<typeof zLeaderboardsRequest>;

//
// Weapon Stats (weapon damage/kills ranking, filterable by map, mode and date range)
//
export const WEAPON_STATS_SORT_BY = [
    "games",
    "damage",
    "damage_per_game",
    "kills",
    "kills_per_game",
] as const;

/** Top N rows returned per request, ranked by `sortBy`. */
export const WEAPON_STATS_MAX_RESULTS = 100;

/** Minimum games a weapon needs to qualify when ranking by a per-game average
 *  (`damage_per_game`/`kills_per_game`), so a weapon used once with a lucky game
 *  can't top the ranking. Doesn't apply to the raw-total sorts (games/damage/kills). */
export const WEAPON_STATS_MIN_GAMES_FOR_PER_GAME = 10;

export const zWeaponStatsRequest = z.object({
    /** ISO date (YYYY-MM-DD), inclusive. */
    from: z.string(),
    /** ISO date (YYYY-MM-DD), inclusive. */
    to: z.string(),
    mapIdFilter: z.enum([ALL_MAPS, ...VALID_MAP_IDS]),
    teamModeFilter: z.union([
        z.literal(TeamMode.Solo),
        z.literal(TeamMode.Duo),
        z.literal(TeamMode.Squad),
        z.literal(ALL_TEAM_MODES),
    ]),
    sortBy: z.enum(WEAPON_STATS_SORT_BY),
});

export type WeaponStatsRequest = z.infer<typeof zWeaponStatsRequest>;
export type WeaponStatsSortBy = WeaponStatsRequest["sortBy"];

export interface WeaponStatsEntry {
    type: string;
    name: string;
    totalDamage: number;
    kills: number;
    gamesUsed: number;
    avgDamagePerGame: number;
    avgKillsPerGame: number;
}
export type WeaponStatsResponse = WeaponStatsEntry[];

//
// Server Stats (aggregate server-wide activity for the public /stats?view=server page)
//
export const zServerStatsRequest = z.object({
    interval: z.enum(["daily", "weekly", "monthly", "yearly", "alltime"]),
});

export type ServerStatsRequest = z.infer<typeof zServerStatsRequest>;
export type ServerStatsInterval = ServerStatsRequest["interval"];

export interface ServerStatsResponse {
    interval: ServerStatsInterval;
    totals: {
        /** Distinct games played. */
        games: number;
        /** Player-games (one row per player per game). */
        participations: number;
        /** Distinct players by encoded IP (includes anonymous). */
        uniquePlayers: number;
        /** Distinct logged-in accounts. */
        registeredPlayers: number;
    };
    byTeamMode: { teamMode: number; games: number; participations: number }[];
    byRegion: { region: string; games: number; participations: number }[];
    byMap: { mapId: number; games: number }[];
    /** Bucketed activity over time (bucket = ISO timestamp). */
    timeseries: { bucket: string; games: number; players: number }[];
    /** Current live activity (not cached; sampled from the region heartbeats). */
    live: {
        totalPlayers: number;
        totalGames: number;
        regions: { region: string; playerCount: number; gameCount: number }[];
    };
    generatedAt: number;
}
