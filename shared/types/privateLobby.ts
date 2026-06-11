// /api/private_lobby_v2 websocket msgs typing

import { z } from "zod";
import type { CustomLoadoutConfig } from "../defs/customLoadout";
import type { FindGameMatchData } from "./api";

export type PrivateLobbyErrorType =
    | "join_full"
    | "join_not_found"
    | "join_failed"
    | "create_failed"
    | "lost_conn"
    | "join_game_failed"
    | "find_game_error"
    | "find_game_full"
    | "find_game_invalid_protocol"
    | "kicked"
    | "banned"
    | "behind_proxy"
    | "rate_limited"
    | "login_required"
    | "mode_disabled"
    | "team_full"
    | "host_left";

export interface RoomData {
    roomUrl: string;
    findingGame: boolean;
    lastError: PrivateLobbyErrorType | "";
    region: string;
    enabledGameModeIdxs: number[];
    gameModeIdx: number;
    /** Full lobby capacity, taken from the selected mode's map (`mapDef.gameMode.maxPlayers`). */
    maxPlayers: number;
    /** Number of players per team for the selected mode (1 for Solo). */
    teamSize: number;
    /** Number of team slots available (`maxPlayers / teamSize`). */
    teamCount: number;
    /** Arena-mode roles the leader has enabled for the match (subset of the map's `arenaModeRoles`). Empty for non-arena modes. */
    enabledArenaRoles: string[];
    /** When true, any member (not just the leader) can click a team slot to join it. Default true. */
    allowMembersJoinTeams: boolean;
    /** When true, this lobby's matches are listed in the public spectator menu. Default true. */
    publicSpectating: boolean;
    /** When true, this lobby's matches do not count towards XP, and an "Advanced Settings" tab is shown. Default false. */
    advancedSettings: boolean;
    /** When true, every player spawns with `customLoadout` instead of the map's default items, and Arena Roles are disabled. Default false. */
    customLoadoutEnabled: boolean;
    /** Leader-configured spawn loadout, applied when `customLoadoutEnabled` is true. */
    customLoadout: CustomLoadoutConfig;
    /** Additional named loadouts ("Custom Loadout 01", "02", ...) the leader can configure and assign to specific players via `PrivateLobbyMenuPlayer.loadoutIndex`. Max length: MAX_EXTRA_CUSTOM_LOADOUTS. */
    extraCustomLoadouts: CustomLoadoutConfig[];
}

//
// Private lobby msgs that the server sends to clients
//

/**
 * send by the server to all clients to make them join the game
 */
export interface PrivateLobbyJoinGameMsg {
    readonly type: "joinGame";
    data: FindGameMatchData;
}

export interface PrivateLobbyMenuPlayer {
    name: string;
    playerId: number;
    isLeader: boolean;
    inGame: boolean;
    /** Lobby-local team slot index this player is currently assigned to. */
    teamId: number;
    /** True when the player has self-marked as AFK. Cleared automatically when a match starts. */
    afk: boolean;
    /** True when the player joined via a spectator invite link (`#CODE-s`). */
    spectator: boolean;
    /** Index into the lobby's loadout list (0 = `customLoadout`, 1+ = `extraCustomLoadouts[index - 1]`) this player spawns with when `customLoadoutEnabled` is true. Default 0. */
    loadoutIndex: number;
}

/**
 * Send by the server to update the client lobby ui
 */
export interface PrivateLobbyStateMsg {
    readonly type: "state";
    data: {
        localPlayerId: number; // always -1 by default since it can only be set when the socket is actually sending state to each individual client
        room: RoomData;
        players: PrivateLobbyMenuPlayer[];
        /** Win count per lobby team slot index. Only present when at least one game has been won. */
        teamScores: Record<number, number>;
    };
}

/**
 * Send by the server when the player gets kicked from the lobby room
 */
export interface PrivateLobbyKickedMsg {
    readonly type: "kicked";
    data: {};
}

/**
 * Sent by the server to every in-game member of the lobby when the leader
 * pulls the whole lobby out of an active match early (see Room#forceQuitGame).
 * The client force-disconnects from its current match and returns to the lobby.
 */
export interface PrivateLobbyForceQuitMsg {
    readonly type: "forceQuit";
    data: {};
}

export interface PrivateLobbyErrorMsg {
    readonly type: "error";
    data: {
        type: PrivateLobbyErrorType;
    };
}

export type ServerToClientPrivateLobbyMsg =
    | PrivateLobbyJoinGameMsg
    | PrivateLobbyStateMsg
    | PrivateLobbyKeepAliveMsg
    | PrivateLobbyKickedMsg
    | PrivateLobbyForceQuitMsg
    | PrivateLobbyErrorMsg;

//
// Private lobby msgs that the client sends to the server
//

