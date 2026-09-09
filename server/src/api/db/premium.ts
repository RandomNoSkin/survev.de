import { and, eq, gte, sql } from "drizzle-orm";
import { GameConfig } from "../../../../shared/gameConfig";
import { getGoldenFries } from "./goldenFries";
import { db } from "./index";
import { getPassLevelXp } from "./passReconcile";
import { setPassXp } from "./passXp";
import {
    goldenFriesLedgerTable,
    premiumXpGrantsTable,
    userXpTable,
    usersTable,
} from "./schema";

/** Golden Fries cost of one Premium purchase (grants/extends by PREMIUM_DURATION). */
export const PREMIUM_COST_FRIES = 3000;

/** Every Premium purchase/renewal also gifts this many pass levels' worth of XP. */
export const PREMIUM_BONUS_PASS_LEVELS = 20;

/** Cumulative XP required to go from level 1 to `levels` in the given pass. */
function xpForLevels(passType: string, levels: number): number {
    let total = 0;
    for (let lvl = 1; lvl < levels; lvl++) total += getPassLevelXp(passType, lvl);
    return total;
}

/**
 * Gifts `PREMIUM_BONUS_PASS_LEVELS` levels' worth of XP (× `times`, for the admin
 * grant modal's "how many times over" option - a real purchase always passes the
 * default 1) on the account's CURRENT pass, on top of whatever XP they already have.
 * Fires on every successful Premium purchase/renewal (by design - see the buyPremium
 * caller), not just the first. Reuses `setPassXp`'s absolute-set cascade (derives the
 * new level, grants any pass cosmetics/Golden Fries owed for levels just crossed) so
 * this can't leave cosmetics/fries out of sync with the new XP total.
 *
 * `setPassXp` also anchors `reconcileBaseXp`/`reconcileFrom` to this new total, so
 * `reconcileAllPasses` treats it as the floor going forward (old matches aren't
 * re-counted under it) and — being ratchet-up-only anyway — can never lower it back
 * out. The `premium_xp_grants` row is purely an audit trail for the dashboard.
 */
export async function grantPremiumPassXp(userId: string, times = 1): Promise<void> {
    if (times <= 0) return;
    const passType = GameConfig.serverSettings.currentPass;
    const xpToAdd = xpForLevels(passType, PREMIUM_BONUS_PASS_LEVELS) * times;

    const existing = await db.query.userXpTable.findFirst({
        where: and(eq(userXpTable.userId, userId), eq(userXpTable.passType, passType)),
        columns: { xp: true },
    });
    const currentXp = existing ? Number(existing.xp) : 0;

    await setPassXp(userId, passType, currentXp + xpToAdd);
    await db.insert(premiumXpGrantsTable).values({
        userId,
        passType,
        xpGranted: String(xpToAdd),
    });
}

/**
 * Reverts every XP bonus this account has ever been granted via Premium, across every
 * pass it was granted on (an account can span multiple pass rotations over its Premium
 * history) - for the admin "remove Premium + XP" action. Subtracts the ledger total for
 * each pass from that pass's CURRENT xp (clamped at 0, in case it's somehow already
 * lower - never goes negative) via `setPassXp`'s cascade, so cosmetics/fries above the
 * new level are revoked too. Records a matching negative `premium_xp_grants` entry per
 * pass (the actual amount subtracted, not necessarily the full ledger total, if
 * clamping kicked in) so the ledger's running sum always reflects what's still "in"
 * the account's xp - keeps it a true signed ledger, same idea as goldenFriesLedgerTable,
 * rather than deleting rows and losing the audit trail.
 */
