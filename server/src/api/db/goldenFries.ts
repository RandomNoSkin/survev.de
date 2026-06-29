import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
    DEFAULT_PASS_GOLDEN_FRIES,
    PassDefs,
} from "../../../../shared/defs/gameObjects/passDefs";
import { db } from "./index";
import { goldenFriesLedgerTable, usersTable } from "./schema";

// Re-exported for backwards compatibility; the source of truth now lives in passDefs.
export { DEFAULT_PASS_GOLDEN_FRIES };

/**
 * One-time "welcome" Golden Fries every account receives — on creation AND,
 * retroactively, for all existing accounts (via {@link backfillWelcomeGoldenFries},
 * run by the reconcile job). Set to 0 to disable. Tune freely.
 */
export const WELCOME_GOLDEN_FRIES = 100;
/** `pass:` prefix so the partial unique index dedupes it (granted at most once per user). */
const WELCOME_FRIES_REASON = "pass:welcome_fries";

/** Stable, per-(pass, level) ledger reason, used to detect what's already been paid out. */
function passFriesReason(passType: string, level: number): string {
    return `pass:${passType}:level:${level}`;
}

/**
 * Golden Fries — the account-bound in-game currency.
 *
 * The authoritative balance lives in `users.golden_fries`; every change is also
 * recorded in `golden_fries_ledger` for a full audit trail. Always go through
 * these helpers so the balance and the ledger stay consistent (both writes happen
 * inside a single transaction).
 */

/** Returns the current Golden Fries balance for a user (0 if the user does not exist). */
export async function getGoldenFries(userId: string): Promise<number> {
    const row = await db.query.usersTable.findFirst({
        where: eq(usersTable.id, userId),
        columns: { goldenFries: true },
    });
    return row?.goldenFries ?? 0;
}

/**
 * Awards Golden Fries (or, with a negative `amount`, deducts them) atomically and
 * records a ledger entry. Returns the new balance.
 *
 * This is the primitive the earn logic (e.g. the pass system) calls, e.g.
 * `await awardGoldenFries(user.id, friesForLevelUp, "pass_level")`.
 */
export async function awardGoldenFries(
    userId: string,
    amount: number,
    reason: string,
): Promise<number> {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .update(usersTable)
            .set({ goldenFries: sql`${usersTable.goldenFries} + ${amount}` })
            .where(eq(usersTable.id, userId))
            .returning({ balance: usersTable.goldenFries });

        const balanceAfter = row?.balance ?? 0;

        await tx.insert(goldenFriesLedgerTable).values({
            userId,
            amount,
            reason,
            balanceAfter,
        });

        return balanceAfter;
    });
}

/**
 * Idempotently awards Golden Fries for a one-time event keyed by `reason`. The ledger
 * row IS the lock: a partial unique index on `(user_id, reason) WHERE reason LIKE 'pass:%'`
 * makes a duplicate insert a no-op, so concurrent `/get_pass`, reconcile, and the daily
 * cron can never double-pay the same pass level. Returns the amount awarded (0 if it was
 * already paid out). `reason` MUST start with `pass:` for the uniqueness guard to apply.
 */
export async function awardGoldenFriesOnce(
    userId: string,
    amount: number,
    reason: string,
): Promise<number> {
    return db.transaction(async (tx) => {
        // Insert the ledger row as the idempotency lock (no-op if already awarded).
        const inserted = await tx.execute(sql`
            INSERT INTO golden_fries_ledger (user_id, amount, reason, balance_after)
            VALUES (${userId}, ${amount}, ${reason}, 0)
            ON CONFLICT (user_id, reason) WHERE reason LIKE 'pass:%' DO NOTHING
            RETURNING id
        `);
        const ledgerId = (inserted.rows[0] as { id: number } | undefined)?.id;
        if (ledgerId == null) return 0; // already paid out for this reason

        const [row] = await tx
            .update(usersTable)
            .set({ goldenFries: sql`${usersTable.goldenFries} + ${amount}` })
            .where(eq(usersTable.id, userId))
            .returning({ balance: usersTable.goldenFries });
        const balanceAfter = row?.balance ?? 0;

        // Backfill the real post-balance onto the ledger row inserted above.
        await tx
            .update(goldenFriesLedgerTable)
            .set({ balanceAfter })
            .where(eq(goldenFriesLedgerTable.id, ledgerId));

        return amount;
    });
}

/**
 * Spends Golden Fries if the balance is sufficient. The balance check and the
 * deduction happen in one atomic UPDATE, so concurrent spends can't overdraw.
 * Returns `{ success, balance }` — on failure the balance is left unchanged.
 *
 * Foundation for a future shop; currently has no caller.
 */
export async function spendGoldenFries(
    userId: string,
    amount: number,
    reason: string,
): Promise<{ success: boolean; balance: number }> {
    return db.transaction(async (tx) => {
        const [row] = await tx
            .update(usersTable)
            .set({ goldenFries: sql`${usersTable.goldenFries} - ${amount}` })
            .where(and(eq(usersTable.id, userId), gte(usersTable.goldenFries, amount)))
            .returning({ balance: usersTable.goldenFries });

        if (!row) {
            // Insufficient funds (or unknown user) — report the unchanged balance.
            const current = await getGoldenFries(userId);
            return { success: false, balance: current };
        }

        await tx.insert(goldenFriesLedgerTable).values({
            userId,
            amount: -amount,
            reason,
            balanceAfter: row.balance,
        });

        return { success: true, balance: row.balance };
    });
}

