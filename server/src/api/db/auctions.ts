import {
    and,
    eq,
    gt,
    gte,
    inArray,
    isNotNull,
    lte,
    or,
    type SQL,
    sql,
} from "drizzle-orm";
import {
    AUCTION_DURATION_MS,
    AUCTION_MIN_INCREMENT,
    getItemCategory,
    getItemRarity,
    getMarketFee,
    MARKET_LISTING_TTL_MS,
    MARKET_MAX_PRICE,
    type ShopCategory,
} from "../../../../shared/defs/shopConfig";
import type {
    Auction,
    AuctionListResponse,
    AuctionNotification,
    CreateAuctionResponse,
    PlaceBidResponse,
} from "../../../../shared/types/user";
import { getGoldenFries } from "./goldenFries";
import { db } from "./index";
import {
    auctionsTable,
    goldenFriesLedgerTable,
    itemsTable,
    marketListingsTable,
    offersTable,
    usersTable,
} from "./schema";

const PAGE_SIZE = 30;

class AuctionError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

/**
 * Puts up one owned item instance for auction with a minimum bid. Runs for 24h and cannot
 * be cancelled. Guards: the caller must own a listable cosmetic that is neither actively
 * listed on the market nor already being auctioned (partial-unique index is the lock).
 */
export async function createAuction(
    userId: string,
    itemId: number,
    minBid: number,
): Promise<CreateAuctionResponse> {
    try {
        await db.transaction(async (tx) => {
            // Serialise this player's auction creation. The "one auction at a time" check
            // below is a plain read, so two simultaneous requests would both pass it, and
            // the per-item unique index can't catch that — two different items are two
            // different keys. Locking the auctions table wouldn't help either: with no
            // auction row yet there is nothing there to lock. The seller's own row always
            // exists, so it is what we take the lock on.
            await tx
                .select({ id: usersTable.id })
                .from(usersTable)
                .where(eq(usersTable.id, userId))
                .for("update");

            const [item] = await tx
                .select({ type: itemsTable.type, userId: itemsTable.userId })
                .from(itemsTable)
                .where(eq(itemsTable.id, itemId));
            if (!item || item.userId !== userId) throw new AuctionError("not_owned");

            const category = getItemCategory(item.type);
            if (!category) throw new AuctionError("not_listable");
            if (!Number.isInteger(minBid) || minBid < 1 || minBid > MARKET_MAX_PRICE) {
                throw new AuctionError("bad_price");
            }

            // A player may only run one auction at a time.
            const [existing] = await tx
                .select({ id: auctionsTable.id })
                .from(auctionsTable)
                .where(
                    and(
                        eq(auctionsTable.sellerId, userId),
                        eq(auctionsTable.status, "active"),
                    ),
                );
            if (existing) throw new AuctionError("already_have_auction");

            // Can't auction an item that's actively (un-expired) listed on the market.
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
            if (listing) throw new AuctionError("listed");

            const [seller] = await tx
                .select({ slug: usersTable.slug })
                .from(usersTable)
                .where(eq(usersTable.id, userId));

            const [row] = await tx
                .insert(auctionsTable)
                .values({
                    itemId,
                    sellerId: userId,
                    sellerSlug: seller?.slug ?? "",
                    type: item.type,
                    category,
                    rarity: getItemRarity(item.type),
                    minBid,
                    endsAt: new Date(Date.now() + AUCTION_DURATION_MS),
                })
                // Partial-unique(item active): empty result ⇒ already being auctioned.
                .onConflictDoNothing()
                .returning({ id: auctionsTable.id });
            if (!row) throw new AuctionError("already_auctioned");

            // Void any live buy-offers on this item — it's committed to the auction now, so
            // those offers can no longer be accepted (no escrow was held, so nothing to
            // refund). Prevents a stale offer from later breaking the auction.
            await tx
                .update(offersTable)
                .set({ status: "expired", updatedAt: new Date() })
                .where(
                    and(
                        eq(offersTable.itemId, itemId),
                        inArray(offersTable.status, ["pending", "countered"]),
                    ),
                );
        });
        return { success: true };
    } catch (err) {
        const error = err instanceof AuctionError ? err.code : "error";
        return { success: false, error };
    }
}

