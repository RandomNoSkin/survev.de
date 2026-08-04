import { Hono } from "hono";
import { type DiscordLinkResponse, zExternalMatchHistoryRequest } from "../../../../../shared/types/oauth.ts";
import { type MatchHistoryResponse, type UserStatsResponse, zUserStatsRequest } from "../../../../../shared/types/stats.ts";
import { databaseEnabledMiddleware, validateParams } from "../../auth/middleware.ts";
import { oauthAppRateLimitMiddleware, requireOAuthScope } from "../../auth/oauthMiddleware.ts";
import { matchHistoryQuery } from "../../db/matchHistory.ts";
import { userStatsSqlQuery } from "../../db/stats.ts";
import type { Context } from "../../index.ts";

const zExternalStatsRequest = zUserStatsRequest.omit({ slug: true });

/**
 * Resource API for third-party applications: bearer-token authenticated (see
 * `requireOAuthScope`), one endpoint per scope, called server-to-server by an app's
 * own backend (no session cookie, no CORS concern) on behalf of a user who granted
 * that scope through the /authorize or /link consent flow.
 */
export const ExternalRouter = new Hono<Context>();

ExternalRouter.use(databaseEnabledMiddleware);

ExternalRouter.post(
    "/discord_link",
    requireOAuthScope("read:discord"),
    oauthAppRateLimitMiddleware,
    async (c) => {
        const user = c.get("user")!;
        return c.json<DiscordLinkResponse>({
            linked: user.linkedDiscord,
            discordUserId: user.linkedDiscord ? user.authId : null,
            slug: user.slug,
            username: user.username,
        });
    },
);

ExternalRouter.post(
    "/stats",
    requireOAuthScope("read:stats"),
    oauthAppRateLimitMiddleware,
    validateParams(zExternalStatsRequest),
    async (c) => {
        const user = c.get("user")!;
        const { interval, mapIdFilter } = c.req.valid("json");

        const data = await userStatsSqlQuery(user.id, mapIdFilter, interval);

        return c.json<UserStatsResponse>(data);
    },
);

ExternalRouter.post(
    "/match_history",
    requireOAuthScope("read:stats"),
    oauthAppRateLimitMiddleware,
    validateParams(zExternalMatchHistoryRequest),
    async (c) => {
        const user = c.get("user")!;
        const { from, to, teamModeFilter, offset, count, withSlugs } = c.req.valid("json");

        const data = await matchHistoryQuery({
            userId: user.id,
            teamModeFilter,
            from: from != null ? new Date(from) : undefined,
            to: to != null ? new Date(to) : undefined,
            offset,
            limit: count,
            withSlugs,
        });

        return c.json<MatchHistoryResponse>(data);
    },
);
