import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "../..";
import {
    databaseEnabledMiddleware,
    rateLimitMiddleware,
    validateParams,
} from "../../auth/middleware";
import { db } from "../../db";
import { itemsTable, marketListingsTable, usersTable } from "../../db/schema";

export const UserLoadoutRouter = new Hono<Context>();

const zUserLoadoutRequest = z.object({ slug: z.string().min(1) });

/**
 * Public, read-only: a player's equipped loadout plus their full owned-cosmetic
 * collection (deduped per type) for the stats-page loadout viewer. Each entry also
 * carries whether the player currently has an active market listing for that type
 * (and its cheapest ask), so the viewer can link straight to their storefront.
 */
UserLoadoutRouter.post(
    "/",
    databaseEnabledMiddleware,
    rateLimitMiddleware(60, 60 * 1000),
    validateParams(zUserLoadoutRequest),
    async (c) => {
        const { slug } = c.req.valid("json");
        const user = await db.query.usersTable.findFirst({
            where: eq(usersTable.slug, slug),
            columns: {
                id: true,
                slug: true,
                loadout: true,
                username: true,
                loadoutPrivate: true,
            },
        });
        if (!user) return c.json({ found: false }, 200);

        // The owner chose to hide their loadout from public view.
        if (user.loadoutPrivate) {
            return c.json({ found: true, private: true, username: user.username }, 200);
        }

        const owned = await db
            .select({ id: itemsTable.id, type: itemsTable.type })
            .from(itemsTable)
            .where(eq(itemsTable.userId, user.id));

        const listings = await db
            .select({
                type: marketListingsTable.type,
                price: marketListingsTable.price,
            })
            .from(marketListingsTable)
            .where(
                and(
                    eq(marketListingsTable.sellerId, user.id),
                    eq(marketListingsTable.status, "active"),
                ),
            );

        // Cheapest active ask per type (also serves as the "is on market" flag).
        const marketByType = new Map<string, number>();
        for (const l of listings) {
            const cur = marketByType.get(l.type);
            if (cur === undefined || l.price < cur) marketByType.set(l.type, l.price);
        }

        // Dedupe owned instances into one entry per type, keeping a copy count + a
        // representative instance id (smallest) so viewers can make a buy-offer on it.
        const byType = new Map<string, { count: number; itemId: number }>();
        for (const it of owned) {
            const e = byType.get(it.type);
            if (e) {
                e.count += 1;
                if (it.id < e.itemId) e.itemId = it.id;
            } else {
                byType.set(it.type, { count: 1, itemId: it.id });
            }
        }

        const items = [...byType.entries()].map(([type, e]) => ({
            type,
            count: e.count,
            itemId: e.itemId,
            onMarket: marketByType.has(type),
            price: marketByType.get(type) ?? null,
        }));

        return c.json(
            {
                found: true,
                username: user.username,
                slug: user.slug,
                loadout: user.loadout,
                items,
            },
            200,
        );
    },
);
