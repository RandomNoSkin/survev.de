import { randomBytes } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import type { OAuthApp, OAuthAppStatus, OAuthGrantEntry, OAuthScope } from "../../../../shared/types/oauth.ts";
import { toSha256 } from "../auth/index.ts";
import { generateId } from "../routes/user/auth/authUtils.ts";
import { db } from "./index.ts";
import {
    type OAuthApplicationSelect,
    oauthApplicationsTable,
    oauthAuthCodesTable,
    oauthDeviceCodesTable,
    oauthGrantsTable,
    type UsersTableSelect,
    usersTable,
} from "./schema.ts";

/** Max applications a user may have awaiting admin review at once (anti-spam). */
export const MAX_PENDING_APPS_PER_USER = 5;

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DEVICE_POLL_INTERVAL_SEC = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function randomToken(): string {
    return randomBytes(32).toString("base64url");
}

function generateUserCode(): string {
    let code = "";
    for (let i = 0; i < 8; i++) {
        code += USER_CODE_ALPHABET[Math.floor(Math.random() * USER_CODE_ALPHABET.length)];
    }
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function toPublicApp(row: OAuthApplicationSelect): OAuthApp {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        redirectUris: row.redirectUris,
        status: row.status,
        reviewNote: row.reviewNote,
        secretLastFour: row.secretLastFour,
        createdAt: row.createdAt.toISOString(),
        secretRotatedAt: row.secretRotatedAt?.toISOString() ?? null,
    };
}

//
// ─── Dev-dashboard app management ──────────────────────────────────────────
//

export async function createApp(
    ownerId: string,
    input: { name: string; description: string; redirectUris: string[] },
): Promise<{ app: OAuthApp; clientSecret: string } | { error: "too_many_pending" }> {
    const pendingCount = await db.$count(
        oauthApplicationsTable,
        and(
            eq(oauthApplicationsTable.ownerId, ownerId),
            eq(oauthApplicationsTable.status, "pending"),
        ),
    );
    if (pendingCount >= MAX_PENDING_APPS_PER_USER) {
        return { error: "too_many_pending" };
    }

    const id = generateId(24);
    const secret = randomToken();
    const [row] = await db
        .insert(oauthApplicationsTable)
        .values({
            id,
            ownerId,
            name: input.name,
            description: input.description,
            redirectUris: input.redirectUris,
            clientSecretHash: toSha256(secret),
            secretLastFour: secret.slice(-4),
        })
        .returning();

    return { app: toPublicApp(row), clientSecret: secret };
}

export async function listAppsByOwner(ownerId: string): Promise<OAuthApp[]> {
    const rows = await db
        .select()
        .from(oauthApplicationsTable)
        .where(eq(oauthApplicationsTable.ownerId, ownerId));
    return rows.map(toPublicApp);
}

export async function updateApp(
    ownerId: string,
    applicationId: string,
    input: { name: string; description: string; redirectUris: string[] },
): Promise<OAuthApp | null> {
    const [row] = await db
        .update(oauthApplicationsTable)
        .set({
            name: input.name,
            description: input.description,
            redirectUris: input.redirectUris,
        })
        .where(
            and(
                eq(oauthApplicationsTable.id, applicationId),
                eq(oauthApplicationsTable.ownerId, ownerId),
            ),
        )
        .returning();
    return row ? toPublicApp(row) : null;
}

export async function rotateAppSecret(
    ownerId: string,
    applicationId: string,
): Promise<{ app: OAuthApp; clientSecret: string } | null> {
    const secret = randomToken();
    const [row] = await db
        .update(oauthApplicationsTable)
        .set({
            clientSecretHash: toSha256(secret),
            secretLastFour: secret.slice(-4),
            secretRotatedAt: new Date(),
        })
        .where(
            and(
                eq(oauthApplicationsTable.id, applicationId),
                eq(oauthApplicationsTable.ownerId, ownerId),
            ),
        )
        .returning();
    return row ? { app: toPublicApp(row), clientSecret: secret } : null;
}

