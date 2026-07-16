import {
    and,
    desc,
    eq,
    gte,
    ilike,
    inArray,
    isNull,
    lt,
    or,
    type SQL,
    sql,
} from "drizzle-orm";
import {
    getItemCategory,
    getItemRarity,
    getMarketFee,
    getMarketTotal,
    MARKET_LIST_COOLDOWN_MS,
    MARKET_LISTING_TTL_MS,
    MARKET_MAX_LISTINGS,
    MARKET_MAX_PRICE,
    type ShopCategory,
} from "../../../../shared/defs/shopConfig";
import type {
    BuyListingResponse,
    CancelListingResponse,
    ListItemResponse,
    MarketListing,
    MarketListResponse,
    MyListing,
    SaleNotification,
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

class MarketError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

/** Active listings created before this instant count as expired (auto-taken-back). */
function expiryCutoff(): Date {
    return new Date(Date.now() - MARKET_LISTING_TTL_MS);
}

/**
 * Flips active listings older than the TTL to `expired`, freeing their item instances
 * to be sold again. Run periodically (and on the daily cron); reads are already guarded
 * by the same cutoff, so an unswept-but-expired listing is never shown or buyable.
 */
export async function expireOldListings(): Promise<number> {
    const rows = await db
        .update(marketListingsTable)
        .set({ status: "expired", closedAt: new Date() })
        .where(
            and(
                eq(marketListingsTable.status, "active"),
                lt(marketListingsTable.createdAt, expiryCutoff()),
            ),
        )
        .returning({ id: marketListingsTable.id });
    return rows.length;
}

/**
 * Lists an owned item instance for sale at `price` Golden Fries. Validates ownership
 * and that the price is within the type's allowed bounds, caps the number of active
 * listings, and uses the partial-unique(item active) index as the anti-double-list
 * lock (insert returns no row when the item is already listed).
 */
export async function listItem(
    userId: string,
    itemId: number,
    price: number,
    buyerSlug?: string,
): Promise<ListItemResponse> {
    // Throttle: a player may only create one listing per cooldown window. Based on the
    // most recent listing (any status), so spam-listing/cancelling is also throttled.
    const [recent] = await db
        .select({ createdAt: marketListingsTable.createdAt })
        .from(marketListingsTable)
        .where(eq(marketListingsTable.sellerId, userId))
        .orderBy(desc(marketListingsTable.createdAt))
        .limit(1);
    if (recent) {
        const nextAllowed = recent.createdAt.getTime() + MARKET_LIST_COOLDOWN_MS;
        if (Date.now() < nextAllowed) {
            return { success: false, error: "rate_limited", retryAfter: nextAllowed };
        }
    }

    try {
        const listing = await db.transaction(async (tx) => {
            const [item] = await tx
                .select({ type: itemsTable.type, userId: itemsTable.userId })
                .from(itemsTable)
                .where(eq(itemsTable.id, itemId));
            if (!item || item.userId !== userId) throw new MarketError("not_owned");

            const category = getItemCategory(item.type);
            if (!category) throw new MarketError("not_listable");
            // Any whole-number price is allowed, including 0 (free); the cap only keeps
            // price + fee inside the integer range.
            if (!Number.isInteger(price) || price < 0 || price > MARKET_MAX_PRICE) {
                throw new MarketError("bad_price");
            }

            // Can't list an item that's currently up for auction.
            const [auction] = await tx
                .select({ id: auctionsTable.id })
                .from(auctionsTable)
                .where(
                    and(
                        eq(auctionsTable.itemId, itemId),
                        eq(auctionsTable.status, "active"),
                    ),
                );
            if (auction) throw new MarketError("auctioned");

            const active = await tx
                .select({ id: marketListingsTable.id })
                .from(marketListingsTable)
                .where(
                    and(
                        eq(marketListingsTable.sellerId, userId),
                        eq(marketListingsTable.status, "active"),
                    ),
                );
            if (active.length >= MARKET_MAX_LISTINGS) {
                throw new MarketError("too_many_listings");
            }

            // Private listing: resolve + validate the target buyer (must exist, not self).
            let targetSlug: string | null = null;
            if (buyerSlug) {
                const normalized = buyerSlug.trim().toLowerCase();
                const [buyer] = await tx
                    .select({ id: usersTable.id, slug: usersTable.slug })
                    .from(usersTable)
                    .where(eq(usersTable.slug, normalized));
                if (!buyer) throw new MarketError("buyer_not_found");
                if (buyer.id === userId) throw new MarketError("self_buyer");
                targetSlug = buyer.slug;
            }

            // Free this item if its previous listing already expired (auto-taken-back),
            // so the owner can re-list without waiting for the periodic sweeper.
            await tx
                .update(marketListingsTable)
                .set({ status: "expired", closedAt: new Date() })
                .where(
                    and(
                        eq(marketListingsTable.itemId, itemId),
                        eq(marketListingsTable.status, "active"),
                        lt(marketListingsTable.createdAt, expiryCutoff()),
                    ),
                );

            const [seller] = await tx
                .select({ slug: usersTable.slug })
                .from(usersTable)
                .where(eq(usersTable.id, userId));

            const [row] = await tx
                .insert(marketListingsTable)
                .values({
                    itemId,
                    sellerId: userId,
                    sellerSlug: seller?.slug ?? "",
                    type: item.type,
                    category,
                    rarity: getItemRarity(item.type),
                    price,
                    buyerSlug: targetSlug,
                })
                // Partial-unique(item active): empty result ⇒ already actively listed.
                .onConflictDoNothing()
                .returning({
                    id: marketListingsTable.id,
                    createdAt: marketListingsTable.createdAt,
                });
            if (!row) throw new MarketError("already_listed");

            return {
                listingId: row.id,
                itemId,
                type: item.type,
                price,
                createdAt: row.createdAt.getTime(),
                buyerSlug: targetSlug,
            } satisfies MyListing;
        });
        return { success: true, listing };
    } catch (err) {
        const error = err instanceof MarketError ? err.code : "error";
        return { success: false, error };
    }
}

/**
 * Buys an active listing. Atomic, mirroring buyShopOffer: the active→sold UPDATE is the
 * lock (one buyer wins), the buyer is charged price+fee behind a `gte` balance guard,
 * the seller is paid the full ask, the item instance transfers to the buyer (seller slug
 * appended to its ownership history), and both ledger rows are written. Any failure
 * rolls the whole transaction back. The fee (total − price) is burned.
 */
export async function buyListing(
    buyerId: string,
    buyerSlug: string,
    listingId: number,
): Promise<BuyListingResponse> {
    try {
        const balance = await db.transaction(async (tx) => {
            const [listing] = await tx
                .update(marketListingsTable)
                .set({ status: "sold", buyerId, closedAt: new Date() })
                .where(
                    and(
                        eq(marketListingsTable.id, listingId),
                        eq(marketListingsTable.status, "active"),
                        // Expired listings are auto-taken-back and can't be bought.
                        gte(marketListingsTable.createdAt, expiryCutoff()),
                        // Private listings may only be claimed by their target buyer.
                        or(
                            isNull(marketListingsTable.buyerSlug),
                            eq(marketListingsTable.buyerSlug, buyerSlug),
                        ),
                    ),
                )
                .returning({
                    itemId: marketListingsTable.itemId,
                    sellerId: marketListingsTable.sellerId,
                    sellerSlug: marketListingsTable.sellerSlug,
                    price: marketListingsTable.price,
                });
            if (!listing) throw new MarketError("unavailable");
            if (listing.sellerId === buyerId) throw new MarketError("own_listing");

            const total = getMarketTotal(listing.price);

            // Charge the buyer (atomic balance guard).
            const [buyerBal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} - ${total}` })
                .where(
                    and(eq(usersTable.id, buyerId), gte(usersTable.goldenFries, total)),
                )
                .returning({ balance: usersTable.goldenFries });
            if (!buyerBal) throw new MarketError("insufficient_funds");

            // Pay the seller the full ask (the fee is the burned difference).
            const [sellerBal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} + ${listing.price}` })
                .where(eq(usersTable.id, listing.sellerId))
                .returning({ balance: usersTable.goldenFries });

            // Transfer the item instance + append the seller to its ownership history.
            const [itemRow] = await tx
                .select({ previousOwners: itemsTable.previousOwners })
                .from(itemsTable)
                .where(
                    and(
                        eq(itemsTable.id, listing.itemId),
                        eq(itemsTable.userId, listing.sellerId),
                    ),
                );
            if (!itemRow) throw new MarketError("error"); // seller no longer owns it
            const newOwners = [...(itemRow.previousOwners ?? []), listing.sellerSlug];

            const [moved] = await tx
                .update(itemsTable)
                .set({
                    userId: buyerId,
                    // Keep the item's original source (provenance); the trade is recorded
                    // via previousOwners, not by rewriting where it first came from.
                    status: 0,
                    timeAcquired: Date.now(),
                    previousOwners: newOwners,
                    // What the buyer actually paid out of pocket (ask + fee).
                    pricePaid: total,
                })
                .where(
                    and(
                        eq(itemsTable.id, listing.itemId),
                        eq(itemsTable.userId, listing.sellerId),
                    ),
                )
                .returning({ id: itemsTable.id });
            if (!moved) throw new MarketError("error");

            // The item just changed hands, so every live buy-offer on it is void: they
            // were made to the seller, who no longer owns it. acceptOffer would refuse
            // them anyway (its ownership guard), but leaving them "pending" would keep a
            // dead offer in both users' lists for the whole TTL, burn one of the bidder's
            // outstanding slots, and — if the item ever returned to the seller (bought
            // back, or an admin revert) — silently become acceptable again at the old
            // price without the bidder confirming. Same reasoning as createAuction.
            await tx
                .update(offersTable)
                .set({ status: "expired", updatedAt: new Date() })
                .where(
                    and(
                        eq(offersTable.itemId, listing.itemId),
                        inArray(offersTable.status, ["pending", "countered"]),
                    ),
                );

            await tx.insert(goldenFriesLedgerTable).values([
                {
                    userId: buyerId,
                    amount: -total,
                    reason: `market:buy:${listingId}`,
                    balanceAfter: buyerBal.balance,
                },
                {
                    userId: listing.sellerId,
                    amount: listing.price,
                    reason: `market:sell:${listingId}`,
                    balanceAfter: sellerBal?.balance ?? 0,
                },
            ]);

            return buyerBal.balance;
        });
        return { success: true, balance };
    } catch (err) {
        const error = err instanceof MarketError ? err.code : "error";
        return { success: false, error, balance: await getGoldenFries(buyerId) };
    }
}

