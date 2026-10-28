import { z } from "zod";
import { MapId, TeamMode } from "../gameConfig.ts";
import type { ImpactBreakdown } from "../impactScore.ts";
import type { RoleTag } from "./user.ts";
import {
    STATS_COMPARE_RE,
    STATS_MONTH_RE,
    STATS_PERIODS,
    type StatsPeriod,
    type StatsRange,
    type StatsSeason,
} from "../statsPeriods.ts";

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

/** Another player on the same team in that match. */
export interface MatchHistoryTeammate {
    username: string;
    /** null when the teammate wasn't a logged-in account (guest). */
    slug: string | null;
}

export type MatchHistory = {
    guid: string;
    region: string;
    map_id: number;
    team_mode: number;
    team_count: number;
    team_total: number;
    /** This match's team id (shared with every entry in `teammates`). */
    team_id: number;
    end_time: string | Date;
    time_alive: number;
    rank: number;
    kills: number;
    assists: number;
    team_kills: number;
    damage_dealt: number;
    damage_taken: number;
    /** Display name used for this specific match (can differ from the account's
     *  current username if it was changed since). */
    username: string;
    teammates: MatchHistoryTeammate[];
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
    roleTag: RoleTag;
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
    revives: number;
    teammate_saves: number;
    /** Impact score (0-100), null in solo or on maps that don't opt in. */
    impact_score: number | null;
    impact_breakdown: ImpactBreakdown | null;
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
    /** a calendar month "YYYY-MM" - wins over the interval */
    month: z.string().regex(STATS_MONTH_RE).optional(),
    slug: z.string().min(1),
    mapIdFilter: z.enum([ALL_MAPS, ...VALID_MAP_IDS]),
});

export type UserStatsRequest = z.infer<typeof zUserStatsRequest>;

export type UserStatsResponse = {
    slug: string;
    username: string;
    roleTag: RoleTag;
    player_icon: string;
    banned: boolean;
    /** Geographic region group (e.g. "eu", "as") this account plays most of its rated matches
     *  in — null until it has at least one impact-scored match. Scopes `rating`/`tier` below
     *  to a same-region cohort; recomputed daily. */
    primaryRegion: string | null;
    wins: number;
    kills: number;
    assists: number;
    games: number;
    kpg: string;
    modes: Mode[];
};

export interface Mode {
    teamMode: number;
    games: number;
    wins: number;
    kills: number;
    assists: number;
    winPct: string;
    mostKills: number;
    mostDamage: number;
    kpg: string;
    avgDamage: number;
    avgTimeAlive: number;
    /** Average impact score across this mode's matches played in the account's primary
     *  region (null = none, e.g. solo-only or no rated matches in that region yet). */
    rating: number | null;
    /** Letter tier (F..S) for `rating`, from the daily-computed percentile cutoffs for this
     *  (teamMode, primaryRegion) cohort — null when `rating` is null. */
    tier: string | null;
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
    "most_damage",
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
    mostDamage: number;
    avgKillsPerGame: number;
}
export type WeaponStatsResponse = WeaponStatsEntry[];

//
// Server Stats (aggregate server-wide activity for the public /stats?view=server page)
//
export const zServerStatsRequest = z.object({
    period: z.enum(STATS_PERIODS).default("week"),
    /** with period "season": which one (default the current) */
    season: z.string().max(40).optional(),
    /** a calendar month "YYYY-MM" - wins over the period */
    month: z.string().regex(STATS_MONTH_RE).optional(),
    /** what to compare with, see applyStatsCompare */
    compare: z.string().regex(STATS_COMPARE_RE).optional(),
    teamMode: z.number().int().optional(),
    region: z.string().max(40).optional(),
    mapId: z.number().int().optional(),
});

export type ServerStatsRequest = z.input<typeof zServerStatsRequest>;

/** One set of activity numbers (a whole window, or one mode / region / map of it). */
export interface ServerStatsMetrics {
    /** Distinct games played. */
    games: number;
    /** Player-games (one row per player per game). */
    participations: number;
    /** Distinct players by encoded IP (includes anonymous). */
    uniquePlayers: number;
    /** Distinct logged-in accounts. */
    registeredPlayers: number;
    avgPlayersPerGame: number;
    /** Average match length in seconds (longest survival per game). */
    avgDurationSec: number;
    kills: number;
    killsPerPlayer: number;
    damagePerPlayer: number;
}