export async function revokePremiumPassXp(userId: string): Promise<void> {
    const grants = await db
        .select({
            passType: premiumXpGrantsTable.passType,
            total: sql<string>`sum(${premiumXpGrantsTable.xpGranted})`,
        })
        .from(premiumXpGrantsTable)
        .where(eq(premiumXpGrantsTable.userId, userId))
        .groupBy(premiumXpGrantsTable.passType);

    for (const g of grants) {
        const toRevoke = Number(g.total);
        if (toRevoke <= 0) continue;

        const existing = await db.query.userXpTable.findFirst({
            where: and(eq(userXpTable.userId, userId), eq(userXpTable.passType, g.passType)),
            columns: { xp: true },
        });
        const currentXp = existing ? Number(existing.xp) : 0;
        const newXp = Math.max(0, currentXp - toRevoke);
        const actuallyRevoked = currentXp - newXp;
        if (actuallyRevoked <= 0) continue;

        await setPassXp(userId, g.passType, newXp);
        await db.insert(premiumXpGrantsTable).values({
            userId,
            passType: g.passType,
            xpGranted: String(-actuallyRevoked),
        });
    }
}

/** Whether a `premiumUntil` timestamp currently grants Premium (null = never bought). */
export function isPremiumActive(premiumUntil: Date | null): boolean {
    return premiumUntil != null && premiumUntil.getTime() > Date.now();
}

/**
 * Buys/extends Premium for a user: deducts `PREMIUM_COST_FRIES` and pushes
 * `premiumUntil` out by 2 months from whichever is later - "now" or the account's
 * current expiry (so buying early while still Premium adds on top instead of
 * wasting the remaining time). Balance guard + extension happen in one atomic
 * UPDATE so concurrent double-clicks can't overdraw or double-grant.
 */
export async function buyPremium(
    userId: string,
): Promise<{ success: boolean; balance: number; premiumUntil?: Date; error?: string }> {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .update(usersTable)
            .set({
                goldenFries: sql`${usersTable.goldenFries} - ${PREMIUM_COST_FRIES}`,
                premiumUntil: sql`GREATEST(COALESCE(${usersTable.premiumUntil}, now()), now()) + interval '2 months'`,
            })
            .where(
                and(eq(usersTable.id, userId), gte(usersTable.goldenFries, PREMIUM_COST_FRIES)),
            )
            .returning({ balance: usersTable.goldenFries, premiumUntil: usersTable.premiumUntil });

        if (!row) {
            const current = await getGoldenFries(userId);
            return { success: false, balance: current, error: "insufficient_funds" };
        }

        await tx.insert(goldenFriesLedgerTable).values({
            userId,
            amount: -PREMIUM_COST_FRIES,
            reason: "premium",
            balanceAfter: row.balance,
        });

        return { success: true, balance: row.balance, premiumUntil: row.premiumUntil ?? undefined };
    });
}

/**
 * Sentinel expiry for "permanent" Premium - far enough out to never realistically
 * lapse, without needing a separate `permanent` column/schema change. `isPremiumActive`
 * and every other consumer just compare against `now()` as usual, so nothing else
 * needs to know this is a special value.
 */
export const PERMANENT_PREMIUM_DATE = new Date("9999-12-31T23:59:59Z");

/**
 * Admin/moderation grant - extends Premium by `months` for free (no Golden Fries
 * deduction), same "later of now or current expiry" extension rule as `buyPremium`.
 * Returns the new expiry.
 */
export async function grantPremiumMonths(userId: string, months: number): Promise<Date> {
    const [row] = await db
        .update(usersTable)
        .set({
            premiumUntil: sql`GREATEST(COALESCE(${usersTable.premiumUntil}, now()), now()) + (INTERVAL '1 month' * ${months})`,
        })
        .where(eq(usersTable.id, userId))
        .returning({ premiumUntil: usersTable.premiumUntil });
    return row.premiumUntil!;
}

/** Admin/moderation grant - Premium that never expires (see PERMANENT_PREMIUM_DATE). */
export async function grantPremiumPermanent(userId: string): Promise<Date> {
    await db
        .update(usersTable)
        .set({ premiumUntil: PERMANENT_PREMIUM_DATE })
        .where(eq(usersTable.id, userId));
    return PERMANENT_PREMIUM_DATE;
}

/** Admin/moderation action - immediately clears Premium regardless of remaining time. */
export async function removePremium(userId: string): Promise<void> {
    await db.update(usersTable).set({ premiumUntil: null }).where(eq(usersTable.id, userId));
}
