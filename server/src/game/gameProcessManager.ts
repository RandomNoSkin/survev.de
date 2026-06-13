import type { WebSocket } from "uWebSockets.js";
import { type ChildProcess, fork } from "child_process";
import { randomUUID } from "crypto";
import { type MapDef, MapDefs } from "../../../shared/defs/mapDefs";
import type { TeamMode } from "../../../shared/gameConfig";
import * as net from "../../../shared/net/net";
import { util } from "../../../shared/utils/util";
import { Config } from "../config";
import { ServerLogger } from "../utils/logger";
import {
    type AdminCmdAction,
    type DashboardPlayer,
    type FindGamePrivateBody,
    type FindPrivateLobbyGameBody,
    type GameData,
    type GameSocketData,
    type KillFeedEntry,
    type ProcessMsg,
    ProcessMsgType,
    type ServerGameConfig,
} from "../utils/types";
import type { GameManager } from "./gameManager";

let path: string;
if (process.env.NODE_ENV === "production") {
    path = "dist/gameProcess.js";
} else {
    path = "src/game/gameProcess.ts";
}

/** Max time to wait for a freshly forked game process to report "Created" before
 *  giving up on the find_game request. Kept under the API server's region fetch
 *  timeout so the player gets a fast "find_game_failed" + retry instead of the API
 *  aborting (which is what surfaced as the EU "timed out after 10000ms"). */
const GAME_CREATE_TIMEOUT_MS = 8000;

class GameProcess implements GameData {
    process: ChildProcess;

    canJoin = true;
    isPrivate = false;
    publicSpectating = true;
    creating = false;
    teamMode: TeamMode = 1;
    mapName = "";
    id = "";
    aliveCount = 0;
    startedTime = 0;
    stopped = true;
    created = false;

    manager: GameProcessManager;

    onCreatedCbs: Array<(_proc: typeof this) => void> = [];
    /** Called if the process dies or stalls before reporting "Created", so waiting
     *  find_game/createPrivateGame requests fail fast instead of hanging. */
    onFailedCbs: Array<() => void> = [];

    lastMsgTime = Date.now();

    /** When the current Create was sent; used to measure game-creation latency. */
    createStartTime = 0;

    stoppedTime = Date.now();

    avaliableSlots = 0;

    /** Pending GetPlayerData callbacks, keyed by requestId. */
    readonly pendingPlayerDataRequests = new Map<string, (players: DashboardPlayer[]) => void>();
    /** Pending GetGameFeed callbacks, keyed by requestId. */
    readonly pendingGameFeedRequests = new Map<string, (entries: KillFeedEntry[]) => void>();

