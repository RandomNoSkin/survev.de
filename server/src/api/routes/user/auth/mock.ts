import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import { Config } from "../../../../config.ts";
import { db } from "../../../db/index.ts";
import { usersTable } from "../../../db/schema.ts";
import { createNewUser, generateId, sanitizeSlug, setSessionTokenCookie } from "./authUtils.ts";

export const MockRouter = new Hono();

export const MOCK_USER_ID = "MOCK_USER_ID";

/** Prefix for the `authId` of named/fresh mock accounts (keeps them deterministic). */
const MOCK_AUTH_PREFIX = "MOCK:";

/** Picks a slug derived from `username` that isn't already taken. */
async function uniqueSlug(username: string): Promise<string> {
    const base = sanitizeSlug(username);
    let slug = base;
    while (
        await db.query.usersTable.findFirst({
            where: eq(usersTable.slug, slug),
            columns: { id: true },
        })
    ) {
        slug = `${base}-${generateId(4).toLowerCase()}`;
    }
    return slug;
}

/** Logs in (creating on first use) the mock account with `authId`, then redirects home. */
async function loginMock(
    c: Context,
    authId: string,
    username: string,
    fixedSlug?: string,
) {
    setCookie(c, "app-data", "1", {
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    });

    const existingUser = await db.query.usersTable.findFirst({
        where: eq(usersTable.authId, authId),
        columns: { id: true },
    });

    if (existingUser) {
        await setSessionTokenCookie(existingUser.id, c);
        return c.redirect(Config.oauthBasePath);
    }

    const userId = generateId(15);
    await createNewUser({
        id: userId,
        authId,
        username,
        linked: true,
        slug: fixedSlug ?? (await uniqueSlug(username)),
    });

    await setSessionTokenCookie(userId, c);
    return c.redirect(Config.oauthBasePath);
}

/**
 * Dev-only fake auth. Lets you create and switch between as many mock accounts as you
 * like (only mounted when `Config.debug.allowMockAccount` is on):
 *
 *   /api/auth/mock              → the default shared mock account (legacy behaviour)
 *   /api/auth/mock?name=alice   → a named account; revisiting the same name logs back in,
 *                                 so you can hop between "alice", "bob", … to test trading
 *   /api/auth/mock?fresh=1      → a brand-new throwaway account every time
 *
 * Switching is just hitting the URL again with a different name — it overwrites the
 * session cookie, so two browser profiles can each hold a different mock account.
 */
MockRouter.get("/", async (c) => {
    const name = (c.req.query("name") ?? "").trim();
    const fresh = c.req.query("fresh") === "1" || c.req.query("new") === "1";

    // Default: the single shared account (kept stable so dev data persists across runs).
    if (!name && !fresh) {
        return loginMock(c, MOCK_USER_ID, MOCK_USER_ID, MOCK_USER_ID);
    }

    // Fresh / unnamed-but-fresh: a unique random account that won't collide.
    if (fresh) {
        const rnd = generateId(6);
        return loginMock(c, `${MOCK_AUTH_PREFIX}${rnd}`, name || `Mock ${rnd}`);
    }

    // Named: deterministic authId from the name, so the same name reuses the account.
    return loginMock(c, `${MOCK_AUTH_PREFIX}${name.toLowerCase()}`, name);
});
