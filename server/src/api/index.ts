import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Cron } from "croner";
import { randomUUID } from "crypto";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { version } from "../../../package.json";
import {
    type FindGameResponse,
    type SiteInfoRes,
    zFindGameBody,
} from "../../../shared/types/api";
import { Config } from "../config";
import { GIT_VERSION } from "../utils/gitRevision";
import {
    getHonoIp,
    HTTPRateLimit,
    isBehindProxy,
    logErrorToWebhook,
    verifyTurnsStile,
} from "../utils/serverHelpers";
import { server } from "./apiServer";
import { deleteExpiredSessions, validateSessionToken } from "./auth";
import { rateLimitMiddleware, validateParams } from "./auth/middleware";
import {
    computeCosmeticStats,
    getCachedCosmeticStats,
    warmCosmeticStats,
} from "./cosmeticStats";
import { sweepExpiredBans } from "./db/banExpiry";
import { getOwnedLoadouts } from "./db/loadouts";
import { expireOldListings } from "./db/market";
import { backfillPassItemGrants } from "./db/passGrants";
import { reconcileAllPasses } from "./db/passReconcile";
import type { SessionTableSelect, UsersTableSelect } from "./db/schema";
import { verifyReplayToken } from "./replayToken";
import { ModerationDashboardRouter } from "./routes/ModerationDashboardRouter";
import { cleanupOldLogs, isBanned } from "./routes/private/ModerationRouter";
import { PrivateRouter } from "./routes/private/private";
import { StatsRouter } from "./routes/stats/StatsRouter";
import { AuthRouter } from "./routes/user/AuthRouter";
import { UserRouter } from "./routes/user/UserRouter";

export type Context = {
    Variables: {
        user: UsersTableSelect | null;
        session: SessionTableSelect | null;
    };
};

process.on("uncaughtException", async (err) => {
    console.error(err);

    await logErrorToWebhook("server", "API server error:", err);

    process.exit(1);
});

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.onError((err: unknown, c) => {
    server.logger.error(`${c.req.path} Error:`, err);
    if (err instanceof HTTPException) {
        return err.getResponse();
    }
    return c.text("Internal Server Error", 500);
});

app.use(
    "/api/*",
    cors({
        origin: "*",
        credentials: true,
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Origin", "Content-Type", "Accept", "X-Requested-With"],
        maxAge: 3600,
    }),
);

// @TODO: figure out the origins for this..
// app.use(csrf())

app.route("/api/user/", UserRouter);
app.route("/api/auth/", AuthRouter);
app.route("/api/", StatsRouter);
app.route("/private/", PrivateRouter);
app.route("/moderation", ModerationDashboardRouter);

server.init(app, upgradeWebSocket);

app.get("/api/site_info", (c) => {
    return c.json<SiteInfoRes>(server.getSiteInfo(), 200);
});

// Ownership-based cosmetic rarity + owner counts. Served from a cached snapshot that is
// recomputed at boot and once a day by the midnight cron below.
app.get("/api/cosmetic_stats", (c) => {
    return c.json(getCachedCosmeticStats(), 200);
});

/**
 * Lists the available player POVs for the game a replay token was minted for, so the
 * client can let the viewer switch between them (arrow keys / buttons).
 */
app.get("/api/replay/povs", async (c) => {
    const data = verifyReplayToken(c.req.query("token") ?? "");
    if (!data) {
        return c.json({ error: "invalid_or_expired_token" }, 403);
    }
    const recordings = await server.listReplays(data.region);
    const rec = recordings.find((r: any) => r.gameId === data.gameId);
    if (!rec) {
        return c.json({ error: "not_found" }, 404);
    }
    return c.json({
        gameId: rec.gameId,
        mapName: rec.mapName,
        teamMode: rec.teamMode,
        players: (rec.players ?? []).map((p: any) => ({
            playerId: p.playerId,
            playerName: p.playerName,
        })),
    });
});

/**
 * Public, token-gated replay file download (used by the game client in replay mode).
 * The token is minted by the admin-only dashboard, so this needs no session cookie —
 * which lets the client fetch it cross-origin. The token is game-scoped; the specific
 * POV is chosen via `playerId`. Returns the raw `.svrep.gz` bytes; the client gunzips
 * them with `DecompressionStream`.
 */
app.get("/api/replay", async (c) => {
    const data = verifyReplayToken(c.req.query("token") ?? "");
    if (!data) {
        return c.json({ error: "invalid_or_expired_token" }, 403);
    }
    const playerId = Number(c.req.query("playerId"));
    if (!Number.isFinite(playerId)) {
        return c.json({ error: "invalid_player" }, 400);
    }
    const file = await server.streamReplayFile(data.region, data.gameId, playerId);
    if (!file) {
        return c.json({ error: "not_found" }, 404);
    }
    return c.body(file, 200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
    });
});

/**
 * Public, token-gated god-view track file (used by the client in replay mode to show
 * all players in the advanced spectator regardless of POV). Game-scoped token, same as
 * `/api/replay`. Returns the raw `_tracks.svtrk.gz` bytes, or 404 for older recordings
 * that predate god-view tracks (the client then silently keeps the old behaviour).
 */