export const zCustomLoadoutConfig = z.object({
    name: z.string().optional(),
    weapons: z.tuple([z.string(), z.string(), z.string(), z.string()]),
    helmet: z.string(),
    chest: z.string(),
    backpack: z.string(),
    scope: z.string(),
    // Tolerate (and drop) non-string entries instead of rejecting the whole
    // message: older clients could leave holes in this array (picking a perk in
    // a non-contiguous slot), which JSON-serialize to null. A hard rejection
    // would disconnect the leader and let the broken loadout get re-saved
    // client-side; dropping them here lets validateCustomLoadout clean the rest
    // and broadcast a healed loadout back.
    perks: z
        .array(z.any())
        .transform((perks) => perks.filter((p): p is string => typeof p === "string")),
    inventory: z.record(z.string(), z.number()),
    arenaMode: z.boolean().default(false),
    unlimitedAdren: z.boolean().default(false),
    unlimitedAmmo: z.boolean().default(false),
    allowPickup: z.boolean().default(false),
});

export const zClientRoomData = z.object({
    roomUrl: z.string(),
    findingGame: z.boolean(),
    lastError: z.string(),
    region: z.string(),
    gameModeIdx: z.number(),
    enabledArenaRoles: z.array(z.string()).optional(),
    allowMembersJoinTeams: z.boolean().optional(),
    publicSpectating: z.boolean().optional(),
    advancedSettings: z.boolean().optional(),
    customLoadoutEnabled: z.boolean().optional(),
    customLoadout: zCustomLoadoutConfig.optional(),
    extraCustomLoadouts: z.array(zCustomLoadoutConfig).optional(),
});

export type ClientRoomData = z.infer<typeof zClientRoomData>;

/** Subset of `ClientRoomData` persisted client-side (`config.privateLobbySettings`) and re-applied when the player creates a new lobby. */
export type SavedPrivateLobbySettings = Pick<
    ClientRoomData,
    | "allowMembersJoinTeams"
    | "publicSpectating"
    | "advancedSettings"
    | "customLoadoutEnabled"
    | "customLoadout"
    | "extraCustomLoadouts"
    | "enabledArenaRoles"
>;

export const zKeepAliveMsg = z.object({
    type: z.literal("keepAlive"),
    data: z.object({}).optional(),
});
export type PrivateLobbyKeepAliveMsg = z.infer<typeof zKeepAliveMsg>;

export const zPrivateLobbyJoinMsg = z.object({
    type: z.literal("join"),
    data: z.object({
        roomUrl: z.string(),
        playerData: z.object({
            name: z.string(),
        }),
        /**
         * Set when joining as part of a pre-formed "Create Team" group handoff.
         * All joins sharing the same id within a short window are placed together
         * into the same team slot (see section 5 of the private lobby plan).
         */
        importGroupId: z.string().optional(),
        /**
         * Set when joining via a team-specific invite link/code (e.g. "ABC123-2").
         * Places the player directly into that team slot, or rejects the join
         * with a "team_full" error if it has no room (see Room.addPlayer).
         */
        teamId: z.number().optional(),
        /** Set when joining via a spectator invite link/code (e.g. "ABC123-s"). */
        spectator: z.boolean().optional(),
    }),
});
export type PrivateLobbyJoinMsg = z.infer<typeof zPrivateLobbyJoinMsg>;

export const zPrivateLobbyChangeNameMsg = z.object({
    type: z.literal("changeName"),
    data: z.object({
        name: z.string(),
    }),
});

export type PrivateLobbyChangeNameMsg = z.infer<typeof zPrivateLobbyChangeNameMsg>;

export const zPrivateLobbySetRoomPropsMsg = z.object({
    type: z.literal("setRoomProps"),
    data: zClientRoomData,
});

export type PrivateLobbySetRoomPropsMsg = z.infer<typeof zPrivateLobbySetRoomPropsMsg>;

export const zPrivateLobbyCreateMsg = z.object({
    type: z.literal("create"),
    data: z.object({
        roomData: zClientRoomData,
        playerData: z.object({
            name: z.string(),
        }),
    }),
});

export type PrivateLobbyCreateMsg = z.infer<typeof zPrivateLobbyCreateMsg>;

export const zPrivateLobbyKickMsg = z.object({
    type: z.literal("kick"),
    data: z.object({
        playerId: z.number(),
    }),
});

export type PrivateLobbyKickMsg = z.infer<typeof zPrivateLobbyKickMsg>;

/** Leader-only: hands lobby ownership over to another player. */
export const zPrivateLobbyPromoteMsg = z.object({
    type: z.literal("promote"),
    data: z.object({
        playerId: z.number(),
    }),
});

export type PrivateLobbyPromoteMsg = z.infer<typeof zPrivateLobbyPromoteMsg>;