    constructor(manager: GameProcessManager, id: string, config: ServerGameConfig) {
        this.manager = manager;
        this.process = fork(path, [], {
            serialization: "advanced",
        });

        this.process.on("message", (msg: ProcessMsg) => {
            if (msg.type) {
                this.lastMsgTime = Date.now();
            }

            switch (msg.type) {
                case ProcessMsgType.Created: {
                    this.created = true;
                    this.stopped = false;
                    this.creating = false;
                    // Real create→ready latency (what find_game actually waits on):
                    // from when we sent Create to this "Created". For a fresh fork this
                    // includes fork + Node bootstrap; for a reused process it's basically
                    // just init. `initMs` (map gen, from the child) lets us split out the
                    // fork/boot overhead so a slow number points at the right cause.
                    const elapsed = this.createStartTime
                        ? Date.now() - this.createStartTime
                        : 0;
                    const initMs = msg.initMs ?? 0;
                    const overhead = Math.max(elapsed - initMs, 0);
                    this.manager.logger.info(
                        `Game #${this.id.substring(0, 4)} (${this.mapName}) created in ${elapsed}ms (init ${initMs}ms, overhead ${overhead}ms)`,
                    );
                    if (elapsed > 3000) {
                        // .error so it reaches the webhook. overhead ≫ init ⇒ cold fork /
                        // boot is the cost; init ≫ overhead ⇒ map gen is the cost.
                        this.manager.logger.error(
                            `Slow game creation: ${elapsed}ms for ${this.mapName} (init ${initMs}ms, overhead ${overhead}ms, PID ${this.process.pid})`,
                        );
                    }
                    for (const cb of this.onCreatedCbs) {
                        cb(this);
                    }
                    this.onCreatedCbs.length = 0;
                    this.onFailedCbs.length = 0;
                    break;
                }
                case ProcessMsgType.UpdateData:
                    this.canJoin = msg.canJoin;
                    this.isPrivate = msg.isPrivate;
                    this.publicSpectating = msg.publicSpectating;
                    this.teamMode = msg.teamMode;
                    this.mapName = msg.mapName;
                    if (this.id !== msg.id) {
                        this.manager.processById.delete(this.id);
                        this.id = msg.id;
                        this.manager.processById.set(this.id, this);
                    }
                    this.aliveCount = msg.aliveCount;
                    this.startedTime = msg.startedTime;
                    this.stopped = msg.stopped;
                    if (this.stopped) {
                        this.stoppedTime = Date.now();
                        this.created = false;
                    }
                    break;
                case ProcessMsgType.SocketMsg:
                    for (let i = 0; i < msg.msgs.length; i++) {
                        const socketMsg = msg.msgs[i];
                        const socket = this.manager.sockets.get(socketMsg.socketId);

                        if (!socket) continue;
                        if (socket.getUserData().closed) continue;
                        try {
                            socket.send(socketMsg.data, true, false);
                        } catch (e: any) {
                            if (e?.code !== "EPIPE") throw e;
                        }
                    }
                    break;
                case ProcessMsgType.SocketClose:
                    const socket = this.manager.sockets.get(msg.socketId);
                    if (socket && !socket.getUserData().closed) {
                        if (msg.reason) {
                            const disconnectMsg = new net.DisconnectMsg();
                            disconnectMsg.reason = msg.reason;
                            const stream = new net.MsgStream(new ArrayBuffer(128));
                            stream.serializeMsg(net.MsgType.Disconnect, disconnectMsg);
                            socket.send(stream.getBuffer(), true, false);
                        }

                        socket.close();
                    }
                    break;

                // Dashboard: resolve the pending getGamePlayers() promise
                case ProcessMsgType.PlayerDataResponse: {
                    const resolve = this.pendingPlayerDataRequests.get(msg.requestId);
                    if (resolve) {
                        this.pendingPlayerDataRequests.delete(msg.requestId);
                        resolve(msg.players);
                    }
                    break;
                }

                // Dashboard: resolve the pending getGameFeed() promise
                case ProcessMsgType.GameFeedResponse: {
                    const resolve = this.pendingGameFeedRequests.get(msg.requestId);
                    if (resolve) {
                        this.pendingGameFeedRequests.delete(msg.requestId);
                        resolve(msg.entries);
                    }
                    break;
                }
            }
        });

        this.create(id, config);
    }

    send(msg: ProcessMsg) {
        if (this.process.killed || !this.process.channel) return;

        try {
            this.process.send(msg);
        } catch (e: any) {
            if (e?.code === "ERR_IPC_CHANNEL_CLOSED" || e?.code === "EPIPE") {
                this.manager.processById.delete(this.id);
                return;
            }

            throw e;
        }
    }

    create(id: string, config: ServerGameConfig) {
        this.createStartTime = Date.now();
        this.send({
            type: ProcessMsgType.Create,
            id,
            config,
        });
        this.id = id;
        this.teamMode = config.teamMode;
        this.mapName = config.mapName;
        this.stopped = false;
        this.creating = true;

        const mapDef = MapDefs[this.mapName as keyof typeof MapDefs] as MapDef;
        this.avaliableSlots = mapDef.gameMode.maxPlayers;
    }

