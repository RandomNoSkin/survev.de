import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getMarketTotal } from "../../../../shared/defs/shopConfig";
import { db } from "./index";
import {
    goldenFriesLedgerTable,
    itemsTable,
    marketListingsTable,
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
    type: "pass" | "shop" | "market" | "admin";
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
        const [entry] = await tx
            .select({
                id: goldenFriesLedgerTable.id,
                userId: goldenFriesLedgerTable.userId,
                amount: goldenFriesLedgerTable.amount,
                reason: goldenFriesLedgerTable.reason,
            })
            .from(goldenFriesLedgerTable)
            .where(eq(goldenFriesLedgerTable.id, ledgerId));
        if (!entry) throw new RevertError("not_found");
        if (entry.reason.startsWith("revert:")) throw new RevertError("not_revertable");
        if (await alreadyReverted(tx, ledgerId)) throw new RevertError("already_reverted");

        if (entry.reason.startsWith("pass:")) return revertPassFries(tx, entry);
        if (entry.reason.startsWith("shop:")) return revertShopBuy(tx, entry);
        if (entry.reason.startsWith("admin_grant"))
            return revertAdminGrant(tx, entry);
        const market = /^market:(?:buy|sell):(\d+)$/.exec(entry.reason);
        if (market) return revertMarketTrade(tx, Number(market[1]));

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
    // reason = "shop:<day>:<slot>"; day is YYYY-MM-DD (contains dashes, not colons).
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
                    removeIds.length
                        ? notInArray(itemsTable.id, removeIds)
                        : undefined,
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
        .where(eq(marketListingsTable.id, listingId));
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