/** Leader-only: moves a player into a different team slot. */
export const zPrivateLobbyAssignTeamMsg = z.object({
    type: z.literal("assignTeam"),
    data: z.object({
        playerId: z.number(),
        teamId: z.number(),
    }),
});

export type PrivateLobbyAssignTeamMsg = z.infer<typeof zPrivateLobbyAssignTeamMsg>;

/** Leader-only: assigns a player to spawn with a specific configured loadout (0 = `customLoadout`, 1+ = `extraCustomLoadouts[index - 1]`). */
export const zPrivateLobbyAssignLoadoutMsg = z.object({
    type: z.literal("assignLoadout"),
    data: z.object({
        playerId: z.number(),
        loadoutIndex: z.number(),
    }),
});

export type PrivateLobbyAssignLoadoutMsg = z.infer<typeof zPrivateLobbyAssignLoadoutMsg>;

/** Leader-only: swaps two players' team slots. */
export const zPrivateLobbySwapTeamMsg = z.object({
    type: z.literal("swapTeam"),
    data: z.object({
        playerId: z.number(),
        targetPlayerId: z.number(),
    }),
});

export type PrivateLobbySwapTeamMsg = z.infer<typeof zPrivateLobbySwapTeamMsg>;

/** Any player: toggles their own AFK state. */
export const zPrivateLobbySetAfkMsg = z.object({
    type: z.literal("setAfk"),
    data: z.object({ afk: z.boolean() }),
});

export type PrivateLobbySetAfkMsg = z.infer<typeof zPrivateLobbySetAfkMsg>;

/** Any player (including the leader): toggles their own spectator status. */
export const zPrivateLobbySetSpectatorMsg = z.object({
    type: z.literal("setSpectator"),
    data: z.object({ spectator: z.boolean() }),
});

export type PrivateLobbySetSpectatorMsg = z.infer<typeof zPrivateLobbySetSpectatorMsg>;

/** Leader-only: pulls the whole lobby out of an active match back to the lobby. */
export const zPrivateLobbyLeaveGameMsg = z.object({
    type: z.literal("leaveGame"),
    data: z.object({}).optional(),
});

export type PrivateLobbyLeaveGameMsg = z.infer<typeof zPrivateLobbyLeaveGameMsg>;

export const zPrivateLobbyPlayGameMsg = z.object({
    type: z.literal("playGame"),
    data: z.object({
        version: z.number(),
        region: z.string(),
    }),
});

export type PrivateLobbyPlayGameMsg = z.infer<typeof zPrivateLobbyPlayGameMsg>;

export const zGameCompleteMsg = z.object({
    type: z.literal("gameComplete"),
    data: z
        .object({
            /** True when the local player's in-game team won the match. */
            wonGame: z.boolean().optional(),
            /** The lobby team slot index of the winning team (only set when wonGame is true). */
            lobbyTeamId: z.number().optional(),
        })
        .optional(),
});

export type PrivateLobbyGameCompleteMsg = z.infer<typeof zGameCompleteMsg>;

export const zPrivateLobbyResetScoresMsg = z.object({
    type: z.literal("resetScores"),
    data: z.object({}).optional(),
});

export type PrivateLobbyResetScoresMsg = z.infer<typeof zPrivateLobbyResetScoresMsg>;

export const zPrivateLobbyClientMsg = z.discriminatedUnion("type", [
    zPrivateLobbyCreateMsg,
    zPrivateLobbySetRoomPropsMsg,
    zPrivateLobbyJoinMsg,
    zPrivateLobbyPlayGameMsg,
    zPrivateLobbyLeaveGameMsg,
    zPrivateLobbySetAfkMsg,
    zPrivateLobbySetSpectatorMsg,
    zPrivateLobbyKickMsg,
    zPrivateLobbyPromoteMsg,
    zPrivateLobbyAssignTeamMsg,
    zPrivateLobbyAssignLoadoutMsg,
    zPrivateLobbySwapTeamMsg,
    zPrivateLobbyChangeNameMsg,
    zGameCompleteMsg,
    zPrivateLobbyResetScoresMsg,
    zKeepAliveMsg,
]);

export type ClientToServerPrivateLobbyMsg =
    | PrivateLobbyKeepAliveMsg
    | PrivateLobbyJoinMsg
    | PrivateLobbyChangeNameMsg
    | PrivateLobbySetRoomPropsMsg
    | PrivateLobbyCreateMsg
    | PrivateLobbyKickMsg
    | PrivateLobbyPromoteMsg
    | PrivateLobbyAssignTeamMsg
    | PrivateLobbyAssignLoadoutMsg
    | PrivateLobbySwapTeamMsg
    | PrivateLobbyGameCompleteMsg
    | PrivateLobbyPlayGameMsg
    | PrivateLobbyLeaveGameMsg
    | PrivateLobbySetAfkMsg
    | PrivateLobbySetSpectatorMsg
    | PrivateLobbyResetScoresMsg;