    addJoinTokens(tokens: FindGamePrivateBody["playerData"], autoFill: boolean) {
        // Cache IPs of logged-in players so the WebSocket upgrade can skip the proxy check
        for (const t of tokens) {
            if (t.userId) {
                this.manager.accountIpCache.set(t.ip, Date.now() + 2 * 60 * 1000);
            }
        }
        this.send({
            type: ProcessMsgType.AddJoinToken,
            autoFill,
            tokens,
        });
        this.avaliableSlots--;
    }
    addGroupedJoinTokens(teams: FindGamePrivateBody["playerData"][]) {
        for (const tokens of teams) {
            for (const t of tokens) {
                if (t.userId) {
                    this.manager.accountIpCache.set(t.ip, Date.now() + 2 * 60 * 1000);
                }
            }
        }
        this.send({
            type: ProcessMsgType.AddGroupedJoinTokens,
            teams,
        });
        this.avaliableSlots--;
    }
    addJoinTokensAsSpectator(tokens: FindGamePrivateBody["playerData"], autoFill: boolean) {
        this.send({
            type: ProcessMsgType.AddJoinTokenAsSpectator,
            autoFill,
            tokens,
        });
        //this.avaliableSlots--;
    }

    handleMsg(data: ArrayBuffer, socketId: string, ip: string) {
        this.send({
            type: ProcessMsgType.SocketMsg,
            msgs: [
                {
                    socketId,
                    data,
                    ip,
                },
            ],
        });
    }

    handleSocketClose(socketId: string) {
        this.send({
            type: ProcessMsgType.SocketClose,
            socketId,
        });
    }
}

export class GameProcessManager implements GameManager {
    readonly sockets = new Map<string, WebSocket<GameSocketData>>();

    /**
     * Short-lived cache: IP → has a linked account.
     * Populated when AddJoinToken is called with a non-empty userId.
     * Used during WebSocket upgrade to skip the proxy check for logged-in players.
     * Entries expire after 2 minutes (more than enough to cover the join window).
     */
    readonly accountIpCache = new Map<string, number>();

    /** Returns true if this IP recently joined with a linked account. */
    ipHasAccount(ip: string): boolean {
        const expires = this.accountIpCache.get(ip);
        if (expires === undefined) return false;
        if (expires < Date.now()) { this.accountIpCache.delete(ip); return false; }
        return true;
    }

    readonly processById = new Map<string, GameProcess>();
    readonly processes: GameProcess[] = [];

    serverVerifiedOnly = false;

    readonly logger = new ServerLogger("Game Process Manager");

    /** Counts the 5s watchdog ticks so the heartbeat log fires roughly every 30s. */
    private heartbeatTicks = 0;

    constructor() {
        process.on("beforeExit", () => {
            for (const gameProc of this.processes) {
                gameProc.process.kill();
            }
        });

        setInterval(() => {
            for (const gameProc of this.processes) {
                gameProc.send({
                    type: ProcessMsgType.KeepAlive,
                });

                if (Date.now() - gameProc.lastMsgTime > 10000) {
                    this.logger.warn(
                        `Process ${gameProc.process.pid} - #${gameProc.id.substring(0, 4)} did not send a message in more 10 seconds, killing`,
                    );
                    // SIGQUIT dumps a core, which is useful for debugging infinite loops
                    // locally — but in prod a loot blowup wedges several processes at once,
                    // and a core dump per wedged process floods the disk/IO and makes the
                    // outage worse. Use SIGKILL in prod, SIGQUIT only in dev.
                    this.killProcess(
                        gameProc,
                        process.env.NODE_ENV === "production" ? "SIGKILL" : "SIGQUIT",
                    );
                } else if (
                    gameProc.stopped &&
                    Date.now() - gameProc.stoppedTime > 60000
                ) {
                    this.logger.warn(
                        `Process ${gameProc.process.pid} - #${gameProc.id.substring(0, 4)} stopped more than a minute ago, killing`,
                    );
                    this.killProcess(gameProc);
                }
            }

            // Heartbeat (~every 30s): the OOM that took the server down was driven by the
            // number of game processes (each its own ~50-100MB Node instance), so log the
            // process census as the early-warning signal. main-process RSS is included for
            // completeness, but it only covers THIS process — the children are separate.
            if (++this.heartbeatTicks >= 6) {
                this.heartbeatTicks = 0;
                const active = this.processes.filter((p) => !p.stopped).length;
                const creating = this.processes.filter((p) => p.creating).length;
                const totalPlayers = this.processes.reduce((a, p) => a + p.aliveCount, 0);
                const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
                const maxGames = Config.gameServer.maxGames;
                const summary =
                    `Heartbeat: procs=${this.processes.length}/${maxGames} ` +
                    `(active=${active}, creating=${creating}), players=${totalPlayers}, mainRss=${rssMb}MB`;
                // Warn loudly (→ webhook) once we're near the cap: that's when a further
                // spike risks OOM and find_game starts fast-failing.
                if (this.processes.length >= maxGames * 0.8) {
                    this.logger.error(`${summary} — near maxGames cap`);
                } else {
                    this.logger.info(summary);
                }
            }
        }, 5000);
    }

