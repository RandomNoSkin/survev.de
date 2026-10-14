import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { Config } from "../config";
import { getHonoIp } from "../utils/serverHelpers";
import { server } from "./apiServer";
import type { PublicLobby } from "../../../shared/types/privateLobby";

export interface PublicGame {
    id: string;
    teamMode: number;
    mapName: string;
    isPrivate: boolean;
    playerCount: number;
    /** Epoch ms on this API server's clock, 0 while the match hasn't started. */
    startedAt: number;
}

const POLL_MS = 1500;
const KEEPALIVE_MS = 20_000;
const MAX_STREAMS_PER_IP = 5;

const subscribers = new Set<SSEStreamingApi>();
const streamsPerIp = new Map<string, number>();
const snapshot: Record<string, PublicGame[]> = {};
// keyed on the raw game-server values, so per-poll re-basing jitter never counts as a change
const lastKey: Record<string, string> = {};
let lobbySnapshot: Record<string, PublicLobby[]> = {};
let lobbyKey = "";
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

async function send(stream: SSEStreamingApi, event: string, data: unknown) {
    try {
        await stream.writeSSE({ event, data: JSON.stringify(data) });
    } catch {
        /* client gone - removed on abort */
    }
}

function broadcast(event: string, data: unknown) {
    for (const s of subscribers) send(s, event, data);
}

async function poll() {
    if (polling) return;
    polling = true;
    try {
        pollLobbies();
        await Promise.all(
            Object.entries(server.regions).map(async ([regionId, region]) => {
                const res = await region.collectGameInfos(false);
                if (!Array.isArray(res?.data)) return;
                // Re-base the start onto our clock so game-server clock skew drops out.
                const offset = Date.now() - (typeof res.now === "number" ? res.now : Date.now());
                const games: PublicGame[] = res.data
                    .filter((g: any) => g.playerCount > 0 && !g.stopped)
                    .map((g: any) => ({
                        id: g.id,
                        teamMode: g.teamMode,
                        mapName: g.mapName ?? "",
                        isPrivate: !!g.isPrivate,
                        playerCount: g.playerCount,
                        startedAt: g.startedAt ? g.startedAt + offset : 0,
                    }));
                const key = JSON.stringify(
                    res.data.map((g: any) => [g.id, g.mapName, g.isPrivate, g.playerCount, g.stopped, g.startedAt]),
                );
                snapshot[regionId] = games;
                if (key !== lastKey[regionId]) {
                    lastKey[regionId] = key;
                    broadcast("games", { serverNow: Date.now(), region: regionId, games });
                }
            }),
        );
    } finally {
        polling = false;
    }
}

/** SSE stream that pushes a region's public game list whenever it changes. Region
 *  game servers are polled once per interval for all viewers combined, and only
 *  while at least one spectator menu is open. */
export function spectateStream(c: Context) {
    const ip = getHonoIp(c, Config.apiServer.proxyIPHeader) ?? "unknown";
    const open = streamsPerIp.get(ip) ?? 0;
    if (open >= MAX_STREAMS_PER_IP) {
        return c.json({ error: "too_many_streams" }, 429);
    }
    streamsPerIp.set(ip, open + 1);

    // nginx buffers proxied responses by default, which would hold back every event
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
        subscribers.add(stream);
        try {
            if (!pollTimer) {
                await poll();
                pollTimer = setInterval(poll, POLL_MS);
            }
            await send(stream, "snapshot", {
                serverNow: Date.now(),
                regions: snapshot,
                lobbies: lobbySnapshot,
            });

            const keepalive = setInterval(() => send(stream, "ping", {}), KEEPALIVE_MS);
            const signal = c.req.raw.signal;
            if (!signal.aborted) {
                await new Promise<void>((resolve) => {
                    signal.addEventListener("abort", () => resolve(), { once: true });
                });
            }
            clearInterval(keepalive);
        } finally {
            subscribers.delete(stream);
            const left = (streamsPerIp.get(ip) ?? 1) - 1;
            if (left > 0) streamsPerIp.set(ip, left);
            else streamsPerIp.delete(ip);
            if (!subscribers.size && pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
        }
    });
}

/** Lobbies live in this process, so they're read directly - no game server round trip. */
function pollLobbies() {
    const byRegion: Record<string, PublicLobby[]> = {};
    for (const lobby of server.privateLobbyMenu.listPublicLobbies()) {
        (byRegion[lobby.region] ??= []).push(lobby);
    }
    const key = JSON.stringify(byRegion);
    if (key === lobbyKey) return;
    lobbyKey = key;
    lobbySnapshot = byRegion;
    broadcast("lobbies", { lobbies: byRegion });
}
