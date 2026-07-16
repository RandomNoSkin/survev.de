import { and, desc, eq, gte, ilike, inArray, ne, type SQL, sql } from "drizzle-orm";
import {
    getItemCategory,
    MARKET_LISTING_TTL_MS,
} from "../../../../shared/defs/shopConfig";
import type {
    GiftFriesResponse,
    GiftItemResponse,
    GiftNotification,
    ItemOwner,
    ItemOwnersResponse,
    UserSearchResult,
} from "../../../../shared/types/user";
import { isBlockedBetween } from "./blocks";
import { getGoldenFries } from "./goldenFries";
import { db } from "./index";
import { getOwnedLoadouts } from "./loadouts";
import {
    auctionsTable,
    giftNotificationsTable,
    goldenFriesLedgerTable,
    itemsTable,
    marketListingsTable,
    usersTable,
} from "./schema";

const OWNERS_PAGE_SIZE = 50;

class GiftError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

/** Escapes LIKE wildcards so user search text is matched literally. */
function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Gifts an owned item instance to another player for free (instant transfer, no market
 * listing). Mirrors the transfer core of {@link buyListing}: the item row's `user_id`
 * moves to the recipient and the sender's slug is appended to the ownership history.
 * Guards: the sender must own the instance, it must be a giftable cosmetic and not
 * currently (actively, un-expired) listed, and the recipient must exist and not be the
 * sender. No loadout mutation is needed — `getOwnedLoadouts` self-heals the sender's
 * equipped loadout at their next game join.
 */
export async function giftItem(
    senderId: string,
    senderSlug: string,
    senderName: string,
    itemId: number,
    recipientSlug: string,
): Promise<GiftItemResponse> {
    try {
        await db.transaction(async (tx) => {
            // Resolve the recipient (must exist, not self).
            const normalized = recipientSlug.trim().toLowerCase();
            const [recipient] = await tx
                .select({ id: usersTable.id })
                .from(usersTable)
                .where(eq(usersTable.slug, normalized));
            if (!recipient) throw new GiftError("recipient_not_found");
            if (recipient.id === senderId) throw new GiftError("self_gift");
            // A block in either direction stops gifts.
            if (await isBlockedBetween(senderId, recipient.id)) {
                throw new GiftError("blocked");
            }

            // Sender must own the instance; it must be a giftable cosmetic.
            const [item] = await tx
                .select({
                    type: itemsTable.type,
                    userId: itemsTable.userId,
                    previousOwners: itemsTable.previousOwners,
                })
                .from(itemsTable)
                .where(eq(itemsTable.id, itemId));
            if (!item || item.userId !== senderId) throw new GiftError("not_owned");
            if (!getItemCategory(item.type)) throw new GiftError("not_giftable");

            // Can't gift an item that's actively listed on the market (expired-but-unswept
            // listings don't count — those are already auto-taken-back).
            const expiryCutoff = new Date(Date.now() - MARKET_LISTING_TTL_MS);
            const [listing] = await tx
                .select({ id: marketListingsTable.id })
                .from(marketListingsTable)
                .where(
                    and(
                        eq(marketListingsTable.itemId, itemId),
                        eq(marketListingsTable.status, "active"),
                        gte(marketListingsTable.createdAt, expiryCutoff),
                    ),
                );
            if (listing) throw new GiftError("listed");

            // Can't gift an item that's currently up for auction.
            const [auction] = await tx
                .select({ id: auctionsTable.id })
                .from(auctionsTable)
                .where(
                    and(
                        eq(auctionsTable.itemId, itemId),
                        eq(auctionsTable.status, "active"),
                    ),
                );
            if (auction) throw new GiftError("auctioned");

            const newOwners = [...(item.previousOwners ?? []), senderSlug];
            const [moved] = await tx
                .update(itemsTable)
                .set({
                    userId: recipient.id,
                    // Keep the item's original source (provenance); the gift is recorded
                    // via previousOwners, not by rewriting where it first came from.
                    status: 0,
                    timeAcquired: Date.now(),
                    previousOwners: newOwners,
                    // Received for free.
                    pricePaid: 0,
                })
                .where(and(eq(itemsTable.id, itemId), eq(itemsTable.userId, senderId)))
                .returning({ id: itemsTable.id });
            if (!moved) throw new GiftError("error");

            // Notify the recipient (shown as a popup on their next profile load).
            await tx.insert(giftNotificationsTable).values({
                recipientId: recipient.id,
                fromSlug: senderSlug,
                fromName: senderName,
                kind: "item",
                itemType: item.type,
            });
        });
        // Best-effort: if the sender no longer owns a copy of the gifted type, strip it
        // from their equipped loadout right away (the immediate equivalent of the
        // self-heal that otherwise only happens at their next game join).
        await getOwnedLoadouts([senderId]).catch(() => {});
        return { success: true };
    } catch (err) {
        const error = err instanceof GiftError ? err.code : "error";
        return { success: false, error };
    }
}

/**
 * Gifts Golden Fries from one player to another (no fee, nothing burned). Atomic: the
 * sender is debited behind a `gte` balance guard, the recipient credited the full amount,
 * and both ledger rows are written in one transaction. Reasons use a `gift:` prefix (NOT
 * `pass:%`) so the pass idempotency index never applies.
 */