    getPlayerCount(): number {
        return this.processes.reduce((a, b) => {
            return a + b.aliveCount;
        }, 0);
    }

    /**
     * Returns a game process to host `config`, reusing an idle (stopped) process if one
     * is free. Returns `undefined` when a new process would have to be forked but the
     * `maxGames` cap is already reached — the caller must fail the request fast (the
     * client retries) rather than spawn unbounded processes. Forking past the host's RAM
     * budget is what OOM-killed the server: each game is its own ~50-100MB Node process,
     * and a find_game/retry storm forks them faster than they're reaped.
     */
    newGame(config: ServerGameConfig): GameProcess | undefined {
        let gameProc: GameProcess | undefined;

        for (let i = 0; i < this.processes.length; i++) {
            const p = this.processes[i];
            if (p.stopped) {
                gameProc = p;
                break;
            }
        }

        const id = randomUUID();
        if (!gameProc) {
            if (this.processes.length >= Config.gameServer.maxGames) {
                this.logger.warn(
                    `maxGames cap (${Config.gameServer.maxGames}) reached — refusing to fork a new process; failing request ` +
                        `[procs=${this.processes.length}, active=${this.processes.filter((p) => !p.stopped).length}, creating=${this.processes.filter((p) => p.creating).length}]`,
                );
                return undefined;
            }
            gameProc = new GameProcess(this, id, config);

            this.processes.push(gameProc);

            gameProc.process.on("exit", () => {
                this.killProcess(gameProc!);
            });
            gameProc.process.on("close", () => {
                this.killProcess(gameProc!);
            });
            gameProc.process.on("disconnect", () => {
                this.killProcess(gameProc!);
            });
            this.logger.info("Created new process with PID", gameProc.process.pid);
        } else {
            this.processById.delete(gameProc.id);
            gameProc.create(id, config);
        }

        this.processById.set(id, gameProc);

        if (this.serverVerifiedOnly) {
            gameProc.send({ type: ProcessMsgType.AdminCmd, cmd: { action: "verify" } });
        }

        return gameProc;
    }

    commitProcessGenocide() {
        for (const proc of this.processes) {
            this.killProcess(proc);
        }
    }

    killProcess(gameProc: GameProcess, signal: NodeJS.Signals = "SIGTERM"): void {
        for (const [, socket] of this.sockets) {
            const data = socket.getUserData();
            if (data.closed) continue;
            if (data.gameId !== gameProc.id) continue;
            this.logger.warn(`Closing socket for ${gameProc.id}`);
            socket.close();
        }

        // Fail any find_game/createPrivateGame requests still waiting on this
        // process's creation so they return immediately instead of hanging until
        // the API server's abort timeout.
        for (const cb of gameProc.onFailedCbs) cb();
        gameProc.onFailedCbs.length = 0;
        gameProc.onCreatedCbs.length = 0;

        // send SIGTERM, if still hasn't terminated after 5 seconds, send SIGKILL >:3
        gameProc.process.kill(signal);
        setTimeout(() => {
            if (!gameProc.process.killed) {
                gameProc.process.kill("SIGKILL");
            }
        }, 5000);

        util.removeFrom(this.processes, gameProc);
        this.processById.delete(gameProc.id);
    }

