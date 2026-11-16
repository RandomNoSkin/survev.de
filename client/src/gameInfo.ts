import { api } from "./api";
import type { ConfigManager } from "./config";
import type { PublicLobby, PublicLobbyDetails } from "../../shared/types/privateLobby";

type RoleTag = "owner" | "admin" | "mod" | "premium" | "bot" | null;

export interface SpectateGame {
    id: string;
    teamMode: number;
    mapName: string;
    isPrivate: boolean;
    playerCount: number;
    /** Epoch ms on THIS client's clock when the match started, 0 while waiting. */
    startedAt: number;
}

export interface SpectateGameDetails {
    game: SpectateGame;
    players: { name: string; roleTag: RoleTag; kills: number; alive: boolean; teamId: number }[];
    feed: { killer: string; victim: string; weapon: string }[];
}

type GamesListener = (region: string, games: SpectateGame[]) => void;

/** Moves server start timestamps onto the local clock, so a skewed client clock
 *  doesn't skew the runtime (off by at most the one-way latency). */
function stamp(games: SpectateGame[], serverNow: unknown): SpectateGame[] {
    const offset = typeof serverNow === "number" ? Date.now() - serverNow : 0;
    return games.map((g) => ({
        ...g,
        mapName: g.mapName ?? "",
        startedAt: g.startedAt ? g.startedAt + offset : 0,
    }));
}

export class GameInfo {
    private source: EventSource | null = null;

    constructor(public config: ConfigManager) {}

    /** Subscribes to the server's live game list; `onGames` fires once per region on
     *  connect and again whenever a region's games change. */
    openStream(
        onGames: GamesListener,
        onConnected: (ok: boolean) => void,
        onLobbies: (byRegion: Record<string, PublicLobby[]>) => void,
    ) {
        this.closeStream();
        const source = new EventSource(api.resolveUrl("/api/spectate_stream"));
        this.source = source;
        source.addEventListener("snapshot", (e) => {
            const { serverNow, regions, lobbies } = JSON.parse((e as MessageEvent).data);
            for (const region in regions) onGames(region, stamp(regions[region], serverNow));
            onLobbies(lobbies ?? {});
            onConnected(true);
        });
        source.addEventListener("games", (e) => {
            const { serverNow, region, games } = JSON.parse((e as MessageEvent).data);
            onGames(region, stamp(games, serverNow));
        });
        source.addEventListener("lobbies", (e) => {
            onLobbies(JSON.parse((e as MessageEvent).data).lobbies ?? {});
        });
        // EventSource reconnects by itself; this only drives the error hint
        source.onerror = () => onConnected(false);
    }

    closeStream() {
        this.source?.close();
        this.source = null;
    }

    get streamOpen() {
        return !!this.source;
    }

    async fetchLobbyDetails(publicId: string): Promise<PublicLobbyDetails | null> {
        try {
            const res = await fetch(api.resolveUrl("/api/spectate_lobby_details"), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ publicId }),
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data?.lobby ? (data as PublicLobbyDetails) : null;
        } catch {
            return null;
        }
    }

    async fetchDetails(region: string, gameId: string): Promise<SpectateGameDetails | null> {
        try {
            const res = await fetch(api.resolveUrl("/api/spectate_game_details"), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ region, gameId }),
            });
            if (!res.ok) return null;
            const data = await res.json();
            if (!data?.game) return null;
            return {
                game: stamp([data.game], data.now)[0],
                players: data.players ?? [],
                feed: data.feed ?? [],
            };
        } catch {
            return null;
        }
    }
}
