import { sql } from "drizzle-orm";
import type { TradePriceStats, TradeSale } from "../../../../shared/types/user";
import { db } from "./index";

const STATS_WINDOW_DAYS = 30;

/**
 * Every completed player-to-player sale, from the four ways an item can change hands:
 * bought listings, settled auctions, accepted offers and filled buy orders, plus the
 * archived sales of items that were used up since. `price` is what the seller asked /
 * agreed to (auctions: the winning bid).
 */
const SALES = sql`(
    SELECT type, price, 'listing' AS kind, closed_at AS at FROM market_listings
        WHERE status = 'sold' AND closed_at IS NOT NULL
    UNION ALL
    SELECT type, current_bid AS price, 'auction' AS kind, ends_at AS at FROM auctions
        WHERE status = 'settled' AND current_bid IS NOT NULL
    UNION ALL
    SELECT type, COALESCE(counter_amount, amount) AS price, 'offer' AS kind, updated_at AS at FROM offers
        WHERE status = 'accepted'
    UNION ALL
    SELECT type, amount AS price, 'order' AS kind, closed_at AS at FROM buy_orders
        WHERE status = 'filled' AND closed_at IS NOT NULL
    UNION ALL
    SELECT type, price, kind, at FROM trade_sales_archive
) AS sales`;

const rows = (r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

/** The latest sales, newest first - of one item type, or of everything. */
export async function getRecentSales(type?: string, limit = 20): Promise<TradeSale[]> {
    const res = await db.execute(sql`
        SELECT type, price, kind, at FROM ${SALES}
        ${type ? sql`WHERE type = ${type}` : sql``}
        ORDER BY at DESC LIMIT ${limit}
    `);
    return rows(res).map((r) => ({
        type: String(r.type),
        price: Number(r.price),
        kind: String(r.kind),
        at: new Date(r.at as string).getTime(),
    }));
}

/** Price stats of one item type: last sale, and avg/min/max/count over 30 days. */
export async function getPriceStats(type: string): Promise<TradePriceStats | null> {
    const res = await db.execute(sql`
        SELECT
            (SELECT price FROM ${SALES} WHERE type = ${type} ORDER BY at DESC LIMIT 1) AS last,
            AVG(price) AS avg, MIN(price) AS min, MAX(price) AS max, COUNT(*) AS count
        FROM ${SALES}
        WHERE type = ${type} AND at > now() - make_interval(days => ${STATS_WINDOW_DAYS})
    `);
    const r = rows(res)[0];
    if (!r || r.last == null) return null;
    const count = Number(r.count);
    const last = Number(r.last);
    // no sale in the window: the last one still says something
    return {
        last,
        avg: count ? Math.round(Number(r.avg)) : last,
        min: count ? Number(r.min) : last,
        max: count ? Number(r.max) : last,
        count,
    };
}