app.get("/api/replay/tracks", async (c) => {
    const data = verifyReplayToken(c.req.query("token") ?? "");
    if (!data) {
        return c.json({ error: "invalid_or_expired_token" }, 403);
    }
    const file = await server.streamReplayTracks(data.region, data.gameId);
    if (!file) {
        return c.json({ error: "not_found" }, 404);
    }
    return c.body(file, 200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
    });
});

// not using the middleware here to not add extra indentation... smh
const findGameRateLimit = new HTTPRateLimit(5, 3000);

app.post("/api/find_game", validateParams(zFindGameBody), async (c) => {
    const ip = getHonoIp(c, Config.apiServer.proxyIPHeader);

    if (!ip) {
        return c.json<FindGameResponse>({ error: "invalid_ip" }, 500);
    }

    if (findGameRateLimit.isRateLimited(ip)) {
        return c.json<FindGameResponse>({ error: "rate_limited" }, 429);
    }

    const banData = await isBanned(ip);
    if (banData) {
        return c.json<FindGameResponse>({
            banned: true,
            reason: banData.reason,
            permanent: banData.permanent,
            expiresIn: banData.expiresIn,
        });
    }

    const token = randomUUID();
    let user: UsersTableSelect | null = null;

    const sessionId = getCookie(c, "session") ?? null;

    if (sessionId) {
        try {
            const account = await validateSessionToken(sessionId);
            user = account.user;

            if (account.user?.banned) {
                user = null;
            }
        } catch (err) {
            server.logger.error("/api/find_game: Failed to validate session", err);
            user = null;
        }
    }

    if (!user && (await isBehindProxy(ip, 3))) {
        return c.json<FindGameResponse>({ error: "behind_proxy" });
    }

    const body = c.req.valid("json");
    if (server.captchaEnabled && !user) {
        if (!body.turnstileToken) {
            return c.json<FindGameResponse>({ error: "invalid_captcha" });
        }

        try {
            if (!(await verifyTurnsStile(body.turnstileToken, ip))) {
                return c.json<FindGameResponse>({ error: "invalid_captcha" });
            }
        } catch (err) {
            server.logger.error("/api/find_game: Failed verifying turnstile: ", err);
            return c.json<FindGameResponse>({ error: "invalid_captcha" }, 500);
        }
    }

    //const mode = server.modes[body.gameModeIdx];
    const mode = server.modesByRegion[body.region]?.[body.gameModeIdx];
    console.log("Selected mode:", mode);
    if (!mode || !mode.enabled) {
        return c.json<FindGameResponse>({ error: "full" });
    }

    if (server.regions[body.region]?.verifiedOnly && !user) {
        return c.json<FindGameResponse>({ error: "player_not_verified" });
    }

    // Re-validate the saved loadout against what the account CURRENTLY owns so a cosmetic
    // that was traded/rented away can't be spawned with (see getOwnedLoadouts). Falls back
    // to the raw stored loadout only if validation fails for some reason.
    let userLoadout = user?.loadout;
    if (user) {
        try {
            userLoadout = (await getOwnedLoadouts([user.id]))[0]?.loadout ?? userLoadout;
        } catch (err) {
            server.logger.error(
                "/api/find_game: Failed to validate loadout ownership",
                err,
            );
        }
    }

    const data = await server.findGame({
        region: body.region,
        version: body.version,
        mapName: mode.mapName,
        teamMode: mode.teamMode,
        autoFill: true,
        playerData: [
            {
                token,
                userId: user?.id || null,
                ip,
                loadout: userLoadout,
                admin: user?.admin ?? false,
            },
        ],
    });

    if ("error" in data) {
        return c.json(data);
    }

    return c.json<FindGameResponse>({
        res: [
            {
                zone: "",
                data: token,
                useHttps: data.useHttps,
                hosts: data.hosts,
                addrs: data.addrs,
                gameId: data.gameId,
            },
        ],
    });
});

const zRegionOnly = z.object({ region: z.string() });
const zFindSpectator = z.object({
    region: z.string(),
    version: z.number().optional(),
    zones: z.array(z.string()).optional(),
    gameModeIdx: z.number().optional(),
    appsid: z.string().optional(),
    gameId: z.string().optional(),
});
const zFindGameById = z.object({
    region: z.string(),
    gameId: z.string(),
    version: z.number().optional(),
});

// /api/game_infos
app.post("/api/game_infos", validateParams(zRegionOnly), async (c) => {
    const body = c.req.valid("json");
    const data = await server.collectGameInfos(body.region);
    return c.json(data);
});

// /api/find_spectator_game
app.post("/api/find_spectator_game", validateParams(zFindSpectator), async (c) => {
    const body = c.req.valid("json");
    const data = await server.findSpectatorGame(body);
    return c.json(data);
});

