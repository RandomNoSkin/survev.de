import { describe, expect, test, vi } from "vitest";

// no DB in tests: lobby members have no stored loadouts
vi.mock("../../server/src/api/db/loadouts.ts", () => ({ getOwnedLoadouts: async () => [] }));
// no DB: everyone plays the default arena loadout
vi.mock("../../server/src/api/db/arena.ts", () => ({
    getJoinArenaLoadouts: async () => [{ primary: "hk416", pistol: "p30l", throwable: "frag", perk: "takedown" }],
    getJoinArenaStreaks: async () => ({ airdrop: "flare_gun", juggernaut: "m134", airdropWeapon: "m249", brokenArrow: false }),
}));

import { Config } from "../../server/src/config.ts";
// load order as in the real server: apiServer creates the PrivateLobbyMenu while loading,
// so importing privateLobby first would hit it mid-definition (import cycle via auth)
import "../../server/src/api/apiServer.ts";
import { Player, PrivateLobbyMenu, Room } from "../../server/src/privateLobby.ts";
import { gunGameMapScale } from "../../shared/defs/modes/gunGameDefs.ts";
import { MapDefs } from "../../shared/defs/mapDefs.ts";
import { GameMode, MapId, TeamMode } from "../../shared/gameConfig.ts";
import type { ClientRoomData } from "../../shared/types/privateLobby.ts";
import { createGame } from "./gameTestHelpers.ts";

const region = Object.keys(Config.regions)[0] ?? "local";
const MODES = [
    { mapName: "local", teamMode: TeamMode.Solo, enabled: true },
    { mapName: "two_vs_two", teamMode: TeamMode.Duo, enabled: true },
    { mapName: "comp", teamMode: TeamMode.Squad, enabled: true },
    // the arena client's modes (anyone can pick those)
    { mapName: "gungame", teamMode: TeamMode.Solo, gameMode: GameMode.GunGame, arena: true, enabled: true },
    { mapName: "domination", teamMode: TeamMode.Squad, gameMode: GameMode.Domination, arena: true, enabled: true },
];

function lobby(modeIdx = 0) {
    const createPrivateGame = vi.fn(async (_body: any) => ({ gameId: "game", useHttps: false, hosts: ["h"], addrs: ["h"] }));
    const server = { modesByRegion: { [region]: MODES }, createPrivateGame } as any;
    const menu = new PrivateLobbyMenu(server);
    const room = new Room(menu, "TEST", props({ gameModeIdx: modeIdx }));
    const join = (opts: { owner?: boolean; premium?: boolean; userId?: string } = {}) => {
        const socket = { send: vi.fn(), close: vi.fn(), raw: {} } as any;
        const p = new Player(socket, menu, opts.userId ?? null, "1.2.3.4", false, opts.premium ?? false, null, opts.owner ?? false);
        p.setName(`P${room.players.length}`);
        room.addPlayer(p);
        return p;
    };
    return { room, join, createPrivateGame };
}

function props(over: Partial<ClientRoomData> = {}): ClientRoomData {
    return { roomUrl: "", findingGame: false, lastError: "", region, gameModeIdx: 0, ...over };
}

/** the leader changes settings (bypasses the 1/s rate limit of setRoomProps) */
function set(room: Room, over: Partial<ClientRoomData>) {
    room.setProps(props({ ...room.data, ...over } as ClientRoomData));
    room.sendState();
}

async function start(room: Room) {
    await room.findGame({ region, version: 0 } as any);
}