export async function deleteApp(ownerId: string, applicationId: string): Promise<boolean> {
    const rows = await db
        .delete(oauthApplicationsTable)
        .where(
            and(
                eq(oauthApplicationsTable.id, applicationId),
                eq(oauthApplicationsTable.ownerId, ownerId),
            ),
        )
        .returning({ id: oauthApplicationsTable.id });
    return rows.length > 0;
}

//
// ─── Consent-flow app lookups (not owner-scoped) ───────────────────────────
//

/** Looks up an approved app by client_id, for the consent screens (/authorize, /device). */
export async function getApprovedApp(clientId: string): Promise<
    { app: OAuthApplicationSelect; ownerSlug: string } | null
> {
    const [row] = await db
        .select({ app: oauthApplicationsTable, ownerSlug: usersTable.slug })
        .from(oauthApplicationsTable)
        .innerJoin(usersTable, eq(usersTable.id, oauthApplicationsTable.ownerId))
        .where(
            and(
                eq(oauthApplicationsTable.id, clientId),
                eq(oauthApplicationsTable.status, "approved" satisfies OAuthAppStatus),
            ),
        );
    return row ?? null;
}

/** Verifies client_id + client_secret for server-to-server calls (/device/code, /token). */
export async function verifyClientCredentials(
    clientId: string,
    clientSecret: string,
): Promise<OAuthApplicationSelect | null> {
    const [row] = await db
        .select()
        .from(oauthApplicationsTable)
        .where(eq(oauthApplicationsTable.id, clientId));
    if (!row) return null;
    if (row.clientSecretHash !== toSha256(clientSecret)) return null;
    return row;
}

//
// ─── Grants (long-lived, revocable access tokens) ──────────────────────────
//

/** Approves consent and issues (or rotates) the (user, app) access token. */
export async function upsertGrant(
    userId: string,
    applicationId: string,
    scopes: OAuthScope[],
): Promise<string> {
    const token = randomToken();
    await db
        .insert(oauthGrantsTable)
        .values({
            userId,
            applicationId,
            scopes,
            accessTokenHash: toSha256(token),
        })
        .onConflictDoUpdate({
            target: [oauthGrantsTable.userId, oauthGrantsTable.applicationId],
            set: {
                scopes,
                accessTokenHash: toSha256(token),
                createdAt: new Date(),
                lastUsedAt: null,
            },
        });
    return token;
}

export async function listGrantsByUser(userId: string): Promise<OAuthGrantEntry[]> {
    const rows = await db
        .select({
            applicationId: oauthGrantsTable.applicationId,
            appName: oauthApplicationsTable.name,
            scopes: oauthGrantsTable.scopes,
            createdAt: oauthGrantsTable.createdAt,
            lastUsedAt: oauthGrantsTable.lastUsedAt,
        })
        .from(oauthGrantsTable)
        .innerJoin(
            oauthApplicationsTable,
            eq(oauthApplicationsTable.id, oauthGrantsTable.applicationId),
        )
        .where(eq(oauthGrantsTable.userId, userId));

    return rows.map((r) => ({
        applicationId: r.applicationId,
        appName: r.appName,
        scopes: r.scopes,
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    }));
}

export async function revokeGrant(userId: string, applicationId: string): Promise<boolean> {
    const rows = await db
        .delete(oauthGrantsTable)
        .where(
            and(
                eq(oauthGrantsTable.userId, userId),
                eq(oauthGrantsTable.applicationId, applicationId),
            ),
        )
        .returning({ userId: oauthGrantsTable.userId });
    return rows.length > 0;
}

/** Live lookup used by the bearer-token resource middleware — never cached. */
export async function getGrantByAccessToken(
    rawToken: string,
): Promise<{ grant: typeof oauthGrantsTable.$inferSelect; user: UsersTableSelect } | null> {
    const [row] = await db
        .select({ grant: oauthGrantsTable, user: usersTable })
        .from(oauthGrantsTable)
        .innerJoin(usersTable, eq(usersTable.id, oauthGrantsTable.userId))
        .where(eq(oauthGrantsTable.accessTokenHash, toSha256(rawToken)));
    return row ?? null;
}

const LAST_USED_UPDATE_THROTTLE_MS = 5 * 60 * 1000;

