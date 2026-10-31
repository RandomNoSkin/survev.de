import { and, eq, sql } from "drizzle-orm";
import { type CrateType, keyOpensCrate, rollCrate } from "../../../../shared/defs/crateConfig";
import type { OpenCrateResponse } from "../../../../shared/types/user";
import { ItemStatus } from "../../../../shared/utils/loadout";
import { db } from "./index";
import {
    auctionsTable,
    crateOpeningsTable,
    goldenFriesLedgerTable,
    itemsTable,
    marketListingsTable,
    offersTable,
    tradeSalesArchiveTable,
    usersTable,
} from "./schema";

class CrateError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

/** One open at a time per player; the client animation takes longer than this anyway. */
const OPEN_COOLDOWN_MS = 1500;
const lastOpen = new Map<string, number>();

/**
 * Opens `crate` with one of the player's `keyType` keys: the key is used up (deleted) and
 * a random cosmetic from the crate's pool is added - or Golden Fries are credited. A key
 * that is listed on the market or up for auction can't be used.
 */
export async function openCrate(
    userId: string,
    crate: CrateType,
    keyType: string,
): Promise<OpenCrateResponse> {
    if (!keyOpensCrate(keyType, crate)) return { success: false, error: "wrong_key" };
    const now = Date.now();
    if (now - (lastOpen.get(userId) ?? 0) < OPEN_COOLDOWN_MS) {
        return { success: false, error: "too_fast" };
    }
    lastOpen.set(userId, now);

    const drop = rollCrate(crate);
    if (!drop) return { success: false, error: "empty_crate" };

    try {
        return await db.transaction(async (tx) => {
            const keys = await tx
                .select({ id: itemsTable.id })
                .from(itemsTable)
                .where(
                    and(
                        eq(itemsTable.userId, userId),
                        eq(itemsTable.type, keyType),
                        sql`NOT EXISTS (SELECT 1 FROM ${marketListingsTable} WHERE ${marketListingsTable.itemId} = ${itemsTable.id} AND ${marketListingsTable.status} = 'active')`,
                        sql`NOT EXISTS (SELECT 1 FROM ${auctionsTable} WHERE ${auctionsTable.itemId} = ${itemsTable.id} AND ${auctionsTable.status} = 'active')`,
                    ),
                )
                // use the oldest key first
                .orderBy(itemsTable.timeAcquired, itemsTable.id)
                .limit(1)
                .for("update", { skipLocked: true });
            const key = keys[0];
            if (!key) throw new CrateError("no_key");

            await archiveSales(tx, key.id);
            const [gone] = await tx
                .delete(itemsTable)
                .where(and(eq(itemsTable.id, key.id), eq(itemsTable.userId, userId)))
                .returning({ id: itemsTable.id });
            if (!gone) throw new CrateError("no_key");

            if (drop.fries !== undefined) {
                const [bal] = await tx
                    .update(usersTable)
                    .set({ goldenFries: sql`${usersTable.goldenFries} + ${drop.fries}` })
                    .where(eq(usersTable.id, userId))
                    .returning({ balance: usersTable.goldenFries });
                await tx.insert(goldenFriesLedgerTable).values({
                    userId,
                    amount: drop.fries,
                    reason: `crate:${crate}`,
                    balanceAfter: bal.balance,
                });
                await tx.insert(crateOpeningsTable).values({
                    userId,
                    crate,
                    keyType,
                    itemType: "golden_fries",
                    amount: drop.fries,
                });
                return { success: true, fries: drop.fries, balance: bal.balance, keyType };
            }

            const itemType = drop.type;
            const [item] = await tx
                .insert(itemsTable)
                .values({
                    userId,
                    type: itemType,
                    source: `crate:${crate}`,
                    timeAcquired: Date.now(),
                    // the reveal already showed it - no "new item" popup on top
                    status: ItemStatus.Confirmed,
                })
                .returning({ id: itemsTable.id });

            await tx.insert(crateOpeningsTable).values({
                userId,
                crate,
                keyType,
                itemType,
                itemId: item.id,
            });
            return { success: true, item: { id: item.id, type: itemType }, keyType };
        });
    } catch (err) {
        lastOpen.delete(userId);
        return { success: false, error: err instanceof CrateError ? err.code : "error" };
    }
}

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Copies the completed sales of an item into the archive before the item is deleted. */
export async function archiveSales(tx: Tx, itemId: number) {
    const sales: { type: string; price: number; kind: string; at: Date }[] = [];
    const listings = await tx
        .select({ type: marketListingsTable.type, price: marketListingsTable.price, at: marketListingsTable.closedAt })
        .from(marketListingsTable)
        .where(and(eq(marketListingsTable.itemId, itemId), eq(marketListingsTable.status, "sold")));
    for (const l of listings) if (l.at) sales.push({ type: l.type, price: l.price, kind: "listing", at: l.at });
    const auctions = await tx
        .select({ type: auctionsTable.type, price: auctionsTable.currentBid, at: auctionsTable.endsAt })
        .from(auctionsTable)
        .where(and(eq(auctionsTable.itemId, itemId), eq(auctionsTable.status, "settled")));
    for (const a of auctions) if (a.price != null) sales.push({ type: a.type, price: a.price, kind: "auction", at: a.at });
    const offers = await tx
        .select({
            type: offersTable.type,
            price: sql<number>`COALESCE(${offersTable.counterAmount}, ${offersTable.amount})`,
            at: offersTable.updatedAt,
        })
        .from(offersTable)
        .where(and(eq(offersTable.itemId, itemId), eq(offersTable.status, "accepted")));
    for (const o of offers) sales.push({ type: o.type, price: Number(o.price), kind: "offer", at: o.at });
    if (sales.length) await tx.insert(tradeSalesArchiveTable).values(sales);
}

// keep the cooldown map small
setInterval(() => {
    const cutoff = Date.now() - OPEN_COOLDOWN_MS;
    for (const [id, t] of lastOpen) if (t < cutoff) lastOpen.delete(id);
}, 60_000).unref?.();
