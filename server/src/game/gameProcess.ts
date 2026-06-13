import NanoTimer from "nanotimer";
import { platform } from "os";
import { Config } from "../config";
import { logErrorToWebhook } from "../utils/serverHelpers";
import { type ProcessMsg, ProcessMsgType } from "../utils/types";
import { Game } from "./game";
import { gameLogger } from "../utils/betterLogger";

let game: Game | undefined;

/**
 * Log a crash with its FULL stack to the file logger AND the error webhook.
 * The previous code did `gameLogger.error("...", err)`, but betterLogger's printf
 * only emits `message` (no splat), so the `err`/stack was silently dropped and
 * nothing was ever sent to the webhook — which is why prod crashes were invisible.
 */
function reportCrash(context: string, err: unknown) {
    const details = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[gameProcess] ${context}:`, err);
    gameLogger.error(`${context}: ${details}`);
    void logErrorToWebhook("server", `Game process crash: ${context}`, err);
}

/**
 * Recover from a crash inside the game loop by stopping just THIS game instead of
 * killing the whole process. `game.stop()` disconnects its players and notifies the
 * manager (which reuses/reaps the process); the sendData callback resets `game` to
 * undefined on the stopped UpdateData. Falls back to clearing `game` if stop() throws.
 */
function stopCrashedGame(context: string, err: unknown) {
    reportCrash(context, err);
    try {
        game?.stop();
    } catch (stopErr) {
        reportCrash(`${context} (stop() also failed)`, stopErr);
    }
    game = undefined;
}

function sendMsg(msg: ProcessMsg) {
    try {
        process.send!(msg);
    } catch (e: any) {
        if (e?.code !== "EPIPE") throw e;
    }
}

process.on("disconnect", () => {
    process.exit();
});

const socketMsgs: Array<{
    socketId: string;
    data: Uint8Array;
    ip: string;
}> = [];

let lastMsgTime = Date.now();

process.on("message", async (msg: ProcessMsg) => {
    if (msg.type) {
        lastMsgTime = Date.now();
    }

    try {
    if (msg.type === ProcessMsgType.Create && !game) {
        game = new Game(
            msg.id,
            msg.config,
            (id, data) => {
                socketMsgs.push({
                    socketId: id,
                    data,
                    ip: "",
                });
            },
            (id, reason) => {
                sendMsg({
                    type: ProcessMsgType.SocketClose,
                    socketId: id,
                    reason,
                });
            },
            (msg) => {
                sendMsg(msg);
                if (msg.stopped) {
                    game = undefined;
                }
            },
        );

        // Break creation down so the find_game creation timeout is explainable in
        // Discord: process startup (fork + Node bootstrap + module load) vs map
        // generation (game.init). startupMs ≈ time from this child being spawned to
        // it actually starting the map build.
        const startupMs = Math.round(process.uptime() * 1000);
        const initStart = Date.now();
        await game.init();
        const initMs = Date.now() - initStart;
        gameLogger.info(
            `Game "${msg.config.mapName}" ready — startup ${startupMs}ms + init ${initMs}ms`,
        );
        // Surface the breakdown to the webhook when it gets close to the creation
        // timeout, so we can see WHY find_game timed out (startup vs map-gen).
        if (startupMs + initMs > 3000) {
            void logErrorToWebhook(
                "server",
                `Slow game creation for "${msg.config.mapName}" (teamMode=${msg.config.teamMode}): ` +
                    `process startup ${startupMs}ms + map/init ${initMs}ms = ${startupMs + initMs}ms total`,
            );
        }
        sendMsg({
            type: ProcessMsgType.Created,
        });
    }

    if (!game) return;

    switch (msg.type) {
        case ProcessMsgType.AddJoinToken:
            game.addJoinTokens(msg.tokens, msg.autoFill);
            break;
        case ProcessMsgType.AddGroupedJoinTokens:
            game.addGroupedJoinTokens(msg.teams);
            break;
        case ProcessMsgType.AddJoinTokenAsSpectator:
            game.addJoinTokensAsSpectator(msg.tokens, false);
            break;
        case ProcessMsgType.SocketMsg:
            const sMsg = msg.msgs[0];
            game.handleMsg(sMsg.data as ArrayBuffer, sMsg.socketId, sMsg.ip);
            break;
        case ProcessMsgType.SocketClose:
            game.handleSocketClose(msg.socketId);
            break;

        // Dashboard: return live player list
        case ProcessMsgType.GetPlayerData:
            sendMsg({
                type: ProcessMsgType.PlayerDataResponse,
                requestId: msg.requestId,
                players: game.getPlayerDataForDashboard(),
            });
            break;

        // Dashboard: execute an admin action (freeze/kick/announce/etc.)
        case ProcessMsgType.AdminCmd:
            game.executeAdminCmd(msg.cmd);
            break;

        // Dashboard: return recent kill feed buffer
        case ProcessMsgType.GetGameFeed:
            sendMsg({
                type: ProcessMsgType.GameFeedResponse,
                requestId: msg.requestId,
                entries: game.recentKills,
            });
            break;
    }
    } catch (err) {
        // A single bad IPC message (e.g. a malformed player input flowing through
        // game.handleMsg) must not take down the whole game process. Because this
        // handler is async, an uncaught throw here would otherwise become an
        // unhandled rejection and kill the process.
        reportCrash("message handler crashed", err);
    }
});

setInterval(() => {
    if (Date.now() - lastMsgTime > 10000) {
        console.log("Game process has not received a message in 10 seconds, exiting");
        gameLogger.warn("No messages received in 10 seconds, exiting");
        process.exit();
    }

    if (game) {
        game?.updateData();
    } else {
        sendMsg({
            type: ProcessMsgType.KeepAlive,
        });
    }
}, 5000);

// setInterval on windows sucks
// and doesn't give accurate timings
if (platform() === "win32") {
    new NanoTimer().setInterval(
        () => {
            try {
                game?.update();
            } catch (err) {
                stopCrashedGame("game.update crashed", err);
            }
        },
        "",
        `${1000 / Config.gameTps}m`,
    );

    new NanoTimer().setInterval(
        () => {
            try {
                game?.netSync();
                sendMsg({
                    type: ProcessMsgType.SocketMsg,
                    msgs: socketMsgs,
                });
                socketMsgs.length = 0;
            } catch (err) {
                stopCrashedGame("game.netSync crashed", err);
            }
        },
        "",
        `${1000 / Config.netSyncTps}m`,
    );
} else {
    setInterval(() => {
        try {
            game?.update();
        } catch (err) {
            stopCrashedGame("game.update crashed", err);
        }
    }, 1000 / Config.gameTps);

    setInterval(() => {
        try {
            game?.netSync();
            sendMsg({
                type: ProcessMsgType.SocketMsg,
                msgs: socketMsgs,
            });
            socketMsgs.length = 0;
        } catch (err) {
            stopCrashedGame("game.netSync crashed", err);
        }
    }, 1000 / Config.netSyncTps);
}

process.on("uncaughtException", async (err) => {
    // Truly unexpected top-level error: log the full stack everywhere, then exit
    // (process state may be corrupt). await the webhook so it isn't cut off by exit.
    const details = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(err);
    gameLogger.error(`uncaughtException: ${details}`);
    game = undefined;

    await logErrorToWebhook("server", "Game process uncaughtException", err);

    process.exit(1);
});

// An unhandled promise rejection would otherwise crash the process by default
// (Node >= 15). Log it with the full stack and keep running; if the rejection left
// the active game corrupt, the next update() tick is caught by stopCrashedGame.
process.on("unhandledRejection", (reason) => {
    reportCrash("unhandledRejection", reason);
});
