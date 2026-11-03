import { and, asc, eq, gt } from "drizzle-orm";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import { db } from "./index";
import { isPremiumActive } from "./premium";
import { grantPremiumUnlocks } from "./premiumUnlocks";
import { goldenFriesLedgerTable, itemsTable, passItemGrantsTable, usersTable } from "./schema";

/**
 * Items every Premium PURCHASE gives, once per purchase (buying twice gets them twice).
 *
 * Adding an entry here is retroactive: every account whose Premium is active when the
 * server starts gets it for each purchase of its current Premium stretch (the purchases
 * since its last lapse). An account whose Premium already ran out gets nothing - it
 * gets the entry with its next purchase, like everyone buying from then on.
 *
 * `id` must never change or be reused - it is the grant ledger key (an id already
 * paid out is never paid out again, so renaming one pays everyone a second time).
 * `items`: item type -> how many per purchase.
 *
 * Example: { id: "keys_2026_11", items: { key_gold: 2 } }
 */
export const PREMIUM_PURCHASE_REWARDS: { id: string; items: Record<string, number> }[] = [];

/** How long one purchase extends Premium (see buyPremium's `interval '2 months'`). */
const PURCHASE_MONTHS = 2;

function rewardGrantKey(rewardId: string, purchaseId: number): string {
    return `premium_reward:${rewardId}:${purchaseId}`;
}

/**
 * The purchases (fries ledger rows, reason "premium") of the user's current Premium
 * stretch: walks them in order with the same "extend from the later of now or the
 * expiry" rule as buyPremium, starting over after every lapse. Admin grants aren't
 * purchases and don't appear here.
 */
async function currentStretchPurchases(userId: string): Promise<number[]> {
    const rows = await db
        .select({ id: goldenFriesLedgerTable.id, at: goldenFriesLedgerTable.createdAt })
        .from(goldenFriesLedgerTable)
        .where(and(eq(goldenFriesLedgerTable.userId, userId), eq(goldenFriesLedgerTable.reason, "premium")))
        .orderBy(asc(goldenFriesLedgerTable.createdAt), asc(goldenFriesLedgerTable.id));
    let stretch: number[] = [];
    let expiry: Date | undefined;
    for (const r of rows) {
        if (expiry && r.at > expiry) stretch = [];
        const from = expiry && expiry > r.at ? expiry : r.at;
        expiry = new Date(from);
        expiry.setMonth(expiry.getMonth() + PURCHASE_MONTHS);
        stretch.push(r.id);
    }
    return stretch;
}

/**
 * Pays out every PREMIUM_PURCHASE_REWARDS entry the user is owed for the purchases of
 * their current Premium stretch and hasn't got yet. No-op without active Premium.
 * Idempotent (the grant ledger row per reward + purchase is the lock), so safe to call
 * on every purchase and at every server start. Returns how many items were granted.
 */
export async function grantPremiumRewards(userId: string): Promise<number> {
    const rewards = PREMIUM_PURCHASE_REWARDS.filter((r) =>
        Object.entries(r.items).every(([type, n]) => n > 0 && !!GameObjectDefs.typeToDefSafe(type)),
    );
    if (!rewards.length) return 0;
    const [user] = await db
        .select({ premiumUntil: usersTable.premiumUntil })
        .from(usersTable)
        .where(eq(usersTable.id, userId));
    if (!user || !isPremiumActive(user.premiumUntil)) return 0;
    const purchases = await currentStretchPurchases(userId);
    if (!purchases.length) return 0;

    const owed = rewards.flatMap((r) => purchases.map((p) => ({ key: rewardGrantKey(r.id, p), items: r.items })));
    const now = Date.now();
    return db.transaction(async (tx) => {
        // grant markers first: the (userId, grantKey) PK is the lock, as in grantPremiumUnlocks
        const inserted = await tx
            .insert(passItemGrantsTable)
            .values(owed.map((o) => ({ userId, grantKey: o.key })))
            .onConflictDoNothing()
            .returning({ grantKey: passItemGrantsTable.grantKey });
        const got = new Set(inserted.map((i) => i.grantKey));
        const items = owed
            .filter((o) => got.has(o.key))
            .flatMap((o) =>
                Object.entries(o.items).flatMap(([type, n]) =>
                    Array.from({ length: n }, () => ({ userId, type, source: "premium_reward", timeAcquired: now })),
                ),
            );
        if (items.length) await tx.insert(itemsTable).values(items);
        return items.length;
    });
}

/**
 * Catches every account with active Premium up on the per-purchase rewards and the
 * premium-exclusive unlocks - run at server start, so a deploy that adds one pays it
 * out right away.
 */
export async function grantPremiumFeaturesToActive(): Promise<{ users: number; items: number }> {
    const users = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(gt(usersTable.premiumUntil, new Date()));
    let items = 0;
    for (const u of users) {
        items += await grantPremiumRewards(u.id);
        items += await grantPremiumUnlocks(u.id);
    }
    return { users: users.length, items };
}