    getById(id: string): GameData | undefined {
        return this.processById.get(id);
    }

    async findGame(body: FindGamePrivateBody): Promise<string> {
        let game: GameProcess | undefined = this.processes
            .filter((proc) => {
                return (
                    // Never match a stopped process: its child has no game and will never
                    // send "Created", so waiting on it just burns the 8s find_game timeout
                    // (and a stopped game could still report a stale canJoin=true).
                    !proc.stopped &&
                    (proc.canJoin || proc.creating) &&
                    proc.avaliableSlots > 0 &&
                    proc.teamMode === body.teamMode &&
                    proc.mapName === body.mapName
                );
            })
            .sort((a, b) => {
                return a.startedTime - b.startedTime;
            })[0];

        if (!game) {
            game = this.newGame({
                teamMode: body.teamMode,
                mapName: body.mapName as keyof typeof MapDefs,
            });
        }

        // Cap reached (no idle process and at maxGames) — fail fast so the client
        // retries in a moment instead of us forking past the RAM budget.
        if (!game) {
            return "";
        }

        // if the game has not finished creating
        // wait for it to be created to send the find game response
        if (!game.created) {
            return await new Promise<string>((resolve) => {
                let settled = false;
                let timer: ReturnType<typeof setTimeout>;
                const settle = (value: string) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(value);
                };

                game.onCreatedCbs.push(() => {
                    if (this.serverVerifiedOnly && body.playerData.some((p) => !p.userId)) {
                        settle("player_not_verified");
                        return;
                    }
                    game.addJoinTokens(body.playerData, body.autoFill);
                    settle(game.id);
                });
                // Process died before "Created" (e.g. a throw in game.init()).
                game.onFailedCbs.push(() => settle(""));
                // Backstop for a process that neither finishes nor dies (a hang):
                // fail before the API server's abort timeout so the player retries.
                timer = setTimeout(() => {
                    // Attach load + liveness context so the timeout is diagnosable in
                    // Discord: is the server overloaded (many procs/creating at once),
                    // or is THIS child stuck/dead? lastChildMsg = time since the child
                    // last sent anything — large + alive ⇒ blocked in heavy work (map
                    // gen); the child's own "Slow game creation" log gives the exact split.
                    const sinceMsg = Date.now() - game.lastMsgTime;
                    const active = this.processes.filter((p) => !p.stopped).length;
                    const creating = this.processes.filter((p) => p.creating).length;
                    const totalPlayers = this.processes.reduce((a, p) => a + p.aliveCount, 0);
                    this.logger.error(
                        `Game #${game.id.substring(0, 4)} (${game.mapName}) creation timed out after ${GAME_CREATE_TIMEOUT_MS}ms — failing find_game ` +
                            `[childAlive=${!game.process.killed}, lastChildMsg=${sinceMsg}ms ago, pid=${game.process.pid}, ` +
                            `procs=${this.processes.length} (active=${active}, creating=${creating}), totalPlayers=${totalPlayers}]`,
                    );
                    settle("");
                }, GAME_CREATE_TIMEOUT_MS);
            });
        }

        if (this.serverVerifiedOnly && body.playerData.some((p) => !p.userId)) {
            return "player_not_verified";
        }

        game.addJoinTokens(body.playerData, body.autoFill);

