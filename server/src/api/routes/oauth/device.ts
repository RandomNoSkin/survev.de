import { Hono } from "hono";
import {
    type AuthorizeInfoResponse,
    type DeviceCodeResponse,
    zDeviceCodeRequest,
    zDeviceDecisionRequest,
    zDeviceLookupRequest,
} from "../../../../../shared/types/oauth.ts";
import { authMiddleware, databaseEnabledMiddleware, rateLimitMiddleware, validateParams } from "../../auth/middleware.ts";
import { Config } from "../../../config.ts";
import { createDeviceCode, decideDeviceCode, lookupDeviceCodeByUserCode, verifyClientCredentials } from "../../db/oauth.ts";
import type { Context } from "../../index.ts";

/**
 * Device-code flow: a bot backend (no callback URL of its own) requests a code here,
 * shows the short `userCode` to its user, and the user approves it on survev.de/link
 * while logged in. The bot then polls `/api/oauth/token` (grant_type=device_code)
 * until the user decides — see `pollDeviceCode` in db/oauth.ts for that state machine.
 */
export const DeviceRouter = new Hono<Context>();

DeviceRouter.use(databaseEnabledMiddleware);

// POST /api/oauth/device/code — public, client_id + client_secret authenticated
// (called by the bot's own backend, not the browser).
DeviceRouter.post(
    "/code",
    rateLimitMiddleware(20, 60 * 1000),
    validateParams(zDeviceCodeRequest),
    async (c) => {
        const { clientId, clientSecret, scope } = c.req.valid("json");

        const app = await verifyClientCredentials(clientId, clientSecret);
        if (!app) return c.json({ error: "invalid_client" }, 401);
        if (app.status !== "approved") return c.json({ error: "app_not_approved" }, 400);

        const { deviceCode, userCode, expiresIn, interval } = await createDeviceCode(
            app.id,
            scope,
        );
        const verificationUri = `${Config.oauthRedirectURI}/link`;

        return c.json<DeviceCodeResponse>({
            deviceCode,
            userCode,
            verificationUri,
            verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
            expiresIn,
            interval,
        });
    },
);

// Everything below is session-cookie authenticated: the browser, at /link.
DeviceRouter.use("/lookup", rateLimitMiddleware(40, 60 * 1000), authMiddleware);
DeviceRouter.use("/approve", rateLimitMiddleware(40, 60 * 1000), authMiddleware);
DeviceRouter.use("/deny", rateLimitMiddleware(40, 60 * 1000), authMiddleware);

DeviceRouter.post("/lookup", validateParams(zDeviceLookupRequest), async (c) => {
    const { userCode } = c.req.valid("json");

    const found = await lookupDeviceCodeByUserCode(userCode);
    if (!found) {
        // Deliberately generic — invalid, expired, already-used and unapproved-app
        // all look identical from the outside so the code can't be used as an oracle.
        return c.json<AuthorizeInfoResponse>({ error: "invalid_or_expired_code" }, 400);
    }

    return c.json<AuthorizeInfoResponse>({
        appName: found.appName,
        ownerSlug: found.ownerSlug,
        scopes: found.scopes,
    });
});

DeviceRouter.post("/approve", validateParams(zDeviceDecisionRequest), async (c) => {
    const user = c.get("user")!;
    const { userCode } = c.req.valid("json");

    const ok = await decideDeviceCode(userCode, user.id, "approved");
    if (!ok) return c.json({ error: "invalid_or_expired_code" }, 400);
    return c.json({ success: true });
});

DeviceRouter.post("/deny", validateParams(zDeviceDecisionRequest), async (c) => {
    const user = c.get("user")!;
    const { userCode } = c.req.valid("json");

    const ok = await decideDeviceCode(userCode, user.id, "denied");
    if (!ok) return c.json({ error: "invalid_or_expired_code" }, 400);
    return c.json({ success: true });
});