describe("member lobby (leader is not an owner)", () => {
    test("plays the selected mode with XP, owner settings are refused", async () => {
        const { room, join, createPrivateGame } = lobby(2);
        join();
        join();
        set(room, { specialMode: GameMode.GunGame, xpEnabled: false });
        expect(room.data.leaderOwner).toBe(false);
        expect(room.data.specialMode).toBeUndefined();
        expect(room.data.xpEnabled).toBeUndefined();
        expect(room.data.teamSize).toBe(TeamMode.Squad);

        await start(room);
        const body = createPrivateGame.mock.calls[0][0];
        expect(body.mapName).toBe("comp");
        expect(body.teamMode).toBe(TeamMode.Squad);
        expect(body.gameMode).toBeUndefined();
        expect(body.xpEnabled).toBeUndefined();
        // both players in the first team slot
        expect(body.teams).toHaveLength(1);
        expect(body.teams[0]).toHaveLength(2);
    });

    test("only the leader changes settings", () => {
        const { room, join } = lobby(0);
        join();
        const member = join();
        room.onMsg(member, { type: "setRoomProps", data: props({ ...room.data, gameModeIdx: 2 }) } as any);
        expect(room.data.gameModeIdx).toBe(0);
    });

    test("Advanced Settings still mean no XP, Premium features stay off without Premium", async () => {
        const { room, join, createPrivateGame } = lobby(0);
        join();
        set(room, { advancedSettings: true, customMapEnabled: true });
        expect(room.data.customMapEnabled).toBe(false);
        await start(room);
        const body = createPrivateGame.mock.calls[0][0];
        expect(body.advancedSettings).toBe(true);
        expect(body.xpEnabled).toBeUndefined();
        expect(body.customMap).toBeUndefined();
    });

    test("solo lobby: every player in their own slot", async () => {
        const { room, join, createPrivateGame } = lobby(0);
        join();
        join();
        join();
        await start(room);
        expect(createPrivateGame.mock.calls[0][0].teams.map((t: unknown[]) => t.length)).toStrictEqual([1, 1, 1]);
    });
});

