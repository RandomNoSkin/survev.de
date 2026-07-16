import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getMarketFee, getMarketTotal } from "../../../../shared/defs/shopConfig";
import { db } from "./index";
import {
    auctionsTable,
    goldenFriesLedgerTable,
    itemsTable,
    marketListingsTable,
    offersTable,
    shopPurchasesTable,
    usersTable,
} from "./schema";
import { shopOfferItemTypes } from "./shop";

/** A transaction handle, as passed to the `db.transaction(async (tx) => …)` callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Thrown when a ledger entry can't be reverted; `code` is surfaced to the dashboard. */
export class RevertError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

export interface RevertResult {
    type: "pass" | "shop" | "market" | "admin" | "auction" | "offer" | "gift";
    detail: string;
}

interface LedgerEntry {
    id: number;
    userId: string;
    amount: number;
    reason: string;
}

/**
 * Adjusts a user's Golden Fries balance by `delta` (deductions are clamped at 0, so a
 * user who already spent the fries can't go negative) and records the compensating
 * ledger row. Returns the post-balance.
 */
async function adjustBalance(
    tx: Tx,
    userId: string,
    delta: number,
    reason: string,
): Promise<number> {
    const [row] = await tx
        .update(usersTable)
        .set({
            goldenFries:
                delta >= 0
                    ? sql`${usersTable.goldenFries} + ${delta}`
                    : sql`GREATEST(0, ${usersTable.goldenFries} - ${-delta})`,
        })
        .where(eq(usersTable.id, userId))
        .returning({ balance: usersTable.goldenFries });
    const balanceAfter = row?.balance ?? 0;
    await tx
        .insert(goldenFriesLedgerTable)
        .values({ userId, amount: delta, reason, balanceAfter });
    return balanceAfter;
}

/** A ledger entry counts as reverted once a compensating `revert:<id>` row exists. */
async function alreadyReverted(tx: Tx, ledgerId: number): Promise<boolean> {
    const [row] = await tx
        .select({ id: goldenFriesLedgerTable.id })
        .from(goldenFriesLedgerTable)
        .where(eq(goldenFriesLedgerTable.reason, `revert:${ledgerId}`))
        .limit(1);
    return !!row;
}

/**
 * Reverts a Golden Fries ledger entry, dispatching on its reason. All work happens in a
 * single transaction; double-reverts are blocked by the `revert:<id>` marker (and, for
 * trades, the listing status). Throws {@link RevertError} on any precondition failure.
 *
 *   pass:…        → deduct the awarded fries but KEEP the `pass:…` row, since that row is
 *                   the reconcile idempotency lock — leaving it prevents the fries from
 *                   ever being re-granted by a later reconcile.
 *   shop:<day>:<slot> → refund the spend, remove the granted item instance(s) and release
 *                   the day/slot lock so the offer is buyable again.
 *   market:buy/sell:<id> → undo the whole trade from either side: refund the buyer the
 *                   full total, deduct the seller their ask, return the item to the seller,
 *                   and mark the listing reverted.
 *
 * Item-moved-on safety: if the item is no longer owned by the account that should give it
 * back (sold / traded / deleted), the revert is blocked rather than creating phantom
 * items or touching an innocent third party.
 */
