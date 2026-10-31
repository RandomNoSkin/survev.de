import { and, eq, gte, sql } from "drizzle-orm";
import { UnlockDefs } from "../../../../shared/defs/gameObjects/unlockDefs";
import {
    DUMP_VALUE,
    getItemCategory,
    MARKET_LISTING_TTL_MS,
} from "../../../../shared/defs/shopConfig";
import type { DumpItemResponse } from "../../../../shared/types/user";
import { archiveSales } from "./crates";
import { getGoldenFries } from "./goldenFries";
import { db } from "./index";
import { getOwnedLoadouts } from "./loadouts";
import {
    auctionsTable,
    goldenFriesLedgerTable,
    itemsTable,
    marketListingsTable,
    usersTable,
} from "./schema";

class DumpError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

/** Items every account gets for free - dumping them would just print fries on alts. */
const FREE_SOURCES = new Set(["unlock_new_account", "unlock_default"]);
const DEFAULT_TYPES = new Set(UnlockDefs.unlock_default?.unlocks ?? []);

/**
 * Destroys one of the player's items for a flat DUMP_VALUE Golden Fries. Listed or
 * auctioned items can't be dumped (cancel first), and neither can the free starter /
 * default cosmetics.
 */
export async function dumpItem(userId: string, itemId: number): Promise<DumpItemResponse> {
    try {
        const balance = await db.transaction(async (tx) => {
            const [item] = await tx
                .select({ type: itemsTable.type, userId: itemsTable.userId, source: itemsTable.source })
                .from(itemsTable)
                .where(eq(itemsTable.id, itemId))
                .for("update");
            if (!item || item.userId !== userId) throw new DumpError("not_owned");
            if (!getItemCategory(item.type)) throw new DumpError("not_dumpable");
            if (FREE_SOURCES.has(item.source) || DEFAULT_TYPES.has(item.type)) {
                throw new DumpError("starter_item");
            }

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
            if (listing) throw new DumpError("listed");
            const [auction] = await tx
                .select({ id: auctionsTable.id })
                .from(auctionsTable)
                .where(and(eq(auctionsTable.itemId, itemId), eq(auctionsTable.status, "active")));
            if (auction) throw new DumpError("auctioned");

            // keep its past sales in the price history, then destroy it
            await archiveSales(tx, itemId);
            const [gone] = await tx
                .delete(itemsTable)
                .where(and(eq(itemsTable.id, itemId), eq(itemsTable.userId, userId)))
                .returning({ id: itemsTable.id });
            if (!gone) throw new DumpError("not_owned");

            const [bal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} + ${DUMP_VALUE}` })
                .where(eq(usersTable.id, userId))
                .returning({ balance: usersTable.goldenFries });
            await tx.insert(goldenFriesLedgerTable).values({
                userId,
                amount: DUMP_VALUE,
                reason: `dump:${item.type}`,
                balanceAfter: bal.balance,
            });
            return bal.balance;
        });
        // Same self-heal as after a gift: if that was the last copy of an equipped item,
        // it comes out of the saved loadout right away.
        await getOwnedLoadouts([userId]).catch(() => {});
        return { success: true, fries: DUMP_VALUE, balance };
    } catch (err) {
        return {
            success: false,
            error: err instanceof DumpError ? err.code : "error",
            balance: await getGoldenFries(userId),
        };
    }
}
