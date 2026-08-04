import type { Context, Next } from "hono";
import type { OAuthScope } from "../../../../shared/types/oauth.ts";
import { HTTPRateLimit } from "../../utils/rateLimit.ts";
import { getGrantByAccessToken, touchGrantLastUsed } from "../db/oauth.ts";

/**
 * Authenticates a resource-endpoint request via `Authorization: Bearer <token>`,
 * verifies the grant carries `scope`, and populates `c.get("user")`/`c.get("oauthGrant")`
 * the same way `authMiddleware` populates `user`/`session` for session-cookie routes.
 *
 * Always a live DB lookup — no caching — so revoking a grant (`db/oauth.ts`'s
 * `revokeGrant`, or deleting the app/account, both of which cascade) takes effect on
 * the very next request.
 */
export function requireOAuthScope(scope: OAuthScope) {
    return async (c: Context, next: Next) => {
        const authHeader = c.req.header("Authorization") ?? "";
        if (!authHeader.startsWith("Bearer ")) {
            return c.json({ error: "invalid_token" }, 401);
        }
        const token = authHeader.slice("Bearer ".length).trim();
        if (!token) {
            return c.json({ error: "invalid_token" }, 401);
        }

        const result = await getGrantByAccessToken(token);
        if (!result) {
            return c.json({ error: "invalid_token" }, 401);
        }

        const { grant, user } = result;
        if (!grant.scopes.includes(scope)) {
            return c.json({ error: "insufficient_scope" }, 403);
        }

        touchGrantLastUsed(grant.userId, grant.applicationId, grant.lastUsedAt);

        c.set("user", user);
        c.set("oauthGrant", grant);
        return next();
    };
}

// Keyed by application id (not IP): a third-party backend calling on behalf of many
// of its own users shares one IP, so an IP-keyed limit would punish all of them for
// one noisy app. Applied after requireOAuthScope so `oauthGrant` is populated.
const externalApiRateLimit = new HTTPRateLimit(60, 60 * 1000);

export async function oauthAppRateLimitMiddleware(c: Context, next: Next) {
    const grant = c.get("oauthGrant");
    if (grant && externalApiRateLimit.isRateLimited(grant.applicationId)) {
        return c.json({ error: "rate_limited" }, 429);
    }
    return next();
}