/** Throttled — only writes if `lastUsedAt` is stale, to avoid a write on every call. */
export function touchGrantLastUsed(userId: string, applicationId: string, lastUsedAt: Date | null): void {
    if (lastUsedAt && Date.now() - lastUsedAt.getTime() < LAST_USED_UPDATE_THROTTLE_MS) return;
    db.update(oauthGrantsTable)
        .set({ lastUsedAt: new Date() })
        .where(
            and(
                eq(oauthGrantsTable.userId, userId),
                eq(oauthGrantsTable.applicationId, applicationId),
            ),
        )
        .catch(() => {});
}

//
// ─── Redirect flow: authorization codes ────────────────────────────────────
//

export async function createAuthCode(
    applicationId: string,
    userId: string,
    redirectUri: string,
    scopes: OAuthScope[],
): Promise<string> {
    const code = randomToken();
    await db.insert(oauthAuthCodesTable).values({
        id: toSha256(code),
        applicationId,
        userId,
        redirectUri,
        scopes,
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    });
    return code;
}

/** Single-use: deletes the code as part of consuming it. */
export async function consumeAuthCode(
    rawCode: string,
    clientId: string,
    redirectUri: string,
): Promise<{ userId: string; scopes: OAuthScope[] } | null> {
    const [row] = await db
        .delete(oauthAuthCodesTable)
        .where(eq(oauthAuthCodesTable.id, toSha256(rawCode)))
        .returning();
    if (!row) return null;
    if (row.applicationId !== clientId) return null;
    if (row.redirectUri !== redirectUri) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    return { userId: row.userId, scopes: row.scopes };
}

//
// ─── Device flow ────────────────────────────────────────────────────────────
//

export async function createDeviceCode(
    applicationId: string,
    scopes: OAuthScope[],
): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number }> {
    const deviceCode = randomToken();
    let userCode = generateUserCode();

    // Vanishingly unlikely to collide, but the column is unique — retry a few times.
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await db.insert(oauthDeviceCodesTable).values({
                id: toSha256(deviceCode),
                userCode,
                applicationId,
                scopes,
                pollIntervalSec: DEFAULT_DEVICE_POLL_INTERVAL_SEC,
                expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_MS),
            });
            break;
        } catch {
            userCode = generateUserCode();
            if (attempt === 4) throw new Error("Failed to allocate a unique device user_code");
        }
    }

    return {
        deviceCode,
        userCode,
        expiresIn: Math.floor(DEVICE_CODE_TTL_MS / 1000),
        interval: DEFAULT_DEVICE_POLL_INTERVAL_SEC,
    };
}

/** For the /link consent screen. Generic not-found result for invalid/expired/used codes. */
export async function lookupDeviceCodeByUserCode(userCode: string): Promise<
    { applicationId: string; appName: string; ownerSlug: string; scopes: OAuthScope[] } | null
> {
    const [row] = await db
        .select({
            applicationId: oauthDeviceCodesTable.applicationId,
            status: oauthDeviceCodesTable.status,
            expiresAt: oauthDeviceCodesTable.expiresAt,
            scopes: oauthDeviceCodesTable.scopes,
            appName: oauthApplicationsTable.name,
            appStatus: oauthApplicationsTable.status,
            ownerSlug: usersTable.slug,
        })
        .from(oauthDeviceCodesTable)
        .innerJoin(
            oauthApplicationsTable,
            eq(oauthApplicationsTable.id, oauthDeviceCodesTable.applicationId),
        )
        .innerJoin(usersTable, eq(usersTable.id, oauthApplicationsTable.ownerId))
        .where(eq(oauthDeviceCodesTable.userCode, userCode.trim().toUpperCase()));

    if (!row) return null;
    if (row.status !== "pending") return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    if (row.appStatus !== "approved") return null;

    return {
        applicationId: row.applicationId,
        appName: row.appName,
        ownerSlug: row.ownerSlug,
        scopes: row.scopes,
    };
}

