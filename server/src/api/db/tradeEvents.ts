import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { TRADE_EVENT_TTL_MS } from "../../../../shared/defs/shopConfig";
import type { TradeEvent, TradeEventKind } from "../../../../shared/types/user";
import { db } from "./index";
import { tradeEventsTable } from "./schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Records a trade notification for `userId` ("your item sold", "you were outbid", ...).
 * Pass the trade's transaction so the event only exists if the trade went through.
 */
export async function addTradeEvent(
    tx: Tx | typeof db,
    userId: string,
    kind: TradeEventKind,
    type: string,
    amount: number | null,
    otherSlug: string | null,
) {
    await tx.insert(tradeEventsTable).values({ userId, kind, type, amount, otherSlug });
}

/** The player's unseen events, oldest first (at most 50). */
export async function getUnseenTradeEvents(userId: string): Promise<TradeEvent[]> {
    const rows = await db
        .select()
        .from(tradeEventsTable)
        .where(and(eq(tradeEventsTable.userId, userId), eq(tradeEventsTable.seen, false)))
        .orderBy(asc(tradeEventsTable.createdAt))
        .limit(50);
    return rows.map((r) => ({
        id: r.id,
        kind: r.kind as TradeEventKind,
        type: r.type,
        amount: r.amount,
        otherSlug: r.otherSlug,
        createdAt: r.createdAt.getTime(),
    }));
}

export async function markTradeEventsSeen(userId: string, ids: number[]) {
    if (!ids.length) return;
    await db
        .update(tradeEventsTable)
        .set({ seen: true })
        .where(and(eq(tradeEventsTable.userId, userId), inArray(tradeEventsTable.id, ids)));
}

/** Drops events older than the TTL (seen or not). */
export async function pruneTradeEvents(): Promise<number> {
    const rows = await db
        .delete(tradeEventsTable)
        .where(lt(tradeEventsTable.createdAt, new Date(Date.now() - TRADE_EVENT_TTL_MS)))
        .returning({ id: tradeEventsTable.id });
    return rows.length;
}