/** Cancels one of the caller's own active listings, freeing the item to be sold again. */
export async function cancelListing(
    userId: string,
    listingId: number,
): Promise<CancelListingResponse> {
    const [row] = await db
        .update(marketListingsTable)
        .set({ status: "cancelled", closedAt: new Date() })
        .where(
            and(
                eq(marketListingsTable.id, listingId),
                eq(marketListingsTable.sellerId, userId),
                eq(marketListingsTable.status, "active"),
            ),
        )
        .returning({ id: marketListingsTable.id });
    return row ? { success: true } : { success: false, error: "not_found" };
}

/** Escapes LIKE wildcards so user search text is matched literally. */
function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Runs the shared joined listing query (item provenance + seller username) for a set of
 * conditions, newest first, paginated. Used by the public market, storefronts, and the
 * per-player private-offers view.
 */
async function queryListings(conds: SQL[], page: number): Promise<MarketListResponse> {
    const rows = await db
        .select({
            listingId: marketListingsTable.id,
            itemId: marketListingsTable.itemId,
            type: marketListingsTable.type,
            price: marketListingsTable.price,
            sellerSlug: marketListingsTable.sellerSlug,
            createdAt: marketListingsTable.createdAt,
            sellerUsername: usersTable.username,
            source: itemsTable.source,
            previousOwners: itemsTable.previousOwners,
            games: itemsTable.games,
            wins: itemsTable.wins,
            kills: itemsTable.kills,
            damage: itemsTable.damage,
        })
        .from(marketListingsTable)
        .leftJoin(itemsTable, eq(itemsTable.id, marketListingsTable.itemId))
        .leftJoin(usersTable, eq(usersTable.id, marketListingsTable.sellerId))
        .where(and(...conds))
        .orderBy(desc(marketListingsTable.createdAt))
        .limit(PAGE_SIZE + 1)
        .offset(page * PAGE_SIZE);

    const hasMore = rows.length > PAGE_SIZE;
    const listings: MarketListing[] = rows.slice(0, PAGE_SIZE).map((r) => ({
        listingId: r.listingId,
        itemId: r.itemId,
        type: r.type,
        price: r.price,
        fee: getMarketFee(r.price),
        total: getMarketTotal(r.price),
        sellerSlug: r.sellerSlug,
        sellerUsername: r.sellerUsername ?? "",
        createdAt: r.createdAt.getTime(),
        source: r.source ?? "",
        previousOwners: r.previousOwners ?? [],
        games: r.games ?? 0,
        wins: r.wins ?? 0,
        kills: r.kills ?? 0,
        damage: r.damage ?? 0,
    }));

    return { success: true, listings, page, hasMore };
}