export async function revertLedgerEntry(
    ledgerId: number,
    _adminSlug: string,
): Promise<RevertResult> {
    return db.transaction(async (tx) => {
        // Lock the entry first: the `already_reverted` checks below are plain reads, so two
        // concurrent reverts of the same row (a double-clicked dashboard button) would both
        // pass them and refund twice, minting fries. Locking serialises them — the second
        // one then sees the marker the first wrote. Reverts keyed on a listing/auction/offer
        // additionally lock that row, which covers a trade's two ledger legs having
        // different ids.
        const [entry] = await tx
            .select({
                id: goldenFriesLedgerTable.id,
                userId: goldenFriesLedgerTable.userId,
                amount: goldenFriesLedgerTable.amount,
                reason: goldenFriesLedgerTable.reason,
            })
            .from(goldenFriesLedgerTable)
            .where(eq(goldenFriesLedgerTable.id, ledgerId))
            .for("update");
        if (!entry) throw new RevertError("not_found");
        if (entry.reason.startsWith("revert:")) throw new RevertError("not_revertable");
        if (await alreadyReverted(tx, ledgerId))
            throw new RevertError("already_reverted");

        if (entry.reason.startsWith("pass:")) return revertPassFries(tx, entry);
        if (entry.reason.startsWith("shop:")) return revertShopBuy(tx, entry);
        if (entry.reason.startsWith("admin_grant")) return revertAdminGrant(tx, entry);
        const market = /^market:(?:buy|sell):(\d+)$/.exec(entry.reason);
        if (market) return revertMarketTrade(tx, Number(market[1]));
        const auctionSale = /^auction:sell:(\d+)$/.exec(entry.reason);
        if (auctionSale) return revertAuctionSale(tx, Number(auctionSale[1]));
        // A bid/refund is an intermediate escrow move; revert the whole sale from its
        // `auction:sell` row instead (that also undoes the winning bid + returns the item).
        if (/^auction:(?:bid|refund):\d+$/.test(entry.reason)) {
            throw new RevertError("revert_via_sale");
        }
        const offer = /^offer:(?:buy|sell):(\d+)$/.exec(entry.reason);
        if (offer) return revertOfferTrade(tx, Number(offer[1]));
        if (/^gift:(?:send|recv):/.test(entry.reason)) {
            return revertGiftFries(tx, entry);
        }

        throw new RevertError("not_revertable");
    });
}

async function revertPassFries(tx: Tx, entry: LedgerEntry): Promise<RevertResult> {
    // Deduct the awarded fries; the original `pass:…` row (the reconcile lock) stays.
    await adjustBalance(tx, entry.userId, -entry.amount, `revert:${entry.id}`);
    return {
        type: "pass",
        detail: `deducted ${entry.amount} fries (lock kept — reconcile won't re-grant)`,
    };
}

async function revertAdminGrant(tx: Tx, entry: LedgerEntry): Promise<RevertResult> {
    // Simply reverse the granted amount: a positive grant is deducted (clamped at 0),
    // a negative "removal" is refunded. No items involved.
    await adjustBalance(tx, entry.userId, -entry.amount, `revert:${entry.id}`);
    const verb = entry.amount >= 0 ? "deducted" : "refunded";
    return { type: "admin", detail: `${verb} ${Math.abs(entry.amount)} fries` };
}

async function revertShopBuy(tx: Tx, entry: LedgerEntry): Promise<RevertResult> {
    // reason = "shop:<key>:<slot>". The key is a day ("YYYY-MM-DD", slots 0/1) or a week
    // ("wYYYY-MM-DD", slots 2/3) — both carry dashes but never colons, so this split holds.
    const [, day, slotStr] = entry.reason.split(":");
    const slot = Number(slotStr);
    const types = shopOfferItemTypes(entry.userId, day, slot);
    const source = `shop:${day}`;

    // Find one still-owned instance of each granted type. If any is gone (sold/traded/
    // deleted), block — we don't do partial reverts.
    const removeIds: number[] = [];
    for (const type of types) {
        const [item] = await tx
            .select({ id: itemsTable.id })
            .from(itemsTable)
            .where(
                and(
                    eq(itemsTable.userId, entry.userId),
                    eq(itemsTable.type, type),
                    eq(itemsTable.source, source),
                    removeIds.length ? notInArray(itemsTable.id, removeIds) : undefined,
                ),
            )
            .limit(1);
        if (!item) throw new RevertError("item_gone");
        removeIds.push(item.id);
    }
    if (removeIds.length) {
        await tx.delete(itemsTable).where(inArray(itemsTable.id, removeIds));
    }

    // Release the day/slot lock so the offer becomes buyable again.
    await tx
        .delete(shopPurchasesTable)
        .where(
            and(
                eq(shopPurchasesTable.userId, entry.userId),
                eq(shopPurchasesTable.day, day),
                eq(shopPurchasesTable.slot, slot),
            ),
        );

    // Refund what was spent (entry.amount is negative).
    await adjustBalance(tx, entry.userId, -entry.amount, `revert:${entry.id}`);
    return {
        type: "shop",
        detail: `refunded ${-entry.amount} fries, removed ${removeIds.length} item(s), slot freed`,
    };
}

