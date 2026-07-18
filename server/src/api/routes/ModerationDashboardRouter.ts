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
    type SQL,
    sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { z } from "zod";
import {
    _allowedCrosshairs,
    _allowedDeathEffects,
    _allowedEmotes,
    _allowedHealEffects,
    _allowedMeleeSkins,
    _allowedOutfits,
    UnlockDefs,
} from "../../../../shared/defs/gameObjects/unlockDefs";
import { MapDefs } from "../../../../shared/defs/mapDefs";
import { MapId, TeamModeToString } from "../../../../shared/defs/types/misc";
import { GameConfig, type TeamMode } from "../../../../shared/gameConfig";
import { util } from "../../../../shared/utils/util";
import { logModerationAction } from "../../utils/serverHelpers";
import type { Context } from "..";
import { server } from "../apiServer";
import { validateSessionToken } from "../auth";
import { validateParams } from "../auth/middleware";
import { db } from "../db";
import { RevertError, revertLedgerEntry } from "../db/friesRevert";
import {
    deleteGame,
    removeUserFromGame,
    restoreUserToGame,
    setGamePlayerModeration,
} from "../db/gameModeration";
import { awardGoldenFries } from "../db/goldenFries";
import { computeMatchXp, reconcileAllPasses } from "../db/passReconcile";
import { setPassXp } from "../db/passXp";
import {
    auctionsTable,
    banCommentsTable,
    banHistoryTable,
    bannedIpsTable,
    chatBannedIpsTable,
    chatLogsTable,
    gameModerationTable,
    goldenFriesLedgerTable,
    ipLogsTable,
    itemsTable,
    marketListingsTable,
    matchDataTable,
    offersTable,
    usersTable,
    userXpTable,
} from "../db/schema";
import { signReplayToken } from "../replayToken";
import { dashboardHtml } from "./moderationDashboard.html";

/** map_id → MapDefs key (name), for labelling match rows in the XP-gain drill-down. */
const MAP_ID_TO_NAME: Record<number, string> = Object.fromEntries(
    Object.entries(MapDefs).map(([name, def]) => [def.mapId, name]),
);

/**
 * Escapes LIKE/ILIKE wildcards so a search term is matched literally — in-game names
 * are user-controlled and may well contain `%` or `_`.
 */
function escapeLike(term: string): string {
    return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Upper bound for a moderation window (the Games tab's "All time"), also the clamp
 *  that keeps a silly `?window=` from producing an out-of-range cutoff date. */
const MAX_WINDOW_MS = 3650 * 24 * 60 * 60 * 1000;

/**
 * Length of a moderation time window, parsed from `<n>h` / `<n>d`.
 *
 * The tabs offer 24h / 7d / 30d, and the Games tab additionally "All time" (3650d) —
 * which the old hard-coded mapping silently turned into 7 days, so "All time" quietly
 * hid everything older than a week. Anything unparseable still falls back to 7 days.
 */
function windowToMs(param: string): number {
    const m = /^(\d+)([hd])$/.exec(param);
    if (!m) return 7 * 24 * 60 * 60 * 1000;
    const unitMs = m[2] === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return Math.min(Number(m[1]) * unitMs, MAX_WINDOW_MS);
}

// ── Warnings-tab heuristics (all admin-tunable via constants) ────────────────
/** Flag a game where one IP has at least this many joins (players OR spectators). */
const WARN_MIN_JOINS_PER_GAME = 2;
/** Flag an IP used by at least this many distinct accounts within the window. */
const WARN_MIN_ACCOUNTS_PER_IP = 3;
/** Per-window game count above which an account is flagged for suspiciously high volume. */
const WARN_MIN_GAMES: Record<string, number> = { "24h": 40, "7d": 150, "30d": 400 };
/** Floor for the "high XP per game" (farming) flag, so a tiny mean can't cause noise. */
const WARN_XP_PER_GAME_FLOOR = 150;

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
 * Gates the dashboard. A full admin gets everything; a moderator (limited staff role)
 * may ONLY reach the replays-related routes below — every other route 403s for them.
 * If not authenticated → redirect to Discord OAuth with a return-to cookie.
 */
const isProd = process.env["NODE_ENV"] === "production";

/**
 * Sub-paths (relative to the `/moderation` mount) a moderator (non-admin) may hit:
 * the SPA shell, replays, and the read-only XP-gain views + the two write routes that
 * back their ONLY permitted action, marking things suspicious. Matched after stripping
 * the mount prefix, so it works whether Hono reports the full or stripped path.
 *
 * Read-only reach is decided here; the *scope* of the two writes is enforced at the
 * routes themselves (a moderator may only ever set/clear "sus" — never botted, remove,
 * restore or delete). Every path not listed here 403s for a moderator.
 */
const MODERATOR_ALLOWED_PATHS = new Set([
    "",
    "/",
    "/api/me",
    "/api/replays",
    "/api/replays/token",
    "/api/replays/sus",
    "/api/xp-gain",
    "/api/xp-gain/games",
]);

/** Dynamic (parameterised) sub-paths a moderator may hit — see MODERATOR_ALLOWED_PATHS. */
const MODERATOR_ALLOWED_PATTERNS: RegExp[] = [
    /^\/api\/xp-gain\/user\/[^/]+$/,
    /^\/api\/game\/[^/]+\/players$/,
    /^\/api\/game\/[^/]+\/moderate$/,
];

function moderatorMayAccess(subPath: string): boolean {
    return (
        MODERATOR_ALLOWED_PATHS.has(subPath) ||
        MODERATOR_ALLOWED_PATTERNS.some((re) => re.test(subPath))
    );
}

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
        // Moderators are a limited staff role; anyone else is forbidden.
        if (!user.moderator) {
            return c.text("Forbidden: admin access required", 403);
        }
        const subPath = c.req.path.replace(/^\/moderation/, "");
        if (!moderatorMayAccess(subPath)) {
            return c.text("Forbidden: moderators may only access replays + XP gain", 403);
        }
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
                banExpiresAt: true,
                userCreated: true,
            },
        }),
        db.query.chatBannedIpsTable.findMany({
            orderBy: [desc(chatBannedIpsTable.createdAt)],
        }),
    ]);
    return { ipBans, accountBans, chatBans };
}

/** Human-friendly rendering of a (possibly fractional) day duration for logs. */
function fmtBanDuration(days: number): string {
    const totalMin = Math.round(days * 24 * 60);
    if (totalMin < 60) return `${totalMin}m`;
    if (totalMin < 60 * 24) {
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        return m ? `${h}h ${m}m` : `${h}h`;
    }
    const d = Math.floor(totalMin / (60 * 24));
    const h = Math.floor((totalMin % (60 * 24)) / 60);
    return h ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Resolves a ban's absolute expiry: an explicit `expiresAt` (epoch ms, e.g. an exact
 * end date/time picked in the dashboard) wins; otherwise it's `now + duration` days.
 */
