import { and, desc, eq, getTableColumns, gt, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import {
    BUY_ORDER_MAX_OPEN,
    BUY_ORDER_TTL_MS,
    getItemCategory,
    getMarketTotal,
} from "../../../../shared/defs/shopConfig";
import type {
    BuyOrder,
    BuyOrderActionResponse,
    BuyOrderListResponse,
    CreateBuyOrderResponse,
} from "../../../../shared/types/user";
import { getGoldenFries } from "./goldenFries";
import { db } from "./index";
import { resolveRoleTag } from "./roleTag";
import {
    auctionsTable,
    blocksTable,
    buyOrdersTable,
    goldenFriesLedgerTable,
    itemsTable,
    marketListingsTable,
    offersTable,
    usersTable,
} from "./schema";
import { addTradeEvent } from "./tradeEvents";

class OrderError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

const buyerColumns = {
    buyerUsername: usersTable.username,
    owner: usersTable.owner,
    admin: usersTable.admin,
    moderator: usersTable.moderator,
    premiumUntil: usersTable.premiumUntil,
    showOwnerPrefix: usersTable.showOwnerPrefix,
    showAdminPrefix: usersTable.showAdminPrefix,
    showModPrefix: usersTable.showModPrefix,
    showPremiumPrefix: usersTable.showPremiumPrefix,
};

const orderColumns = { ...getTableColumns(buyOrdersTable), ...buyerColumns };

type OrderRow = typeof buyOrdersTable.$inferSelect & {
    buyerUsername: string | null;
    owner: boolean | null;
    admin: boolean | null;
    moderator: boolean | null;
    premiumUntil: Date | null;
    showOwnerPrefix: boolean | null;
    showAdminPrefix: boolean | null;
    showModPrefix: boolean | null;
    showPremiumPrefix: boolean | null;
};

function mapOrder(r: OrderRow): BuyOrder {
    return {
        orderId: r.id,
        type: r.type,
        amount: r.amount,
        total: r.total,
        status: r.status,
        buyerSlug: r.buyerSlug,
        buyerUsername: r.buyerUsername ?? r.buyerSlug,
        buyerRoleTag: resolveRoleTag({
            owner: !!r.owner,
            admin: !!r.admin,
            moderator: !!r.moderator,
            premiumUntil: r.premiumUntil,
            showOwnerPrefix: r.showOwnerPrefix ?? true,
            showAdminPrefix: r.showAdminPrefix ?? true,
            showModPrefix: r.showModPrefix ?? true,
            showPremiumPrefix: r.showPremiumPrefix ?? true,
        }),
        sellerSlug: r.sellerSlug,
        createdAt: r.createdAt.getTime(),
        expiresAt: r.expiresAt.getTime(),
    };
}

/**
 * Creates a buy order: the buyer pays `amount` + fee now (held until it's filled,
 * cancelled or runs out). One open order per item type, at most BUY_ORDER_MAX_OPEN.
 */
export async function createBuyOrder(buyerId: string, type: string, amount: number): Promise<CreateBuyOrderResponse> {
    if (!getItemCategory(type)) return { success: false, error: "not_tradeable" };
    const total = getMarketTotal(amount);
    try {
        const result = await db.transaction(async (tx) => {
            const open = await tx
                .select({ id: buyOrdersTable.id, type: buyOrdersTable.type })
                .from(buyOrdersTable)
                .where(and(eq(buyOrdersTable.buyerId, buyerId), eq(buyOrdersTable.status, "open")));
            if (open.some((o) => o.type === type)) throw new OrderError("duplicate");
            if (open.length >= BUY_ORDER_MAX_OPEN) throw new OrderError("too_many");

            const [bal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} - ${total}` })
                .where(and(eq(usersTable.id, buyerId), gte(usersTable.goldenFries, total)))
                .returning({ balance: usersTable.goldenFries, slug: usersTable.slug });
            if (!bal) throw new OrderError("insufficient_funds");

            const [row] = await tx
                .insert(buyOrdersTable)
                .values({
                    buyerId,
                    buyerSlug: bal.slug,
                    type,
                    amount,
                    total,
                    expiresAt: new Date(Date.now() + BUY_ORDER_TTL_MS),
                })
                // the partial unique index (one open order per type) loses a race here
                .onConflictDoNothing()
                .returning();
            if (!row) throw new OrderError("duplicate");

            await tx.insert(goldenFriesLedgerTable).values({
                userId: buyerId,
                amount: -total,
                reason: `order:hold:${row.id}`,
                balanceAfter: bal.balance,
            });
            return { balance: bal.balance, row };
        });
        const [buyer] = await db.select(buyerColumns).from(usersTable).where(eq(usersTable.id, buyerId));
        return { success: true, balance: result.balance, order: mapOrder({ ...result.row, ...buyer }) };
    } catch (err) {
        return { success: false, error: err instanceof OrderError ? err.code : "error", balance: await getGoldenFries(buyerId) };
    }
}

/** Closes an open order as `status` and refunds the buyer the held total. */
async function closeAndRefund(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    orderId: number,
    status: "cancelled" | "expired",
    onlyBuyer?: string,
) {
    const [order] = await tx
        .update(buyOrdersTable)
        .set({ status, closedAt: new Date() })
        .where(
            and(
                eq(buyOrdersTable.id, orderId),
                eq(buyOrdersTable.status, "open"),
                onlyBuyer ? eq(buyOrdersTable.buyerId, onlyBuyer) : undefined,
            ),
        )
        .returning();
    if (!order) return null;
    const [bal] = await tx
        .update(usersTable)
        .set({ goldenFries: sql`${usersTable.goldenFries} + ${order.total}` })
        .where(eq(usersTable.id, order.buyerId))
        .returning({ balance: usersTable.goldenFries });
    await tx.insert(goldenFriesLedgerTable).values({
        userId: order.buyerId,
        amount: order.total,
        reason: `order:refund:${order.id}`,
        balanceAfter: bal?.balance ?? 0,
    });
    return { order, balance: bal?.balance ?? 0 };
}

export async function cancelBuyOrder(buyerId: string, orderId: number): Promise<BuyOrderActionResponse> {
    try {
        const res = await db.transaction((tx) => closeAndRefund(tx, orderId, "cancelled", buyerId));
        if (!res) return { success: false, error: "gone", balance: await getGoldenFries(buyerId) };
        return { success: true, balance: res.balance };
    } catch {
        return { success: false, error: "error" };
    }
}

/** Refunds every open order past its end. Returns how many. */
export async function expireBuyOrders(): Promise<number> {
    const due = await db
        .select({ id: buyOrdersTable.id })
        .from(buyOrdersTable)
        .where(and(eq(buyOrdersTable.status, "open"), lte(buyOrdersTable.expiresAt, new Date())))
        .limit(200);
    let n = 0;
    for (const { id } of due) {
        await db.transaction(async (tx) => {
            const res = await closeAndRefund(tx, id, "expired");
            if (!res) return;
            await addTradeEvent(tx, res.order.buyerId, "order_expired", res.order.type, res.order.total, null);
            n++;
        });
    }
    return n;
}

/**
 * Sells one of the caller's items to an open buy order: the order is claimed (one seller
 * wins), the item moves to the buyer, the seller gets `amount` (the held fee is burned),
 * and any live listing / offers on that copy are closed - same as a market sale.
 */
export async function fillBuyOrder(sellerId: string, orderId: number, itemId: number): Promise<BuyOrderActionResponse> {
    try {
        const balance = await db.transaction(async (tx) => {
            const [seller] = await tx
                .select({ slug: usersTable.slug })
                .from(usersTable)
                .where(eq(usersTable.id, sellerId));
            const [order] = await tx
                .update(buyOrdersTable)
                .set({ status: "filled", sellerId, sellerSlug: seller?.slug ?? "", itemId, closedAt: new Date() })
                .where(
                    and(
                        eq(buyOrdersTable.id, orderId),
                        eq(buyOrdersTable.status, "open"),
                        gt(buyOrdersTable.expiresAt, new Date()),
                    ),
                )
                .returning();
            if (!order) throw new OrderError("gone");
            if (order.buyerId === sellerId) throw new OrderError("own_order");

            const [block] = await tx
                .select({ userId: blocksTable.userId })
                .from(blocksTable)
                .where(
                    or(
                        and(eq(blocksTable.userId, order.buyerId), eq(blocksTable.blockedId, sellerId)),
                        and(eq(blocksTable.userId, sellerId), eq(blocksTable.blockedId, order.buyerId)),
                    ),
                )
                .limit(1);
            if (block) throw new OrderError("blocked");

            const [item] = await tx
                .select({ type: itemsTable.type, previousOwners: itemsTable.previousOwners })
                .from(itemsTable)
                .where(and(eq(itemsTable.id, itemId), eq(itemsTable.userId, sellerId)));
            if (!item) throw new OrderError("not_owned");
            if (item.type !== order.type) throw new OrderError("wrong_item");

            const [auction] = await tx
                .select({ id: auctionsTable.id })
                .from(auctionsTable)
                .where(and(eq(auctionsTable.itemId, itemId), eq(auctionsTable.status, "active")));
            if (auction) throw new OrderError("auctioned");

            const [moved] = await tx
                .update(itemsTable)
                .set({
                    userId: order.buyerId,
                    status: 0,
                    timeAcquired: Date.now(),
                    previousOwners: [...(item.previousOwners ?? []), seller?.slug ?? ""],
                    pricePaid: order.total,
                })
                .where(and(eq(itemsTable.id, itemId), eq(itemsTable.userId, sellerId)))
                .returning({ id: itemsTable.id });
            if (!moved) throw new OrderError("not_owned");

            // a listing of this very copy is void now, and so are offers on it
            await tx
                .update(marketListingsTable)
                .set({ status: "cancelled", closedAt: new Date() })
                .where(and(eq(marketListingsTable.itemId, itemId), eq(marketListingsTable.status, "active")));
            await tx
                .update(offersTable)
                .set({ status: "expired", updatedAt: new Date() })
                .where(and(eq(offersTable.itemId, itemId), inArray(offersTable.status, ["pending", "countered"])));

            const [sellerBal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} + ${order.amount}` })
                .where(eq(usersTable.id, sellerId))
                .returning({ balance: usersTable.goldenFries });
            await tx.insert(goldenFriesLedgerTable).values({
                userId: sellerId,
                amount: order.amount,
                reason: `order:sell:${order.id}`,
                balanceAfter: sellerBal?.balance ?? 0,
            });
            await addTradeEvent(tx, order.buyerId, "order_filled", order.type, order.amount, seller?.slug ?? null);
            return sellerBal?.balance ?? 0;
        });
        return { success: true, balance };
    } catch (err) {
        return { success: false, error: err instanceof OrderError ? err.code : "error", balance: await getGoldenFries(sellerId) };
    }
}