// /api/find_game_by_id
app.post("/api/find_game_by_id", validateParams(zFindGameById), async (c) => {
    const ip = getHonoIp(c, Config.apiServer.proxyIPHeader);

    if (!ip) {
        return c.json<FindGameResponse>({ error: "invalid_ip" }, 500);
    }

    if (findGameRateLimit.isRateLimited(ip)) {
        return c.json<FindGameResponse>({ error: "rate_limited" }, 429);
    }

    const banData = await isBanned(ip);
    if (banData) {
        return c.json<FindGameResponse>({
            banned: true,
            reason: banData.reason,
            permanent: banData.permanent,
            expiresIn: banData.expiresIn,
        });
    }

    const token = randomUUID();
    let user: UsersTableSelect | null = null;

    const sessionId = getCookie(c, "session") ?? null;

    if (sessionId) {
        try {
            const account = await validateSessionToken(sessionId);
            user = account.user;

            if (account.user?.banned) {
                user = null;
            }
        } catch (err) {
            server.logger.error("/api/find_game: Failed to validate session", err);
            user = null;
        }
    }

    if (!user && (await isBehindProxy(ip, 3))) {
        return c.json<FindGameResponse>({ error: "behind_proxy" });
    }

    const body = c.req.valid("json");
    const admin = user?.admin ?? false;

    const data = await server.findGameById(body.region, body.gameId, admin);
    return c.json(data);
});

app.post(
    "/api/report_error",
    rateLimitMiddleware(5, 60 * 1000),
    validateParams(z.object({ loc: z.string(), error: z.any(), data: z.any() })),
    (c) => {
        const content = c.req.valid("json");
        if (content.error) {
            try {
                content.error = JSON.parse(content.error);
            } catch {}
        }

        let stackTrace: string | undefined;
        if (
            typeof content.error == "object" &&
            "stacktrace" in content.error &&
            typeof content.error.stacktrace == "string" &&
            content.error.stacktrace
        ) {
            stackTrace = `### Stacktrace:\n \`\`\`${content.error.stacktrace.replaceAll("`", "\\`")}\`\`\``;
            delete content.error.stacktrace;
        }

        logErrorToWebhook("client", content, stackTrace);

        return c.json({ success: true }, 200);
    },
);

// reset player count to 0 if region seems to be down
setInterval(() => {
    for (const regionId in server.regions) {
        const region = server.regions[regionId];
        if (Date.now() - region.lastUpdateTime > 60000) {
            server.logger.warn(
                `Region ${regionId} has not sent player count in more than 60 seconds`,
            );
            region.playerCount = 0;
        }
    }
}, 60000);

// Take back marketplace listings older than their 24h TTL, freeing the item to be
// re-listed. Reads are already cutoff-guarded, so this just keeps the DB state truthful.
setInterval(
    () => {
        expireOldListings()
            .then((n) => {
                if (n > 0) server.logger.info(`Expired ${n} stale market listings`);
            })
            .catch((err) => server.logger.error("Failed to expire market listings", err));
    },
    10 * 60 * 1000,
);

// Lift time-limited account, IP and chat bans once their duration has run out and
// append the matching ban-history unban entries. Runs shortly after boot (so a
// restart clears anything that expired while down) and every 5 minutes after.
const sweepBans = () =>
    sweepExpiredBans().catch((err) =>
        server.logger.error("Failed to sweep expired bans", err),
    );
setTimeout(sweepBans, 15 * 1000);
setInterval(sweepBans, 5 * 60 * 1000);

// One-time backfill of pass item grants for existing accounts (no-op after the
// first run). Must finish before requests are served so the new grant logic doesn't
// duplicate items that pre-date the grant ledger.
try {
    await backfillPassItemGrants();
} catch (err) {
    server.logger.error("Failed to backfill pass item grants", err);
}

const honoServer = serve({
    fetch: app.fetch,
    port: Config.apiServer.port,
});
injectWebSocket(honoServer);

// Warm the ownership-based cosmetic rarity cache once at boot (then on-demand per request).
warmCosmeticStats();

// run clean up scripts every midnight
new Cron("0 0 * * *", async () => {
    try {
        await cleanupOldLogs();
        await deleteExpiredSessions();
        server.logger.info("Deleted old logs and expired sessions");
    } catch (err) {
        server.logger.error("Failed to run cleanup script", err);
    }

    // Daily full pass reconcile for all users (XP + item unlocks + Golden Fries).
    // Separate try/catch so a reconcile failure never blocks the cleanup above.
    try {
        const r = await reconcileAllPasses();
        server.logger.info(
            `Daily pass reconcile: ${r.usersReconciled} users fixed, +${r.totalXpAdded} XP, ` +
                `${r.totalUnlocksGranted} unlocks, ${r.totalGoldenFriesAwarded} golden fries`,
        );
    } catch (err) {
        server.logger.error("Failed to run daily pass reconcile", err);
    }

    // Recompute ownership-based cosmetic rarity + owner counts for the new day.
    try {
        await computeCosmeticStats();
        server.logger.info("Recomputed cosmetic ownership stats");
    } catch (err) {
        server.logger.error("Failed to recompute cosmetic stats", err);
    }
});

server.logger.info(`Survev API Server v${version} - GIT ${GIT_VERSION}`);
server.logger.info(`Listening on ${Config.apiServer.host}:${Config.apiServer.port}`);
server.logger.info("Press Ctrl+C to exit.");
