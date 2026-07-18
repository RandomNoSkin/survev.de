import { z } from "zod";
import type { CustomLoadoutConfig } from "../../../shared/defs/customLoadout";
import type { MapDefs } from "../../../shared/defs/mapDefs";
import { TeamMode } from "../../../shared/gameConfig";
import type { FindGameError } from "../../../shared/types/api";
import { zCustomLoadoutConfig } from "../../../shared/types/privateLobby";
import { loadoutSchema } from "../../../shared/utils/loadout";
import type { MatchDataTable } from "../api/db/schema";

export interface GameSocketData {
    gameId: string;
    id: string;
    closed: boolean;
    rateLimit: Record<symbol, number>;
    ip: string;
    disconnectReason: string;
}

export const zUpdateRegionBody = z.object({
    regionId: z.string(),
    data: z.object({
        playerCount: z.number(),
        // Default keeps older game servers (that don't send it yet) valid during rollout.
        gameCount: z.number().default(0),
    }),
});
export type UpdateRegionBody = z.infer<typeof zUpdateRegionBody>;

export const zSetGameModeBody = z.object({
    index: z.number(),
    team_mode: z.nativeEnum(TeamMode).optional(),
    map_name: z.string().optional(),
    enabled: z.boolean().optional(),
});

export const zSetClientThemeBody = z.object({
    theme: z.string(),
});

export interface SaveGameBody {
    matchData: (MatchDataTable & { ip: string; findGameIp: string })[];
    /** Per logged-in player: the cosmetic types they had equipped + their match result,
     *  used server-side to attribute games/wins/kills/damage to the owned item instances.
     *  Optional for backward-compat with locally-saved "lost" games. */
    cosmeticStats?: {
        userId: string;
        won: boolean;
        kills: number;
        damage: number;
        types: string[];
    }[];
}

export interface ServerGameConfig {
    readonly mapName: keyof typeof MapDefs;
    readonly teamMode: TeamMode;
    /** Isolated match created from a private lobby: hidden from public matchmaking (see `Game.canJoin`). */
    readonly isPrivate?: boolean;
    /** Arena-mode role pool the private lobby leader narrowed down to; restricts `Game.arenaRoles` when set. */
    readonly arenaRoles?: string[];
    /** Private lobby "Advanced Settings" toggle was on; matches are saved with MapId.Custom so they're excluded from XP. Default false. */
    readonly advancedSettings?: boolean;
    /** Private lobby "Custom Loadout" toggle was on; every player spawns with this loadout instead of the map's default items. */
    readonly customLoadout?: CustomLoadoutConfig;

    readonly customLoadoutEnabled?: boolean; // Whether the private lobby had "Custom Loadout" enabled; used to determine whether to apply the custom loadout or the map's default items, and whether to populate `arenaRoles` (see `Game.arenaRoles`)

    /** Private lobby "Public Spectating" toggle; when false, this match is hidden from the public spectator menu (`/api/game_infos`). Default true. */
    readonly publicSpectating?: boolean;
}

export interface GameData {
    id: string;
    teamMode: TeamMode;
    mapName: string;
    canJoin: boolean;
    /** Isolated match created from a private lobby; joined via tokens, not public matchmaking (see `canJoin`). */
    isPrivate: boolean;
    /** Private lobby "Public Spectating" toggle; when false, hidden from `/api/game_infos`. Default true. */
    publicSpectating: boolean;
    aliveCount: number;
    startedTime: number;
    stopped: boolean;
}

export const zFindGamePrivateBody = z.object({
    region: z.string(),
    version: z.number(),
    autoFill: z.boolean(),
    mapName: z.string(),
    teamMode: z.number(),
    playerData: z.array(
        z.object({
            token: z.string(),
            userId: z.string().nullable(),
            ip: z.string(),
            admin: z.boolean(),
            loadout: loadoutSchema.optional(),
            customLoadout: zCustomLoadoutConfig.optional(),
        }),
    ),
});

export type FindGamePrivateBody = z.infer<typeof zFindGamePrivateBody>;

const zPrivateLobbyPlayerData = z.object({
    token: z.string(),
    userId: z.string().nullable(),
    ip: z.string(),
    admin: z.boolean(),
    loadout: loadoutSchema.optional(),
    customLoadout: zCustomLoadoutConfig.optional(),
});

/** Body for spinning up a fully isolated match from a private lobby; `teams` groups players that should land in the same in-game Group. */
export const zFindPrivateLobbyGameBody = z.object({
    region: z.string(),
    version: z.number(),
    mapName: z.string(),
    teamMode: z.number(),
    teams: z.array(z.array(zPrivateLobbyPlayerData)),
    /** Spectators joining the lobby — each gets its own join token so the game server can authenticate them. */
    spectators: z.array(zPrivateLobbyPlayerData).optional(),
    /** Arena-mode role pool the lobby leader narrowed down to (see `RoomData.enabledArenaRoles`). */
    arenaRoles: z.array(z.string()).optional(),
    /** Mirrors `RoomData.advancedSettings` — when true, the resulting match is excluded from XP. */
    advancedSettings: z.boolean().optional(),
    /** Mirrors `RoomData.customLoadout` — when set, every player spawns with this loadout instead of the map's default items. */
    customLoadout: zCustomLoadoutConfig.optional(),
    customLoadoutEnabled: z.boolean().optional(), // Whether the lobby leader enabled "Custom Loadout" in the private lobby; used to determine whether to apply the custom loadout or the map's default items, and whether to populate `arenaRoles` (see `Game.arenaRoles`)
    /** Mirrors `RoomData.publicSpectating` — when false, the resulting match is hidden from the public spectator menu. */
    publicSpectating: z.boolean().optional(),
});

