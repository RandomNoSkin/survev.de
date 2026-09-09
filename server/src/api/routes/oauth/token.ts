import { Hono } from "hono";
import { type TokenErrorResponse, type TokenResponse, zTokenRequest } from "../../../../../shared/types/oauth.ts";
import { databaseEnabledMiddleware, rateLimitMiddleware, validateParams } from "../../auth/middleware.ts";
import { consumeAuthCode, pollDeviceCode, upsertGrant, verifyClientCredentials } from "../../db/oauth.ts";
import type { Context } from "../../index.ts";

/**
 * Server-to-server token endpoint, client_id + client_secret authenticated (never a
 * session cookie). Handles both consent flows via `grantType`: `authorization_code`
 * (redirect flow, single-use code) and `device_code` (the bot polls this repeatedly
 * until the user decides — see `pollDeviceCode`'s state machine in db/oauth.ts).
 */
export const TokenRouter = new Hono<Context>();

TokenRouter.use(databaseEnabledMiddleware);
// Generous limit: the device flow polls this endpoint repeatedly by design.
TokenRouter.use(rateLimitMiddleware(120, 60 * 1000));

TokenRouter.post("/", validateParams(zTokenRequest), async (c) => {
    const body = c.req.valid("json");

    const app = await verifyClientCredentials(body.clientId, body.clientSecret);
    if (!app) return c.json<TokenErrorResponse>({ error: "invalid_client" }, 401);
    if (app.status !== "approved") {
        return c.json<TokenErrorResponse>({ error: "app_not_approved" }, 400);
    }

    if (body.grantType === "authorization_code") {
        const result = await consumeAuthCode(body.code, body.clientId, body.redirectUri);
        if (!result) return c.json<TokenErrorResponse>({ error: "invalid_grant" }, 400);

        const accessToken = await upsertGrant(result.userId, body.clientId, result.scopes);
        return c.json<TokenResponse>({
            accessToken,
            tokenType: "bearer",
            scope: result.scopes,
        });
    }

    // grantType === "device_code"
    const result = await pollDeviceCode(body.deviceCode, body.clientId);
    if (result.type === "error") {
        return c.json<TokenErrorResponse>({ error: result.error }, 400);
    }
    return c.json<TokenResponse>({
        accessToken: result.token,
        tokenType: "bearer",
        scope: result.scopes,
    });
});
