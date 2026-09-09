import { and, eq, inArray } from "drizzle-orm";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import { UnlockDefs } from "../../../../shared/defs/gameObjects/unlockDefs";
import { db } from "./index";
import { itemsTable, passItemGrantsTable } from "./schema";

/**
 * Premium-exclusive cosmetic unlocks (`UnlockDefs.unlock_premium`).
 *
 * Parallels `unlock_default`/`unlock_new_account`, but instead of a one-shot grant at
 * account creation, these are granted whenever an account has (or gets) an active
 * Premium subscription - see `grantPremiumUnlocks` below, called from the
 * `/premium/buy` route right alongside the pass-XP bonus.
 *
 * Idempotency reuses the existing `pass_item_grants` ledger table (a generic
 * `(userId, grantKey)` grant record, not actually pass-specific despite the table
 * name) with a distinctly-prefixed key (`account_premium_unlock:<item>`) so it can
 * never collide with a real pass's `pass:<passType>:<level>:<item>` keys - including
 * the *battle pass's own* unrelated "premium tier" concept some of those pass defs
 * already anticipate (see `PassDef.donatorSkin`), which this is NOT the same thing
 * as. This only ever GRANTS, never revokes - once unlocked, a premium-exclusive
 * cosmetic stays owned even if the subscription later lapses (a deliberate choice,
 * not an oversight: revoking on lapse is a separate product decision to make later).
 */

function premiumUnlockGrantKey(item: string): string {
    return `account_premium_unlock:${item}`;
}

/** A listed unlock is a real, grantable cosmetic (matches passGrants.ts's isGrantableItem). */
function isGrantableItem(item: string): boolean {
    return !!item && !!GameObjectDefs.typeToDefSafe(item);
}

/**
 * Grants every cosmetic in `UnlockDefs.unlock_premium.unlocks` the user hasn't
 * already received. Safe to call on every Premium purchase/renewal (not just the
 * first) - already-granted items are skipped via the grant-ledger lock, so nothing
 * is ever duplicated. A no-op today since the unlock list starts empty; starts
 * granting automatically the moment cosmetics are added to it. Returns how many new
 * items were granted.
 */
export async function grantPremiumUnlocks(userId: string): Promise<number> {
    const rewards = UnlockDefs.unlock_premium.unlocks.filter(isGrantableItem);
    if (rewards.length === 0) return 0;

    const keys = rewards.map(premiumUnlockGrantKey);
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

    const toGrant = rewards.filter((item) => !have.has(premiumUnlockGrantKey(item)));
    if (toGrant.length === 0) return 0;

    const now = Date.now();
    return db.transaction(async (tx) => {
        // Insert the grant markers FIRST: the PK (userId, grantKey) is the lock, same
        // idiom as grantPassItems - a concurrent transaction that loses the race gets
        // no rows back and so grants no duplicate item instances below.
        const inserted = await tx
            .insert(passItemGrantsTable)
            .values(toGrant.map((item) => ({ userId, grantKey: premiumUnlockGrantKey(item) })))
            .onConflictDoNothing()
            .returning({ grantKey: passItemGrantsTable.grantKey });
        const insertedKeys = new Set(inserted.map((i) => i.grantKey));

        const itemsToInsert = toGrant.filter((item) =>
            insertedKeys.has(premiumUnlockGrantKey(item)),
        );
        if (itemsToInsert.length > 0) {
            await tx.insert(itemsTable).values(
                itemsToInsert.map((item) => ({
                    userId,
                    type: item,
                    source: "unlock_premium",
                    timeAcquired: now,
                })),
            );
        }
        return itemsToInsert.length;
    });
}
