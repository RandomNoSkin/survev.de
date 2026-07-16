import { and, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import {
    getItemCategory,
    getMarketFee,
    OFFER_MAX_OUTSTANDING,
    OFFER_TTL_MS,
} from "../../../../shared/defs/shopConfig";
import type {
    MakeOfferResponse,
    Offer,
    OfferActionResponse,
    OfferListResponse,
} from "../../../../shared/types/user";
import { getGoldenFries } from "./goldenFries";
import { db } from "./index";
import {
    auctionsTable,
    blocksTable,
    goldenFriesLedgerTable,
    itemsTable,
    marketListingsTable,
    offersTable,
    usersTable,
} from "./schema";

class OfferError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

const ACTIVE = ["pending", "countered"] as const;

/**
 * Makes a buy-offer on another player's specific item instance. No fries move now — the
 * owner may accept (charged then), decline, or counter. Guards: the item must be an
 * existing tradeable cosmetic owned by someone else and not currently being auctioned; a
 * player can't stack duplicate offers on the same item or exceed the outstanding cap.
 */
export async function makeOffer(
    fromUserId: string,
    itemId: number,
    amount: number,
): Promise<MakeOfferResponse> {
    try {
        await db.transaction(async (tx) => {
            const [item] = await tx
                .select({ type: itemsTable.type, ownerId: itemsTable.userId })
                .from(itemsTable)
                .where(eq(itemsTable.id, itemId));
            if (!item) throw new OfferError("item_not_found");
            if (item.ownerId === fromUserId) throw new OfferError("self_offer");
            if (!getItemCategory(item.type)) throw new OfferError("item_not_found");

            // Respect the owner's "disable offers" account setting.
            const [owner] = await tx
                .select({ offersDisabled: usersTable.offersDisabled })
                .from(usersTable)
                .where(eq(usersTable.id, item.ownerId));
            if (owner?.offersDisabled) throw new OfferError("offers_disabled");

            // A block in either direction stops offers.
            const [block] = await tx
                .select({ userId: blocksTable.userId })
                .from(blocksTable)
                .where(
                    or(
                        and(
                            eq(blocksTable.userId, item.ownerId),
                            eq(blocksTable.blockedId, fromUserId),
                        ),
                        and(
                            eq(blocksTable.userId, fromUserId),
                            eq(blocksTable.blockedId, item.ownerId),
                        ),
                    ),
                )
                .limit(1);
            if (block) throw new OfferError("blocked");

            // Can't offer on an item that's currently in an active auction.
            const [auction] = await tx
                .select({ id: auctionsTable.id })
                .from(auctionsTable)
                .where(
                    and(
                        eq(auctionsTable.itemId, itemId),
                        eq(auctionsTable.status, "active"),
                    ),
                );
            if (auction) throw new OfferError("auctioned");

            // One active offer per (bidder, item).
            const [dupe] = await tx
                .select({ id: offersTable.id })
                .from(offersTable)
                .where(
                    and(
                        eq(offersTable.fromUserId, fromUserId),
                        eq(offersTable.itemId, itemId),
                        inArray(offersTable.status, [...ACTIVE]),
                    ),
                );
            if (dupe) throw new OfferError("duplicate");

            const outstanding = await tx
                .select({ id: offersTable.id })
                .from(offersTable)
                .where(
                    and(
                        eq(offersTable.fromUserId, fromUserId),
                        inArray(offersTable.status, [...ACTIVE]),
                    ),
                );
            if (outstanding.length >= OFFER_MAX_OUTSTANDING) {
                throw new OfferError("too_many");
            }

            const [from] = await tx
                .select({ slug: usersTable.slug })
                .from(usersTable)
                .where(eq(usersTable.id, fromUserId));
            const [to] = await tx
                .select({ slug: usersTable.slug })
                .from(usersTable)
                .where(eq(usersTable.id, item.ownerId));

            await tx.insert(offersTable).values({
                itemId,
                type: item.type,
                fromUserId,
                fromSlug: from?.slug ?? "",
                toUserId: item.ownerId,
                toSlug: to?.slug ?? "",
                amount,
            });
        });
        return { success: true };
    } catch (err) {
        const error = err instanceof OfferError ? err.code : "error";
        return { success: false, error };
    }
}

/**
 * Accepts an offer (charge-on-accept). A pending offer is accepted by the owner (at the
 * offered amount); a countered offer is accepted by the bidder (at the counter amount). In
 * both cases the bidder pays price+fee (fee burned), the owner receives the price, the item
 * transfers to the bidder, any active listing on it is cancelled, and other live offers on
 * the same item are expired. Atomic; the status guard is the single-winner lock.
 */
export async function acceptOffer(
    userId: string,
    offerId: number,
): Promise<OfferActionResponse> {
    try {
        const balance = await db.transaction(async (tx) => {
            const [offer] = await tx
                .select({
                    itemId: offersTable.itemId,
                    fromUserId: offersTable.fromUserId,
                    fromSlug: offersTable.fromSlug,
                    toUserId: offersTable.toUserId,
                    toSlug: offersTable.toSlug,
                    amount: offersTable.amount,
                    counterAmount: offersTable.counterAmount,
                    status: offersTable.status,
                })
                .from(offersTable)
                .where(eq(offersTable.id, offerId));
            if (!offer) throw new OfferError("not_found");

            // Whose turn it is to accept + the binding price.
            let price: number;
            if (offer.status === "pending") {
                if (offer.toUserId !== userId) throw new OfferError("not_found");
                price = offer.amount;
            } else if (offer.status === "countered") {
                if (offer.fromUserId !== userId) throw new OfferError("not_found");
                price = offer.counterAmount ?? offer.amount;
            } else {
                throw new OfferError("gone");
            }

            // If the item was put up for auction after the offer was made, the offer can't
            // be accepted — that would transfer the item out from under the live auction.
            const [auction] = await tx
                .select({ id: auctionsTable.id })
                .from(auctionsTable)
                .where(
                    and(
                        eq(auctionsTable.itemId, offer.itemId),
                        eq(auctionsTable.status, "active"),
                    ),
                );
            if (auction) throw new OfferError("auctioned");

            // Claim the offer (status → accepted); a concurrent accept/decline loses.
            const [claimed] = await tx
                .update(offersTable)
                .set({ status: "accepted", updatedAt: new Date() })
                .where(
                    and(
                        eq(offersTable.id, offerId),
                        eq(offersTable.status, offer.status),
                    ),
                )
                .returning({ id: offersTable.id });
            if (!claimed) throw new OfferError("gone");

            // The owner must still hold the item.
            const [itemRow] = await tx
                .select({ previousOwners: itemsTable.previousOwners })
                .from(itemsTable)
                .where(
                    and(
                        eq(itemsTable.id, offer.itemId),
                        eq(itemsTable.userId, offer.toUserId),
                    ),
                );
            if (!itemRow) throw new OfferError("gone");

            const total = price + getMarketFee(price);

            // Charge the bidder (atomic balance guard).
            const [fromBal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} - ${total}` })
                .where(
                    and(
                        eq(usersTable.id, offer.fromUserId),
                        gte(usersTable.goldenFries, total),
                    ),
                )
                .returning({ balance: usersTable.goldenFries });
            if (!fromBal) throw new OfferError("offerer_broke");

            // Pay the owner the price (fee burned).
            const [toBal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} + ${price}` })
                .where(eq(usersTable.id, offer.toUserId))
                .returning({ balance: usersTable.goldenFries });

            // Transfer the item to the bidder. The ownership read above is not a lock, so
            // a market sale or another accepted offer can still move the item out from
            // under us between the two statements; without this check the owner would be
            // paid a second time for an item the bidder never receives.
            const newOwners = [...(itemRow.previousOwners ?? []), offer.toSlug];
            const [moved] = await tx
                .update(itemsTable)
                .set({
                    userId: offer.fromUserId,
                    status: 0,
                    timeAcquired: Date.now(),
                    previousOwners: newOwners,
                    pricePaid: total,
                })
                .where(
                    and(
                        eq(itemsTable.id, offer.itemId),
                        eq(itemsTable.userId, offer.toUserId),
                    ),
                )
                .returning({ id: itemsTable.id });
            if (!moved) throw new OfferError("gone");

            // Cancel any active market listing on this item (it just changed hands).
            await tx
                .update(marketListingsTable)
                .set({ status: "cancelled", closedAt: new Date() })
                .where(
                    and(
                        eq(marketListingsTable.itemId, offer.itemId),
                        eq(marketListingsTable.status, "active"),
                    ),
                );

            // Expire every other live offer on this item — the owner no longer holds it.
            await tx
                .update(offersTable)
                .set({ status: "expired", updatedAt: new Date() })
                .where(
                    and(
                        eq(offersTable.itemId, offer.itemId),
                        ne(offersTable.id, offerId),
                        inArray(offersTable.status, [...ACTIVE]),
                    ),
                );

            await tx.insert(goldenFriesLedgerTable).values([
                {
                    userId: offer.fromUserId,
                    amount: -total,
                    reason: `offer:buy:${offerId}`,
                    balanceAfter: fromBal.balance,
                },
                {
                    userId: offer.toUserId,
                    amount: price,
                    reason: `offer:sell:${offerId}`,
                    balanceAfter: toBal?.balance ?? 0,
                },
            ]);

            return fromBal.balance;
        });
        return { success: true, balance };
    } catch (err) {
        const error = err instanceof OfferError ? err.code : "error";
        return { success: false, error, balance: await getGoldenFries(userId) };
    }
}

