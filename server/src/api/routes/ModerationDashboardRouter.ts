/**
 * Moderation Dashboard Router
 *
 * All routes require an active session with admin=true.
 * Non-admin or unauthenticated requests are redirected to Discord OAuth
 * which will send the user back here after login.
 *
 * Route overview:
 *   GET  /moderation                               → serve the dashboard SPA
 *   GET  /moderation/api/me                        → current admin user info
 *   GET  /moderation/api/bans                      → all IP, account, and chat bans
 *   POST /moderation/api/ban/ip                    → create an IP ban
 *   POST /moderation/api/ban/account               → create an account ban
 *   POST /moderation/api/ban/chat                  → create a chat ban
 *   POST /moderation/api/unban/ip                  → remove an IP ban
 *   POST /moderation/api/unban/account             → remove an account ban
 *   POST /moderation/api/unban/chat                → remove a chat ban
 *   GET  /moderation/api/ip/:hash                  → IP details: accounts + ISP
 *   GET  /moderation/api/player/:name              → player details: IPs used + ISP
 *   GET  /moderation/api/ban-comments/:type/:target → comment thread for a ban
 *   POST /moderation/api/ban-comments              → add a comment to a ban
 *   GET  /moderation/api/chat/:query               → chat history for one player (by name/ip)
 *   GET  /moderation/api/chatlog                    → global chat log (newest first), ?search= to filter
 *   GET  /moderation/api/chatlog/game/:gameId       → full chat of one game (for message context)
 *   GET  /moderation/api/events                    → SSE stream for live updates
 *   GET  /moderation/api/game/:region/:id/players  → live player list for a game
 *   POST /moderation/api/game/:region/:id/cmd      → execute admin command on a game
 */