function resolveBanExpiry(duration: number, expiresAt?: number): Date {
    return expiresAt != null
        ? new Date(expiresAt)
        : new Date(Date.now() + util.daysToMs(duration));
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
 * Called after any ban or unban operation (including the auto-expiry sweep) so all
 * open dashboards update instantly.
 */
export async function broadcastBans() {
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

/**
 * What `game_moderation.user_id` holds — the "mod key", i.e. who a flag is about:
 *   - `<account id>`        a logged-in player
 *   - `guest:<playerId>`    a player with no account, identified by their match_data
 *                           playerId (unique within the game; in-game names are not,
 *                           and the recording metadata carries no account reference)
 *   - `""`                  the game as a whole (raised from the Replays tab)
 *
 * Only real accounts can carry an XP-moving status. Guests own no account and earn no
 * XP, and a game-wide flag isn't about one player — both can only ever be "sus".
 */
const GUEST_KEY_PREFIX = "guest:";

function guestModKey(playerId: number): string {
    return `${GUEST_KEY_PREFIX}${playerId}`;
}

function isGuestModKey(key: string): boolean {
    return key.startsWith(GUEST_KEY_PREFIX);
}

/** playerId encoded in a guest mod key, or NaN when the key is malformed. */
function guestPlayerId(key: string): number {
    return Number(key.slice(GUEST_KEY_PREFIX.length));
}

/** Moderation statuses the XP-gain tab can exclude rows by (see resolveXpExclusions). */
const XP_EXCLUDABLE_STATUSES = ["sus", "botted", "removed"];

/** Parses a `?exclude…=a,b,c` CSV query param into a deduped, trimmed list. */
function parseCsvParam(param: string | undefined): string[] {
    return [
        ...new Set(
            (param ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
        ),
    ];
}

/**
 * Resolves the XP-gain tab's tag-exclusion filter into things the aggregations can test
 * cheaply: the "gameId|userId" keys carrying an excluded moderation status, the game ids
 * flagged as a WHOLE (rows with an empty user id, raised from the Replays tab), and the
 * banned account ids.
 *
 * `game_moderation` only ever holds hand-moderated rows, so reading the excluded
 * statuses whole is cheaper than constraining them to the window's game ids.
 */
async function resolveXpExclusions(tags: string[]): Promise<{
    modKeys: Set<string>;
    modGameIds: Set<string>;
    bannedIds: Set<string>;
}> {
    const statuses = tags.filter((t) => XP_EXCLUDABLE_STATUSES.includes(t));

    const [modRows, bannedRows] = await Promise.all([
        statuses.length
            ? db
                  .select({
                      gameId: gameModerationTable.gameId,
                      userId: gameModerationTable.userId,
                  })
                  .from(gameModerationTable)
                  .where(inArray(gameModerationTable.status, statuses))
            : [],
        tags.includes("banned")
            ? db
                  .select({ id: usersTable.id })
                  .from(usersTable)
                  .where(eq(usersTable.banned, true))
            : [],
    ]);

    return {
        modKeys: new Set(
            modRows.filter((r) => r.userId).map((r) => `${r.gameId}|${r.userId}`),
        ),
        // A game-level flag applies to everyone in that game, not just one account.
        modGameIds: new Set(modRows.filter((r) => !r.userId).map((r) => r.gameId)),
        bannedIds: new Set(bannedRows.map((r) => r.id)),
    };
}

/** True when an excluded tag covers this (game, player) row — see resolveXpExclusions. */
function xpRowExcluded(
    ex: { modKeys: Set<string>; modGameIds: Set<string>; bannedIds: Set<string> },
    gameId: string,
    userId: string,
): boolean {
    return (
        ex.bannedIds.has(userId) ||
        ex.modGameIds.has(gameId) ||
        ex.modKeys.has(`${gameId}|${userId}`)
    );
}

/**
 * Authoritative check for the moderator write scope: a moderator may set "sus", and may
 * "clear" only a row that is currently "sus" (a no-op for XP). Clearing a "botted" or
 * "removed" row restores XP, so that — like setting "botted" — stays admin-only.
 *
 * Returns an error code when the action must be refused, or null when it's allowed.
 */
async function moderatorSusOnlyDenial(
    gameId: string,
    userId: string,
    status: "sus" | "botted" | "clear",
): Promise<string | null> {
    if (status === "sus") return null;
    if (status === "botted") return "forbidden_moderators_may_only_mark_sus";

    // status === "clear": only legal when there is nothing but a "sus" label to remove.
    const existing = await db.query.gameModerationTable.findFirst({
        where: and(
            eq(gameModerationTable.gameId, gameId),
            eq(gameModerationTable.userId, userId),
        ),
        columns: { status: true },
    });
    return existing && existing.status !== "sus"
        ? "forbidden_moderators_may_only_clear_sus"
        : null;
}

/**
 * Tags a live player list with the staff roles from the accounts DB.
 *
 * The game process only knows the `admin` flag it was handed at join time and nothing
 * at all about moderators, so the API server (the only side with DB access) resolves
 * both here. Only staff rows are fetched, so a normal lobby costs one small query.
 */
async function withStaffFlags(players: any[]): Promise<any[]> {
    const userIds = [...new Set(players.map((p) => p.userId).filter(Boolean))];
    if (!userIds.length) return players;

    const staff = await db
        .select({
            id: usersTable.id,
            admin: usersTable.admin,
            moderator: usersTable.moderator,
        })
        .from(usersTable)
        .where(
            and(
                inArray(usersTable.id, userIds),
                or(eq(usersTable.admin, true), eq(usersTable.moderator, true)),
            ),
        );
    if (!staff.length) return players;

    const byId = new Map(staff.map((u) => [u.id, u]));
    return players.map((p) => {
        const u = p.userId ? byId.get(p.userId) : undefined;
        if (!u) return p;
        return { ...p, isAdmin: p.isAdmin || u.admin, isModerator: u.moderator };
    });
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
        return c.json({
            id: user.id,
            username: user.username,
            slug: user.slug,
            admin: !!user.admin,
            moderator: !!user.moderator,
        });
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
                // Optional absolute expiry (epoch ms); overrides `duration` when set.
                expiresAt: z.number().int().positive().optional(),
            }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const { ip, reason, duration, permanent, expiresAt } = c.req.valid("json");
            const expiresIn = resolveBanExpiry(duration, expiresAt);

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
                    // Linked account bans inherit the IP ban's expiry so they lift
                    // together (independently, via the account expiry sweep).
                    .set({
                        banned: true,
                        banReason: reason,
                        bannedBy: admin.slug,
                        banExpiresAt: permanent ? null : expiresIn,
                    })
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
                {
                    name: "Duration",
                    value: permanent ? "permanent" : fmtBanDuration(duration),
                },
                { name: "By admin", value: adminTag(admin) },
            ]);

            broadcastBans();
            return c.json({ ok: true });
        },
    )

    /** Creates an account ban (permanent or time-limited). Broadcasts updated bans. */
    .post(
        "/api/ban/account",
        validateParams(
            z.object({
                slug: z.string(),
                reason: z.string().default(""),
                duration: z.number().default(7),
                permanent: z.boolean().default(false),
                // Optional absolute expiry (epoch ms); overrides `duration` when set.
                expiresAt: z.number().int().positive().optional(),
            }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const { slug, reason, duration, permanent, expiresAt } = c.req.valid("json");
            // null = permanent; otherwise the ban-expiry sweep lifts it after this date.
            const banExpiresAt = permanent ? null : resolveBanExpiry(duration, expiresAt);

            await db
                .update(usersTable)
                .set({
                    banned: true,
                    banReason: reason,
                    bannedBy: admin.slug,
                    banExpiresAt,
                })
                .where(eq(usersTable.slug, slug));

            await recordBan({
                banType: "account",
                banTarget: slug,
                reason,
                bannedBy: admin.slug,
                expiresAt: banExpiresAt,
                permanent,
            });

            void logModerationAction("🔨 Account banned", [
                { name: "Account", value: slug },
                { name: "Reason", value: reason || "–" },
                {
                    name: "Duration",
                    value: permanent ? "permanent" : fmtBanDuration(duration),
                },
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
                // Optional absolute expiry (epoch ms); overrides `duration` when set.
                expiresAt: z.number().int().positive().optional(),
            }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const { ip, reason, duration, permanent, expiresAt } = c.req.valid("json");
            const expiresIn = resolveBanExpiry(duration, expiresAt);

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
                {
                    name: "Duration",
                    value: permanent ? "permanent" : fmtBanDuration(duration),
                },
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
                .set({ banned: false, banReason: "", bannedBy: "", banExpiresAt: null })
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
                .set({ banned: false, banReason: "", bannedBy: "", banExpiresAt: null })
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

        const [banRecord, rows, banHistory, nameCounts] = await Promise.all([
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
            // How often each name was seen from this IP (exact count, not limited to 200).
            db
                .select({
                    username: ipLogsTable.username,
                    count: sql<number>`count(*)::int`,
                })
                .from(ipLogsTable)
                .where(eq(ipLogsTable.encodedIp, hash))
                .groupBy(ipLogsTable.username),
        ]);

        // Name → how many times that (name, this IP) combo was logged.
        const countByName = new Map(nameCounts.map((r) => [r.username, Number(r.count)]));

        // Collect ISP and deduplicate recent names from ip_logs
        const seenNames = new Set<string>();
        const accounts: ((typeof rows)[number] & {
            source: "recent" | "historical";
            count: number;
        })[] = [];
        let isp = "";

        for (const row of rows) {
            if (!isp && row.isp) isp = row.isp;
            if (!seenNames.has(row.username)) {
                seenNames.add(row.username);
                accounts.push({
                    ...row,
                    source: "recent",
                    count: countByName.get(row.username) ?? 0,
                });
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
                    count: countByName.get(row.username) ?? 0,
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

        const [rows, ipCounts] = await Promise.all([
            db
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
                .limit(200),
            // How often this name was seen from each IP (exact count, not limited to 200).
            db
                .select({
                    encodedIp: ipLogsTable.encodedIp,
                    count: sql<number>`count(*)::int`,
                })
                .from(ipLogsTable)
                .where(eq(ipLogsTable.username, name))
                .groupBy(ipLogsTable.encodedIp),
        ]);

        const countByIp = new Map(ipCounts.map((r) => [r.encodedIp, Number(r.count)]));

        const seenIps = new Set<string>();
        const ips: {
            ip: string;
            isp: string;
            region: string;
            lastSeen: Date;
            slug: string | null;
            count: number;
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
                    count: countByIp.get(row.encodedIp) ?? 0,
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

    /**
     * Account "session" lookup by slug — shows every name and IP the account has
     * played under (aggregated from ip_logs, keyed by the account's userId), plus
     * ban history. Unlike opening the full account-detail modal, this keeps the
     * moderator on the lookup view so they can spot alt names / shared IPs.
     */
    .get("/api/slug/:slug", async (c) => {
        const slug = c.req.param("slug");

        const user = await db.query.usersTable.findFirst({
            where: eq(usersTable.slug, slug),
            columns: { id: true, slug: true, username: true },
        });
        if (!user) return c.json({ error: "not found" }, 404);

        const [nameRows, ipRows] = await Promise.all([
            // Every display name this account has used, with how often + when last seen.
            db
                .select({
                    username: ipLogsTable.username,
                    count: sql<number>`count(*)::int`,
                    lastSeen: sql<Date>`max(${ipLogsTable.createdAt})`,
                })
                .from(ipLogsTable)
                .where(eq(ipLogsTable.userId, user.id))
                .groupBy(ipLogsTable.username)
                .orderBy(desc(sql`count(*)`)),
            // Every IP this account has played from, with how often + when last seen.
            db
                .select({
                    ip: ipLogsTable.encodedIp,
                    isp: sql<string>`max(${ipLogsTable.isp})`,
                    region: sql<string>`max(${ipLogsTable.region})`,
                    count: sql<number>`count(*)::int`,
                    lastSeen: sql<Date>`max(${ipLogsTable.createdAt})`,
                })
                .from(ipLogsTable)
                .where(eq(ipLogsTable.userId, user.id))
                .groupBy(ipLogsTable.encodedIp)
                .orderBy(desc(sql`max(${ipLogsTable.createdAt})`)),
        ]);

        // Ban history across the account's slug (account bans) + its IP hashes (ip/chat bans).
        const hashes = ipRows.map((r) => r.ip);
        const banHistory = await db
            .select()
            .from(banHistoryTable)
            .where(
                or(
                    and(
                        eq(banHistoryTable.banType, "account"),
                        eq(banHistoryTable.banTarget, slug),
                    ),
                    hashes.length
                        ? and(
                              inArray(banHistoryTable.banType, ["ip", "chat"]),
                              inArray(banHistoryTable.banTarget, hashes),
                          )
                        : undefined,
                ),
            )
            .orderBy(desc(banHistoryTable.bannedAt))
            .limit(100);

        return c.json({
            slug: user.slug,
            username: user.username,
            userId: user.id,
            names: nameRows.map((r) => ({
                username: r.username,
                count: Number(r.count),
                lastSeen: r.lastSeen,
            })),
            ips: ipRows.map((r) => ({
                ip: r.ip,
                isp: r.isp,
                region: r.region,
                count: Number(r.count),
                lastSeen: r.lastSeen,
            })),
            banHistory,
        });
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
                const players = await withStaffFlags(
                    await server.getDashboardGamePlayers(regionId, gameId),
                );
                await push("players", { players });
            }

            // Periodic server list updates (every 8 s)
            const serverTimer = setInterval(async () => {
                await push("servers", await fetchServers());
            }, 8_000);

            // Periodic player list updates for the watched game (every 3 s)
            const playerTimer = gameId
                ? setInterval(async () => {
                      const players = await withStaffFlags(
                          await server.getDashboardGamePlayers(regionId, gameId),
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

    /**
     * Lists all recorded games across every region (newest first), for the Replays tab.
     *
     * A recording's metadata only carries the in-game name, so each POV is resolved
     * against match_data here: to an account (slug) when the player was logged in, or
     * to a guest mod key otherwise — so every POV, guests included, can be flagged.
     * Batched into three queries regardless of how many games are listed.
     */
    .get("/api/replays", async (c) => {
        const regions = await Promise.all(
            Object.entries(server.regions).map(async ([regionId, region]) => {
                const recordings = await region.listReplays().catch(() => []);
                return { regionId, recordings };
            }),
        );

        const gameIds = [
            ...new Set(
                regions.flatMap((r) =>
                    (r.recordings as any[]).map((rec) => rec.gameId).filter(Boolean),
                ),
            ),
        ];

        const [rows, mods] = await Promise.all([
            gameIds.length
                ? db
                      .select({
                          gameId: matchDataTable.gameId,
                          username: matchDataTable.username,
                          userId: matchDataTable.userId,
                          removedUserId: matchDataTable.removedUserId,
                          playerId: matchDataTable.playerId,
                      })
                      .from(matchDataTable)
                      .where(inArray(matchDataTable.gameId, gameIds))
                : [],
            // Existing flags, so the tab can show what was already raised.
            gameIds.length
                ? db
                      .select({
                          gameId: gameModerationTable.gameId,
                          userId: gameModerationTable.userId,
                          status: gameModerationTable.status,
                      })
                      .from(gameModerationTable)
                      .where(inArray(gameModerationTable.gameId, gameIds))
                : [],
        ]);

        // A "removed" player keeps their account in removed_user_id — still an account.
        const accountIds = [
            ...new Set(
                rows.map((r) => r.userId || r.removedUserId || "").filter(Boolean),
            ),
        ];
        const users = accountIds.length
            ? await db
                  .select({
                      id: usersTable.id,
                      slug: usersTable.slug,
                      banned: usersTable.banned,
                  })
                  .from(usersTable)
                  .where(inArray(usersTable.id, accountIds))
            : [];

        const userById = new Map(users.map((u) => [u.id, u]));
        const rowByName = new Map(rows.map((r) => [`${r.gameId}|${r.username}`, r]));
        const modByKey = new Map(mods.map((m) => [`${m.gameId}|${m.userId}`, m.status]));

        return c.json({
            regions: regions.map((r) => ({
                regionId: r.regionId,
                recordings: (r.recordings as any[]).map((rec) => ({
                    ...rec,
                    // A flag on the game as a whole (mod key "").
                    gameStatus: modByKey.get(`${rec.gameId}|`) ?? null,
                    players: (rec.players ?? []).map((p: any) => {
                        const row = rowByName.get(`${rec.gameId}|${p.playerName}`);
                        const accountId = row
                            ? row.userId || row.removedUserId || ""
                            : "";
                        const user = accountId ? userById.get(accountId) : undefined;
                        // Three distinct cases, and they must not be conflated:
                        //   account  → flag the account
                        //   guest    → flag their per-game player slot
                        //   no row   → the game wrote no match_data (never finished, or
                        //              it was deleted); we know nothing about this POV,
                        //              so there is nothing to attach a flag to.
                        const modKey = user
                            ? accountId
                            : row
                              ? guestModKey(row.playerId)
                              : "";
                        return {
                            ...p,
                            slug: user?.slug ?? null,
                            banned: user?.banned ?? false,
                            guest: !!row && !user,
                            noData: !row,
                            modKey,
                            modStatus: modKey
                                ? (modByKey.get(`${rec.gameId}|${modKey}`) ?? null)
                                : null,
                        };
                    }),
                })),
            })),
        });
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
     * Flags a replay as suspicious straight from the Replays tab — a moderator's main
     * action. Without `playerName` the whole GAME is flagged; with it, that one POV is
     * flagged — its account when the player was logged in, otherwise the guest's
     * per-game slot. Either way the name is resolved server-side through match_data, so
     * a client can never inject an arbitrary mod key.
     *
     * Writes the same `game_moderation` rows the XP/Games tabs use, so a flag raised
     * here surfaces everywhere, including the admin-only Sus tab.
     */
    .post(
        "/api/replays/sus",
        validateParams(
            z.object({
                gameId: z.string().min(1),
                playerName: z.string().min(1).optional(),
                reason: z.string().min(1).max(500),
            }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const { gameId, playerName, reason } = c.req.valid("json");

            let modKey = ""; // "" ⇒ the game as a whole
            if (playerName) {
                const rows = await db
                    .select({
                        userId: matchDataTable.userId,
                        removedUserId: matchDataTable.removedUserId,
                        playerId: matchDataTable.playerId,
                    })
                    .from(matchDataTable)
                    .where(
                        and(
                            eq(matchDataTable.gameId, gameId),
                            eq(matchDataTable.username, playerName),
                        ),
                    )
                    .limit(5);

                if (!rows.length) return c.json({ error: "player_not_in_game" }, 404);
                // Prefer a row that carries an account; fall back to the guest's slot.
                const row = rows.find((r) => r.userId || r.removedUserId) ?? rows[0]!;
                const accountId = row.userId || row.removedUserId || "";
                modKey = accountId || guestModKey(row.playerId);
            }

            await setGamePlayerModeration(gameId, modKey, "sus", admin.slug, reason);

            void logModerationAction(
                "🚩 Marked suspicious (replay)",
                [
                    { name: "Game", value: gameId },
                    { name: "Player", value: playerName ?? "— whole game —" },
                    {
                        name: "Account",
                        value: !playerName
                            ? "—"
                            : isGuestModKey(modKey)
                              ? "guest (no account)"
                              : modKey,
                    },
                    { name: "Reason", value: reason },
                    { name: "By", value: adminTag(admin) },
                ],
                0xe08a1a,
            );

            return c.json({ ok: true, modKey, guest: isGuestModKey(modKey) });
        },
    )

    /**
     * "Sus" tab (admin-only): every game/player currently flagged suspicious, newest
     * first, with the reason and the staff member who raised it. Rows with an empty
     * user id are game-level flags (raised from the Replays tab).
     */
    .get("/api/sus", async (c) => {
        const rows = await db
            .select()
            .from(gameModerationTable)
            .where(eq(gameModerationTable.status, "sus"))
            .orderBy(desc(gameModerationTable.markedAt))
            .limit(500);

        if (!rows.length) return c.json({ entries: [] });

        const gameIds = [...new Set(rows.map((r) => r.gameId))];
        // Guest keys name a player slot, not an account — resolved separately below.
        const flaggedIds = [
            ...new Set(rows.map((r) => r.userId).filter((id) => id && !isGuestModKey(id))),
        ];
        const markerSlugs = [...new Set(rows.map((r) => r.markedBy).filter(Boolean))];
        const flaggedPlayerIds = [
            ...new Set(
                rows
                    .filter((r) => isGuestModKey(r.userId))
                    .map((r) => guestPlayerId(r.userId))
                    .filter((n) => Number.isFinite(n)),
            ),
        ];
        // Only needed when at least one flag names a player (game-wide flags don't).
        const needsPlayerDetail = !!flaggedIds.length || !!flaggedPlayerIds.length;

        const [flagged, markers, metas, detail] = await Promise.all([
            flaggedIds.length
                ? db
                      .select({
                          id: usersTable.id,
                          slug: usersTable.slug,
                          username: usersTable.username,
                          banned: usersTable.banned,
                      })
                      .from(usersTable)
                      .where(inArray(usersTable.id, flaggedIds))
                : [],
            // The staff member who raised the flag is stored as a slug; resolve their
            // display name + role so the tab can show who (and what) flagged it.
            markerSlugs.length
                ? db
                      .select({
                          slug: usersTable.slug,
                          username: usersTable.username,
                          admin: usersTable.admin,
                          moderator: usersTable.moderator,
                      })
                      .from(usersTable)
                      .where(inArray(usersTable.slug, markerSlugs))
                : [],
            db
                .select({
                    gameId: matchDataTable.gameId,
                    region: sql<string>`max(${matchDataTable.region})`,
                    mapId: sql<number>`max(${matchDataTable.mapId})`,
                    teamMode: sql<number>`max(${matchDataTable.teamMode})`,
                    createdAt: sql<Date>`max(${matchDataTable.createdAt})`,
                    players: sql<number>`count(distinct ${matchDataTable.playerId})`,
                })
                .from(matchDataTable)
                .where(inArray(matchDataTable.gameId, gameIds))
                .groupBy(matchDataTable.gameId),
            // The flagged players' own match rows: the in-game name behind a guest slot
            // (so the tab shows a name, not a raw key) and the IP each of them used in
            // that game — the target an IP ban needs, and the only IP a guest has.
            needsPlayerDetail
                ? db
                      .select({
                          gameId: matchDataTable.gameId,
                          userId: matchDataTable.userId,
                          removedUserId: matchDataTable.removedUserId,
                          playerId: matchDataTable.playerId,
                          username: matchDataTable.username,
                          encodedIp: matchDataTable.encodedIp,
                      })
                      .from(matchDataTable)
                      .where(
                          and(
                              inArray(matchDataTable.gameId, gameIds),
                              or(
                                  flaggedIds.length
                                      ? inArray(matchDataTable.userId, flaggedIds)
                                      : undefined,
                                  flaggedIds.length
                                      ? inArray(
                                            matchDataTable.removedUserId,
                                            flaggedIds,
                                        )
                                      : undefined,
                                  flaggedPlayerIds.length
                                      ? inArray(
                                            matchDataTable.playerId,
                                            flaggedPlayerIds,
                                        )
                                      : undefined,
                              ),
                          ),
                      )
                : [],
        ]);

        const userById = new Map(flagged.map((u) => [u.id, u]));
        const markerBySlug = new Map(markers.map((u) => [u.slug, u]));
        const metaByGame = new Map(metas.map((m) => [m.gameId, m]));
        // Keyed by "gameId|modKey" so account and guest rows resolve the same way. The
        // playerId filter above can pull in same-slot rows from other flagged games;
        // keying by game makes those harmless.
        const detailByKey = new Map(
            detail.map((r) => {
                const accountId = r.userId || r.removedUserId || "";
                const key = accountId || guestModKey(r.playerId);
                return [`${r.gameId}|${key}`, r];
            }),
        );

        return c.json({
            entries: rows.map((r) => {
                const guest = isGuestModKey(r.userId);
                const u = r.userId && !guest ? userById.get(r.userId) : undefined;
                const marker = markerBySlug.get(r.markedBy);
                const meta = metaByGame.get(r.gameId);
                const mapId = meta ? Number(meta.mapId) : null;
                const det = r.userId
                    ? detailByKey.get(`${r.gameId}|${r.userId}`)
                    : undefined;
                return {
                    gameId: r.gameId,
                    // "" ⇒ the game as a whole; guest: ⇒ a player with no account.
                    scope: !r.userId ? "game" : guest ? "guest" : "player",
                    userId: r.userId,
                    slug: u?.slug ?? null,
                    username: guest ? (det?.username ?? null) : u?.username || null,
                    // The IP this player used in this game — an IP ban's target, and
                    // for a guest the only handle there is.
                    encodedIp: det?.encodedIp || null,
                    banned: u?.banned ?? false,
                    reason: r.note,
                    markedBy: r.markedBy,
                    markedByName: marker?.username || r.markedBy,
                    markedByRole: marker?.admin
                        ? "admin"
                        : marker?.moderator
                          ? "moderator"
                          : null,
                    markedAt: r.markedAt,
                    region: meta?.region ?? null,
                    mapId,
                    mapName:
                        mapId != null ? (MAP_ID_TO_NAME[mapId] ?? String(mapId)) : null,
                    teamMode: meta ? Number(meta.teamMode) : null,
                    players: meta ? Number(meta.players) : null,
                    playedAt: meta?.createdAt ?? null,
                };
            }),
        });
    })

    /**
     * XP-gain leaderboard for the "XP Gain" tab — surfaces accounts that earned a lot
     * of XP within a recent time window, to spot account boosting.
     *
     * XP is recomputed from match_data (one row per game, same aggregation the pass
     * reconcile uses) via computeMatchXp — base XP only, no boost events, so the
     * ranking is deterministic and pass-independent. Returns the top gainers plus
     * per-day buckets for a sparkline. Bounded to a window + top-N (the box is small,
     * this is admin-triggered and off the hot path).
     */
    .get("/api/xp-gain", async (c) => {
        const windowParam = c.req.query("window") ?? "7d";
        const cutoff = new Date(Date.now() - windowToMs(windowParam));
        const excludeRegions = parseCsvParam(c.req.query("excludeRegions"));
        const excludeTags = parseCsvParam(c.req.query("excludeTags"));

        const exclusions = await resolveXpExclusions(excludeTags);

        // One row per (user, game): dedupe self-joins the same way passReconcile does
        // (HAVING count(*) = 1 keeps only games where the account appears once).
        const stats = await db
            .select({
                userId: matchDataTable.userId,
                gameId: matchDataTable.gameId,
                kills: sql<number>`max(${matchDataTable.kills})`,
                damage: sql<number>`max(${matchDataTable.damageDealt})`,
                timeAlive: sql<number>`max(${matchDataTable.timeAlive})`,
                rank: sql<number>`min(${matchDataTable.rank})`,
                mapId: sql<number>`max(${matchDataTable.mapId})`,
                createdAt: sql<Date>`max(${matchDataTable.createdAt})`,
            })
            .from(matchDataTable)
            .where(
                and(
                    gte(matchDataTable.createdAt, cutoff),
                    sql`${matchDataTable.userId} <> ''`,
                    // Voided (botted) games are excluded so the leaderboard reflects
                    // the XP the accounts actually keep.
                    eq(matchDataTable.voided, false),
                    excludeRegions.length
                        ? notInArray(matchDataTable.region, excludeRegions)
                        : undefined,
                ),
            )
            .groupBy(matchDataTable.userId, matchDataTable.gameId)
            .having(sql`count(*) = 1`);

        // Aggregate per user: total XP, games, and a per-day XP bucket for the sparkline.
        // Excluded rows are dropped before aggregating, so the totals and the sparkline
        // reflect exactly what the filtered view claims.
        const perUser = new Map<
            string,
            { xpGained: number; games: number; spark: Map<string, number> }
        >();
        for (const s of stats) {
            const uid = s.userId ?? "";
            if (xpRowExcluded(exclusions, s.gameId, uid)) continue;
            const xp = computeMatchXp(s);
            let u = perUser.get(uid);
            if (!u) {
                u = { xpGained: 0, games: 0, spark: new Map() };
                perUser.set(uid, u);
            }
            u.xpGained += xp;
            u.games += 1;
            const day = new Date(s.createdAt).toISOString().slice(0, 10);
            u.spark.set(day, (u.spark.get(day) ?? 0) + xp);
        }

        // Rank by XP gained, keep the top 100 suspects.
        const ranked = [...perUser.entries()]
            .map(([userId, u]) => ({ userId, ...u }))
            .sort((a, b) => b.xpGained - a.xpGained)
            .slice(0, 100);

        // Resolve slug / username for the ranked users, and list the regions present in
        // the window (unfiltered, so the exclude dropdown always offers every option).
        const userIds = ranked.map((r) => r.userId);
        const [users, regionRows] = await Promise.all([
            userIds.length
                ? db
                      .select({
                          id: usersTable.id,
                          slug: usersTable.slug,
                          username: usersTable.username,
                          banned: usersTable.banned,
                      })
                      .from(usersTable)
                      .where(inArray(usersTable.id, userIds))
                : [],
            db
                .selectDistinct({ region: matchDataTable.region })
                .from(matchDataTable)
                .where(
                    and(
                        gte(matchDataTable.createdAt, cutoff),
                        sql`${matchDataTable.userId} <> ''`,
                    ),
                ),
        ]);
        const userById = new Map(users.map((u) => [u.id, u]));

        return c.json({
            window: windowParam,
            regions: regionRows
                .map((r) => r.region)
                .filter(Boolean)
                .sort(),
            excludedRegions: excludeRegions,
            excludedTags: excludeTags,
            users: ranked.map((r) => {
                const u = userById.get(r.userId);
                return {
                    userId: r.userId,
                    slug: u?.slug ?? null,
                    username: u?.username || null,
                    banned: u?.banned ?? false,
                    xpGained: Math.round(r.xpGained * 100) / 100,
                    games: r.games,
                    xpPerGame:
                        r.games > 0 ? Math.round((r.xpGained / r.games) * 100) / 100 : 0,
                    spark: [...r.spark.entries()]
                        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
                        .map(([d, xp]) => ({ d, xp: Math.round(xp * 100) / 100 })),
                };
            }),
        });
    })

    /**
     * Per-game XP breakdown for one account in a time window — the drill-down behind
     * a row on the XP-gain leaderboard. Returns every game (one row per game, same
     * dedupe as the reconcile) with its stats and computed XP, newest data first, so
     * the dashboard can chart the individual games and link to each one.
     */
    .get("/api/xp-gain/user/:userId", async (c) => {
        const userId = c.req.param("userId");
        const windowParam = c.req.query("window") ?? "7d";
        const cutoff = new Date(Date.now() - windowToMs(windowParam));

        const [user, stats] = await Promise.all([
            db.query.usersTable.findFirst({
                where: eq(usersTable.id, userId),
                columns: { id: true, slug: true, username: true, banned: true },
            }),
            db
                .select({
                    gameId: matchDataTable.gameId,
                    region: sql<string>`max(${matchDataTable.region})`,
                    mapId: sql<number>`max(${matchDataTable.mapId})`,
                    teamMode: sql<number>`max(${matchDataTable.teamMode})`,
                    kills: sql<number>`max(${matchDataTable.kills})`,
                    damage: sql<number>`max(${matchDataTable.damageDealt})`,
                    timeAlive: sql<number>`max(${matchDataTable.timeAlive})`,
                    rank: sql<number>`min(${matchDataTable.rank})`,
                    createdAt: sql<Date>`max(${matchDataTable.createdAt})`,
                    // True if this game was "removed" from the account (user_id blanked).
                    removed: sql<boolean>`bool_or(${matchDataTable.removedUserId} = ${userId})`,
                })
                .from(matchDataTable)
                // Match live rows AND rows this account was removed from, so removed
                // games stay visible here (badged) and can be restored.
                .where(
                    and(
                        or(
                            eq(matchDataTable.userId, userId),
                            eq(matchDataTable.removedUserId, userId),
                        ),
                        gte(matchDataTable.createdAt, cutoff),
                    ),
                )
                .groupBy(matchDataTable.gameId)
                .having(sql`count(*) = 1`),
        ]);

        const games = stats
            .map((s) => {
                const mapId = Number(s.mapId);
                const stat = {
                    kills: Number(s.kills),
                    damage: Number(s.damage),
                    timeAlive: Number(s.timeAlive),
                    rank: Number(s.rank),
                    mapId,
                };
                return {
                    gameId: s.gameId,
                    region: s.region,
                    mapId,
                    mapName: MAP_ID_TO_NAME[mapId] ?? String(mapId),
                    teamMode: Number(s.teamMode),
                    kills: stat.kills,
                    damage: stat.damage,
                    timeAlive: stat.timeAlive,
                    rank: stat.rank,
                    createdAt: s.createdAt,
                    removed: !!s.removed,
                    xp: Math.round(computeMatchXp(stat) * 100) / 100,
                };
            })
            .sort(
                (a, b) =>
                    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
            );

        const totalXp =
            Math.round(games.reduce((sum, g) => sum + (g.removed ? 0 : g.xp), 0) * 100) /
            100;

        return c.json({
            userId,
            slug: user?.slug ?? null,
            username: user?.username || null,
            banned: user?.banned ?? false,
            window: windowParam,
            totalXp,
            games,
        });
    })

    /**
     * XP-gain "Games" sub-tab: one entry per (player, game) in the window, sorted by
     * the XP that player gained in that game (desc). Same one-row-per-game dedupe as
     * the leaderboard, but NOT aggregated up to the account, so a single suspicious
     * game surfaces directly. Voided (botted) games are still shown — tagged with
     * their moderation status — so a moderator can review or undo them. Optional
     * ?region= filters the list; the response also returns the distinct regions in
     * the window to populate the filter dropdown.
     */
    .get("/api/xp-gain/games", async (c) => {
        const windowParam = c.req.query("window") ?? "7d";
        const regionParam = c.req.query("region") ?? "";
        const excludeRegions = parseCsvParam(c.req.query("excludeRegions"));
        const excludeTags = parseCsvParam(c.req.query("excludeTags"));
        const limitRaw = Number(c.req.query("limit") ?? "200");
        const limit =
            Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;
        const cutoff = new Date(Date.now() - windowToMs(windowParam));

        const exclusions = await resolveXpExclusions(excludeTags);

        const conds = [
            gte(matchDataTable.createdAt, cutoff),
            sql`${matchDataTable.userId} <> ''`,
        ];
        if (regionParam) conds.push(eq(matchDataTable.region, regionParam));
        if (excludeRegions.length)
            conds.push(notInArray(matchDataTable.region, excludeRegions));

        const stats = await db
            .select({
                userId: matchDataTable.userId,
                gameId: matchDataTable.gameId,
                region: sql<string>`max(${matchDataTable.region})`,
                kills: sql<number>`max(${matchDataTable.kills})`,
                damage: sql<number>`max(${matchDataTable.damageDealt})`,
                timeAlive: sql<number>`max(${matchDataTable.timeAlive})`,
                rank: sql<number>`min(${matchDataTable.rank})`,
                mapId: sql<number>`max(${matchDataTable.mapId})`,
                teamMode: sql<number>`max(${matchDataTable.teamMode})`,
                createdAt: sql<Date>`max(${matchDataTable.createdAt})`,
            })
            .from(matchDataTable)
            .where(and(...conds))
            .groupBy(matchDataTable.userId, matchDataTable.gameId)
            .having(sql`count(*) = 1`);

        const entries = stats
            // Excluded rows are dropped BEFORE the sort + top-N slice, so the filter
            // pulls the next-highest games into view instead of leaving gaps.
            .filter((s) => !xpRowExcluded(exclusions, s.gameId, s.userId ?? ""))
            .map((s) => {
                const mapId = Number(s.mapId);
                const stat = {
                    kills: Number(s.kills),
                    damage: Number(s.damage),
                    timeAlive: Number(s.timeAlive),
                    rank: Number(s.rank),
                    mapId,
                };
                return {
                    gameId: s.gameId,
                    // Non-null in practice — the query filters `userId <> ''`.
                    userId: s.userId ?? "",
                    region: s.region,
                    mapId,
                    mapName: MAP_ID_TO_NAME[mapId] ?? String(mapId),
                    teamMode: Number(s.teamMode),
                    kills: stat.kills,
                    damage: stat.damage,
                    timeAlive: stat.timeAlive,
                    rank: stat.rank,
                    createdAt: s.createdAt,
                    xp: Math.round(computeMatchXp(stat) * 100) / 100,
                };
            })
            .sort((a, b) => b.xp - a.xp)
            .slice(0, limit);

        // Resolve account + per-(game,player) moderation status for the shown entries,
        // plus the distinct regions in the window for the filter dropdown.
        const userIds = [...new Set(entries.map((e) => e.userId))];
        const gameIds = [...new Set(entries.map((e) => e.gameId))];
        const users = userIds.length
            ? await db
                  .select({
                      id: usersTable.id,
                      slug: usersTable.slug,
                      username: usersTable.username,
                      banned: usersTable.banned,
                  })
                  .from(usersTable)
                  .where(inArray(usersTable.id, userIds))
            : [];
        const mods = gameIds.length
            ? await db
                  .select({
                      gameId: gameModerationTable.gameId,
                      userId: gameModerationTable.userId,
                      status: gameModerationTable.status,
                  })
                  .from(gameModerationTable)
                  .where(inArray(gameModerationTable.gameId, gameIds))
            : [];
        // Distinct player-slot count per shown game (low counts = likely bot lobby).
        const counts = gameIds.length
            ? await db
                  .select({
                      gameId: matchDataTable.gameId,
                      n: sql<number>`count(distinct ${matchDataTable.playerId})`,
                  })
                  .from(matchDataTable)
                  .where(inArray(matchDataTable.gameId, gameIds))
                  .groupBy(matchDataTable.gameId)
            : [];
        const regionRows = await db
            .selectDistinct({ region: matchDataTable.region })
            .from(matchDataTable)
            .where(
                and(
                    gte(matchDataTable.createdAt, cutoff),
                    sql`${matchDataTable.userId} <> ''`,
                ),
            );
        const userById = new Map(users.map((u) => [u.id, u]));
        const modByKey = new Map(mods.map((m) => [m.gameId + "|" + m.userId, m.status]));
        const playersByGame = new Map(counts.map((c) => [c.gameId, Number(c.n)]));
        const regions = regionRows
            .map((r) => r.region)
            .filter(Boolean)
            .sort();

        return c.json({
            window: windowParam,
            region: regionParam,
            regions,
            games: entries.map((e) => {
                const u = userById.get(e.userId);
                return {
                    ...e,
                    slug: u?.slug ?? null,
                    username: u?.username || null,
                    banned: u?.banned ?? false,
                    players: playersByGame.get(e.gameId) ?? 0,
                    modStatus: modByKey.get(e.gameId + "|" + e.userId) ?? null,
                };
            }),
        });
    })

    /**
     * Game-level search for the "Games" tab. Returns one summary row per game so the
     * moderator can drill into the full roster (all per-player actions + delete). An
     * exact game id is looked up directly by the client; here we support browsing recent
     * games with filters: `player` (slug), `mapId`, `teamMode`, `region`, `window`, and
     * `minKills` / `minDamage` (top value in the game) to surface outlier/botted lobbies.
     */
    .get("/api/games/search", async (c) => {
        const windowParam = c.req.query("window") ?? "7d";
        const region = c.req.query("region") ?? "";
        const mapIdParam = c.req.query("mapId") ?? "";
        const teamModeParam = c.req.query("teamMode") ?? "";
        const player = (c.req.query("player") ?? "").trim().toLowerCase();
        const minKills = Math.max(0, Number(c.req.query("minKills") ?? "0") || 0);
        const minDamage = Math.max(0, Number(c.req.query("minDamage") ?? "0") || 0);
        const cutoff = new Date(Date.now() - windowToMs(windowParam));

        const conds = [gte(matchDataTable.createdAt, cutoff)];
        if (region) conds.push(eq(matchDataTable.region, region));
        if (mapIdParam) conds.push(eq(matchDataTable.mapId, Number(mapIdParam)));
        if (teamModeParam)
            conds.push(eq(matchDataTable.teamMode, Number(teamModeParam) as TeamMode));

        // Restrict to games a specific player appeared in. The one box matches BOTH an
        // exact account slug and the in-game name (substring, case-insensitive), and
        // unions the two:
        //   - by slug     → every game of that account, under every name they used
        //   - by name     → every game anyone played under that name — the only way to
        //                   find a guest, who has no account and therefore no slug
        // Searching both means a name that happens to equal someone's slug can't hide
        // the other's games.
        if (player) {
            const [u] = await db
                .select({ id: usersTable.id })
                .from(usersTable)
                .where(eq(usersTable.slug, player))
                .limit(1);

            const gidRows = await db
                .selectDistinct({ gameId: matchDataTable.gameId })
                .from(matchDataTable)
                .where(
                    and(
                        gte(matchDataTable.createdAt, cutoff),
                        or(
                            u ? eq(matchDataTable.userId, u.id) : undefined,
                            ilike(matchDataTable.username, `%${escapeLike(player)}%`),
                        ),
                    ),
                );
            const gids = gidRows.map((r) => r.gameId);
            if (!gids.length)
                return c.json({ games: [], maps: [], regions: [], unknownPlayer: true });
            conds.push(inArray(matchDataTable.gameId, gids));
        }

        const rows = await db
            .select({
                gameId: matchDataTable.gameId,
                createdAt: sql<Date>`max(${matchDataTable.createdAt})`,
                mapId: sql<number>`max(${matchDataTable.mapId})`,
                teamMode: sql<number>`max(${matchDataTable.teamMode})`,
                region: sql<string>`max(${matchDataTable.region})`,
                players: sql<number>`count(distinct ${matchDataTable.playerId})`,
                topKills: sql<number>`max(${matchDataTable.kills})`,
                topDamage: sql<number>`max(${matchDataTable.damageDealt})`,
            })
            .from(matchDataTable)
            .where(and(...conds))
            .groupBy(matchDataTable.gameId)
            .having(
                sql`max(${matchDataTable.kills}) >= ${minKills} AND max(${matchDataTable.damageDealt}) >= ${minDamage}`,
            )
            .orderBy(desc(sql`max(${matchDataTable.createdAt})`))
            .limit(100);

        // Which of these games already carry any moderation flag (sus/botted/removed)?
        const gameIds = rows.map((r) => r.gameId);
        const modRows = gameIds.length
            ? await db
                  .selectDistinct({ gameId: gameModerationTable.gameId })
                  .from(gameModerationTable)
                  .where(inArray(gameModerationTable.gameId, gameIds))
            : [];
        const flagged = new Set(modRows.map((m) => m.gameId));

        // Filter dropdown sources (distinct maps + regions currently in the data).
        const [mapRows, regionRows] = await Promise.all([
            db.selectDistinct({ mapId: matchDataTable.mapId }).from(matchDataTable),
            db
                .selectDistinct({ region: matchDataTable.region })
                .from(matchDataTable)
                .where(gte(matchDataTable.createdAt, cutoff)),
        ]);
        const maps = mapRows
            .map((m) => ({
                mapId: m.mapId,
                name: MAP_ID_TO_NAME[m.mapId] ?? String(m.mapId),
            }))
            .sort((a, b) => a.mapId - b.mapId);
        const regions = regionRows
            .map((r) => r.region)
            .filter(Boolean)
            .sort();

        return c.json({
            window: windowParam,
            maps,
            regions,
            games: rows.map((r) => ({
                gameId: r.gameId,
                createdAt: r.createdAt,
                mapId: Number(r.mapId),
                mapName: MAP_ID_TO_NAME[Number(r.mapId)] ?? String(r.mapId),
                teamMode: Number(r.teamMode),
                region: r.region,
                players: Number(r.players),
                topKills: Number(r.topKills),
                topDamage: Number(r.topDamage),
                flagged: flagged.has(r.gameId),
            })),
        });
    })

    /**
     * Full player roster for one game (the expandable detail in the "Games" sub-tab):
     * every participant with their stats, the XP they earned, and their per-player
     * moderation status — so a moderator can bott/un-bott each one individually.
     */
    .get("/api/game/:gameId/players", async (c) => {
        const gameId = c.req.param("gameId");

        // No user join here: a "removed" player's user_id is blanked (moved to
        // removed_user_id), so we resolve the effective account id per row and look
        // the accounts up in a batch, so removed players still show with their name.
        const [rows, mods] = await Promise.all([
            db
                .select({
                    userId: matchDataTable.userId,
                    removedUserId: matchDataTable.removedUserId,
                    username: matchDataTable.username,
                    playerId: matchDataTable.playerId,
                    teamId: matchDataTable.teamId,
                    timeAlive: matchDataTable.timeAlive,
                    rank: matchDataTable.rank,
                    died: matchDataTable.died,
                    kills: matchDataTable.kills,
                    assists: matchDataTable.assists,
                    damageDealt: matchDataTable.damageDealt,
                    damageTaken: matchDataTable.damageTaken,
                    mapId: matchDataTable.mapId,
                    teamMode: matchDataTable.teamMode,
                    region: matchDataTable.region,
                    createdAt: matchDataTable.createdAt,
                    voided: matchDataTable.voided,
                    // The IP this player actually used in THIS game — more useful for
                    // judging the game than the account's current one, and it covers
                    // guests too (who have no account to look an IP up from).
                    encodedIp: matchDataTable.encodedIp,
                })
                .from(matchDataTable)
                .where(eq(matchDataTable.gameId, gameId))
                .orderBy(asc(matchDataTable.rank)),
            db
                .select({
                    userId: gameModerationTable.userId,
                    status: gameModerationTable.status,
                })
                .from(gameModerationTable)
                .where(eq(gameModerationTable.gameId, gameId)),
        ]);

        const effId = (r: { userId: string | null; removedUserId: string | null }) =>
            r.userId ? r.userId : (r.removedUserId ?? "");
        const userIds = [...new Set(rows.map(effId).filter(Boolean))];
        const users = userIds.length
            ? await db
                  .select({
                      id: usersTable.id,
                      slug: usersTable.slug,
                      banned: usersTable.banned,
                  })
                  .from(usersTable)
                  .where(inArray(usersTable.id, userIds))
            : [];
        const userById = new Map(users.map((u) => [u.id, u]));
        const modByUser = new Map(mods.map((m) => [m.userId, m.status]));

        const first = rows[0];
        const meta = first
            ? {
                  region: first.region,
                  mapId: first.mapId,
                  mapName: MAP_ID_TO_NAME[first.mapId] ?? String(first.mapId),
                  teamMode: first.teamMode,
                  createdAt: first.createdAt,
              }
            : null;

        return c.json({
            gameId,
            meta,
            players: rows.map((r) => {
                const uid = effId(r);
                const u = uid ? userById.get(uid) : undefined;
                const removed = !!r.removedUserId && !r.userId;
                // Who a flag on this row is about: the account, or the guest's slot.
                const modKey = uid || guestModKey(r.playerId);
                const stat = {
                    kills: r.kills,
                    damage: r.damageDealt,
                    timeAlive: r.timeAlive,
                    rank: r.rank,
                    mapId: r.mapId,
                };
                return {
                    userId: uid, // effective account id ("" for a guest)
                    modKey, // what the row's actions target
                    guest: !uid,
                    slug: u?.slug ?? null,
                    banned: u?.banned ?? false,
                    username: r.username,
                    encodedIp: r.encodedIp,
                    playerId: r.playerId,
                    teamId: r.teamId,
                    timeAlive: r.timeAlive,
                    rank: r.rank,
                    died: r.died,
                    kills: r.kills,
                    assists: r.assists,
                    damage: r.damageDealt,
                    damageTaken: r.damageTaken,
                    voided: r.voided,
                    removed,
                    xp: Math.round(computeMatchXp(stat) * 100) / 100,
                    // modByUser is keyed by mod key, so this covers guests too.
                    modStatus: modByUser.get(modKey) ?? null,
                };
            }),
        });
    })

    /**
     * Sets/clears the moderation status of ONE player in ONE game. "botted" revokes
     * that player's XP (plus the pass cosmetics and Golden Fries earned from the game)
     * and remembers the exact amount; "clear" restores it; "sus" is a label only.
     * Fully reversible — see setGamePlayerModeration.
     *
     * An empty `userId` marks the GAME AS A WHOLE (only meaningful for "sus", which
     * touches no XP) — that's what the Replays tab's game-level flag writes.
     *
     * Moderators may only set "sus", or "clear" a row that is currently "sus". Anything
     * that moves XP (botted, or clearing a botted row) stays admin-only.
     */
    .post(
        "/api/game/:gameId/moderate",
        validateParams(
            z.object({
                userId: z.string(),
                status: z.enum(["sus", "botted", "clear"]),
                note: z.string().max(500).optional(),
            }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const gameId = c.req.param("gameId");
            const { userId, status, note } = c.req.valid("json");

            // Neither a game-wide flag nor a guest owns XP, so neither may be "botted".
            if (status === "botted" && (!userId || isGuestModKey(userId))) {
                return c.json(
                    { error: !userId ? "game_level_botted_unsupported" : "guest_botted_unsupported" },
                    400,
                );
            }

            // A guest key names a player slot, not an account — make sure that slot
            // really exists in this game, so a bad key can't create an orphan row.
            if (isGuestModKey(userId)) {
                const playerId = guestPlayerId(userId);
                const found = Number.isFinite(playerId)
                    ? await db
                          .select({ playerId: matchDataTable.playerId })
                          .from(matchDataTable)
                          .where(
                              and(
                                  eq(matchDataTable.gameId, gameId),
                                  eq(matchDataTable.playerId, playerId),
                              ),
                          )
                          .limit(1)
                    : [];
                if (!found.length) return c.json({ error: "guest_not_in_game" }, 404);
            }

            if (!admin.admin) {
                const denied = await moderatorSusOnlyDenial(gameId, userId, status);
                if (denied) return c.json({ error: denied }, 403);
            }

            const result = await setGamePlayerModeration(
                gameId,
                userId,
                status,
                admin.slug,
                note ?? "",
            );

            const removedXp = result.deltas.reduce((sum, d) => sum + d.xpDelta, 0);
            void logModerationAction(
                "🎮 Game moderation",
                [
                    { name: "Game", value: gameId },
                    { name: "Player", value: userId },
                    { name: "Status", value: result.status ?? "cleared" },
                    {
                        name: "XP",
                        value:
                            status === "botted"
                                ? `-${Math.round(removedXp * 100) / 100}`
                                : status === "clear"
                                  ? "restored"
                                  : "—",
                    },
                    { name: "By admin", value: adminTag(admin) },
                ],
                status === "botted" ? 0xaa1a1a : 0x3355ee,
            );

            return c.json({ ok: true, ...result });
        },
    )

    /**
     * Permanently deletes a game: revokes the XP (+ cosmetics + Golden Fries) every
     * account gained from it, then hard-deletes its match rows and moderation flags.
     * Removes the game from the leaderboard, stats and match history entirely.
     * Irreversible — the moderator reviews the full roster first (expandable row).
     */
    .post("/api/game/:gameId/delete", async (c) => {
        const admin = c.get("user")!;
        const gameId = c.req.param("gameId");

        const result = await deleteGame(gameId);

        void logModerationAction(
            "🗑️ Game deleted",
            [
                { name: "Game", value: gameId },
                { name: "Players affected", value: String(result.players) },
                { name: "XP removed", value: String(result.xpRemoved) },
                { name: "Rows deleted", value: String(result.rowsDeleted) },
                { name: "By admin", value: adminTag(admin) },
            ],
            0xaa1a1a,
        );

        return c.json({ ok: true, ...result });
    })

    /**
     * Removes ONE player from a game (without deleting the game): blanks their user_id
     * so the game vanishes from that account's stats AND the leaderboard, and revokes
     * the XP they gained from it. Reversible via /restore-user.
     */
    .post(
        "/api/game/:gameId/remove-user",
        validateParams(
            z.object({ userId: z.string().min(1), note: z.string().max(500).optional() }),
        ),
        async (c) => {
            const admin = c.get("user")!;
            const gameId = c.req.param("gameId");
            const { userId, note } = c.req.valid("json");

            const result = await removeUserFromGame(
                gameId,
                userId,
                admin.slug,
                note ?? "",
            );
            const removedXp = result.deltas.reduce((sum, d) => sum + d.xpDelta, 0);
            void logModerationAction(
                "➖ Player removed from game",
                [
                    { name: "Game", value: gameId },
                    { name: "Player", value: userId },
                    {
                        name: "XP removed",
                        value: String(Math.round(removedXp * 100) / 100),
                    },
                    { name: "By admin", value: adminTag(admin) },
                ],
                0xaa4400,
            );
            return c.json({ ok: true, ...result });
        },
    )

    /** Undoes /remove-user: re-attaches the player to the game and restores their XP. */
    .post(
        "/api/game/:gameId/restore-user",
        validateParams(z.object({ userId: z.string().min(1) })),
        async (c) => {
            const admin = c.get("user")!;
            const gameId = c.req.param("gameId");
            const { userId } = c.req.valid("json");

            const result = await restoreUserToGame(gameId, userId);
            void logModerationAction(
                "➕ Player restored to game",
                [
                    { name: "Game", value: gameId },
                    { name: "Player", value: userId },
                    { name: "By admin", value: adminTag(admin) },
                ],
                0x3355ee,
            );
            return c.json({ ok: true, ...result });
        },
    )

    /**
     * Competitive leaderboard for the moderation dashboard — mirrors the public stats
     * leaderboard (rank players by kills / wins / KPG / max damage, filtered by team
     * mode, map and time interval) but is admin-scoped: banned players are INCLUDED
     * (flagged) and voided (botted) games are excluded. Each ranked player links to
     * their games, where the full roster can be reviewed and botted games deleted.
     */
    .get("/api/leaderboard", async (c) => {
        const type = c.req.query("type") ?? "kills";
        const teamMode = Number(c.req.query("teamMode") ?? "1");
        const interval = c.req.query("interval") ?? "alltime";
        const mapIdParam = c.req.query("mapId");

        // Whitelisted stat expressions (same semantics as the public leaderboard).
        const valExpr =
            (
                {
                    kills: "SUM(match_data.kills)",
                    wins: "COUNT(CASE WHEN match_data.rank = 1 THEN 1 END)",
                    kpg: "ROUND(SUM(match_data.kills) * 1.0 / COUNT(DISTINCT match_data.game_id), 2)",
                    most_damage_dealt: "MAX(match_data.damage_dealt)",
                } as Record<string, string>
            )[type] ?? "SUM(match_data.kills)";

        const conds = [
            sql`${matchDataTable.userId} <> ''`,
            eq(matchDataTable.voided, false),
            eq(matchDataTable.teamMode, teamMode as TeamMode),
        ];
        if (mapIdParam) conds.push(eq(matchDataTable.mapId, Number(mapIdParam)));
        if (interval === "daily")
            conds.push(gte(matchDataTable.createdAt, sql`NOW() - INTERVAL '1 day'`));
        else if (interval === "weekly")
            conds.push(gte(matchDataTable.createdAt, sql`NOW() - INTERVAL '7 days'`));

        const rows = await db
            .select({
                userId: matchDataTable.userId,
                slug: usersTable.slug,
                username: usersTable.username,
                banned: usersTable.banned,
                games: sql<number>`count(distinct ${matchDataTable.gameId})`,
                val: sql.raw(`${valExpr} as val`) as SQL<number>,
                // Only "Max Damage" maps a row to one exact game: the game where the
                // player dealt that MAX damage. null for the aggregate types (no
                // array_agg cost, since NULL short-circuits).
                topGameId: (type === "most_damage_dealt"
                    ? sql`(array_agg(${matchDataTable.gameId} ORDER BY ${matchDataTable.damageDealt} DESC))[1]`
                    : sql`NULL`) as SQL<string | null>,
            })
            .from(matchDataTable)
            .leftJoin(usersTable, eq(usersTable.id, matchDataTable.userId))
            .where(and(...conds))
            .groupBy(
                matchDataTable.userId,
                usersTable.slug,
                usersTable.username,
                usersTable.banned,
            )
            .orderBy(sql`val DESC`)
            .limit(100);

        // Distinct maps in the data, for the filter dropdown.
        const mapRows = await db
            .selectDistinct({ mapId: matchDataTable.mapId })
            .from(matchDataTable)
            .where(sql`${matchDataTable.userId} <> ''`);
        const maps = mapRows
            .map((m) => ({
                mapId: m.mapId,
                name: MAP_ID_TO_NAME[m.mapId] ?? String(m.mapId),
            }))
            .sort((a, b) => a.mapId - b.mapId);

        return c.json({
            type,
            teamMode,
            interval,
            mapId: mapIdParam ?? "",
            maps,
            players: rows.map((r) => ({
                userId: r.userId ?? "",
                slug: r.slug ?? null,
                username: r.username || null,
                banned: r.banned ?? false,
                games: Number(r.games),
                val: Number(r.val),
                // The exact game behind a "Max Damage" row, for the "Open game" action.
                topGameId: r.topGameId ?? null,
            })),
        });
    })

    /**
     * Warnings tab — surfaces suspicious behaviour in a recent window:
     *   1. sharedIpGames    — one IP joined the same game 2+ times (players OR
     *      spectators; ip_logs records both), i.e. multi-boxing / alt-farming / ghosting.
     *   2. sharedIpAccounts — one IP used by many distinct accounts (alt farm).
     *   3. xpSpikes         — accounts with abnormally high game volume or XP/game
     *      (grinding/botting or feeding). XP is recomputed via computeMatchXp.
     * All heuristics are windowed + capped; this is admin-triggered, off the hot path.
     */
    .get("/api/warnings", async (c) => {
        const windowParam = c.req.query("window") ?? "24h";
        const cutoff = new Date(Date.now() - windowToMs(windowParam));

        // Distinct real-account count for an ip_logs group (ignores guests/spectators
        // whose user_id is empty/null).
        const distinctAccounts = sql<number>`count(distinct ${ipLogsTable.userId}) filter (where ${ipLogsTable.userId} is not null and ${ipLogsTable.userId} <> '')`;

        const [sharedIpGames, sharedIpAccounts, xpStats] = await Promise.all([
            // 1) Same IP appearing more than once in a single game.
            db
                .select({
                    gameId: ipLogsTable.gameId,
                    ip: ipLogsTable.encodedIp,
                    region: sql<string>`max(${ipLogsTable.region})`,
                    joins: sql<number>`count(*)::int`,
                    accounts: sql<number>`${distinctAccounts}::int`,
                    names: sql<string[]>`array_agg(distinct ${ipLogsTable.username})`,
                    lastSeen: sql<Date>`max(${ipLogsTable.createdAt})`,
                })
                .from(ipLogsTable)
                .where(
                    and(
                        gte(ipLogsTable.createdAt, cutoff),
                        sql`${ipLogsTable.encodedIp} <> ''`,
                    ),
                )
                .groupBy(ipLogsTable.gameId, ipLogsTable.encodedIp)
                .having(sql`count(*) >= ${WARN_MIN_JOINS_PER_GAME}`)
                .orderBy(desc(sql`count(*)`))
                .limit(100),

            // 2) Same IP used by many distinct accounts within the window.
            db
                .select({
                    ip: ipLogsTable.encodedIp,
                    isp: sql<string>`max(${ipLogsTable.isp})`,
                    accounts: sql<number>`${distinctAccounts}::int`,
                    joins: sql<number>`count(*)::int`,
                    names: sql<string[]>`array_agg(distinct ${ipLogsTable.username})`,
                    lastSeen: sql<Date>`max(${ipLogsTable.createdAt})`,
                })
                .from(ipLogsTable)
                .where(
                    and(
                        gte(ipLogsTable.createdAt, cutoff),
                        sql`${ipLogsTable.encodedIp} <> ''`,
                    ),
                )
                .groupBy(ipLogsTable.encodedIp)
                .having(sql`${distinctAccounts} >= ${WARN_MIN_ACCOUNTS_PER_IP}`)
                .orderBy(desc(distinctAccounts))
                .limit(100),

            // 3) Per-user + per-game rows for XP-spike detection (one row per game).
            db
                .select({
                    userId: matchDataTable.userId,
                    gameId: matchDataTable.gameId,
                    kills: sql<number>`max(${matchDataTable.kills})`,
                    damage: sql<number>`max(${matchDataTable.damageDealt})`,
                    timeAlive: sql<number>`max(${matchDataTable.timeAlive})`,
                    rank: sql<number>`min(${matchDataTable.rank})`,
                    mapId: sql<number>`max(${matchDataTable.mapId})`,
                })
                .from(matchDataTable)
                .where(
                    and(
                        gte(matchDataTable.createdAt, cutoff),
                        sql`${matchDataTable.userId} <> ''`,
                    ),
                )
                .groupBy(matchDataTable.userId, matchDataTable.gameId)
                .having(sql`count(*) = 1`),
        ]);

        // Aggregate XP per user, then flag high volume and/or high XP/game (farming).
        const perUser = new Map<string, { xp: number; games: number }>();
        for (const s of xpStats) {
            const xp = computeMatchXp({
                kills: Number(s.kills),
                damage: Number(s.damage),
                timeAlive: Number(s.timeAlive),
                rank: Number(s.rank),
                mapId: Number(s.mapId),
            });
            const uid = s.userId ?? "";
            let u = perUser.get(uid);
            if (!u) {
                u = { xp: 0, games: 0 };
                perUser.set(uid, u);
            }
            u.xp += xp;
            u.games += 1;
        }

        // Mean XP/game across established players → relative "farming" threshold.
        let sumPerGame = 0;
        let nPerGame = 0;
        for (const u of perUser.values()) {
            if (u.games >= 5) {
                sumPerGame += u.xp / u.games;
                nPerGame++;
            }
        }
        const meanPerGame = nPerGame ? sumPerGame / nPerGame : 0;
        const farmThreshold = Math.max(WARN_XP_PER_GAME_FLOOR, meanPerGame * 3);
        const minGames = WARN_MIN_GAMES[windowParam] ?? WARN_MIN_GAMES["7d"];

        const flagged: {
            userId: string;
            xpGained: number;
            games: number;
            xpPerGame: number;
            reasons: string[];
        }[] = [];
        for (const [userId, u] of perUser) {
            const xpPerGame = u.games ? u.xp / u.games : 0;
            const reasons: string[] = [];
            if (u.games >= minGames) reasons.push(`${u.games} games`);
            if (u.games >= 5 && xpPerGame >= farmThreshold)
                reasons.push(`high XP/game (${Math.round(xpPerGame)})`);
            if (reasons.length) {
                flagged.push({
                    userId,
                    xpGained: Math.round(u.xp * 100) / 100,
                    games: u.games,
                    xpPerGame: Math.round(xpPerGame * 100) / 100,
                    reasons,
                });
            }
        }
        flagged.sort((a, b) => b.xpGained - a.xpGained);
        const xpSpikes = flagged.slice(0, 100);

        // Resolve slug / username / ban state for the flagged accounts.
        const userIds = xpSpikes.map((s) => s.userId);
        const users = userIds.length
            ? await db
                  .select({
                      id: usersTable.id,
                      slug: usersTable.slug,
                      username: usersTable.username,
                      banned: usersTable.banned,
                  })
                  .from(usersTable)
                  .where(inArray(usersTable.id, userIds))
            : [];
        const userById = new Map(users.map((u) => [u.id, u]));

        return c.json({
            window: windowParam,
            sharedIpGames: sharedIpGames.map((r) => ({
                gameId: r.gameId,
                ip: r.ip,
                region: r.region,
                joins: Number(r.joins),
                accounts: Number(r.accounts),
                names: r.names ?? [],
                lastSeen: r.lastSeen,
            })),
            sharedIpAccounts: sharedIpAccounts.map((r) => ({
                ip: r.ip,
                isp: r.isp,
                accounts: Number(r.accounts),
                joins: Number(r.joins),
                names: r.names ?? [],
                lastSeen: r.lastSeen,
            })),
            xpSpikes: xpSpikes.map((s) => {
                const u = userById.get(s.userId);
                return {
                    userId: s.userId,
                    slug: u?.slug ?? null,
                    username: u?.username || null,
                    banned: u?.banned ?? false,
                    xpGained: s.xpGained,
                    games: s.games,
                    xpPerGame: s.xpPerGame,
                    reasons: s.reasons,
                };
            }),
        });
    })

    /**
     * Returns the live player list for a specific running game.
     * Calls the game server via HTTP, which uses IPC to query the game process.
     */
    .get("/api/game/:region/:id/players", async (c) => {
        const regionId = c.req.param("region");
        const gameId = c.req.param("id");
        const players = await withStaffFlags(
            await server.getDashboardGamePlayers(regionId, gameId),
        );
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
                moderator: usersTable.moderator,
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

    /**
     * Grants or revokes the limited "moderator" staff role (replays-only access to this
     * dashboard). Admin-only — this route isn't in MODERATOR_ALLOWED_PATHS, so a
     * moderator can't self-promote. Admins can't be demoted to moderator here.
     */
    .post(
        "/api/account/moderator",
        validateParams(z.object({ slug: z.string().min(1), moderator: z.boolean() })),
        async (c) => {
            const admin = c.get("user")!;
            const { slug, moderator } = c.req.valid("json");

            const target = await db.query.usersTable.findFirst({
                where: eq(usersTable.slug, slug),
                columns: { id: true, admin: true },
            });
            if (!target) return c.json({ error: "account_not_found" }, 404);
            if (target.admin) return c.json({ error: "target_is_admin" }, 400);

            await db
                .update(usersTable)
                .set({ moderator })
                .where(eq(usersTable.id, target.id));

            void logModerationAction(
                moderator ? "🛡 Moderator added" : "🛡 Moderator removed",
                [
                    { name: "Account", value: slug },
                    { name: "By admin", value: adminTag(admin) },
                ],
                0x8888ff,
            );
            return c.json({ ok: true, moderator });
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
                moderator: true,
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

    /**
     * Golden Fries (GP) ledger for one account, for the account-detail "GP History".
     * `?filter=earned` (amount > 0) or `?filter=spent` (amount < 0); default all.
     * Totals are always over the full history so the summary is stable across filters.
     */
    .get("/api/account/:slug/gp", async (c) => {
        const slug = c.req.param("slug");
        const filter = c.req.query("filter") ?? "all";

        const user = await db.query.usersTable.findFirst({
            where: eq(usersTable.slug, slug),
            columns: { id: true, slug: true, goldenFries: true },
        });
        if (!user) return c.json({ error: "not found" }, 404);

        const amountCond =
            filter === "earned"
                ? sql`${goldenFriesLedgerTable.amount} > 0`
                : filter === "spent"
                  ? sql`${goldenFriesLedgerTable.amount} < 0`
                  : undefined;

        const [totals, entries] = await Promise.all([
            db
                .select({
                    earned: sql<number>`coalesce(sum(${goldenFriesLedgerTable.amount}) filter (where ${goldenFriesLedgerTable.amount} > 0), 0)::int`,
                    spent: sql<number>`coalesce(-sum(${goldenFriesLedgerTable.amount}) filter (where ${goldenFriesLedgerTable.amount} < 0), 0)::int`,
                    count: sql<number>`count(*)::int`,
                })
                .from(goldenFriesLedgerTable)
                .where(eq(goldenFriesLedgerTable.userId, user.id)),
            db
                .select({
                    id: goldenFriesLedgerTable.id,
                    amount: goldenFriesLedgerTable.amount,
                    reason: goldenFriesLedgerTable.reason,
                    balanceAfter: goldenFriesLedgerTable.balanceAfter,
                    createdAt: goldenFriesLedgerTable.createdAt,
                })
                .from(goldenFriesLedgerTable)
                .where(and(eq(goldenFriesLedgerTable.userId, user.id), amountCond))
                .orderBy(desc(goldenFriesLedgerTable.createdAt))
                .limit(500),
        ]);

        // For marketplace rows (reason "market:buy:<id>" / "market:sell:<id>") resolve
        // the trade counterparty + item, so the history shows who the fries went to/from.
        const marketIds: number[] = [];
        for (const e of entries) {
            const m = /^market:(?:buy|sell):(\d+)$/.exec(e.reason);
            if (m) marketIds.push(Number(m[1]));
        }
        const marketById = new Map<
            number,
            {
                type: string;
                sellerSlug: string | null;
                sellerName: string | null;
                buyerSlug: string | null;
                buyerName: string | null;
            }
        >();
        if (marketIds.length) {
            const listings = await db
                .select({
                    id: marketListingsTable.id,
                    type: marketListingsTable.type,
                    sellerId: marketListingsTable.sellerId,
                    sellerSlug: marketListingsTable.sellerSlug,
                    buyerId: marketListingsTable.buyerId,
                })
                .from(marketListingsTable)
                .where(inArray(marketListingsTable.id, marketIds));

            const partyIds = new Set<string>();
            for (const l of listings) {
                if (l.sellerId) partyIds.add(l.sellerId);
                if (l.buyerId) partyIds.add(l.buyerId);
            }
            const partyRows = partyIds.size
                ? await db
                      .select({
                          id: usersTable.id,
                          slug: usersTable.slug,
                          username: usersTable.username,
                      })
                      .from(usersTable)
                      .where(inArray(usersTable.id, [...partyIds]))
                : [];
            const partyById = new Map(partyRows.map((p) => [p.id, p]));
            for (const l of listings) {
                const seller = l.sellerId ? partyById.get(l.sellerId) : undefined;
                const buyer = l.buyerId ? partyById.get(l.buyerId) : undefined;
                marketById.set(l.id, {
                    type: l.type,
                    sellerSlug: seller?.slug ?? l.sellerSlug ?? null,
                    sellerName: seller?.username || seller?.slug || l.sellerSlug || null,
                    buyerSlug: buyer?.slug ?? null,
                    buyerName: buyer?.username || buyer?.slug || null,
                });
            }
        }

        // For auction rows (reason "auction:bid|refund|sell:<id>") resolve the item + the
        // seller/winner so the history reads meaningfully instead of a raw reason string.
        const auctionIds: number[] = [];
        for (const e of entries) {
            const a = /^auction:(?:bid|refund|sell):(\d+)$/.exec(e.reason);
            if (a) auctionIds.push(Number(a[1]));
        }
        const auctionInfoById = new Map<
            number,
            {
                type: string;
                sellerSlug: string | null;
                sellerName: string | null;
                winnerSlug: string | null;
                winnerName: string | null;
            }
        >();
        if (auctionIds.length) {
            const rows = await db
                .select({
                    id: auctionsTable.id,
                    type: auctionsTable.type,
                    sellerId: auctionsTable.sellerId,
                    sellerSlug: auctionsTable.sellerSlug,
                    winnerId: auctionsTable.currentBidderId,
                    winnerSlug: auctionsTable.currentBidderSlug,
                })
                .from(auctionsTable)
                .where(inArray(auctionsTable.id, auctionIds));
            const partyIds = new Set<string>();
            for (const r of rows) {
                if (r.sellerId) partyIds.add(r.sellerId);
                if (r.winnerId) partyIds.add(r.winnerId);
            }
            const partyRows = partyIds.size
                ? await db
                      .select({
                          id: usersTable.id,
                          slug: usersTable.slug,
                          username: usersTable.username,
                      })
                      .from(usersTable)
                      .where(inArray(usersTable.id, [...partyIds]))
                : [];
            const partyById = new Map(partyRows.map((p) => [p.id, p]));
            for (const r of rows) {
                const seller = r.sellerId ? partyById.get(r.sellerId) : undefined;
                const winner = r.winnerId ? partyById.get(r.winnerId) : undefined;
                auctionInfoById.set(r.id, {
                    type: r.type,
                    sellerSlug: seller?.slug ?? r.sellerSlug ?? null,
                    sellerName: seller?.username || seller?.slug || r.sellerSlug || null,
                    winnerSlug: winner?.slug ?? r.winnerSlug ?? null,
                    winnerName: winner?.username || winner?.slug || r.winnerSlug || null,
                });
            }
        }

        // For buy-offer rows (reason "offer:buy|sell:<id>") resolve the item + counterparty.
        const offerIds: number[] = [];
        for (const e of entries) {
            const o = /^offer:(?:buy|sell):(\d+)$/.exec(e.reason);
            if (o) offerIds.push(Number(o[1]));
        }
        const offerInfoById = new Map<
            number,
            {
                type: string;
                buyerSlug: string | null;
                buyerName: string | null;
                sellerSlug: string | null;
                sellerName: string | null;
            }
        >();
        if (offerIds.length) {
            const rows = await db
                .select({
                    id: offersTable.id,
                    type: offersTable.type,
                    fromId: offersTable.fromUserId,
                    fromSlug: offersTable.fromSlug,
                    toId: offersTable.toUserId,
                    toSlug: offersTable.toSlug,
                })
                .from(offersTable)
                .where(inArray(offersTable.id, offerIds));
            const partyIds = new Set<string>();
            for (const r of rows) {
                partyIds.add(r.fromId);
                partyIds.add(r.toId);
            }
            const partyRows = partyIds.size
                ? await db
                      .select({
                          id: usersTable.id,
                          slug: usersTable.slug,
                          username: usersTable.username,
                      })
                      .from(usersTable)
                      .where(inArray(usersTable.id, [...partyIds]))
                : [];
            const partyById = new Map(partyRows.map((p) => [p.id, p]));
            for (const r of rows) {
                const buyer = partyById.get(r.fromId);
                const seller = partyById.get(r.toId);
                offerInfoById.set(r.id, {
                    type: r.type,
                    buyerSlug: buyer?.slug ?? r.fromSlug ?? null,
                    buyerName: buyer?.username || buyer?.slug || r.fromSlug || null,
                    sellerSlug: seller?.slug ?? r.toSlug ?? null,
                    sellerName: seller?.username || seller?.slug || r.toSlug || null,
                });
            }
        }

        // For Golden Fries gift rows the counterparty slug is baked into the reason
        // ("gift:send:<recipient>" / "gift:recv:<sender>"); resolve their display name.
        const giftSlugs = new Set<string>();
        for (const e of entries) {
            const g = /^gift:(?:send|recv):(.+)$/.exec(e.reason);
            if (g) giftSlugs.add(g[1].trim().toLowerCase());
        }
        const giftNameBySlug = new Map<string, string>();
        if (giftSlugs.size) {
            const rows = await db
                .select({ slug: usersTable.slug, username: usersTable.username })
                .from(usersTable)
                .where(inArray(usersTable.slug, [...giftSlugs]));
            for (const r of rows) giftNameBySlug.set(r.slug, r.username || r.slug);
        }

        // Which entries have already been reverted? A compensating `revert:<id>` row
        // exists in this user's ledger for each reverted entry.
        const revertRows = await db
            .select({ reason: goldenFriesLedgerTable.reason })
            .from(goldenFriesLedgerTable)
            .where(
                and(
                    eq(goldenFriesLedgerTable.userId, user.id),
                    sql`${goldenFriesLedgerTable.reason} LIKE 'revert:%'`,
                ),
            );
        const revertedIds = new Set<number>();
        for (const r of revertRows) {
            const n = Number(r.reason.slice("revert:".length));
            if (Number.isInteger(n)) revertedIds.add(n);
        }
        const isRevertableReason = (reason: string) =>
            reason.startsWith("pass:") ||
            reason.startsWith("shop:") ||
            reason.startsWith("admin_grant") ||
            /^market:(buy|sell):\d+$/.test(reason) ||
            // Only the sale row reverts an auction (it undoes the winning bid + item too).
            /^auction:sell:\d+$/.test(reason) ||
            /^offer:(buy|sell):\d+$/.test(reason) ||
            /^gift:(send|recv):/.test(reason);

        const entriesOut = entries.map((e) => {
            const reverted = revertedIds.has(e.id);
            const revertable = !reverted && isRevertableReason(e.reason);

            // Auction rows (bid / refund / sale): show the item + seller/winner.
            const au = /^auction:(bid|refund|sell):(\d+)$/.exec(e.reason);
            const auInfo = au ? auctionInfoById.get(Number(au[2])) : undefined;
            const auction = au
                ? {
                      kind: au[1] as "bid" | "refund" | "sell",
                      item: auInfo?.type ?? null,
                      sellerSlug: auInfo?.sellerSlug ?? null,
                      sellerName: auInfo?.sellerName ?? null,
                      winnerSlug: auInfo?.winnerSlug ?? null,
                      winnerName: auInfo?.winnerName ?? null,
                  }
                : null;

            // Buy-offer rows (buy = fries went to the seller; sell = came from the buyer).
            const of = /^offer:(buy|sell):(\d+)$/.exec(e.reason);
            const ofInfo = of ? offerInfoById.get(Number(of[2])) : undefined;
            const offer = of
                ? {
                      direction: of[1] as "buy" | "sell",
                      item: ofInfo?.type ?? null,
                      counterpartySlug:
                          of[1] === "buy"
                              ? (ofInfo?.sellerSlug ?? null)
                              : (ofInfo?.buyerSlug ?? null),
                      counterpartyName:
                          of[1] === "buy"
                              ? (ofInfo?.sellerName ?? null)
                              : (ofInfo?.buyerName ?? null),
                  }
                : null;

            // Golden Fries gift rows: counterparty slug is in the reason.
            const g = /^gift:(send|recv):(.+)$/.exec(e.reason);
            const gift = g
                ? {
                      direction: g[1] as "send" | "recv",
                      counterpartySlug: g[2],
                      counterpartyName:
                          giftNameBySlug.get(g[2].trim().toLowerCase()) ?? g[2],
                  }
                : null;

            const m = /^market:(buy|sell):(\d+)$/.exec(e.reason);
            const info = m ? marketById.get(Number(m[2])) : undefined;
            if (!m || !info)
                return {
                    ...e,
                    market: null,
                    auction,
                    offer,
                    gift,
                    reverted,
                    revertable,
                };
            const direction = m[1] as "buy" | "sell";
            return {
                ...e,
                reverted,
                revertable,
                auction,
                offer,
                gift,
                market: {
                    direction,
                    item: info.type,
                    // Buyer's row → counterparty is the seller (fries went to them);
                    // seller's row → counterparty is the buyer (fries came from them).
                    counterpartySlug:
                        direction === "buy" ? info.sellerSlug : info.buyerSlug,
                    counterpartyName:
                        direction === "buy" ? info.sellerName : info.buyerName,
                },
            };
        });

        const t = totals[0] ?? { earned: 0, spent: 0, count: 0 };
        return c.json({
            slug: user.slug,
            userId: user.id,
            balance: user.goldenFries ?? 0,
            totalEarned: Number(t.earned),
            totalSpent: Number(t.spent),
            count: Number(t.count),
            filter,
            entries: entriesOut,
        });
    })

    /**
     * Reverts a single Golden Fries ledger entry (pass reward, shop buy, or market
     * trade). Type-specific rollback lives in {@link revertLedgerEntry}; blocked with a
     * clear code (e.g. `item_gone`, `already_reverted`) when it can't be done cleanly.
     */
    .post("/api/account/gp/:id/revert", async (c) => {
        const admin = c.get("user")!;
        const id = Number(c.req.param("id"));
        if (!Number.isInteger(id)) return c.json({ error: "bad_id" }, 400);
        try {
            const res = await revertLedgerEntry(id, admin.slug);
            void logModerationAction("↩️ Fries revert", [
                { name: "Ledger #", value: String(id) },
                { name: "Type", value: res.type },
                { name: "Detail", value: res.detail },
                { name: "By admin", value: adminTag(admin) },
            ]);
            return c.json({ ok: true, ...res });
        } catch (e) {
            const code = e instanceof RevertError ? e.code : "error";
            return c.json({ error: code }, 400);
        }
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

            // One shared cascade: sets xp + derived level, anchors the reconcile so
            // the value sticks, and lines up owned cosmetics AND Golden Fries.
            const { level, granted, revoked, friesGranted, friesRevoked } =
                await setPassXp(user.id, passType, xp);

            void logModerationAction(
                "⭐ XP set",
                [
                    { name: "Account", value: slug },
                    { name: "Pass", value: passType },
                    { name: "Level / XP", value: `${level} / ${xp}` },
                    { name: "Items +/-", value: `+${granted} / -${revoked}` },
                    { name: "Fries +/-", value: `+${friesGranted} / -${friesRevoked}` },
                    { name: "By admin", value: adminTag(admin) },
                ],
                0x3355ee,
            );

            return c.json({
                ok: true,
                level,
                granted,
                revoked,
                friesGranted,
                friesRevoked,
            });
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