describe("owner lobby", () => {
    test("Gun Game: its own map, solo, the Gun Game rules and its player limit", async () => {
        const { room, join, createPrivateGame } = lobby(2);
        join({ owner: true });
        join();
        set(room, { specialMode: GameMode.GunGame });
        expect(room.data.leaderOwner).toBe(true);
        expect(room.data.specialMode).toBe(GameMode.GunGame);
        expect(room.data.teamSize).toBe(1);
        expect(room.data.modeMaxPlayers).toBe(MapDefs.gungame.gameMode.maxPlayers);

        await start(room);
        const body = createPrivateGame.mock.calls[0][0];
        expect(body.mapName).toBe("gungame");
        expect(body.teamMode).toBe(TeamMode.Solo);
        expect(body.gameMode).toBe(GameMode.GunGame);
        expect(body.mapScale).toBe(1);
    });

    test("Gun Game: a bigger player limit makes a bigger map", async () => {
        const { room, join, createPrivateGame } = lobby(0);
        join({ owner: true });
        set(room, { specialMode: GameMode.GunGame });
        set(room, { playerLimit: 20 });
        expect(room.data.maxPlayers).toBe(20);
        await start(room);
        expect(createPrivateGame.mock.calls[0][0].mapScale).toBe(gunGameMapScale(20));
        expect(gunGameMapScale(20)).toBeCloseTo(Math.SQRT2, 1);
    });

    test("XP on with Advanced Settings, or off without", async () => {
        const a = lobby(0);
        a.join({ owner: true });
        set(a.room, { advancedSettings: true, xpEnabled: true });
        await start(a.room);
        expect(a.createPrivateGame.mock.calls[0][0].xpEnabled).toBe(true);

        const b = lobby(0);
        b.join({ owner: true });
        set(b.room, { xpEnabled: false });
        await start(b.room);
        expect(b.createPrivateGame.mock.calls[0][0].xpEnabled).toBe(false);
    });

    test("handing the lobby to a non-owner turns the owner settings off", () => {
        const { room, join } = lobby(2);
        join({ owner: true });
        const member = join();
        set(room, { specialMode: GameMode.GunGame, xpEnabled: false });
        expect(room.data.specialMode).toBe(GameMode.GunGame);
        room.promote(member.playerId);
        expect(room.data.leaderOwner).toBe(false);
        expect(room.data.specialMode).toBeUndefined();
        expect(room.data.xpEnabled).toBeUndefined();
        expect(room.data.teamSize).toBe(TeamMode.Squad);
    });

    test("Domination: its own map, two teams (groups) of six as the lobby split them", async () => {
        const { room, join, createPrivateGame } = lobby(2);
        const owner = join({ owner: true });
        const others = [join(), join(), join()];
        set(room, { specialMode: GameMode.Domination });
        expect(room.data.teamSize).toBe(6);
        expect(room.data.teamCount).toBe(2);
        expect(room.data.modeMaxPlayers).toBe(MapDefs.domination.gameMode.maxPlayers);
        // two in each team
        room.assignTeam(others[1].playerId, 1);
        room.assignTeam(others[2].playerId, 1);

        await start(room);
        const body = createPrivateGame.mock.calls[0][0];
        expect(body.mapName).toBe("domination");
        expect(body.gameMode).toBe(GameMode.Domination);
        expect(body.teamMode).toBe(TeamMode.Squad);
        // one in-game group per lobby team
        expect(body.teams.map((t: unknown[]) => t.length)).toStrictEqual([2, 2]);
        expect(body.teams.flat()[0].arenaLoadouts[0].primary).toBe("hk416");
        expect(owner).toBeDefined();
    });

    test("an arena mode picked from the mode list (no owner needed) runs with its own rules", async () => {
        const { room, join, createPrivateGame } = lobby(4);
        const players = [join(), join(), join()];
        expect(room.data.teamSize).toBe(6);
        expect(room.data.teamCount).toBe(2);
        room.assignTeam(players[2].playerId, 1);
        await start(room);
        const body = createPrivateGame.mock.calls[0][0];
        expect(body.mapName).toBe("domination");
        expect(body.gameMode).toBe(GameMode.Domination);
        expect(body.teams.map((t: unknown[]) => t.length)).toStrictEqual([2, 1]);
        expect(body.teams.flat()[0].arenaLoadouts[0].primary).toBe("hk416");

        // Gun Game too: its map grows with the player limit
        const gg = lobby(3);
        gg.join();
        gg.join();
        await start(gg.room);
        const ggBody = gg.createPrivateGame.mock.calls[0][0];
        expect(ggBody.gameMode).toBe(GameMode.GunGame);
        expect(ggBody.mapScale).toBe(gunGameMapScale(gg.room.data.maxPlayers));
    });

    test("members don't get the Game Modes", () => {
        const { room, join } = lobby(0);
        join();
        set(room, { specialMode: GameMode.Domination });
        expect(room.data.specialMode).toBeUndefined();
    });

    test("turning Gun Game off again plays the selected mode", async () => {
        const { room, join, createPrivateGame } = lobby(1);
        join({ owner: true });
        set(room, { specialMode: GameMode.GunGame });
        set(room, { specialMode: undefined });
        expect(room.data.teamSize).toBe(TeamMode.Duo);
        await start(room);
        const body = createPrivateGame.mock.calls[0][0];
        expect(body.mapName).toBe("two_vs_two");
        expect(body.gameMode).toBeUndefined();
    });
});

describe("the match", () => {
    test("XP: lobby setting wins, else none with Advanced Settings", () => {
        const game = (cfg: object) =>
            new (createGame(TeamMode.Solo, "main").constructor as any)("t", { mapName: "main", teamMode: TeamMode.Solo, ...cfg }, () => {}, () => {});
        expect(game({}).earnsXp).toBe(true);
        expect(game({ advancedSettings: true }).earnsXp).toBe(false);
        expect(game({ advancedSettings: true, xpEnabled: true }).earnsXp).toBe(true);
        expect(game({ xpEnabled: false }).earnsXp).toBe(false);
        expect(MapId.Custom).toBeDefined();
    });
});
