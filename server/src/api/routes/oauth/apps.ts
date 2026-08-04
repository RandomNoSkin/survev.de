import { Hono } from "hono";
import {
    type CreateAppResponse,
    type OAuthApp,
    zApplicationIdRequest,
    zCreateAppRequest,
    zUpdateAppRequest,
} from "../../../../../shared/types/oauth.ts";
import { authMiddleware, databaseEnabledMiddleware, rateLimitMiddleware, validateParams } from "../../auth/middleware.ts";
import { createApp, deleteApp, listAppsByOwner, rotateAppSecret, updateApp } from "../../db/oauth.ts";
import type { Context } from "../../index.ts";

/** Session-cookie-authenticated dev-dashboard CRUD ("Meine Apps"). */
export const AppsRouter = new Hono<Context>();

AppsRouter.use(databaseEnabledMiddleware);
AppsRouter.use(rateLimitMiddleware(40, 60 * 1000));
AppsRouter.use(authMiddleware);

AppsRouter.post("/create", validateParams(zCreateAppRequest), async (c) => {
    const user = c.get("user")!;
    const body = c.req.valid("json");

    const result = await createApp(user.id, body);
    if ("error" in result) {
        return c.json({ error: result.error }, 400);
    }
    return c.json<CreateAppResponse>(result);
});

AppsRouter.post("/list", async (c) => {
    const user = c.get("user")!;
    const apps = await listAppsByOwner(user.id);
    return c.json<OAuthApp[]>(apps);
});

AppsRouter.post("/update", validateParams(zUpdateAppRequest), async (c) => {
    const user = c.get("user")!;
    const { applicationId, ...body } = c.req.valid("json");

    const app = await updateApp(user.id, applicationId, body);
    if (!app) return c.json({ error: "not_found" }, 404);
    return c.json<OAuthApp>(app);
});

AppsRouter.post("/rotate_secret", validateParams(zApplicationIdRequest), async (c) => {
    const user = c.get("user")!;
    const { applicationId } = c.req.valid("json");

    const result = await rotateAppSecret(user.id, applicationId);
    if (!result) return c.json({ error: "not_found" }, 404);
    return c.json<CreateAppResponse>(result);
});

AppsRouter.post("/delete", validateParams(zApplicationIdRequest), async (c) => {
    const user = c.get("user")!;
    const { applicationId } = c.req.valid("json");

    const deleted = await deleteApp(user.id, applicationId);
    if (!deleted) return c.json({ error: "not_found" }, 404);
    return c.json({ success: true });
});