import {
    and,
    asc,
    desc,
    eq,
    gt,
    gte,
    ilike,
    inArray,
    isNull,
    lte,
    notInArray,
    or,
    sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { z } from "zod";
import { PassDefs } from "../../../../shared/defs/gameObjects/passDefs";
import {
    _allowedCrosshairs,
    _allowedEmotes,
    _allowedHealEffects,
    _allowedMeleeSkins,
    _allowedOutfits,
    _allowedDeathEffects,
    UnlockDefs,
} from "../../../../shared/defs/gameObjects/unlockDefs";
import { MapId, TeamModeToString } from "../../../../shared/defs/types/misc";
import { GameConfig } from "../../../../shared/gameConfig";
import { util } from "../../../../shared/utils/util";
import { logModerationAction } from "../../utils/serverHelpers";
import type { Context } from "..";
import { server } from "../apiServer";
import { validateSessionToken } from "../auth";
import { validateParams } from "../auth/middleware";
import { db } from "../db";
import { awardGoldenFries } from "../db/goldenFries";
import { grantPassItems, revokePassItemsAbove } from "../db/passGrants";
import { getPassLevelAndXp, reconcileAllPasses } from "../db/passReconcile";
import {
    banCommentsTable,
    banHistoryTable,
    bannedIpsTable,
    chatBannedIpsTable,
    chatLogsTable,
    ipLogsTable,
    itemsTable,
    matchDataTable,
    usersTable,
    userXpTable,
} from "../db/schema";
import { signReplayToken } from "../replayToken";
import { dashboardHtml } from "./moderationDashboard.html";

/** Every cosmetic an admin may grant, by category, for the account-detail "Give" UI. */
const COSMETIC_CATALOG = {
    outfit: _allowedOutfits,
    melee: _allowedMeleeSkins,
    heal: _allowedHealEffects,
    emote: _allowedEmotes,
    deathEffect: _allowedDeathEffects,
    crosshair: _allowedCrosshairs,
};
const ALLOWED_COSMETICS = [...new Set(Object.values(COSMETIC_CATALOG).flat())];

/** Default-unlock item types that must never be removed (would break accounts). */
const PROTECTED_ITEM_TYPES = [
    ...(UnlockDefs.unlock_default?.unlocks ?? []),
    ...(UnlockDefs.unlock_new_account?.unlocks ?? []),
];

/** Formats the executing admin for audit fields, adding a Discord @mention when linked. */
function adminTag(admin: {
    slug: string;
    authId?: string | null;
    linkedDiscord?: boolean;
}): string {
    return admin.linkedDiscord && admin.authId
        ? `${admin.slug} (<@${admin.authId}>)`
        : admin.slug;
}

// ─── Admin guard middleware ────────────────────────────────────────────────────

/**
 * Checks for a valid session with admin=true.
 * If not authenticated → redirect to Discord OAuth with a return-to cookie.
 * If authenticated but not admin → 403.
 */
const isProd = process.env["NODE_ENV"] === "production";

async function adminGuard(c: any, next: () => Promise<void>) {
    if (!isProd) {
        c.set("user", { id: "dev", username: "dev", slug: "dev", admin: true });
        return next();
    }

    const sessionToken = getCookie(c, "session") ?? null;

    if (!sessionToken) {
        return c.redirect(`/api/auth/discord?redirect=/moderation`);
    }

    const { user } = await validateSessionToken(sessionToken);

    if (!user) {
        return c.redirect(`/api/auth/discord?redirect=/moderation`);
    }

    if (!user.admin) {
        return c.text("Forbidden: admin access required", 403);
    }

    c.set("user", user);
    return next();
}

// ─── SSE broadcast state ───────────────────────────────────────────────────────

/** All currently open SSE streams from connected admin browsers. */
const activeSseStreams = new Set<SSEStreamingApi>();

/** Fetches all bans from the DB and returns a serialisable payload. */
async function fetchAllBans() {
    const [ipBans, accountBans, chatBans] = await Promise.all([
        db.query.bannedIpsTable.findMany({ orderBy: [desc(bannedIpsTable.createdAt)] }),
        db.query.usersTable.findMany({
            where: eq(usersTable.banned, true),
            columns: {
                id: true,
                slug: true,
                username: true,
                banReason: true,
                bannedBy: true,
                userCreated: true,
            },
        }),
        db.query.chatBannedIpsTable.findMany({
            orderBy: [desc(chatBannedIpsTable.createdAt)],
        }),
    ]);
    return { ipBans, accountBans, chatBans };
}

/** Appends a ban event to the audit log (`ban_history`). */
async function recordBan(entry: {
    banType: "ip" | "account" | "chat";
    banTarget: string;
    reason: string;
    bannedBy: string;
    expiresAt: Date | null;
    permanent: boolean;
}) {
    await db.insert(banHistoryTable).values(entry);
}

/** Closes all still-active history entries for a target (sets unban time + actor). */
async function recordUnban(
    banType: "ip" | "account" | "chat",
    banTarget: string,
    unbannedBy: string,
) {
    await db
        .update(banHistoryTable)
        .set({ unbannedAt: new Date(), unbannedBy })
        .where(
            and(
                eq(banHistoryTable.banType, banType),
                eq(banHistoryTable.banTarget, banTarget),
                isNull(banHistoryTable.unbannedAt),
            ),
        );
}

/**
 * Pushes the current ban list to every connected admin browser.
 * Called after any ban or unban operation so all open dashboards update instantly.
 */
async function broadcastBans() {
    if (activeSseStreams.size === 0) return;
    const bans = await fetchAllBans();
    const data = JSON.stringify(bans);
    for (const stream of activeSseStreams) {
        try {
            await stream.writeSSE({ event: "bans", data });
        } catch {
            /* client gone */
        }
    }
}

/** Fetches the server/game list from all regions, including private lobby matches with "Public Spectating" disabled. */
async function fetchServers() {
    const regions = await Promise.all(
        Object.entries(server.regions).map(async ([regionId, region]) => {
            const infos = await region.collectGameInfos(true).catch(() => null);
            const games = Array.isArray(infos?.data) ? infos.data : [];
            return { regionId, games, verifiedOnly: region.verifiedOnly };
        }),
    );
    return { regions };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const ModerationDashboardRouter = new Hono<Context>()
    .use(adminGuard)

    // ── Serve the SPA HTML (auth already checked by adminGuard above) ──────
    .get("/", (c) => {
        return c.html(dashboardHtml);
    })

    // ── Current user info (for the frontend to display "logged in as ...") ─
    .get("/api/me", (c) => {
        const user = c.get("user")!;
        return c.json({ id: user.id, username: user.username, slug: user.slug });
    })

    // ─────────────────────────────────────────────────────────────────────────
    // BAN MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────

    /** Returns all IP bans, account bans, and chat bans. */
    .get("/api/bans", async (c) => {
        return c.json(await fetchAllBans());
    })

    /** Creates an IP ban. Also bans any account linked to this IP. Broadcasts to all admins. */
    .post(
        "/api/ban/ip",
        validateParams(
            z.object({
                ip: z.string(),
                reason: z.string().default(""),
                duration: z.number().default(7),
                permanent: z.boolean().default(false),
            }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const { ip, reason, duration, permanent } = c.req.valid("json");
            const expiresIn = new Date(Date.now() + util.daysToMs(duration));

            await db
                .insert(bannedIpsTable)
                .values({
                    encodedIp: ip,
                    reason,
                    expiresIn,
                    permanent,
                    bannedBy: admin.slug,
                })
                .onConflictDoUpdate({
                    target: bannedIpsTable.encodedIp,
                    set: { reason, expiresIn, permanent, bannedBy: admin.slug },
                });

            // Also ban any account that has ever used this IP
            const linked = await db
                .selectDistinct({ userId: ipLogsTable.userId })
                .from(ipLogsTable)
                .where(eq(ipLogsTable.encodedIp, ip));

            const userIds = linked
                .map((r) => r.userId)
                .filter((id): id is string => !!id);
            if (userIds.length) {
                await db
                    .update(usersTable)
                    .set({ banned: true, banReason: reason, bannedBy: admin.slug })
                    .where(inArray(usersTable.id, userIds));
            }

            await recordBan({
                banType: "ip",
                banTarget: ip,
                reason,
                bannedBy: admin.slug,
                expiresAt: expiresIn,
                permanent,
            });

            void logModerationAction("🔨 IP banned", [
                { name: "IP hash", value: ip },
                { name: "Reason", value: reason || "–" },
                { name: "Duration", value: permanent ? "permanent" : `${duration}d` },
                { name: "By admin", value: adminTag(admin) },
            ]);

            broadcastBans();
            return c.json({ ok: true });
        },
    )

    /** Creates an account ban. Broadcasts updated bans. */
    .post(
        "/api/ban/account",
        validateParams(
            z.object({
                slug: z.string(),
                reason: z.string().default(""),
            }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const { slug, reason } = c.req.valid("json");

            await db
                .update(usersTable)
                .set({ banned: true, banReason: reason, bannedBy: admin.slug })
                .where(eq(usersTable.slug, slug));

            await recordBan({
                banType: "account",
                banTarget: slug,
                reason,
                bannedBy: admin.slug,
                expiresAt: null,
                permanent: false,
            });

            void logModerationAction("🔨 Account banned", [
                { name: "Account", value: slug },
                { name: "Reason", value: reason || "–" },
                { name: "By admin", value: adminTag(admin) },
            ]);

            broadcastBans();
            return c.json({ ok: true });
        },
    )

    /** Creates a chat ban. Broadcasts updated bans. */
    .post(
        "/api/ban/chat",
        validateParams(
            z.object({
                ip: z.string(),
                reason: z.string().default(""),
                duration: z.number().default(7),
                permanent: z.boolean().default(false),
            }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const { ip, reason, duration, permanent } = c.req.valid("json");
            const expiresIn = new Date(Date.now() + util.daysToMs(duration));

            await db
                .insert(chatBannedIpsTable)
                .values({
                    encodedIp: ip,
                    reason,
                    expiresIn,
                    permanent,
                    bannedBy: admin.slug,
                })
                .onConflictDoUpdate({
                    target: chatBannedIpsTable.encodedIp,
                    set: { reason, expiresIn, permanent, bannedBy: admin.slug },
                });

            await recordBan({
                banType: "chat",
                banTarget: ip,
                reason,
                bannedBy: admin.slug,
                expiresAt: expiresIn,
                permanent,
            });

            void logModerationAction("🔇 Chat banned", [
                { name: "IP hash", value: ip },
                { name: "Reason", value: reason || "–" },
                { name: "Duration", value: permanent ? "permanent" : `${duration}d` },
                { name: "By admin", value: adminTag(admin) },
            ]);

            broadcastBans();
            return c.json({ ok: true });
        },
    )

    /** Removes an IP ban. Also unbans any account that was linked to this IP. Broadcasts updated bans. */
    .post("/api/unban/ip", validateParams(z.object({ ip: z.string() })), async (c) => {
        const admin = c.get("user")!;
        const { ip } = c.req.valid("json");

        await db.delete(bannedIpsTable).where(eq(bannedIpsTable.encodedIp, ip));

        // Unban any accounts that were linked to this IP
        const linked = await db
            .selectDistinct({ userId: ipLogsTable.userId })
            .from(ipLogsTable)
            .where(eq(ipLogsTable.encodedIp, ip));

        const userIds = linked.map((r) => r.userId).filter((id): id is string => !!id);
        if (userIds.length) {
            await db
                .update(usersTable)
                .set({ banned: false, banReason: "", bannedBy: "" })
                .where(inArray(usersTable.id, userIds));
        }

        await recordUnban("ip", ip, admin.slug);

        void logModerationAction(
            "♻️ IP unbanned",
            [
                { name: "IP hash", value: ip },
                { name: "By admin", value: adminTag(admin) },
            ],
            0x1a7a1a,
        );

        broadcastBans();
        return c.json({ ok: true });
    })

    /** Removes an account ban. Broadcasts updated bans. */
    .post(
        "/api/unban/account",
        validateParams(z.object({ slug: z.string() })),
        async (c) => {
            const admin = c.get("user")!;
            const { slug } = c.req.valid("json");
            await db
                .update(usersTable)
                .set({ banned: false, banReason: "", bannedBy: "" })
                .where(eq(usersTable.slug, slug));
            await recordUnban("account", slug, admin.slug);
            void logModerationAction(
                "♻️ Account unbanned",
                [
                    { name: "Account", value: slug },
                    { name: "By admin", value: adminTag(admin) },
                ],
                0x1a7a1a,
            );
            broadcastBans();
            return c.json({ ok: true });
        },
    )

    /** Removes a chat ban. Broadcasts updated bans. */
    .post("/api/unban/chat", validateParams(z.object({ ip: z.string() })), async (c) => {
        const admin = c.get("user")!;
        const { ip } = c.req.valid("json");
        await db.delete(chatBannedIpsTable).where(eq(chatBannedIpsTable.encodedIp, ip));
        await recordUnban("chat", ip, admin.slug);
        void logModerationAction(
            "♻️ Chat unbanned",
            [
                { name: "IP hash", value: ip },
                { name: "By admin", value: adminTag(admin) },
            ],
            0x1a7a1a,
        );
        broadcastBans();
        return c.json({ ok: true });
    })

    // ─────────────────────────────────────────────────────────────────────────
    // IP / PLAYER LOOKUP
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns the 100 most recently seen unique players (name + most recent IP + ISP).
     * Used to populate the quick-access list on the IP/Player lookup tab.
     */
    .get("/api/recent", async (c) => {
        const rows = await db
            .select({
                username: ipLogsTable.username,
                encodedIp: ipLogsTable.encodedIp,
                isp: ipLogsTable.isp,
                region: ipLogsTable.region,
                createdAt: ipLogsTable.createdAt,
                slug: usersTable.slug,
            })
            .from(ipLogsTable)
            .leftJoin(usersTable, eq(ipLogsTable.userId, usersTable.id))
            .orderBy(desc(ipLogsTable.createdAt))
            .limit(1000); // fetch more, deduplicate by username below

        const seen = new Set<string>();
        const recent: typeof rows = [];
        for (const row of rows) {
            if (!seen.has(row.username)) {
                seen.add(row.username);
                recent.push(row);
                if (recent.length >= 100) break;
            }
        }
        return c.json({ recent });
    })

    /**
     * Returns all names + accounts that ever used this encoded IP, plus the ISP.
     * Recent names (≤30 days) come directly from ip_logs.
     * Historical names (>30 days) are recovered via match_data using the userId
     * linked to the IP — so account-holders keep their full name history.
     * The real IP is never stored or returned here.
     */
    .get("/api/ip/:hash", async (c) => {
        const hash = c.req.param("hash");

        const [banRecord, rows, banHistory] = await Promise.all([
            db.query.bannedIpsTable.findFirst({
                where: eq(bannedIpsTable.encodedIp, hash),
            }),
            db
                .select({
                    username: ipLogsTable.username,
                    userId: ipLogsTable.userId,
                    slug: usersTable.slug,
                    isp: ipLogsTable.isp,
                    region: ipLogsTable.region,
                    gameId: ipLogsTable.gameId,
                    createdAt: ipLogsTable.createdAt,
                })
                .from(ipLogsTable)
                .where(eq(ipLogsTable.encodedIp, hash))
                .leftJoin(usersTable, eq(ipLogsTable.userId, usersTable.id))
                .orderBy(desc(ipLogsTable.createdAt))
                .limit(200),
            // Full ban history for this IP (IP + chat bans target the hash directly).
            db
                .select()
                .from(banHistoryTable)
                .where(
                    and(
                        inArray(banHistoryTable.banType, ["ip", "chat"]),
                        eq(banHistoryTable.banTarget, hash),
                    ),
                )
                .orderBy(desc(banHistoryTable.bannedAt))
                .limit(100),
        ]);

        // Collect ISP and deduplicate recent names from ip_logs
        const seenNames = new Set<string>();
        const accounts: ((typeof rows)[number] & { source: "recent" | "historical" })[] =
            [];
        let isp = "";

        for (const row of rows) {
            if (!isp && row.isp) isp = row.isp;
            if (!seenNames.has(row.username)) {
                seenNames.add(row.username);
                accounts.push({ ...row, source: "recent" });
            }
        }

        // Query match_data directly by encoded IP — covers all players (incl. guests)
        // with no time limit, since match_data is never deleted.
        // Note: no ORDER BY with SELECT DISTINCT (Postgres requires ORDER BY cols to be in SELECT list)
        const historical = await db
            .selectDistinct({
                username: matchDataTable.username,
                userId: matchDataTable.userId,
            })
            .from(matchDataTable)
            .where(eq(matchDataTable.encodedIp, hash))
            .limit(500);

        for (const row of historical) {
            if (!seenNames.has(row.username)) {
                seenNames.add(row.username);
                const knownSlug = rows.find((r) => r.userId === row.userId)?.slug ?? null;
                accounts.push({
                    username: row.username,
                    userId: row.userId ?? "",
                    slug: knownSlug,
                    isp: "",
                    region: "",
                    gameId: "",
                    createdAt: new Date(0),
                    source: "historical",
                });
            }
        }

        return c.json({
            hash,
            isp,
            banned: !!banRecord,
            banRecord,
            accounts,
            banHistory,
        });
    })

    /**
     * Returns chat history for a player, looked up by username or encoded IP.
     * Query param: ?by=name (default) or ?by=ip
     * Returns the 200 most recent messages, newest first.
     */
    .get("/api/chat/:query", async (c) => {
        const query = c.req.param("query");
        const by = c.req.query("by") ?? "name";

        const rows = await db
            .select({
                id: chatLogsTable.id,
                createdAt: chatLogsTable.createdAt,
                gameId: chatLogsTable.gameId,
                username: chatLogsTable.username,
                channel: chatLogsTable.channel,
                message: chatLogsTable.message,
                encodedIp: chatLogsTable.encodedIp,
                slug: usersTable.slug,
            })
            .from(chatLogsTable)
            .where(
                by === "ip"
                    ? eq(chatLogsTable.encodedIp, query)
                    : eq(chatLogsTable.username, query),
            )
            .leftJoin(usersTable, eq(chatLogsTable.userId, usersTable.id))
            .orderBy(desc(chatLogsTable.createdAt))
            .limit(200);

        return c.json({ messages: rows });
    })

    /**
     * Global chat log for the Chat Log tab.
     * Without ?search: the most recent messages across ALL games (newest first).
     * With ?search=<term>: messages whose text matches (case-insensitive).
     * The dashboard groups the returned rows by game. Capped via ?limit (default 500).
     */
    .get("/api/chatlog", async (c) => {
        const search = (c.req.query("search") ?? "").trim();
        const limit = Math.min(Math.max(Number(c.req.query("limit")) || 500, 1), 1000);
        const channelParam = c.req.query("channel");
        const channel =
            channelParam !== undefined &&
            channelParam !== "" &&
            Number.isFinite(Number(channelParam))
                ? Number(channelParam)
                : undefined;

        const rows = await db
            .select({
                id: chatLogsTable.id,
                createdAt: chatLogsTable.createdAt,
                gameId: chatLogsTable.gameId,
                username: chatLogsTable.username,
                channel: chatLogsTable.channel,
                message: chatLogsTable.message,
                encodedIp: chatLogsTable.encodedIp,
                slug: usersTable.slug,
            })
            .from(chatLogsTable)
            .where(
                and(
                    search ? ilike(chatLogsTable.message, `%${search}%`) : undefined,
                    channel !== undefined
                        ? eq(chatLogsTable.channel, channel)
                        : undefined,
                ),
            )
            .leftJoin(usersTable, eq(chatLogsTable.userId, usersTable.id))
            .orderBy(desc(chatLogsTable.createdAt))
            .limit(limit);

        return c.json({ messages: rows });
    })

    /**
     * Full chat history for a single game, oldest first — used to show a clicked
     * message together with its surrounding context (the whole game's chat).
     */
    .get("/api/chatlog/game/:gameId", async (c) => {
        const gameId = c.req.param("gameId");

        const rows = await db
            .select({
                id: chatLogsTable.id,
                createdAt: chatLogsTable.createdAt,
                gameId: chatLogsTable.gameId,
                username: chatLogsTable.username,
                channel: chatLogsTable.channel,
                message: chatLogsTable.message,
                encodedIp: chatLogsTable.encodedIp,
                slug: usersTable.slug,
            })
            .from(chatLogsTable)
            .where(eq(chatLogsTable.gameId, gameId))
            .leftJoin(usersTable, eq(chatLogsTable.userId, usersTable.id))
            .orderBy(asc(chatLogsTable.createdAt))
            .limit(2000);

        return c.json({ messages: rows });
    })

    /**
     * Returns all IP hashes + ISP a player used, looked up by display name.
     */
    .get("/api/player/:name", async (c) => {
        const name = c.req.param("name");

        const rows = await db
            .select({
                encodedIp: ipLogsTable.encodedIp,
                isp: ipLogsTable.isp,
                region: ipLogsTable.region,
                createdAt: ipLogsTable.createdAt,
                slug: usersTable.slug,
            })
            .from(ipLogsTable)
            .where(eq(ipLogsTable.username, name))
            .leftJoin(usersTable, eq(ipLogsTable.userId, usersTable.id))
            .orderBy(desc(ipLogsTable.createdAt))
            .limit(200);

        const seenIps = new Set<string>();
        const ips: {
            ip: string;
            isp: string;
            region: string;
            lastSeen: Date;
            slug: string | null;
        }[] = [];
        for (const row of rows) {
            if (!seenIps.has(row.encodedIp)) {
                seenIps.add(row.encodedIp);
                ips.push({
                    ip: row.encodedIp,
                    isp: row.isp,
                    region: row.region,
                    lastSeen: row.createdAt,
                    slug: row.slug,
                });
            }
        }

        // Aggregate ban history across all of this player's targets: their IP hashes
        // (ip + chat bans) and any linked account slug(s) (account bans).
        const hashes = [...seenIps];
        const slugs = [
            ...new Set(ips.map((i) => i.slug).filter((s): s is string => !!s)),
        ];
        const banHistory =
            hashes.length || slugs.length
                ? await db
                      .select()
                      .from(banHistoryTable)
                      .where(
                          or(
                              hashes.length
                                  ? and(
                                        inArray(banHistoryTable.banType, ["ip", "chat"]),
                                        inArray(banHistoryTable.banTarget, hashes),
                                    )
                                  : undefined,
                              slugs.length
                                  ? and(
                                        eq(banHistoryTable.banType, "account"),
                                        inArray(banHistoryTable.banTarget, slugs),
                                    )
                                  : undefined,
                          ),
                      )
                      .orderBy(desc(banHistoryTable.bannedAt))
                      .limit(100)
                : [];

        return c.json({ name, ips, banHistory });
    })

    // ─────────────────────────────────────────────────────────────────────────
    // BAN COMMENTS
    // ─────────────────────────────────────────────────────────────────────────

    /** Returns the comment thread for a ban, oldest first. */
    .get("/api/ban-comments/:type/:target", async (c) => {
        const banType = c.req.param("type");
        const target = c.req.param("target");

        const comments = await db
            .select()
            .from(banCommentsTable)
            .where(
                and(
                    eq(banCommentsTable.banType, banType),
                    eq(banCommentsTable.banTarget, target),
                ),
            )
            .orderBy(asc(banCommentsTable.createdAt));

        return c.json({ comments });
    })

    /** Adds a comment to a ban's thread. */
    .post(
        "/api/ban-comments",
        validateParams(
            z.object({
                type: z.enum(["ip", "account", "chat"]),
                target: z.string(),
                comment: z.string().min(1),
            }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const { type, target, comment } = c.req.valid("json");

            await db.insert(banCommentsTable).values({
                banType: type,
                banTarget: target,
                comment,
                createdBy: admin.slug,
            });

            return c.json({ ok: true });
        },
    )

    // ─────────────────────────────────────────────────────────────────────────
    // SSE – LIVE EVENT STREAM
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Server-Sent Events stream for the live dashboard.
     *
     * Query params:
     *   region  (optional) – region of the game being watched
     *   gameId  (optional) – specific game to receive player updates for
     *
     * Events pushed:
     *   "bans"    – full ban list, sent immediately and on every ban change
     *   "servers" – all regions + games, sent immediately then every 8 s
     *   "players" – live player list for the watched game, sent immediately then every 3 s
     */
    .get("/api/events", async (c) => {
        const regionId = c.req.query("region") ?? "";
        const gameId = c.req.query("gameId") ?? "";

        return streamSSE(c, async (stream) => {
            activeSseStreams.add(stream);

            // Helper that wraps writeSSE and swallows errors for gone clients
            const push = async (event: string, data: unknown) => {
                try {
                    await stream.writeSSE({ event, data: JSON.stringify(data) });
                } catch {
                    /* client disconnected */
                }
            };

            // Send initial snapshots immediately
            await push("bans", await fetchAllBans());
            await push("servers", await fetchServers());
            if (gameId) {
                const players = await server.getDashboardGamePlayers(regionId, gameId);
                await push("players", { players });
            }

            // Periodic server list updates (every 8 s)
            const serverTimer = setInterval(async () => {
                await push("servers", await fetchServers());
            }, 8_000);

            // Periodic player list updates for the watched game (every 3 s)
            const playerTimer = gameId
                ? setInterval(async () => {
                      const players = await server.getDashboardGamePlayers(
                          regionId,
                          gameId,
                      );
                      await push("players", { players });
                  }, 3_000)
                : null;

            // Periodic kill+chat feed updates for the watched game (every 3 s)
            let lastFeedAt = new Date();
            const feedTimer = gameId
                ? setInterval(async () => {
                      const entries = await db
                          .select({
                              id: chatLogsTable.id,
                              createdAt: chatLogsTable.createdAt,
                              username: chatLogsTable.username,
                              channel: chatLogsTable.channel,
                              message: chatLogsTable.message,
                          })
                          .from(chatLogsTable)
                          .where(
                              and(
                                  eq(chatLogsTable.gameId, gameId),
                                  gt(chatLogsTable.createdAt, lastFeedAt),
                              ),
                          )
                          .orderBy(asc(chatLogsTable.createdAt))
                          .limit(50);
                      lastFeedAt = new Date();
                      if (entries.length) await push("feed", { entries });
                  }, 3_000)
                : null;

            // Keep the stream open until the client disconnects
            await new Promise<void>((resolve) => {
                c.req.raw.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                });
            });

            // Cleanup on disconnect
            clearInterval(serverTimer);
            if (playerTimer) clearInterval(playerTimer);
            if (feedTimer) clearInterval(feedTimer);
            activeSseStreams.delete(stream);
        });
    })

    // ─────────────────────────────────────────────────────────────────────────
    // LIVE SERVER VIEW (kept for direct REST access)
    // ─────────────────────────────────────────────────────────────────────────

    /** Returns a snapshot of all regions + running games. */
    .get("/api/servers", async (c) => {
        return c.json(await fetchServers());
    })

    /** Sends an announcement to every running game across all regions. */
    .post(
        "/api/servers/announce",
        validateParams(
            z.object({
                text: z.string(),
                color: z.string().optional(),
                sender: z.string().optional(),
            }),
        ),
        async (c) => {
            const { text, color, sender } = c.req.valid("json");
            const cmd = { action: "announce", text, color, sender };

            await Promise.all(
                Object.entries(server.regions).map(async ([regionId, region]) => {
                    const infos = await region.collectGameInfos(true).catch(() => null);
                    const games = Array.isArray(infos?.data) ? infos.data : [];
                    await Promise.all(
                        games
                            .filter((g: any) => !g.stopped)
                            .map((g: any) =>
                                server.sendDashboardGameCmd(regionId, g.id, cmd),
                            ),
                    );
                }),
            );

            return c.json({ ok: true });
        },
    )

    /**
     * Returns a spectate token for a specific game so the dashboard can open the
     * game client in spectator mode. Calls the game server via the existing
     * find_game_by_id flow (same as the in-game spectate button).
     */
    .get("/api/game/:region/:id/spectate-token", async (c) => {
        const regionId = c.req.param("region");
        const gameId = c.req.param("id");
        const data = await server.findGameById(regionId, gameId, true /* admin */);
        return c.json(data);
    })

    // ─────────────────────────────────────────────────────────────────────────
    // REPLAYS
    // ─────────────────────────────────────────────────────────────────────────

    /** Lists all recorded games across every region (newest first), for the Replays tab. */
    .get("/api/replays", async (c) => {
        const regions = await Promise.all(
            Object.entries(server.regions).map(async ([regionId, region]) => {
                const recordings = await region.listReplays().catch(() => []);
                return { regionId, recordings };
            }),
        );
        return c.json({ regions });
    })

    /**
     * Mints a short-lived replay token so the dashboard can open the game client at
     * `CLIENT_URL/?replay=<token>` (same idea as the spectate token above).
     */
    .get("/api/replays/token", (c) => {
        const region = c.req.query("region") ?? "";
        const gameId = c.req.query("gameId") ?? "";
        if (!region || !gameId) {
            return c.json({ error: "invalid_params" }, 400);
        }
        // Game-scoped token: lets the viewer switch between every POV of this game.
        return c.json({ token: signReplayToken({ region, gameId }) });
    })

    /**
     * Returns the live player list for a specific running game.
     * Calls the game server via HTTP, which uses IPC to query the game process.
     */
    .get("/api/game/:region/:id/players", async (c) => {
        const regionId = c.req.param("region");
        const gameId = c.req.param("id");
        const players = await server.getDashboardGamePlayers(regionId, gameId);
        return c.json({ players });
    })

    /**
     * Executes an admin command on a running game.
     * Supported actions: stop | freeze | unfreeze | verify | kick | announce | announce_player | chat
     */
    .post(
        "/api/game/:region/:id/cmd",
        validateParams(
            z.object({
                action: z.string(),
                target: z.string().optional(),
                text: z.string().optional(),
                color: z.string().optional(),
                sender: z.string().optional(),
            }),
        ),
        async (c) => {
            const regionId = c.req.param("region");
            const gameId = c.req.param("id");
            const cmd = c.req.valid("json");
            // Log admin chat messages to the DB so they appear in the feed
            if (cmd.action === "chat" && cmd.text) {
                await db
                    .insert(chatLogsTable)
                    .values({
                        gameId,
                        username: cmd.sender ?? "ADMIN",
                        userId: "",
                        encodedIp: "admin",
                        channel: 0,
                        message: cmd.text,
                    })
                    .onConflictDoNothing();
            }
            await server.sendDashboardGameCmd(regionId, gameId, cmd);
            return c.json({ ok: true });
        },
    )

    /** Returns chat logs for a specific game since a given timestamp (for the feed). */
    .get("/api/game/:region/:id/chat", async (c) => {
        const gameId = c.req.param("id");
        const since = c.req.query("since");
        const sinceDate = since ? new Date(since) : new Date(0);
        const messages = await db
            .select({
                id: chatLogsTable.id,
                createdAt: chatLogsTable.createdAt,
                username: chatLogsTable.username,
                channel: chatLogsTable.channel,
                message: chatLogsTable.message,
            })
            .from(chatLogsTable)
            .where(
                and(
                    eq(chatLogsTable.gameId, gameId),
                    gt(chatLogsTable.createdAt, sinceDate),
                ),
            )
            .orderBy(asc(chatLogsTable.createdAt))
            .limit(100);
        return c.json({ messages });
    })

    .post("/api/servers/:region/verify", async (c) => {
        await server.setServerVerified(c.req.param("region"), true);
        return c.json({ ok: true });
    })

    .post("/api/servers/:region/unverify", async (c) => {
        await server.setServerVerified(c.req.param("region"), false);
        return c.json({ ok: true });
    })

    /** Returns all registered accounts with per-pass levels, creation date, and last IP. */
    .get("/api/accounts", async (c) => {
        // 1. All users
        const users = await db
            .select({
                id: usersTable.id,
                username: usersTable.username,
                slug: usersTable.slug,
                banned: usersTable.banned,
                admin: usersTable.admin,
                userCreated: usersTable.userCreated,
                goldenFries: usersTable.goldenFries,
                authId: usersTable.authId,
                linkedDiscord: usersTable.linkedDiscord,
                linkedGoogle: usersTable.linkedGoogle,
            })
            .from(usersTable);

        // 2. All userXp rows → Map<userId, Map<passType, {level, xp}>>
        const allXp = await db.select().from(userXpTable);
        const xpByUser = new Map<string, Map<string, { level: number; xp: number }>>();
        for (const row of allXp) {
            if (!xpByUser.has(row.userId)) xpByUser.set(row.userId, new Map());
            xpByUser
                .get(row.userId)!
                .set(row.passType, { level: row.level, xp: Number(row.xp) });
        }

        // 3. Most recent encoded IP per user (DISTINCT ON — PostgreSQL only)
        const latestIpRows = await db.execute<{ user_id: string; encoded_ip: string }>(
            sql`SELECT DISTINCT ON (user_id) user_id, encoded_ip FROM ip_logs WHERE user_id != '' ORDER BY user_id, created_at DESC`,
        );
        const ipByUser = new Map<string, string>();
        for (const row of latestIpRows.rows) {
            ipByUser.set(row.user_id as string, row.encoded_ip as string);
        }

        const passTypes = Object.keys((GameConfig.serverSettings as any).passes ?? {});

        const accounts = users.map((u) => ({
            ...u,
            discordId: u.linkedDiscord ? u.authId : null,
            lastIp: ipByUser.get(u.id) ?? null,
            passes: Object.fromEntries((xpByUser.get(u.id) ?? new Map()).entries()),
        }));

        return c.json({ accounts, passTypes });
    })

    /** Grants (or, with a negative amount, removes) Golden Fries for an account. */
    .post(
        "/api/account/golden-fries",
        validateParams(
            z.object({
                slug: z.string().min(1),
                amount: z.number().int().gte(-1_000_000).lte(1_000_000),
            }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const { slug, amount } = c.req.valid("json");

            const target = await db.query.usersTable.findFirst({
                where: eq(usersTable.slug, slug),
                columns: { id: true },
            });
            if (!target) return c.json({ error: "account_not_found" }, 404);

            const balance = await awardGoldenFries(
                target.id,
                amount,
                `admin_grant:${admin.slug}`,
            );
            void logModerationAction(
                "🍟 Golden Fries",
                [
                    { name: "Account", value: slug },
                    { name: "Amount", value: (amount > 0 ? "+" : "") + amount },
                    { name: "Balance", value: String(balance) },
                    { name: "By admin", value: adminTag(admin) },
                ],
                0xe0a23c,
            );
            return c.json({ ok: true, balance });
        },
    )

    /** Full account detail: identity (incl. discord id), per-pass XP, owned items grouped by source, recent matches. */
    .get("/api/account/:slug", async (c) => {
        const slug = c.req.param("slug");

        const user = await db.query.usersTable.findFirst({
            where: eq(usersTable.slug, slug),
            columns: {
                id: true,
                username: true,
                slug: true,
                authId: true,
                linkedDiscord: true,
                linkedGoogle: true,
                linked: true,
                banned: true,
                banReason: true,
                admin: true,
                goldenFries: true,
                userCreated: true,
            },
        });
        if (!user) return c.json({ error: "account_not_found" }, 404);

        const passTypes = Object.keys((GameConfig.serverSettings as any).passes ?? {});

        const [xpRows, items, matches] = await Promise.all([
            db.select().from(userXpTable).where(eq(userXpTable.userId, user.id)),
            db
                .select({
                    id: itemsTable.id,
                    type: itemsTable.type,
                    source: itemsTable.source,
                })
                .from(itemsTable)
                .where(eq(itemsTable.userId, user.id)),
            db
                .select({
                    gameId: matchDataTable.gameId,
                    region: matchDataTable.region,
                    mapId: matchDataTable.mapId,
                    teamMode: matchDataTable.teamMode,
                    createdAt: matchDataTable.createdAt,
                    timeAlive: matchDataTable.timeAlive,
                    rank: matchDataTable.rank,
                    kills: matchDataTable.kills,
                    damageDealt: matchDataTable.damageDealt,
                    damageTaken: matchDataTable.damageTaken,
                })
                .from(matchDataTable)
                .where(eq(matchDataTable.userId, user.id))
                .orderBy(desc(matchDataTable.createdAt))
                .limit(25),
        ]);

        const xp = xpRows.map((r) => ({
            passType: r.passType,
            level: r.level,
            xp: Number(r.xp),
        }));

        // Owned items grouped by source so a whole source group (e.g. an S2 pass)
        // can be removed at once.
        const itemsBySource: Record<string, { id: number; type: string }[]> = {};
        for (const it of items) {
            (itemsBySource[it.source] ??= []).push({ id: it.id, type: it.type });
        }

        const prettyMatches = matches.map((m) => ({
            ...m,
            teamMode: TeamModeToString[m.teamMode],
            mapId: MapId[m.mapId],
        }));

        return c.json({
            user: { ...user, discordId: user.linkedDiscord ? user.authId : null },
            passTypes,
            xp,
            itemsBySource,
            matches: prettyMatches,
        });
    })

    /** Sets a pass's level + xp absolutely, then grants the corresponding unlocks. */
    .post(
        "/api/account/set-xp",
        validateParams(
            z.object({
                slug: z.string().min(1),
                passType: z.string().min(1),
                // level is ignored — it is derived from xp so the two stay in sync
                level: z.number().int().gte(0).optional(),
                xp: z.number().gte(0),
            }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const { slug, passType, xp } = c.req.valid("json");

            const user = await db.query.usersTable.findFirst({
                where: eq(usersTable.slug, slug),
                columns: { id: true },
            });
            if (!user) return c.json({ error: "account_not_found" }, 404);

            // Derive the level from the (total) xp using the pass curve, so setting
            // xp also sets the matching level.
            const level = PassDefs[passType] ? getPassLevelAndXp(passType, xp).level : 0;

            // Anchor the reconcile job at this admin value + time, so it won't
            // re-count old matches but keeps accruing XP from new ones.
            const now = new Date();
            await db
                .insert(userXpTable)
                .values({
                    userId: user.id,
                    passType,
                    level,
                    xp: String(xp),
                    reconcileBaseXp: String(xp),
                    reconcileFrom: now,
                })
                .onConflictDoUpdate({
                    target: [userXpTable.userId, userXpTable.passType],
                    set: {
                        level,
                        xp: String(xp),
                        reconcileBaseXp: String(xp),
                        reconcileFrom: now,
                        lastUpdated: now,
                    },
                });

            // Bring owned pass items exactly in line with the derived level:
            // grant everything up to it, take back anything above it.
            const granted = await grantPassItems(user.id, passType, level);
            const revoked = await revokePassItemsAbove(user.id, passType, level);

            void logModerationAction(
                "⭐ XP set",
                [
                    { name: "Account", value: slug },
                    { name: "Pass", value: passType },
                    { name: "Level / XP", value: `${level} / ${xp}` },
                    { name: "Items +/-", value: `+${granted} / -${revoked}` },
                    { name: "By admin", value: adminTag(admin) },
                ],
                0x3355ee,
            );

            return c.json({ ok: true, level, granted, revoked });
        },
    )

    /** Grants a single cosmetic (or, with item:"all", every missing allowed cosmetic). */
    .post(
        "/api/account/give-item",
        validateParams(
            z.object({
                slug: z.string().min(1),
                item: z.string().min(1),
                source: z.string().default("admin_grant"),
            }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const { slug, item, source } = c.req.valid("json");

            const user = await db.query.usersTable.findFirst({
                where: eq(usersTable.slug, slug),
                columns: { id: true },
            });
            if (!user) return c.json({ error: "account_not_found" }, 404);

            if (item === "all") {
                const owned = await db
                    .select({ type: itemsTable.type })
                    .from(itemsTable)
                    .where(eq(itemsTable.userId, user.id));
                const ownedTypes = new Set(owned.map((i) => i.type));
                const missing = ALLOWED_COSMETICS.filter((t) => !ownedTypes.has(t));
                if (!missing.length) return c.json({ ok: true, given: 0 });
                const now = Date.now();
                await db.insert(itemsTable).values(
                    missing.map((type) => ({
                        userId: user.id,
                        type,
                        source,
                        timeAcquired: now,
                    })),
                );
                void logModerationAction(
                    "🎁 Items given",
                    [
                        { name: "Account", value: slug },
                        { name: "Item", value: `ALL (${missing.length})` },
                        { name: "Source", value: source },
                        { name: "By admin", value: adminTag(admin) },
                    ],
                    0x1a7a1a,
                );
                return c.json({ ok: true, given: missing.length });
            }

            if (!ALLOWED_COSMETICS.includes(item)) {
                return c.json({ error: "item_not_allowed" }, 400);
            }

            const existing = await db.query.itemsTable.findFirst({
                where: and(eq(itemsTable.userId, user.id), eq(itemsTable.type, item)),
                columns: { id: true },
            });
            if (existing) return c.json({ ok: true, given: 0, message: "already owned" });

            await db.insert(itemsTable).values({
                userId: user.id,
                type: item,
                source,
                timeAcquired: Date.now(),
            });
            void logModerationAction(
                "🎁 Item given",
                [
                    { name: "Account", value: slug },
                    { name: "Item", value: item },
                    { name: "Source", value: source },
                    { name: "By admin", value: adminTag(admin) },
                ],
                0x1a7a1a,
            );
            return c.json({ ok: true, given: 1 });
        },
    )

    /** Removes a single owned cosmetic by type (default-unlock items are protected). */
    .post(
        "/api/account/remove-item",
        validateParams(z.object({ slug: z.string().min(1), item: z.string().min(1) })),
        async (c) => {
            const admin = c.get("user")!;
            const { slug, item } = c.req.valid("json");

            const user = await db.query.usersTable.findFirst({
                where: eq(usersTable.slug, slug),
                columns: { id: true },
            });
            if (!user) return c.json({ error: "account_not_found" }, 404);
            if (PROTECTED_ITEM_TYPES.includes(item)) {
                return c.json({ error: "item_protected" }, 400);
            }

            const res = await db
                .delete(itemsTable)
                .where(and(eq(itemsTable.userId, user.id), eq(itemsTable.type, item)))
                .returning({ type: itemsTable.type });
            if (res.length) {
                void logModerationAction(
                    "➖ Item removed",
                    [
                        { name: "Account", value: slug },
                        { name: "Item", value: item },
                        { name: "By admin", value: adminTag(admin) },
                    ],
                    0xaa4400,
                );
            }
            return c.json({ ok: true, removed: res.length });
        },
    )

    /** Removes every owned item with the given source (e.g. all of one season's pass unlocks). */
    .post(
        "/api/account/remove-item-source",
        validateParams(z.object({ slug: z.string().min(1), source: z.string().min(1) })),
        async (c) => {
            const admin = c.get("user")!;
            const { slug, source } = c.req.valid("json");

            const user = await db.query.usersTable.findFirst({
                where: eq(usersTable.slug, slug),
                columns: { id: true },
            });
            if (!user) return c.json({ error: "account_not_found" }, 404);

            const res = await db
                .delete(itemsTable)
                .where(
                    and(
                        eq(itemsTable.userId, user.id),
                        eq(itemsTable.source, source),
                        PROTECTED_ITEM_TYPES.length
                            ? notInArray(itemsTable.type, PROTECTED_ITEM_TYPES)
                            : undefined,
                    ),
                )
                .returning({ type: itemsTable.type });
            if (res.length) {
                void logModerationAction(
                    "➖ Items removed (source)",
                    [
                        { name: "Account", value: slug },
                        { name: "Source", value: source },
                        { name: "Removed", value: String(res.length) },
                        { name: "By admin", value: adminTag(admin) },
                    ],
                    0xaa4400,
                );
            }
            return c.json({ ok: true, removed: res.length });
        },
    )

    /**
     * Permanently deletes an account. The user row delete cascades to items, XP,
     * sessions, pass grants, shop purchases, market listings and the golden-fries
     * ledger (FK onDelete: cascade); match history is anonymized (userId → null).
     */
    .post(
        "/api/account/delete",
        validateParams(z.object({ slug: z.string().min(1) })),
        async (c) => {
            const admin = c.get("user")!;
            const { slug } = c.req.valid("json");

            const target = await db.query.usersTable.findFirst({
                where: eq(usersTable.slug, slug),
                columns: { id: true, username: true, admin: true },
            });
            if (!target) return c.json({ error: "account_not_found" }, 404);
            if (target.id === admin.id) {
                return c.json({ error: "cannot_delete_self" }, 400);
            }
            // Admin accounts can't be deleted from the dashboard.
            if (target.admin) {
                return c.json({ error: "cannot_delete_admin" }, 400);
            }

            await db.delete(usersTable).where(eq(usersTable.id, target.id));
            await db
                .update(matchDataTable)
                .set({ userId: null })
                .where(eq(matchDataTable.userId, target.id));

            // Audit trail: server log + Discord.
            server.logger.info(
                `[MOD] Account deleted: ${slug} (${target.username || "?"}, id=${target.id}) by ${admin.slug}`,
            );
            void logModerationAction("🗑️ Account deleted", [
                { name: "Account", value: slug },
                { name: "Username", value: target.username || "–" },
                { name: "User ID", value: target.id },
                { name: "By admin", value: adminTag(admin) },
            ]);

            return c.json({ ok: true });
        },
    )

    /** Reconciles pass XP + item unlocks + Golden Fries for ALL passes for all users. */
    .post("/api/reconcile_pass_xp", async (c) => {
        const result = await reconcileAllPasses();
        return c.json({ ok: true, ...result });
    });