/**
 * Places an escrowed bid: the bidder is charged immediately (behind a balance guard) and
 * the previous top bidder is refunded, so the current high bid is always fully funded.
 * Atomic; the active→(same row) UPDATE with a `currentBid` guard is the anti-race lock.
 */
export async function placeBid(
    userId: string,
    auctionId: number,
    amount: number,
): Promise<PlaceBidResponse> {
    try {
        const balance = await db.transaction(async (tx) => {
            const [auction] = await tx
                .select({
                    sellerId: auctionsTable.sellerId,
                    minBid: auctionsTable.minBid,
                    currentBid: auctionsTable.currentBid,
                    currentBidderId: auctionsTable.currentBidderId,
                    endsAt: auctionsTable.endsAt,
                    status: auctionsTable.status,
                })
                .from(auctionsTable)
                .where(eq(auctionsTable.id, auctionId));
            if (!auction || auction.status !== "active") {
                throw new AuctionError("unavailable");
            }
            if (auction.endsAt.getTime() <= Date.now()) throw new AuctionError("ended");
            if (auction.sellerId === userId) throw new AuctionError("own_auction");
            if (auction.currentBidderId === userId) {
                throw new AuctionError("already_highest");
            }

            const minRequired =
                auction.currentBid == null
                    ? auction.minBid
                    : auction.currentBid + AUCTION_MIN_INCREMENT;
            if (!Number.isInteger(amount) || amount < minRequired) {
                const e = new AuctionError("bid_too_low");
                (e as AuctionError & { minRequired?: number }).minRequired = minRequired;
                throw e;
            }

            // Charge the new bidder (atomic balance guard) — their fries are now escrowed.
            const [bidderBal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} - ${amount}` })
                .where(
                    and(eq(usersTable.id, userId), gte(usersTable.goldenFries, amount)),
                )
                .returning({ balance: usersTable.goldenFries });
            if (!bidderBal) throw new AuctionError("insufficient_funds");

            // Move the auction's high bid to this bidder; the guard makes the write lose
            // if a concurrent bid already changed the current bid.
            const [moved] = await tx
                .update(auctionsTable)
                .set({
                    currentBid: amount,
                    currentBidderId: userId,
                    currentBidderSlug: sql`(select ${usersTable.slug} from ${usersTable} where ${usersTable.id} = ${userId})`,
                })
                .where(
                    and(
                        eq(auctionsTable.id, auctionId),
                        eq(auctionsTable.status, "active"),
                        auction.currentBid == null
                            ? sql`${auctionsTable.currentBid} is null`
                            : eq(auctionsTable.currentBid, auction.currentBid),
                    ),
                )
                .returning({ id: auctionsTable.id });
            if (!moved) throw new AuctionError("unavailable"); // lost the race, refunded by rollback

            await tx.insert(goldenFriesLedgerTable).values({
                userId,
                amount: -amount,
                reason: `auction:bid:${auctionId}`,
                balanceAfter: bidderBal.balance,
            });

            // Refund the previous top bidder (their escrow is released).
            if (auction.currentBidderId && auction.currentBid != null) {
                const [prevBal] = await tx
                    .update(usersTable)
                    .set({
                        goldenFries: sql`${usersTable.goldenFries} + ${auction.currentBid}`,
                    })
                    .where(eq(usersTable.id, auction.currentBidderId))
                    .returning({ balance: usersTable.goldenFries });
                await tx.insert(goldenFriesLedgerTable).values({
                    userId: auction.currentBidderId,
                    amount: auction.currentBid,
                    reason: `auction:refund:${auctionId}`,
                    balanceAfter: prevBal?.balance ?? 0,
                });
            }

            return bidderBal.balance;
        });
        return { success: true, balance };
    } catch (err) {
        const code = err instanceof AuctionError ? err.code : "error";
        const minRequired = (err as { minRequired?: number })?.minRequired;
        return {
            success: false,
            error: code,
            balance: await getGoldenFries(userId),
            ...(minRequired != null ? { minRequired } : {}),
        };
    }
}

/**
 * Settles one active auction inside a transaction: with a bid the item transfers to the
 * winner (who already paid) and the seller is paid the bid minus the market fee; without
 * a bid it closes as no_bids (item stays). Returns true if it settled the auction.
 *
 * The `FOR UPDATE` below is load-bearing. Both the sweep and "end early" call this, and a
 * player can fire two of them at once (double-clicking End Auction). With a plain read,
 * both would see `active`, both would pay the seller their proceeds, and those fries would
 * be minted from nothing. Locking the row makes the second caller wait and then re-check
 * the status predicate, which by then no longer matches — so exactly one settle happens.
 */
async function settleAuctionTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    id: number,
): Promise<boolean> {
    const [a] = await tx
        .select({
            itemId: auctionsTable.itemId,
            sellerId: auctionsTable.sellerId,
            sellerSlug: auctionsTable.sellerSlug,
            currentBid: auctionsTable.currentBid,
            currentBidderId: auctionsTable.currentBidderId,
        })
        .from(auctionsTable)
        .where(and(eq(auctionsTable.id, id), eq(auctionsTable.status, "active")))
        .for("update");
    if (!a) return false;

    // No bids → close as unsold, item stays with the seller.
    if (a.currentBid == null || !a.currentBidderId) {
        await tx
            .update(auctionsTable)
            .set({ status: "no_bids" })
            .where(eq(auctionsTable.id, id));
        return true;
    }

    // Transfer the item to the winner (must still be the seller's).
    const [itemRow] = await tx
        .select({ previousOwners: itemsTable.previousOwners })
        .from(itemsTable)
        .where(and(eq(itemsTable.id, a.itemId), eq(itemsTable.userId, a.sellerId)));

    if (!itemRow) {
        // Seller no longer owns it — refund the winner and close.
        const [refundBal] = await tx
            .update(usersTable)
            .set({ goldenFries: sql`${usersTable.goldenFries} + ${a.currentBid}` })
            .where(eq(usersTable.id, a.currentBidderId))
            .returning({ balance: usersTable.goldenFries });
        await tx.insert(goldenFriesLedgerTable).values({
            userId: a.currentBidderId,
            amount: a.currentBid,
            reason: `auction:refund:${id}`,
            balanceAfter: refundBal?.balance ?? 0,
        });
        await tx
            .update(auctionsTable)
            .set({ status: "no_bids", winnerAcked: true })
            .where(eq(auctionsTable.id, id));
        return true;
    }

    const newOwners = [...(itemRow.previousOwners ?? []), a.sellerSlug];
    const [moved] = await tx
        .update(itemsTable)
        .set({
            userId: a.currentBidderId,
            status: 0,
            timeAcquired: Date.now(),
            previousOwners: newOwners,
            pricePaid: a.currentBid,
        })
        .where(and(eq(itemsTable.id, a.itemId), eq(itemsTable.userId, a.sellerId)))
        .returning({ id: itemsTable.id });
    // The read above is not a lock, so the item can still slip away before this write.
    // Bail out rather than pay the seller for an item the winner never received; the
    // rollback leaves the auction active and the next sweep retries it.
    if (!moved) throw new AuctionError("item_moved");

    // Pay the seller the winning bid minus the market fee (fee burned). The winner
    // already paid at bid time, so nothing is charged here.
    const proceeds = a.currentBid - getMarketFee(a.currentBid);
    const [sellerBal] = await tx
        .update(usersTable)
        .set({ goldenFries: sql`${usersTable.goldenFries} + ${proceeds}` })
        .where(eq(usersTable.id, a.sellerId))
        .returning({ balance: usersTable.goldenFries });
    await tx.insert(goldenFriesLedgerTable).values({
        userId: a.sellerId,
        amount: proceeds,
        reason: `auction:sell:${id}`,
        balanceAfter: sellerBal?.balance ?? 0,
    });

    await tx
        .update(auctionsTable)
        .set({ status: "settled" })
        .where(eq(auctionsTable.id, id));
    return true;
}

/**
 * Settles every auction whose end time has passed. Each auction is settled in its own
 * transaction so one failure can't block the rest. Returns the number settled.
 */
export async function settleEndedAuctions(): Promise<number> {
    const due = await db
        .select({ id: auctionsTable.id })
        .from(auctionsTable)
        .where(
            and(
                eq(auctionsTable.status, "active"),
                lte(auctionsTable.endsAt, new Date()),
            ),
        );

    let settled = 0;
    for (const { id } of due) {
        try {
            const ok = await db.transaction((tx) => settleAuctionTx(tx, id));
            if (ok) settled++;
        } catch {
            // Leave this auction active; the next sweep retries it.
        }
    }
    return settled;
}

/**
 * Ends the caller's own auction early: it settles right now, so the current highest bidder
 * (if any) wins the item at their bid. With no bids it just closes (item stays). Only the
 * seller may end their auction.
 */
export async function endAuction(
    userId: string,
    auctionId: number,
): Promise<{ success: boolean; error?: string }> {
    try {
        const ok = await db.transaction(async (tx) => {
            const [a] = await tx
                .select({
                    sellerId: auctionsTable.sellerId,
                    status: auctionsTable.status,
                })
                .from(auctionsTable)
                .where(eq(auctionsTable.id, auctionId));
            if (!a || a.status !== "active") throw new AuctionError("unavailable");
            if (a.sellerId !== userId) throw new AuctionError("not_seller");
            return settleAuctionTx(tx, auctionId);
        });
        return ok ? { success: true } : { success: false, error: "unavailable" };
    } catch (err) {
        return {
            success: false,
            error: err instanceof AuctionError ? err.code : "error",
        };
    }
}

/** Active listings past their TTL are hidden; auctions use their own end time instead. */
function mapAuction(
    r: {
        id: number;
        itemId: number;
        type: string;
        minBid: number;
        currentBid: number | null;
        currentBidderId: string | null;
        currentBidderSlug: string | null;
        sellerId: string;
        sellerSlug: string;
        sellerUsername: string | null;
        endsAt: Date;
        createdAt: Date;
        source: string | null;
        previousOwners: string[] | null;
        games: number | null;
        wins: number | null;
        kills: number | null;
        damage: number | null;
    },
    viewerId?: string,
): Auction {
    return {
        auctionId: r.id,
        itemId: r.itemId,
        type: r.type,
        minBid: r.minBid,
        currentBid: r.currentBid,
        currentBidderSlug: r.currentBidderSlug,
        sellerSlug: r.sellerSlug,
        sellerUsername: r.sellerUsername ?? "",
        endsAt: r.endsAt.getTime(),
        createdAt: r.createdAt.getTime(),
        source: r.source ?? "",
        previousOwners: r.previousOwners ?? [],
        games: r.games ?? 0,
        wins: r.wins ?? 0,
        kills: r.kills ?? 0,
        damage: r.damage ?? 0,
        youAreHighBidder: !!viewerId && r.currentBidderId === viewerId,
        youAreSeller: !!viewerId && r.sellerId === viewerId,
    };
}

/** Browses active auctions (soonest-ending first), optionally filtered by category/rarity. */
export async function getActiveAuctions(
    filters: { category?: ShopCategory; rarity?: number; page?: number },
    viewerId?: string,
): Promise<AuctionListResponse> {
    const page = Math.max(0, filters.page ?? 0);
    const conds: SQL[] = [
        eq(auctionsTable.status, "active"),
        gt(auctionsTable.endsAt, new Date()),
    ];
    if (filters.category) conds.push(eq(auctionsTable.category, filters.category));
    if (filters.rarity != null) conds.push(eq(auctionsTable.rarity, filters.rarity));

    const rows = await db
        .select({
            id: auctionsTable.id,
            itemId: auctionsTable.itemId,
            type: auctionsTable.type,
            minBid: auctionsTable.minBid,
            currentBid: auctionsTable.currentBid,
            currentBidderId: auctionsTable.currentBidderId,
            currentBidderSlug: auctionsTable.currentBidderSlug,
            sellerId: auctionsTable.sellerId,
            sellerSlug: auctionsTable.sellerSlug,
            sellerUsername: usersTable.username,
            endsAt: auctionsTable.endsAt,
            createdAt: auctionsTable.createdAt,
            source: itemsTable.source,
            previousOwners: itemsTable.previousOwners,
            games: itemsTable.games,
            wins: itemsTable.wins,
            kills: itemsTable.kills,
            damage: itemsTable.damage,
        })
        .from(auctionsTable)
        .leftJoin(itemsTable, eq(itemsTable.id, auctionsTable.itemId))
        .leftJoin(usersTable, eq(usersTable.id, auctionsTable.sellerId))
        .where(and(...conds))
        .orderBy(auctionsTable.endsAt)
        .limit(PAGE_SIZE + 1)
        .offset(page * PAGE_SIZE);

    const hasMore = rows.length > PAGE_SIZE;
    const auctions = rows.slice(0, PAGE_SIZE).map((r) => mapAuction(r, viewerId));
    return { success: true, auctions, page, hasMore };
}

/**
 * The item instance the caller currently has up for auction, or null. Drives the loadout
 * "in auction" marker + button disabling (each player can run only one auction at a time).
 */
export async function getActiveAuctionItemId(userId: string): Promise<number | null> {
    const [row] = await db
        .select({ itemId: auctionsTable.itemId })
        .from(auctionsTable)
        .where(
            and(eq(auctionsTable.sellerId, userId), eq(auctionsTable.status, "active")),
        );
    return row?.itemId ?? null;
}

/** How many of the caller's active auctions currently have a bid (drives the tab badge). */
export async function getMyAuctionBidCount(userId: string): Promise<number> {
    const rows = await db
        .select({ id: auctionsTable.id })
        .from(auctionsTable)
        .where(
            and(
                eq(auctionsTable.sellerId, userId),
                eq(auctionsTable.status, "active"),
                isNotNull(auctionsTable.currentBid),
            ),
        );
    return rows.length;
}

/**
 * Settled auction outcomes the caller hasn't acknowledged: items they won, and their own
 * auctions that sold or ended unsold. Drives the profile popups; cleared via ackAuctions.
 */
export async function getUnackedAuctions(userId: string): Promise<AuctionNotification[]> {
    const rows = await db
        .select({
            id: auctionsTable.id,
            type: auctionsTable.type,
            minBid: auctionsTable.minBid,
            currentBid: auctionsTable.currentBid,
            sellerId: auctionsTable.sellerId,
            sellerSlug: auctionsTable.sellerSlug,
            currentBidderId: auctionsTable.currentBidderId,
            currentBidderSlug: auctionsTable.currentBidderSlug,
            status: auctionsTable.status,
        })
        .from(auctionsTable)
        .where(
            or(
                and(
                    eq(auctionsTable.currentBidderId, userId),
                    eq(auctionsTable.status, "settled"),
                    eq(auctionsTable.winnerAcked, false),
                ),
                and(
                    eq(auctionsTable.sellerId, userId),
                    eq(auctionsTable.sellerAcked, false),
                    or(
                        eq(auctionsTable.status, "settled"),
                        eq(auctionsTable.status, "no_bids"),
                    )!,
                ),
            )!,
        );

    return rows.map((r) => {
        if (r.currentBidderId === userId && r.status === "settled") {
            return {
                auctionId: r.id,
                type: r.type,
                amount: r.currentBid ?? 0,
                kind: "won" as const,
                otherName: r.sellerSlug,
            };
        }
        if (r.status === "settled") {
            return {
                auctionId: r.id,
                type: r.type,
                amount: r.currentBid ?? 0,
                kind: "sold" as const,
                otherName: r.currentBidderSlug ?? "someone",
            };
        }
        return {
            auctionId: r.id,
            type: r.type,
            amount: 0,
            kind: "no_bids" as const,
            otherName: "",
        };
    });
}

/** Marks the caller's won/sold/unsold notifications as acknowledged (per side). */
export async function ackAuctions(userId: string, auctionIds: number[]): Promise<void> {
    if (!auctionIds.length) return;
    for (const id of auctionIds) {
        await db
            .update(auctionsTable)
            .set({ winnerAcked: true })
            .where(
                and(eq(auctionsTable.id, id), eq(auctionsTable.currentBidderId, userId)),
            );
        await db
            .update(auctionsTable)
            .set({ sellerAcked: true })
            .where(and(eq(auctionsTable.id, id), eq(auctionsTable.sellerId, userId)));
    }
}