export interface ServerStatsResponse {
    period: StatsPeriod;
    /** epoch ms */
    range: { from: number | null; to: number };
    prevRange: { from: number; to: number } | null;
    seasons: StatsSeason[];
    season?: string;
    /** the calendar month shown, if one was picked */
    month?: string;
    totals: ServerStatsMetrics;
    /** The window before (same length), for the deltas; null for "all time". */
    previous: ServerStatsMetrics | null;
    byTeamMode: (ServerStatsMetrics & { teamMode: number })[];
    byRegion: (ServerStatsMetrics & { region: string })[];
    byMap: (ServerStatsMetrics & { mapId: number })[];
    bucket: StatsRange["bucket"];
    /** Bucketed activity over time (bucket = ISO timestamp). */
    timeseries: { bucket: string; games: number; players: number }[];
    /** The same for the window before, aligned by index. */
    prevTimeseries: { bucket: string; games: number; players: number }[];
    /** Games started per hour of day (UTC). */
    hourOfDay: { hour: number; games: number }[];
    /** What the filters can be set to. */
    options: { teamModes: number[]; regions: string[]; mapIds: number[] };
    /** Current live activity (not cached; sampled from the region heartbeats). */
    live: {
        totalPlayers: number;
        totalGames: number;
        regions: { region: string; playerCount: number; gameCount: number }[];
    };
    generatedAt: number;
}

//
// Extended profile stats (Premium accounts' profiles, /stats/?slug=…)
//
export const zUserProfileStatsRequest = z.object({
    slug: z.string().max(60),
    period: z.enum(STATS_PERIODS).default("alltime"),
    /** with period "season": which one (default the current) */
    season: z.string().max(40).optional(),
    /** a calendar month "YYYY-MM" - wins over the period */
    month: z.string().regex(STATS_MONTH_RE).optional(),
    /** what to compare with, see applyStatsCompare */
    compare: z.string().regex(STATS_COMPARE_RE).optional(),
    teamMode: z.number().int().optional(),
    /** only this map (MapId) */
    mapId: z.number().int().optional(),
});

export type UserProfileStatsRequest = z.input<typeof zUserProfileStatsRequest>;

export interface UserProfileOverview {
    games: number;
    wins: number;
    /** 0-100 */
    winRate: number;
    top5: number;
    kills: number;
    deaths: number;
    kd: number;
    assists: number;
    avgKills: number;
    avgDamage: number;
    totalDamage: number;
    maxKills: number;
    maxDamage: number;
    /** seconds */
    avgTimeAlive: number;
    totalTimeAlive: number;
    revives: number;
    teammateSaves: number;
    avgRank: number;
    /** null when no match in the window had an impact score */
    avgImpact: number | null;
    shots: number;
    hits: number;
    /** 0-100; null without tracked shots */
    accuracy: number | null;
}

export interface UserProfileWeapon {
    weaponType: string;
    games: number;
    kills: number;
    damage: number;
    avgDamage: number;
    maxDamage: number;
    shots: number;
    hits: number;
    accuracy: number | null;
}

/** Head-to-head against one opponent: clean 1v1 kills in local mode (see Game.recordDuel). */
export interface UserProfileDuel {
    slug: string;
    username: string;
    duels: number;
    wins: number;
    losses: number;
    /** 0-100 */
    winRate: number;
}

export interface UserProfileStatsResponse {
    /** false: the account has no Premium - nothing else is sent */
    premium: boolean;
    /** 1v1 opponents, most duels first */
    duels?: UserProfileDuel[];
    /** the player turned "Track 1v1s" off - no duels are shown */
    duelsHidden?: boolean;
    username?: string;
    period?: StatsPeriod;
    range?: { from: number | null; to: number };
    prevRange?: { from: number; to: number } | null;
    seasons?: StatsSeason[];
    season?: string;
    month?: string;
    overview?: UserProfileOverview;
    /** the window before, same length (null: nothing to compare with) */
    previous?: UserProfileOverview | null;
    byMode?: { teamMode: number; games: number; wins: number; kills: number; kd: number; avgDamage: number; winRate: number }[];
    byMap?: { mapId: number; games: number; wins: number; kills: number; avgDamage: number; winRate: number }[];
    /** weapon stats are tracked per day from their introduction on */
    weapons?: UserProfileWeapon[];
    bucket?: StatsRange["bucket"];
    activity?: { bucket: string; games: number; kills: number; wins: number }[];
}