export type FindPrivateLobbyGameBody = z.infer<typeof zFindPrivateLobbyGameBody>;

export type FindGamePrivateRes =
    | {
          gameId: string;
          useHttps: boolean;
          hosts: string[];
          addrs: string[];
      }
    | { error: FindGameError };

export enum ProcessMsgType {
    Create,
    Created,
    KeepAlive,
    UpdateData,
    AddJoinToken,
    AddJoinTokenAsSpectator,
    AddGroupedJoinTokens,
    SocketMsg,
    SocketClose,
    // Dashboard IPC messages
    GetPlayerData, // API server → game process: request live player list
    PlayerDataResponse, // game process → API server: live player list response
    AdminCmd, // API server → game process: execute an admin action
    GetGameFeed, // API server → game process: request recent kill feed
    GameFeedResponse, // game process → API server: recent kill feed response
}

export interface CreateGameMsg {
    type: ProcessMsgType.Create;
    config: ServerGameConfig;
    id: string;
}

export interface GameCreatedMsg {
    type: ProcessMsgType.Created;
    /** Time spent inside game.init() (map gen + plugins), measured in the child. The
     *  parent logs this alongside the create→ready latency so the cold-fork overhead
     *  (latency minus init) is visible. */
    initMs?: number;
}

export interface KeepAliveMsg {
    type: ProcessMsgType.KeepAlive;
}

export interface UpdateDataMsg extends GameData {
    type: ProcessMsgType.UpdateData;
}

export interface AddJoinTokenMsg {
    type: ProcessMsgType.AddJoinToken;
    autoFill: boolean;
    tokens: FindGamePrivateBody["playerData"];
}

export interface AddJoinTokenAsSpectatorMsg {
    type: ProcessMsgType.AddJoinTokenAsSpectator;
    autoFill: boolean;
    tokens: FindGamePrivateBody["playerData"];
}

/** Used for private lobbies: each entry is a team's player batch, registered as its own join group. */
export interface AddGroupedJoinTokensMsg {
    type: ProcessMsgType.AddGroupedJoinTokens;
    teams: FindGamePrivateBody["playerData"][];
}

/**
 * Used for server to send websocket msgs to game
 * And game to send websocket msgs to clients
 * msgs is an array to batch all msgs created in the same game net tick
 * into the same send call
 */
export interface SocketMsgsMsg {
    type: ProcessMsgType.SocketMsg;
    msgs: Array<{
        socketId: string;
        ip: string;
        data: ArrayBuffer | Uint8Array;
    }>;
}

/**
 * Sent by the server to the game when the socket is closed
 * Or by the game to the server when the game wants to close the socket
 */
export interface SocketCloseMsg {
    type: ProcessMsgType.SocketClose;
    socketId: string;
    reason?: string;
}

/** One player's live state, returned by GetPlayerData. */
export interface DashboardPlayer {
    username: string;
    userId: string;
    encodedIp: string;
    kills: number;
    assists: number;
    alive: boolean;
    isSpectator: boolean;
    /**
     * True only for players that joined the game as a spectator. Those are killed on
     * their first tick (DamageType.Spectator), so `alive` is false for them as an
     * implementation detail — this flag lets the dashboard tell them apart from a real
     * player who died and is now spectating.
     */
    joinedAsSpectator: boolean;
    isAdmin: boolean;
    /** Staff flags, resolved from the accounts DB by the API server (not the game). */
    isModerator?: boolean;
    disconnected: boolean;
}

export interface GetPlayerDataMsg {
    type: ProcessMsgType.GetPlayerData;
    /** Unique request id so the manager can match the response to its Promise. */
    requestId: string;
}

export interface PlayerDataResponseMsg {
    type: ProcessMsgType.PlayerDataResponse;
    requestId: string;
    players: DashboardPlayer[];
}

/** One kill event, buffered in-memory by Game for the live dashboard. */
export interface KillFeedEntry {
    ts: number;
    killerName: string;
    killerUserId: string;
    victimName: string;
    victimUserId: string;
    weapon: string;
}

export interface GetGameFeedMsg {
    type: ProcessMsgType.GetGameFeed;
    requestId: string;
}

export interface GameFeedResponseMsg {
    type: ProcessMsgType.GameFeedResponse;
    requestId: string;
    entries: KillFeedEntry[];
}

/** Actions the dashboard can trigger on a running game. */
export type AdminCmdAction =
    | { action: "freeze" }
    | { action: "unfreeze" }
    | { action: "verify" }
    | { action: "unverify" }
    | { action: "stop" }
    | { action: "kick"; target: string }
    | { action: "announce"; text: string; color?: string; sender?: string }
    | {
          action: "announce_player";
          target: string;
          text: string;
          color?: string;
          sender?: string;
      }
    | { action: "chat"; text: string; sender?: string };

export interface AdminCmdMsg {
    type: ProcessMsgType.AdminCmd;
    cmd: AdminCmdAction;
}

export type ProcessMsg =
    | CreateGameMsg
    | GameCreatedMsg
    | KeepAliveMsg
    | UpdateDataMsg
    | AddJoinTokenMsg
    | AddJoinTokenAsSpectatorMsg
    | AddGroupedJoinTokensMsg
    | SocketMsgsMsg
    | SocketCloseMsg
    | GetPlayerDataMsg
    | PlayerDataResponseMsg
    | AdminCmdMsg
    | GetGameFeedMsg
    | GameFeedResponseMsg;

export interface GameInfo {
    id: string;
    teamMode: TeamMode;
    playerCount: number;
    playerNames: string[];
    runtime: number;
    stopped: boolean;
}