/**
 * Reverts a settled auction: returns the item from the winner to the seller, refunds the
 * winner the winning bid they escrowed, and deducts the seller the proceeds they received
 * (bid − fee). Both the winning `auction:bid` leg and the `auction:sell` leg are marked
 * reverted, and the auction row is flipped to "reverted" (double-revert guard). Blocked if
 * the item has since moved on from the winner.
 */
async function revertAuctionSale(tx: Tx, auctionId: number): Promise<RevertResult> {
    const [a] = await tx
        .select({
            itemId: auctionsTable.itemId,
            sellerId: auctionsTable.sellerId,
            sellerSlug: auctionsTable.sellerSlug,
            currentBid: auctionsTable.currentBid,
            currentBidderId: auctionsTable.currentBidderId,
            status: auctionsTable.status,
        })
        .from(auctionsTable)
        .where(eq(auctionsTable.id, auctionId))
        // Serialises reverts arriving via the bid leg and the sell leg at once.
        .for("update");
    if (!a) throw new RevertError("auction_not_found");
    if (a.status === "reverted") throw new RevertError("already_reverted");
    if (a.status !== "settled" || a.currentBid == null || !a.currentBidderId) {
        throw new RevertError("not_a_sale");
    }
    const winnerId = a.currentBidderId;
    const bid = a.currentBid;

    // The item must still be with the winner, else it moved on and we block.
    const [item] = await tx
        .select({
            userId: itemsTable.userId,
            previousOwners: itemsTable.previousOwners,
        })
        .from(itemsTable)
        .where(eq(itemsTable.id, a.itemId));
    if (!item || item.userId !== winnerId) throw new RevertError("item_gone");

    // Return the item to the seller; undo the ownership-history append from the win.
    const owners = item.previousOwners ?? [];
    const newOwners =
        owners.length && owners[owners.length - 1] === a.sellerSlug
            ? owners.slice(0, -1)
            : owners;
    await tx
        .update(itemsTable)
        .set({
            userId: a.sellerId,
            previousOwners: newOwners,
            timeAcquired: Date.now(),
        })
        .where(eq(itemsTable.id, a.itemId));

    // Winner paid `bid` (escrow) → refund it; seller got `bid − fee` → deduct that.
    const proceeds = bid - getMarketFee(bid);

    // Mark each original leg reverted by its own id (like a market trade).
    const [bidLeg] = await tx
        .select({ id: goldenFriesLedgerTable.id })
        .from(goldenFriesLedgerTable)
        .where(
            and(
                eq(goldenFriesLedgerTable.userId, winnerId),
                eq(goldenFriesLedgerTable.reason, `auction:bid:${auctionId}`),
            ),
        )
        .orderBy(desc(goldenFriesLedgerTable.id))
        .limit(1);
    const [sellLeg] = await tx
        .select({ id: goldenFriesLedgerTable.id })
        .from(goldenFriesLedgerTable)
        .where(eq(goldenFriesLedgerTable.reason, `auction:sell:${auctionId}`))
        .limit(1);

    await adjustBalance(
        tx,
        winnerId,
        bid,
        `revert:${bidLeg?.id ?? `auction:bid:${auctionId}`}`,
    );
    await adjustBalance(
        tx,
        a.sellerId,
        -proceeds,
        `revert:${sellLeg?.id ?? `auction:sell:${auctionId}`}`,
    );

    await tx
        .update(auctionsTable)
        .set({ status: "reverted" })
        .where(eq(auctionsTable.id, auctionId));

    return {
        type: "auction",
        detail: `refunded ${bid} to winner, deducted ${proceeds} from seller, item returned`,
    };
}

/**
 * Reverts an accepted buy-offer: returns the item from the buyer to the seller, refunds
 * the buyer the total they paid (price + fee), and deducts the seller the price they got.
 * Mirrors {@link revertMarketTrade} but keyed on the offer row. Blocked if the item moved
 * on from the buyer.
 */