/**
 * Incrementally pays out pass Golden Fries for the levels a player has just crossed,
 * i.e. `oldLevel < rewardLevel <= newLevel`. Returns the total newly awarded.
 *
 * Cheap by design — no ledger read. Idempotency relies on the caller only advancing
 * the persisted pass level once per crossing (which `/get_pass` does). Each rewarded
 * level writes one ledger row using the SAME per-level reason as
 * {@link reconcilePassGoldenFries}, so the two paths never double-pay each other.
 *
 * This is the per-request grant; the retroactive backfill lives in reconcile.
 */
export async function awardNewPassGoldenFries(
    userId: string,
    passType: string,
    oldLevel: number,
    newLevel: number,
): Promise<number> {
    const passDef = PassDefs[passType];
    if (!passDef) return 0;

    let totalAwarded = 0;
    for (const item of passDef.items) {
        if (item.item !== "golden_fries") continue;
        if (item.level <= oldLevel || item.level > newLevel) continue;

        const amount = item.amount ?? DEFAULT_PASS_GOLDEN_FRIES;
        // Idempotent: returns 0 if a concurrent request already paid this level.
        totalAwarded += await awardGoldenFriesOnce(
            userId,
            amount,
            passFriesReason(passType, item.level),
        );
    }

    return totalAwarded;
}

/**
 * Reconciles a user's pass Golden Fries: grants every `golden_fries` reward in the
 * given pass up to `level` that hasn't been paid out yet, and returns the total newly
 * awarded.
 *
 * Idempotent — each (pass, level) reward writes exactly one ledger row with a stable
 * reason, so re-running only fills gaps. This produces the retroactive "flood" for
 * players who already passed those levels before the reward existed, and self-heals if
 * rewards are added/changed later. Intended to be triggered manually (moderation
 * button), NOT on every `/get_pass`.
 */
export async function reconcilePassGoldenFries(
    userId: string,
    passType: string,
    level: number,
): Promise<number> {
    const passDef = PassDefs[passType];
    if (!passDef) return 0;

    const rewards = passDef.items.filter(
        (item) => item.item === "golden_fries" && item.level <= level,
    );
    if (rewards.length === 0) return 0;

    // Which of these reward levels have already been paid out for this user?
    const reasons = rewards.map((r) => passFriesReason(passType, r.level));
    const existing = await db
        .select({ reason: goldenFriesLedgerTable.reason })
        .from(goldenFriesLedgerTable)
        .where(
            and(
                eq(goldenFriesLedgerTable.userId, userId),
                inArray(goldenFriesLedgerTable.reason, reasons),
            ),
        );
    const alreadyGranted = new Set(existing.map((e) => e.reason));

    let totalAwarded = 0;
    for (const reward of rewards) {
        const reason = passFriesReason(passType, reward.level);
        if (alreadyGranted.has(reason)) continue; // cheap skip; the insert below is the real lock

        const amount = reward.amount ?? DEFAULT_PASS_GOLDEN_FRIES;
        // Idempotent even if the pre-read above raced a concurrent payout.
        totalAwarded += await awardGoldenFriesOnce(userId, amount, reason);
    }

    return totalAwarded;
}

/** Idempotently grants the welcome Golden Fries to one user (no-op if already granted or disabled). */
export async function awardWelcomeGoldenFries(userId: string): Promise<number> {
    if (WELCOME_GOLDEN_FRIES <= 0) return 0;
    return awardGoldenFriesOnce(userId, WELCOME_GOLDEN_FRIES, WELCOME_FRIES_REASON);
}

/**
 * Retroactively grants the welcome Golden Fries to every account that hasn't received
 * it yet (idempotent, set-based). Returns the total newly awarded. Run by the reconcile.
 */
export async function backfillWelcomeGoldenFries(): Promise<number> {
    if (WELCOME_GOLDEN_FRIES <= 0) return 0;
    return db.transaction(async (tx) => {
        // One welcome ledger row per user that doesn't have it yet; `balance_after` is
        // the post-grant balance (current + amount), computed before the update below.
        const inserted = await tx.execute(sql`
            INSERT INTO golden_fries_ledger (user_id, amount, reason, balance_after)
            SELECT id, ${WELCOME_GOLDEN_FRIES}, ${WELCOME_FRIES_REASON}, golden_fries + ${WELCOME_GOLDEN_FRIES}
            FROM users
            ON CONFLICT (user_id, reason) WHERE reason LIKE 'pass:%' DO NOTHING
            RETURNING user_id
        `);
        const userIds = inserted.rows.map((r) => (r as { user_id: string }).user_id);
        if (!userIds.length) return 0;

        await tx
            .update(usersTable)
            .set({ goldenFries: sql`${usersTable.goldenFries} + ${WELCOME_GOLDEN_FRIES}` })
            .where(inArray(usersTable.id, userIds));

        return userIds.length * WELCOME_GOLDEN_FRIES;
    });
}
