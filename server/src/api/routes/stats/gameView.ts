import { Hono } from "hono";
import type { Context } from "../..";
import { server } from "../../apiServer";
import { rateLimitMiddleware } from "../../auth/middleware";

/**
 * Public, rate-limited access to a finished game's god-view data (movement tracks +
 * aggregated damage), used by the stats game-view page. Game-scoped by region+gameId
 * (both come from the public match history); exposes only positions/health/damage and
 * player names — no IPs — consistent with the already-public `match_data`.
 */
export const gameViewRouter = new Hono<Context>();

const CACHE = "public, max-age=600";

gameViewRouter.get("/tracks", rateLimitMiddleware(40, 60 * 1000), async (c) => {
    const region = c.req.query("region") ?? "";
    const gameId = c.req.query("gameId") ?? "";
    if (!region || !gameId) {
        return c.json({ error: "invalid_params" }, 400);
    }
    const file = await server.streamReplayTracks(region, gameId);
    if (!file) {
        return c.json({ error: "not_found" }, 404);
    }
    return c.body(file, 200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": CACHE,
    });
});

gameViewRouter.get("/meta", rateLimitMiddleware(40, 60 * 1000), async (c) => {
    const region = c.req.query("region") ?? "";
    const gameId = c.req.query("gameId") ?? "";
    if (!region || !gameId) {
        return c.json({ error: "invalid_params" }, 400);
    }
    const data = await server.streamReplayGameMeta(region, gameId);
    if (!data) {
        return c.json({ error: "not_found" }, 404);
    }
    return c.json(data, 200, { "Cache-Control": CACHE });
});
