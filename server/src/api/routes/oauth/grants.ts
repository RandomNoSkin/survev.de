import { Hono } from "hono";
import { type OAuthGrantEntry, zApplicationIdRequest } from "../../../../../shared/types/oauth.ts";
import { authMiddleware, databaseEnabledMiddleware, rateLimitMiddleware, validateParams } from "../../auth/middleware.ts";
import { listGrantsByUser, revokeGrant } from "../../db/oauth.ts";
import type { Context } from "../../index.ts";

/** Session-cookie-authenticated "Connected Apps" panel (list + revoke). */
export const GrantsRouter = new Hono<Context>();

GrantsRouter.use(databaseEnabledMiddleware);
GrantsRouter.use(rateLimitMiddleware(40, 60 * 1000));
GrantsRouter.use(authMiddleware);

GrantsRouter.post("/list", async (c) => {
    const user = c.get("user")!;
    const grants = await listGrantsByUser(user.id);
    return c.json<OAuthGrantEntry[]>(grants);
});

GrantsRouter.post("/revoke", validateParams(zApplicationIdRequest), async (c) => {
    const user = c.get("user")!;
    const { applicationId } = c.req.valid("json");

    const revoked = await revokeGrant(user.id, applicationId);
    if (!revoked) return c.json({ error: "not_found" }, 404);
    return c.json({ success: true });
});