/** Open orders for item types `userId` owns a copy of (not their own), best first. */
async function ordersForItemsOf(userId: string, limit: number) {
    return db
        .select(orderColumns)
        .from(buyOrdersTable)
        .leftJoin(usersTable, eq(usersTable.id, buyOrdersTable.buyerId))
        .where(
            and(
                eq(buyOrdersTable.status, "open"),
                gt(buyOrdersTable.expiresAt, new Date()),
                ne(buyOrdersTable.buyerId, userId),
                inArray(
                    buyOrdersTable.type,
                    db.selectDistinct({ type: itemsTable.type }).from(itemsTable).where(eq(itemsTable.userId, userId)),
                ),
            ),
        )
        .orderBy(desc(buyOrdersTable.amount), desc(buyOrdersTable.createdAt))
        .limit(limit);
}

export async function getBuyOrders(userId: string): Promise<BuyOrderListResponse> {
    const mine = await db
        .select(orderColumns)
        .from(buyOrdersTable)
        .leftJoin(usersTable, eq(usersTable.id, buyOrdersTable.buyerId))
        .where(eq(buyOrdersTable.buyerId, userId))
        .orderBy(desc(buyOrdersTable.createdAt))
        .limit(30);
    const forMyItems = await ordersForItemsOf(userId, 50);
    return { success: true, mine: mine.map(mapOrder), forMyItems: forMyItems.map(mapOrder) };
}

/** Ids of the open orders the player could fill right now (the badge counts unseen ones). */
export async function orderIdsForMyItems(userId: string): Promise<number[]> {
    return (await ordersForItemsOf(userId, 100)).map((o) => o.id);
}

/** The best open order per item type, for the market ("Wanted"). */
export async function getTopBuyOrders(types?: string[]): Promise<BuyOrder[]> {
    const rows = await db
        .select(orderColumns)
        .from(buyOrdersTable)
        .leftJoin(usersTable, eq(usersTable.id, buyOrdersTable.buyerId))
        .where(
            and(
                eq(buyOrdersTable.status, "open"),
                gt(buyOrdersTable.expiresAt, new Date()),
                types?.length ? inArray(buyOrdersTable.type, types) : undefined,
            ),
        )
        .orderBy(desc(buyOrdersTable.amount))
        .limit(200);
    const best = new Map<string, OrderRow>();
    for (const r of rows) if (!best.has(r.type)) best.set(r.type, r);
    return [...best.values()].map(mapOrder);
}
