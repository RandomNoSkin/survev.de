import { and, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { Config } from "../../config";
import { server } from "../apiServer";
import { broadcastBans } from "../routes/ModerationDashboardRouter";
import { db } from "./index";
import {
    banHistoryTable,
    bannedIpsTable,
    chatBannedIpsTable,
    usersTable,
} from "./schema";

/** Actor recorded in `ban_history` when a ban is lifted automatically on expiry. */
const AUTO_ACTOR = "auto-expiry";

/**
 * Closes every still-open `ban_history` row for the given targets (sets the unban
 * time + actor to the auto-expiry sweep). Targets with no open history row — e.g.
 * accounts banned as a side effect of an IP ban, which only logged an "ip" entry —
 * are simply a no-op. Mirrors {@link recordUnban} in ModerationDashboardRouter.
 */
async function recordAutoUnban(
    banType: "ip" | "account" | "chat",
    targets: string[],
): Promise<void> {
    if (!targets.length) return;
    await db
        .update(banHistoryTable)
        .set({ unbannedAt: new Date(), unbannedBy: AUTO_ACTOR })
        .where(
            and(
                eq(banHistoryTable.banType, banType),
                inArray(banHistoryTable.banTarget, targets),
                isNull(banHistoryTable.unbannedAt),
            ),
        );
}

/**
 * Lifts every ban whose time has run out and appends the matching `ban_history`
 * unban entries, so expired bans don't linger in the live tables (or the dashboard
 * ban list) until the target happens to be re-checked:
 *   - account bans → `banned` cleared on the user (permanent bans have a null
 *     `banExpiresAt` and are never touched);
 *   - IP + chat bans → the non-permanent, expired rows are deleted.
 *
 * Idempotent and safe to run on an interval. No-op when the database is disabled.
 */
export async function sweepExpiredBans(): Promise<{
    accounts: number;
    ips: number;
    chats: number;
}> {
    if (!Config.database.enabled) return { accounts: 0, ips: 0, chats: 0 };
    const now = new Date();

    // ── Account bans ──────────────────────────────────────────────────────────
    const expiredAccounts = await db
        .select({ slug: usersTable.slug })
        .from(usersTable)
        .where(
            and(
                eq(usersTable.banned, true),
                isNotNull(usersTable.banExpiresAt),
                lte(usersTable.banExpiresAt, now),
            ),
        );
    const accountSlugs = expiredAccounts.map((r) => r.slug);
    if (accountSlugs.length) {
        await db
            .update(usersTable)
            .set({ banned: false, banReason: "", bannedBy: "", banExpiresAt: null })
            .where(inArray(usersTable.slug, accountSlugs));
        await recordAutoUnban("account", accountSlugs);
    }

    // ── IP bans ───────────────────────────────────────────────────────────────
    const expiredIps = await db
        .select({ encodedIp: bannedIpsTable.encodedIp })
        .from(bannedIpsTable)
        .where(
            and(
                eq(bannedIpsTable.permanent, false),
                lte(bannedIpsTable.expiresIn, now),
            ),
        );
    const ipTargets = expiredIps.map((r) => r.encodedIp);
    if (ipTargets.length) {
        await db
            .delete(bannedIpsTable)
            .where(inArray(bannedIpsTable.encodedIp, ipTargets));
        await recordAutoUnban("ip", ipTargets);
    }

    // ── Chat bans ─────────────────────────────────────────────────────────────
    const expiredChats = await db
        .select({ encodedIp: chatBannedIpsTable.encodedIp })
        .from(chatBannedIpsTable)
        .where(
            and(
                eq(chatBannedIpsTable.permanent, false),
                lte(chatBannedIpsTable.expiresIn, now),
            ),
        );
    const chatTargets = expiredChats.map((r) => r.encodedIp);
    if (chatTargets.length) {
        await db
            .delete(chatBannedIpsTable)
            .where(inArray(chatBannedIpsTable.encodedIp, chatTargets));
        await recordAutoUnban("chat", chatTargets);
    }

    if (accountSlugs.length || ipTargets.length || chatTargets.length) {
        server.logger.info(
            `Auto-expired bans: ${accountSlugs.length} accounts, ${ipTargets.length} IPs, ${chatTargets.length} chats`,
        );
        // Refresh any open moderation dashboards so the lifted bans disappear live.
        await broadcastBans();
    }

    return {
        accounts: accountSlugs.length,
        ips: ipTargets.length,
        chats: chatTargets.length,
    };
}