/**
 * Browses active public listings (newest first). Private (targeted) listings are never
 * shown here. Optional filters: category, rarity, single seller (storefront), and a
 * free-text `search` matched against the cosmetic type/source/seller/owner-history, plus
 * `searchTypes` (cosmetic types the client resolved as display-name matches).
 */
export async function getMarketListings(filters: {
    category?: ShopCategory;
    rarity?: number;
    sellerSlug?: string;
    page?: number;
    search?: string;
    searchTypes?: string[];
}): Promise<MarketListResponse> {
    const page = Math.max(0, filters.page ?? 0);
    const conds: SQL[] = [
        eq(marketListingsTable.status, "active"),
        // Hide listings past their TTL even before the sweeper flips them.
        gte(marketListingsTable.createdAt, expiryCutoff()),
        // The public market never shows private (targeted) listings.
        isNull(marketListingsTable.buyerSlug),
    ];
    if (filters.category) conds.push(eq(marketListingsTable.category, filters.category));
    if (filters.rarity != null) {
        conds.push(eq(marketListingsTable.rarity, filters.rarity));
    }
    if (filters.sellerSlug) {
        conds.push(eq(marketListingsTable.sellerSlug, filters.sellerSlug));
    }

    const search = filters.search?.trim();
    if (search) {
        const q = `%${escapeLike(search)}%`;
        const ors: SQL[] = [
            ilike(marketListingsTable.type, q),
            ilike(itemsTable.source, q),
            ilike(marketListingsTable.sellerSlug, q),
            ilike(usersTable.username, q),
            sql`${itemsTable.previousOwners}::text ILIKE ${q}`,
        ];
        // Cosmetic display names aren't stored, so the client resolves matching types.
        if (filters.searchTypes?.length) {
            ors.push(inArray(marketListingsTable.type, filters.searchTypes));
        }
        conds.push(or(...ors)!);
    }

    return queryListings(conds, page);
}