export async function decideDeviceCode(
    userCode: string,
    userId: string,
    decision: "approved" | "denied",
): Promise<boolean> {
    const rows = await db
        .update(oauthDeviceCodesTable)
        .set({ status: decision, userId })
        .where(
            and(
                eq(oauthDeviceCodesTable.userCode, userCode.trim().toUpperCase()),
                eq(oauthDeviceCodesTable.status, "pending"),
            ),
        )
        .returning({ id: oauthDeviceCodesTable.id });
    return rows.length > 0;
}

export type DevicePollResult =
    | { type: "success"; token: string; scopes: OAuthScope[] }
    | { type: "error"; error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant" };

/** Implements the RFC 8628-flavored pending/slow_down/denied/expired state machine. */
export async function pollDeviceCode(
    rawDeviceCode: string,
    clientId: string,
): Promise<DevicePollResult> {
    const id = toSha256(rawDeviceCode);
    const [row] = await db.select().from(oauthDeviceCodesTable).where(eq(oauthDeviceCodesTable.id, id));
    if (!row || row.applicationId !== clientId) return { type: "error", error: "invalid_grant" };

    if (row.expiresAt.getTime() < Date.now()) {
        await db.delete(oauthDeviceCodesTable).where(eq(oauthDeviceCodesTable.id, id));
        return { type: "error", error: "expired_token" };
    }

    if (row.status === "denied") {
        await db.delete(oauthDeviceCodesTable).where(eq(oauthDeviceCodesTable.id, id));
        return { type: "error", error: "access_denied" };
    }

    if (row.status === "pending") {
        const now = Date.now();
        if (row.lastPolledAt && now - row.lastPolledAt.getTime() < row.pollIntervalSec * 1000) {
            await db
                .update(oauthDeviceCodesTable)
                .set({ pollIntervalSec: row.pollIntervalSec + 5 })
                .where(eq(oauthDeviceCodesTable.id, id));
            return { type: "error", error: "slow_down" };
        }
        await db
            .update(oauthDeviceCodesTable)
            .set({ lastPolledAt: new Date() })
            .where(eq(oauthDeviceCodesTable.id, id));
        return { type: "error", error: "authorization_pending" };
    }

    // status === "approved"
    await db.delete(oauthDeviceCodesTable).where(eq(oauthDeviceCodesTable.id, id));
    const token = await upsertGrant(row.userId!, row.applicationId, row.scopes);
    return { type: "success", token, scopes: row.scopes };
}

//
// ─── Moderation dashboard: app review ──────────────────────────────────────
//

/** Lists apps for the moderation dashboard's Apps tab, optionally filtered by status
 *  (e.g. "pending" for the review queue); omit the filter to list every app. */
export async function listApps(status?: OAuthAppStatus) {
    const rows = await db
        .select({ app: oauthApplicationsTable, ownerSlug: usersTable.slug })
        .from(oauthApplicationsTable)
        .innerJoin(usersTable, eq(usersTable.id, oauthApplicationsTable.ownerId))
        .where(status ? eq(oauthApplicationsTable.status, status) : undefined)
        .orderBy(desc(oauthApplicationsTable.createdAt));
    return rows.map((r) => ({ ...toPublicApp(r.app), ownerSlug: r.ownerSlug }));
}

export async function reviewApp(
    applicationId: string,
    reviewedBy: string,
    decision: "approve" | "reject",
    note: string,
): Promise<boolean> {
    const rows = await db
        .update(oauthApplicationsTable)
        .set({
            status: decision === "approve" ? "approved" : "rejected",
            reviewedBy,
            reviewedAt: new Date(),
            reviewNote: note,
        })
        .where(eq(oauthApplicationsTable.id, applicationId))
        .returning({ id: oauthApplicationsTable.id });
    return rows.length > 0;
}

//
// ─── Cleanup sweep (hooked into the daily cron, like deleteExpiredSessions) ─
//

export async function cleanupExpiredOAuthArtifacts(): Promise<void> {
    const now = new Date();
    await db.delete(oauthAuthCodesTable).where(lt(oauthAuthCodesTable.expiresAt, now));
    await db.delete(oauthDeviceCodesTable).where(lt(oauthDeviceCodesTable.expiresAt, now));
}