/** Declines an offer: the owner rejects a pending one, or the bidder rejects a counter. */
export async function declineOffer(
    userId: string,
    offerId: number,
): Promise<OfferActionResponse> {
    const [row] = await db
        .update(offersTable)
        .set({ status: "declined", updatedAt: new Date() })
        .where(
            and(
                eq(offersTable.id, offerId),
                or(
                    // Owner rejects a pending offer.
                    and(
                        eq(offersTable.status, "pending"),
                        eq(offersTable.toUserId, userId),
                    ),
                    // A countered offer can be declined by either party (the bidder walks
                    // away, or the owner retracts/rejects the counter).
                    and(
                        eq(offersTable.status, "countered"),
                        or(
                            eq(offersTable.fromUserId, userId),
                            eq(offersTable.toUserId, userId),
                        )!,
                    ),
                )!,
            ),
        )
        .returning({ id: offersTable.id });
    return row ? { success: true } : { success: false, error: "not_found" };
}

/** The owner counters a pending offer with a new price; the bidder then decides. */
export async function counterOffer(
    userId: string,
    offerId: number,
    counterAmount: number,
): Promise<OfferActionResponse> {
    const [row] = await db
        .update(offersTable)
        .set({ status: "countered", counterAmount, updatedAt: new Date() })
        .where(
            and(
                eq(offersTable.id, offerId),
                eq(offersTable.toUserId, userId),
                eq(offersTable.status, "pending"),
            ),
        )
        .returning({ id: offersTable.id });
    return row ? { success: true } : { success: false, error: "not_found" };
}