async function revertOfferTrade(tx: Tx, offerId: number): Promise<RevertResult> {
    const [o] = await tx
        .select({
            itemId: offersTable.itemId,
            fromUserId: offersTable.fromUserId,
            toUserId: offersTable.toUserId,
            toSlug: offersTable.toSlug,
            amount: offersTable.amount,
            counterAmount: offersTable.counterAmount,
            status: offersTable.status,
        })
        .from(offersTable)
        .where(eq(offersTable.id, offerId))
        // Serialises reverts arriving via the buy leg and the sell leg at once.
        .for("update");
    if (!o) throw new RevertError("offer_not_found");
    if (o.status === "reverted") throw new RevertError("already_reverted");
    if (o.status !== "accepted") throw new RevertError("not_a_sale");

    const buyerId = o.fromUserId;
    const sellerId = o.toUserId;
    const price = o.counterAmount ?? o.amount;
    const total = getMarketTotal(price);

    // The item must still be with the buyer, else it moved on and we block.
    const [item] = await tx
        .select({
            userId: itemsTable.userId,
            previousOwners: itemsTable.previousOwners,
        })
        .from(itemsTable)
        .where(eq(itemsTable.id, o.itemId));
    if (!item || item.userId !== buyerId) throw new RevertError("item_gone");

    // Return the item to the seller; undo the ownership-history append from acceptance.
    const owners = item.previousOwners ?? [];
    const newOwners =
        owners.length && owners[owners.length - 1] === o.toSlug
            ? owners.slice(0, -1)
            : owners;
    await tx
        .update(itemsTable)
        .set({
            userId: sellerId,
            previousOwners: newOwners,
            timeAcquired: Date.now(),
        })
        .where(eq(itemsTable.id, o.itemId));

    // Money: buyer paid total → refund; seller got price → deduct.
    const legs = await tx
        .select({
            id: goldenFriesLedgerTable.id,
            reason: goldenFriesLedgerTable.reason,
        })
        .from(goldenFriesLedgerTable)
        .where(
            inArray(goldenFriesLedgerTable.reason, [
                `offer:buy:${offerId}`,
                `offer:sell:${offerId}`,
            ]),
        );
    const buyLeg = legs.find((l) => l.reason === `offer:buy:${offerId}`);
    const sellLeg = legs.find((l) => l.reason === `offer:sell:${offerId}`);

    await adjustBalance(
        tx,
        buyerId,
        total,
        `revert:${buyLeg?.id ?? `offer:buy:${offerId}`}`,
    );
    await adjustBalance(
        tx,
        sellerId,
        -price,
        `revert:${sellLeg?.id ?? `offer:sell:${offerId}`}`,
    );

    await tx
        .update(offersTable)
        .set({ status: "reverted", updatedAt: new Date() })
        .where(eq(offersTable.id, offerId));

    return {
        type: "offer",
        detail: `refunded ${total} to buyer, deducted ${price} from seller, item returned`,
    };
}

/**
 * Reverts a Golden Fries gift (no item): refunds the sender and deducts the recipient. Both
 * legs of a gift are written in one transaction so they share a `createdAt`; that lets us
 * find the matching pair from either the `gift:send` or `gift:recv` row the admin clicked,
 * and mark both reverted. Deductions are clamped at 0 if the recipient already spent them.
 */
