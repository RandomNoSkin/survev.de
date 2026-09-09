import { Hono } from "hono";
import {
    type AuthorizeDecisionResponse,
    type AuthorizeInfoResponse,
    OAUTH_SCOPES,
    type OAuthScope,
    zAuthorizeRequest,
} from "../../../../../shared/types/oauth.ts";
import { authMiddleware, databaseEnabledMiddleware, rateLimitMiddleware, validateParams } from "../../auth/middleware.ts";
import { createAuthCode, getApprovedApp } from "../../db/oauth.ts";
import type { Context } from "../../index.ts";

/**
 * Redirect (classic OAuth2 authorization_code) consent flow. Session-cookie
 * authenticated — this is what the browser hits when a third-party app sends its
 * user to survev.de to approve access. Never redirects on a validation failure (an
 * unvalidated redirect_uri would be an open-redirect vector) — always a JSON error.
 */
export const AuthorizeRouter = new Hono<Context>();

AuthorizeRouter.use(databaseEnabledMiddleware);
AuthorizeRouter.use(rateLimitMiddleware(40, 60 * 1000));
AuthorizeRouter.use(authMiddleware);

function parseScopes(raw: string | undefined): OAuthScope[] | null {
    if (!raw) return null;
    const parts = raw.split(/[\s,]+/).filter(Boolean);
    if (!parts.length) return null;
    const allowed: readonly string[] = OAUTH_SCOPES;
    if (!parts.every((s) => allowed.includes(s))) return null;
    return parts as OAuthScope[];
}

/** Looks up the app + validates redirect_uri; shared by GET / and both POST decisions. */
async function resolveApprovedRedirect(clientId: string, redirectUri: string) {
    const found = await getApprovedApp(clientId);
    if (!found) return null;
    if (!found.app.redirectUris.includes(redirectUri)) return null;
    return found;
}

// GET /api/oauth/authorize?client_id=&redirect_uri=&scope=read:discord+read:stats&state=
// Query-string, not a JSON body, since this is the URL a third-party app links its
// user to directly (standard OAuth2 authorize-endpoint shape).
AuthorizeRouter.get("/", async (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const scopes = parseScopes(c.req.query("scope"));

    if (!clientId || !redirectUri || !scopes) {
        return c.json<AuthorizeInfoResponse>({ error: "invalid_request" }, 400);
    }

    const found = await resolveApprovedRedirect(clientId, redirectUri);
    if (!found) {
        return c.json<AuthorizeInfoResponse>({ error: "app_not_approved" }, 400);
    }

    return c.json<AuthorizeInfoResponse>({
        appName: found.app.name,
        ownerSlug: found.ownerSlug,
        scopes,
    });
});

AuthorizeRouter.post("/approve", validateParams(zAuthorizeRequest), async (c) => {
    const user = c.get("user")!;
    const { clientId, redirectUri, scope, state } = c.req.valid("json");

    const found = await resolveApprovedRedirect(clientId, redirectUri);
    if (!found) return c.json({ error: "invalid_request" }, 400);

    const code = await createAuthCode(clientId, user.id, redirectUri, scope);
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);

    return c.json<AuthorizeDecisionResponse>({ redirectUrl: url.toString() });
});

AuthorizeRouter.post("/deny", validateParams(zAuthorizeRequest), async (c) => {
    const { clientId, redirectUri, state } = c.req.valid("json");

    // Re-validated exactly like /approve — otherwise this endpoint would let anyone
    // logged in bounce the browser to an arbitrary redirect_uri (open redirect).
    const found = await resolveApprovedRedirect(clientId, redirectUri);
    if (!found) return c.json({ error: "invalid_request" }, 400);

    const url = new URL(redirectUri);
    url.searchParams.set("error", "access_denied");
    if (state) url.searchParams.set("state", state);

    return c.json<AuthorizeDecisionResponse>({ redirectUrl: url.toString() });
});