/** A single player's active public listings, addressed by slug (per-player storefront). */
export async function getStorefront(slug: string): Promise<MarketListResponse> {
    return getMarketListings({ sellerSlug: slug });
}

/** Active listings privately targeted at `buyerSlug` (the recipient's "Private" tab). */
export async function getPrivateOffers(buyerSlug: string): Promise<MarketListResponse> {
    const conds: SQL[] = [
        eq(marketListingsTable.status, "active"),
        gte(marketListingsTable.createdAt, expiryCutoff()),
        eq(marketListingsTable.buyerSlug, buyerSlug),
    ];
    return queryListings(conds, 0);
}

/**
 * Marketplace sales the seller hasn't acknowledged yet — drives the "your item sold"
 * popup. Returned in the profile response; cleared via ackSales once confirmed.
 */
export async function getUnackedSales(userId: string): Promise<SaleNotification[]> {
    const rows = await db
        .select({
            listingId: marketListingsTable.id,
            type: marketListingsTable.type,
            price: marketListingsTable.price,
            buyerUsername: usersTable.username,
            buyerSlug: usersTable.slug,
        })
        .from(marketListingsTable)
        .leftJoin(usersTable, eq(usersTable.id, marketListingsTable.buyerId))
        .where(
            and(
                eq(marketListingsTable.sellerId, userId),
                eq(marketListingsTable.status, "sold"),
                eq(marketListingsTable.sellerAcked, false),
            ),
        )
        .orderBy(desc(marketListingsTable.closedAt));

    return rows.map((r) => ({
        listingId: r.listingId,
        type: r.type,
        price: r.price,
        buyerName: r.buyerUsername || r.buyerSlug || "someone",
    }));
}

/** Marks the given sold listings as acknowledged so the popup won't fire again. */
export async function ackSales(userId: string, listingIds: number[]): Promise<void> {
    if (!listingIds.length) return;
    await db
        .update(marketListingsTable)
        .set({ sellerAcked: true })
        .where(
            and(
                eq(marketListingsTable.sellerId, userId),
                eq(marketListingsTable.status, "sold"),
                inArray(marketListingsTable.id, listingIds),
            ),
        );
}

/** The caller's own active listings, for the profile response (drives Sell↔Cancel UI). */
export async function getUserListings(userId: string): Promise<MyListing[]> {
    const rows = await db
        .select({
            listingId: marketListingsTable.id,
            itemId: marketListingsTable.itemId,
            type: marketListingsTable.type,
            price: marketListingsTable.price,
            createdAt: marketListingsTable.createdAt,
            buyerSlug: marketListingsTable.buyerSlug,
        })
        .from(marketListingsTable)
        .where(
            and(
                eq(marketListingsTable.sellerId, userId),
                eq(marketListingsTable.status, "active"),
                // Expired listings are treated as gone (the item is sellable again).
                gte(marketListingsTable.createdAt, expiryCutoff()),
            ),
        )
        .orderBy(desc(marketListingsTable.createdAt));
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime() }));
}