async function revertGiftFries(tx: Tx, entry: LedgerEntry): Promise<RevertResult> {
    // Both legs share the clicked row's exact createdAt (same insert). Compare DB-to-DB via
    // a subquery so we don't lose the timestamp's sub-millisecond precision round-tripping
    // through a JS Date.
    const legs = await tx
        .select({
            id: goldenFriesLedgerTable.id,
            userId: goldenFriesLedgerTable.userId,
            amount: goldenFriesLedgerTable.amount,
            reason: goldenFriesLedgerTable.reason,
        })
        .from(goldenFriesLedgerTable)
        .where(
            and(
                sql`${goldenFriesLedgerTable.createdAt} = (select ${goldenFriesLedgerTable.createdAt} from ${goldenFriesLedgerTable} where ${goldenFriesLedgerTable.id} = ${entry.id})`,
                sql`${goldenFriesLedgerTable.reason} LIKE 'gift:%'`,
            ),
        )
        // A gift has no listing/auction row to lock, and its two legs have different ids —
        // so locking both legs here is what stops one admin reverting via the send row
        // while another reverts the same gift via the recv row.
        .for("update");

    const amount = Math.abs(entry.amount);
    const sendLeg = legs.find(
        (l) => l.reason.startsWith("gift:send:") && l.amount === -amount,
    );
    const recvLeg = legs.find(
        (l) => l.reason.startsWith("gift:recv:") && l.amount === amount,
    );
    if (!sendLeg || !recvLeg) throw new RevertError("gift_incomplete");

    // Reverse the transfer: sender refunded, recipient deducted (clamped at 0).
    await adjustBalance(tx, sendLeg.userId, amount, `revert:${sendLeg.id}`);
    await adjustBalance(tx, recvLeg.userId, -amount, `revert:${recvLeg.id}`);

    return {
        type: "gift",
        detail: `refunded ${amount} to sender, deducted ${amount} from recipient`,
    };
}

async function revertMarketTrade(tx: Tx, listingId: number): Promise<RevertResult> {
    const [listing] = await tx
        .select({
            itemId: marketListingsTable.itemId,
            sellerId: marketListingsTable.sellerId,
            sellerSlug: marketListingsTable.sellerSlug,
            buyerId: marketListingsTable.buyerId,
            price: marketListingsTable.price,
            status: marketListingsTable.status,
        })
        .from(marketListingsTable)
        .where(eq(marketListingsTable.id, listingId))
        // Serialises reverts arriving via the buy leg and the sell leg at once.
        .for("update");
    if (!listing) throw new RevertError("listing_not_found");
    if (listing.status === "reverted") throw new RevertError("already_reverted");
    if (!listing.buyerId) throw new RevertError("not_a_sale");
    const buyerId = listing.buyerId;

    // The item must still be with the buyer, else it moved on and we block.
    const [item] = await tx
        .select({
            userId: itemsTable.userId,
            previousOwners: itemsTable.previousOwners,
        })
        .from(itemsTable)
        .where(eq(itemsTable.id, listing.itemId));
    if (!item || item.userId !== buyerId) throw new RevertError("item_gone");

    // Return the item to the seller; undo the ownership-history append from the buy.
    const owners = item.previousOwners ?? [];
    const newOwners =
        owners.length && owners[owners.length - 1] === listing.sellerSlug
            ? owners.slice(0, -1)
            : owners;
    await tx
        .update(itemsTable)
        .set({
            userId: listing.sellerId,
            previousOwners: newOwners,
            timeAcquired: Date.now(),
        })
        .where(eq(itemsTable.id, listing.itemId));

    // Money: buyer paid total (price + fee) → refund total; seller got price → deduct it.
    const total = getMarketTotal(listing.price);

    // Both original ledger rows, so each side is individually marked reverted.
    const legs = await tx
        .select({
            id: goldenFriesLedgerTable.id,
            reason: goldenFriesLedgerTable.reason,
        })
        .from(goldenFriesLedgerTable)
        .where(
            inArray(goldenFriesLedgerTable.reason, [
                `market:buy:${listingId}`,
                `market:sell:${listingId}`,
            ]),
        );
    const buyLeg = legs.find((l) => l.reason === `market:buy:${listingId}`);
    const sellLeg = legs.find((l) => l.reason === `market:sell:${listingId}`);

    await adjustBalance(
        tx,
        buyerId,
        total,
        `revert:${buyLeg?.id ?? `market:buy:${listingId}`}`,
    );
    await adjustBalance(
        tx,
        listing.sellerId,
        -listing.price,
        `revert:${sellLeg?.id ?? `market:sell:${listingId}`}`,
    );

    // Mark the listing reverted (secondary double-revert guard + honest state).
    await tx
        .update(marketListingsTable)
        .set({ status: "reverted", closedAt: new Date() })
        .where(eq(marketListingsTable.id, listingId));

    return {
        type: "market",
        detail: `refunded ${total} to buyer, deducted ${listing.price} from seller, item returned`,
    };
}
