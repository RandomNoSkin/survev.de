import { pathToFileURL } from "node:url";
import { and, desc, eq, ilike, isNull } from "drizzle-orm";
import { db } from "./index";
import { goldenFriesLedgerTable, itemsTable, marketListingsTable } from "./schema";
import { generateDailyOffers } from "./shop";

/**
 * One-time backfill of `items.price_paid` from history, for instances acquired before the
 * column existed. Market buys are reconstructed exactly from the ledger; shop buys (only
 * for never-traded instances) from the deterministic daily offer. Anything ambiguous is
 * left null. Idempotent: only fills rows that are still null, so it is safe to re-run.
 */
export async function backfillPricePaid(): Promise<{ market: number; shop: number }> {
    let market = 0;
    let shop = 0;

    // --- Pass 1: market buys (exact) ---
    // A purchase debit `market:buy:<listingId>` = -(price+fee); the listing gives the item.
    // Newest first + fill-only-if-null ⇒ the current owner's most recent buy wins.
    const buys = await db
        .select({
            userId: goldenFriesLedgerTable.userId,
            amount: goldenFriesLedgerTable.amount,
            reason: goldenFriesLedgerTable.reason,
        })
        .from(goldenFriesLedgerTable)
        .where(ilike(goldenFriesLedgerTable.reason, "market:buy:%"))
        .orderBy(desc(goldenFriesLedgerTable.id));

    for (const b of buys) {
        const listingId = Number(b.reason.split(":")[2]);
        if (!Number.isFinite(listingId)) continue;
        const [listing] = await db
            .select({ itemId: marketListingsTable.itemId })
            .from(marketListingsTable)
            .where(eq(marketListingsTable.id, listingId));
        if (!listing) continue;
        // Only when the current owner is this buyer and the price is still unknown.
        const res = await db
            .update(itemsTable)
            .set({ pricePaid: Math.abs(b.amount) })
            .where(
                and(
                    eq(itemsTable.id, listing.itemId),
                    eq(itemsTable.userId, b.userId),
                    isNull(itemsTable.pricePaid),
                ),
            )
            .returning({ id: itemsTable.id });
        market += res.length;
    }

    // --- Pass 2: shop buys, only for never-traded instances (owner == original buyer) ---
    const shopItems = await db
        .select({
            id: itemsTable.id,
            userId: itemsTable.userId,
            type: itemsTable.type,
            source: itemsTable.source,
            previousOwners: itemsTable.previousOwners,
        })
        .from(itemsTable)
        .where(and(isNull(itemsTable.pricePaid), ilike(itemsTable.source, "shop:%")));

    for (const it of shopItems) {
        if ((it.previousOwners ?? []).length) continue; // traded → not this owner's shop buy
        const day = it.source.slice("shop:".length);
        if (!day) continue;
        const offer = generateDailyOffers(it.userId, day).find((o) =>
            o.items.some((x) => x.type === it.type),
        );
        if (!offer) continue;
        const priceSum = offer.items.reduce((s, x) => s + x.price, 0) || 1;
        const itemPrice = offer.items.find((x) => x.type === it.type)?.price ?? 0;
        await db
            .update(itemsTable)
            .set({ pricePaid: Math.round((offer.price * itemPrice) / priceSum) })
            .where(eq(itemsTable.id, it.id));
        shop += 1;
    }

    return { market, shop };
}

// Runnable directly: `tsx src/api/db/pricePaidBackfill.ts` (see `db:backfill-prices`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    backfillPricePaid()
        .then((r) => {
            console.log(`price_paid backfill done: ${r.market} market, ${r.shop} shop`);
            process.exit(0);
        })
        .catch((err) => {
            console.error("price_paid backfill failed:", err);
            process.exit(1);
        });
}