export async function giftGoldenFries(
    senderId: string,
    senderSlug: string,
    senderName: string,
    recipientSlug: string,
    amount: number,
): Promise<GiftFriesResponse> {
    if (!Number.isInteger(amount) || amount <= 0) {
        return {
            success: false,
            error: "error",
            balance: await getGoldenFries(senderId),
        };
    }
    try {
        const balance = await db.transaction(async (tx) => {
            const normalized = recipientSlug.trim().toLowerCase();
            const [recipient] = await tx
                .select({ id: usersTable.id })
                .from(usersTable)
                .where(eq(usersTable.slug, normalized));
            if (!recipient) throw new GiftError("recipient_not_found");
            if (recipient.id === senderId) throw new GiftError("self_gift");
            // A block in either direction stops gifts.
            if (await isBlockedBetween(senderId, recipient.id)) {
                throw new GiftError("blocked");
            }

            // Debit the sender (atomic balance guard).
            const [senderBal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} - ${amount}` })
                .where(
                    and(eq(usersTable.id, senderId), gte(usersTable.goldenFries, amount)),
                )
                .returning({ balance: usersTable.goldenFries });
            if (!senderBal) throw new GiftError("insufficient_funds");

            // Credit the recipient the full amount (no fee/burn).
            const [recipientBal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} + ${amount}` })
                .where(eq(usersTable.id, recipient.id))
                .returning({ balance: usersTable.goldenFries });

            await tx.insert(goldenFriesLedgerTable).values([
                {
                    userId: senderId,
                    amount: -amount,
                    reason: `gift:send:${recipientSlug}`,
                    balanceAfter: senderBal.balance,
                },
                {
                    userId: recipient.id,
                    amount,
                    reason: `gift:recv:${senderSlug}`,
                    balanceAfter: recipientBal?.balance ?? 0,
                },
            ]);

            // Notify the recipient (shown as a popup on their next profile load).
            await tx.insert(giftNotificationsTable).values({
                recipientId: recipient.id,
                fromSlug: senderSlug,
                fromName: senderName,
                kind: "fries",
                amount,
            });
            return senderBal.balance;
        });
        return { success: true, balance };
    } catch (err) {
        const error = err instanceof GiftError ? err.code : "error";
        return { success: false, error, balance: await getGoldenFries(senderId) };
    }
}

/** Searches users by username for the gift-recipient picker (excludes self and banned). */
export async function searchUsers(
    selfId: string,
    query: string,
    limit = 15,
): Promise<UserSearchResult[]> {
    const q = `%${escapeLike(query.trim())}%`;
    const rows = await db
        .select({ slug: usersTable.slug, username: usersTable.username })
        .from(usersTable)
        .where(
            and(
                ilike(usersTable.username, q),
                ne(usersTable.id, selfId),
                eq(usersTable.banned, false),
            ),
        )
        .orderBy(usersTable.username)
        .limit(Math.min(Math.max(limit, 1), 25));
    return rows.map((r) => ({ slug: r.slug, username: r.username }));
}

/**
 * Public "who owns this item" view: the distinct non-admin owners of a cosmetic `type`,
 * with how many copies each owns, most-copies first. Paginated (popular cosmetics have
 * many owners) and optionally filtered by username.
 */
export async function getItemOwners(
    type: string,
    page = 0,
    search?: string,
): Promise<ItemOwnersResponse> {
    const p = Math.max(0, page);
    const conds: SQL[] = [eq(itemsTable.type, type), eq(usersTable.admin, false)];
    const s = search?.trim();
    if (s) conds.push(ilike(usersTable.username, `%${escapeLike(s)}%`));

    const rows = await db
        .select({
            slug: usersTable.slug,
            username: usersTable.username,
            copies: sql<number>`count(*)::int`,
        })
        .from(itemsTable)
        .innerJoin(usersTable, eq(usersTable.id, itemsTable.userId))
        .where(and(...conds))
        .groupBy(usersTable.id, usersTable.slug, usersTable.username)
        .orderBy(desc(sql`count(*)`), usersTable.username)
        .limit(OWNERS_PAGE_SIZE + 1)
        .offset(p * OWNERS_PAGE_SIZE);

    const hasMore = rows.length > OWNERS_PAGE_SIZE;
    const owners: ItemOwner[] = rows.slice(0, OWNERS_PAGE_SIZE).map((r) => ({
        slug: r.slug,
        username: r.username,
        copies: r.copies,
    }));

    const [totals] = await db
        .select({ total: sql<number>`count(distinct ${itemsTable.userId})::int` })
        .from(itemsTable)
        .innerJoin(usersTable, eq(usersTable.id, itemsTable.userId))
        .where(and(...conds));

    return { success: true, type, owners, total: totals?.total ?? 0, page: p, hasMore };
}

/** Unacknowledged gifts a player has received — drives the "you got a gift" popup. */
export async function getGiftNotifications(userId: string): Promise<GiftNotification[]> {
    const rows = await db
        .select({
            id: giftNotificationsTable.id,
            fromSlug: giftNotificationsTable.fromSlug,
            fromName: giftNotificationsTable.fromName,
            kind: giftNotificationsTable.kind,
            amount: giftNotificationsTable.amount,
            itemType: giftNotificationsTable.itemType,
        })
        .from(giftNotificationsTable)
        .where(
            and(
                eq(giftNotificationsTable.recipientId, userId),
                eq(giftNotificationsTable.acked, false),
            ),
        )
        .orderBy(desc(giftNotificationsTable.createdAt))
        .limit(50);
    return rows.map((r) => ({
        id: r.id,
        fromName: r.fromName || r.fromSlug,
        kind: r.kind === "item" ? "item" : "fries",
        amount: r.amount,
        itemType: r.itemType,
    }));
}

/** Marks the given received gifts as acknowledged so the popup won't fire again. */
export async function ackGiftNotifications(userId: string, ids: number[]): Promise<void> {
    if (!ids.length) return;
    await db
        .update(giftNotificationsTable)
        .set({ acked: true })
        .where(
            and(
                eq(giftNotificationsTable.recipientId, userId),
                inArray(giftNotificationsTable.id, ids),
            ),
        );
}