        return game.id;
    }

    async createPrivateGame(body: FindPrivateLobbyGameBody): Promise<string> {
        const game = this.newGame({
            teamMode: body.teamMode,
            mapName: body.mapName as keyof typeof MapDefs,
            isPrivate: true,
            arenaRoles: body.arenaRoles,
            advancedSettings: body.advancedSettings,
            customLoadout: body.customLoadout,
            customLoadoutEnabled: body.customLoadoutEnabled,
            publicSpectating: body.publicSpectating,
        });

        // Cap reached — no process available to host the private lobby right now.
        if (!game) {
            return "";
        }

        // if the game has not finished creating
        // wait for it to be created before registering the join groups
        if (!game.created) {
            return await new Promise<string>((resolve) => {
                let settled = false;
                const settle = (value: string) => {
                    if (settled) return;
                    settled = true;
                    resolve(value);
                };
                game.onCreatedCbs.push((game) => {
                    game.addGroupedJoinTokens(body.teams);
                    if (body.spectators?.length) {
                        game.addJoinTokensAsSpectator(body.spectators, false);
                    }
                    settle(game.id);
                });
                // Process died before "Created" — resolve immediately instead of hanging
                // until the API server's abort timeout (the ~2 min find_private_game
                // hangs seen in prod). Mirrors the onFailedCbs handling in findGame.
                game.onFailedCbs.push(() => settle(""));
            });
        }

        game.addGroupedJoinTokens(body.teams);
        if (body.spectators?.length) {
            game.addJoinTokensAsSpectator(body.spectators, false);
        }
        return game.id;
    }

    async findGameById(gameId: string, playerData: any[], autoFill: boolean): Promise<string> {
        let game = this.processById.get(gameId);

        if (!game || game.aliveCount < 0) {
            return "";
        }

        game.addJoinTokensAsSpectator(playerData, autoFill);

        return game.id;
    }

    async getGames(): Promise<GameData[]> {
        return this.processes.map((game) => game);
    }

    /**
     * Requests the live player list from a running game process.
     * Resolves with an empty array if the game is not found or times out after 3 s.
     */
    async getGamePlayers(gameId: string): Promise<DashboardPlayer[]> {
        const proc = this.processById.get(gameId);
        if (!proc) return [];

        const requestId = randomUUID();

        return new Promise<DashboardPlayer[]>((resolve) => {
            const timeout = setTimeout(() => {
                proc.pendingPlayerDataRequests.delete(requestId);
                resolve([]);
            }, 3000);

            proc.pendingPlayerDataRequests.set(requestId, (players) => {
                clearTimeout(timeout);
                resolve(players);
            });

            proc.send({ type: ProcessMsgType.GetPlayerData, requestId });
        });
    }

    /**
     * Requests the recent kill feed buffer from a running game process.
     * Resolves with an empty array if the game is not found or times out after 3 s.
     */
    async getGameFeed(gameId: string): Promise<KillFeedEntry[]> {
        const proc = this.processById.get(gameId);
        if (!proc) return [];

        const requestId = randomUUID();

        return new Promise<KillFeedEntry[]>((resolve) => {
            const timeout = setTimeout(() => {
                proc.pendingGameFeedRequests.delete(requestId);
                resolve([]);
            }, 3000);

            proc.pendingGameFeedRequests.set(requestId, (entries) => {
                clearTimeout(timeout);
                resolve(entries);
            });

            proc.send({ type: ProcessMsgType.GetGameFeed, requestId });
        });
    }

    /** Sends an admin command to a running game process (fire-and-forget). */
    sendAdminCmd(gameId: string, cmd: AdminCmdAction): void {
        this.processById.get(gameId)?.send({ type: ProcessMsgType.AdminCmd, cmd });
    }

    setServerVerified(state: boolean): void {
        this.serverVerifiedOnly = state;
        const cmd: AdminCmdAction = { action: state ? "verify" : "unverify" };
        for (const proc of this.processes) {
            if (!proc.stopped) {
                proc.send({ type: ProcessMsgType.AdminCmd, cmd });
            }
        }
    }

    onOpen(socketId: string, socket: WebSocket<GameSocketData>): void {
        const data = socket.getUserData();
        const proc = this.processById.get(data.gameId);
        if (proc === undefined) {
            this.logger.warn("prcoess not found, closing socket.");
            socket.close();
            return;
        }
        this.sockets.set(socketId, socket);
    }

    onMsg(socketId: string, msg: ArrayBuffer): void {
        const data = this.sockets.get(socketId)?.getUserData();
        if (!data) return;
        this.processById.get(data.gameId)?.handleMsg(msg, socketId, data.ip);
    }

    onClose(socketId: string) {
        const data = this.sockets.get(socketId)?.getUserData();
        this.sockets.delete(socketId);
        if (!data) return;
        this.processById.get(data.gameId)?.handleSocketClose(socketId);
    }
}
