import { and, eq, inArray, sql } from "drizzle-orm";
import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import { PassDefs } from "../../../../shared/defs/gameObjects/passDefs";
import { db } from "./index";
import { itemsTable, passItemGrantsTable } from "./schema";

/**
 * Pass item grants.
 *
 * Pass rewards are recorded in `pass_item_grants` (one row per grantKey) so each
 * reward is handed out exactly once — independent of whether the player still owns
 * the item. This prevents the "sell your pass item → reconcile re-grants it for free"
 * exploit once items become tradeable. The item is part of the key, so adding a new
 * item to a previously-empty pass level later will be granted on the next reconcile.
 */

function passGrantKey(passType: string, level: number, item: string): string {
    return `pass:${passType}:${level}:${item}`;
}

/** A pass entry is a real, grantable cosmetic (not empty and not the fries currency). */
function isGrantableItem(item: string): boolean {
    return !!item && item !== "golden_fries" && !!GameObjectDefs[item];
}

/**
 * Grants every pass cosmetic up to `level` that the user hasn't been granted yet.
 * Inserts one item instance per newly granted reward plus its grant marker, in a
 * single transaction. Returns how many new items were granted.
 */
export async function grantPassItems(
    userId: string,
    passType: string,
    level: number,
): Promise<number> {
    const passDef = PassDefs[passType];
    if (!passDef) return 0;

    const rewards = passDef.items.filter(
        (it) => it.level <= level && isGrantableItem(it.item),
    );
    if (rewards.length === 0) return 0;

    const keys = rewards.map((r) => passGrantKey(passType, r.level, r.item));
    const existing = await db
        .select({ grantKey: passItemGrantsTable.grantKey })
        .from(passItemGrantsTable)
        .where(
            and(
                eq(passItemGrantsTable.userId, userId),
                inArray(passItemGrantsTable.grantKey, keys),
            ),
        );
    const have = new Set(existing.map((e) => e.grantKey));

    const toGrant = rewards.filter(
        (r) => !have.has(passGrantKey(passType, r.level, r.item)),
    );
    if (toGrant.length === 0) return 0;

    const now = Date.now();
    const grantedCount = await db.transaction(async (tx) => {
        // Insert the grant markers FIRST: the PK (userId, grantKey) is the lock. A
        // concurrent transaction that loses the race gets no rows back here and so
        // inserts no duplicate item instances below — closing the duplication exploit.
        const inserted = await tx
            .insert(passItemGrantsTable)
            .values(
                toGrant.map((r) => ({
                    userId,
                    grantKey: passGrantKey(passType, r.level, r.item),
                })),
            )
            .onConflictDoNothing()
            .returning({ grantKey: passItemGrantsTable.grantKey });
        const insertedKeys = new Set(inserted.map((i) => i.grantKey));

        const itemsToInsert = toGrant.filter((r) =>
            insertedKeys.has(passGrantKey(passType, r.level, r.item)),
        );
        if (itemsToInsert.length > 0) {
            await tx.insert(itemsTable).values(
                itemsToInsert.map((r) => ({
                    userId,
                    type: r.item,
                    source: passType,
                    timeAcquired: now,
                })),
            );
        }
        return itemsToInsert.length;
    });

    return grantedCount;
}

/**
 * Inverse of grantPassItems: removes this pass's granted cosmetics for levels
 * ABOVE `level` (so lowering a pass level also takes back the items it gave).
 * Only removes item instances whose source is this pass and whose type is not
 * also a reward at or below the new level. Returns how many instances were removed.
 */
export async function revokePassItemsAbove(
    userId: string,
    passType: string,
    level: number,
): Promise<number> {
    const passDef = PassDefs[passType];
    if (!passDef) return 0;

    const above = passDef.items.filter(
        (it) => it.level > level && isGrantableItem(it.item),
    );
    if (above.length === 0) return 0;

    // Keep item types that are still earned at/below the new level.
    const keepTypes = new Set(
        passDef.items.filter((it) => it.level <= level).map((it) => it.item),
    );
    const removeTypes = [...new Set(above.map((it) => it.item))].filter(
        (t) => !keepTypes.has(t),
    );
    const aboveKeys = above.map((it) => passGrantKey(passType, it.level, it.item));

    return await db.transaction(async (tx) => {
        // Drop the grant markers so a later level-up re-grants them.
        await tx
            .delete(passItemGrantsTable)
            .where(
                and(
                    eq(passItemGrantsTable.userId, userId),
                    inArray(passItemGrantsTable.grantKey, aboveKeys),
                ),
            );

        if (removeTypes.length === 0) return 0;

        const removed = await tx
            .delete(itemsTable)
            .where(
                and(
                    eq(itemsTable.userId, userId),
                    eq(itemsTable.source, passType),
                    inArray(itemsTable.type, removeTypes),
                ),
            )
            .returning({ id: itemsTable.id });
        return removed.length;
    });
}

/**
 * One-time backfill so existing accounts don't get their pass items duplicated by
 * the first reconcile/get_pass under the new grant-ledger logic: for every pass
 * reward, mark it granted for every user who already owns that item type.
 *
 * Guarded to run only once (when `pass_item_grants` is still empty). Uses a single
 * INSERT…SELECT per reward so the database does the work.
 */
export async function backfillPassItemGrants(): Promise<void> {
    const already = await db
        .select({ userId: passItemGrantsTable.userId })
        .from(passItemGrantsTable)
        .limit(1);
    if (already.length > 0) return; // already backfilled

    let rewards = 0;
    for (const [passType, passDef] of Object.entries(PassDefs)) {
        for (const reward of passDef.items) {
            if (!isGrantableItem(reward.item)) continue;
            const key = passGrantKey(passType, reward.level, reward.item);
            await db.execute(sql`
                INSERT INTO pass_item_grants (user_id, grant_key)
                SELECT DISTINCT user_id, ${key} FROM items WHERE type = ${reward.item}
                ON CONFLICT DO NOTHING
            `);
            rewards++;
        }
    }
    console.log(`Backfilled pass item grants for ${rewards} pass rewards`);
}