/** The bidder withdraws their own offer (whether still pending or already countered). */
export async function withdrawOffer(
    fromUserId: string,
    offerId: number,
): Promise<OfferActionResponse> {
    const [row] = await db
        .update(offersTable)
        .set({ status: "withdrawn", updatedAt: new Date() })
        .where(
            and(
                eq(offersTable.id, offerId),
                eq(offersTable.fromUserId, fromUserId),
                inArray(offersTable.status, [...ACTIVE]),
            ),
        )
        .returning({ id: offersTable.id });
    return row ? { success: true } : { success: false, error: "not_found" };
}

/** Maps a joined offer row to the shared `Offer` shape (usernames resolved by the caller). */
function mapOffer(r: {
    id: number;
    itemId: number;
    type: string;
    amount: number;
    counterAmount: number | null;
    status: string;
    fromSlug: string;
    fromUsername: string | null;
    toSlug: string;
    toUsername: string | null;
    createdAt: Date;
    updatedAt: Date;
}): Offer {
    return {
        offerId: r.id,
        itemId: r.itemId,
        type: r.type,
        amount: r.amount,
        counterAmount: r.counterAmount,
        status: r.status,
        fromSlug: r.fromSlug,
        fromUsername: r.fromUsername ?? "",
        toSlug: r.toSlug,
        toUsername: r.toUsername ?? "",
        createdAt: r.createdAt.getTime(),
        updatedAt: r.updatedAt.getTime(),
    };
}

/** The caller's live offers: incoming (on their items) and outgoing (ones they made). */
export async function getOffersForUser(userId: string): Promise<OfferListResponse> {
    const base = {
        id: offersTable.id,
        itemId: offersTable.itemId,
        type: offersTable.type,
        amount: offersTable.amount,
        counterAmount: offersTable.counterAmount,
        status: offersTable.status,
        fromSlug: offersTable.fromSlug,
        toSlug: offersTable.toSlug,
        createdAt: offersTable.createdAt,
        updatedAt: offersTable.updatedAt,
    };

    const incomingRows = await db
        .select({ ...base, fromUsername: usersTable.username })
        .from(offersTable)
        .leftJoin(usersTable, eq(usersTable.id, offersTable.fromUserId))
        .where(
            and(
                eq(offersTable.toUserId, userId),
                inArray(offersTable.status, [...ACTIVE]),
            ),
        )
        .orderBy(desc(offersTable.createdAt));

    const outgoingRows = await db
        .select({ ...base, toUsername: usersTable.username })
        .from(offersTable)
        .leftJoin(usersTable, eq(usersTable.id, offersTable.toUserId))
        .where(
            and(
                eq(offersTable.fromUserId, userId),
                inArray(offersTable.status, [...ACTIVE]),
            ),
        )
        .orderBy(desc(offersTable.createdAt));

    return {
        success: true,
        incoming: incomingRows.map((r) => mapOffer({ ...r, toUsername: null })),
        outgoing: outgoingRows.map((r) => mapOffer({ ...r, fromUsername: null })),
    };
}

/** Expires offers older than the TTL that were never acted upon. Returns how many. */
export async function expireOldOffers(): Promise<number> {
    const rows = await db
        .update(offersTable)
        .set({ status: "expired", updatedAt: new Date() })
        .where(
            and(
                inArray(offersTable.status, [...ACTIVE]),
                lt(offersTable.createdAt, new Date(Date.now() - OFFER_TTL_MS)),
            ),
        )
        .returning({ id: offersTable.id });
    return rows.length;
}
