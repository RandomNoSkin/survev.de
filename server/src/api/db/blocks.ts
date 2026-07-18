import { and, eq, or } from "drizzle-orm";
import type { BlockedUser, FriendActionResponse } from "../../../../shared/types/user";
import { db } from "./index";
import { blocksTable, friendsTable, usersTable } from "./schema";

/** Resolves a slug to a user id (null if no such user). */
async function resolveUser(slug: string): Promise<string | null> {
    const [row] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.slug, slug.trim().toLowerCase()));
    return row?.id ?? null;
}

/**
 * True when either player has blocked the other. A block cuts interaction BOTH ways: the
 * blocked player can't reach the blocker, and the blocker doesn't reach out either. Used
 * as a guard by friend requests, buy-offers and gifts.
 */
export async function isBlockedBetween(a: string, b: string): Promise<boolean> {
    const [row] = await db
        .select({ userId: blocksTable.userId })
        .from(blocksTable)
        .where(
            or(
                and(eq(blocksTable.userId, a), eq(blocksTable.blockedId, b)),
                and(eq(blocksTable.userId, b), eq(blocksTable.blockedId, a)),
            ),
        )
        .limit(1);
    return !!row;
}

/**
 * Blocks `slug` for `userId`. Also tears down any existing relationship: the friendship /
 * pending requests between the two are removed in both directions, so a block always ends
 * up in a clean "no connection" state.
 */
export async function blockUser(
    userId: string,
    slug: string,
): Promise<FriendActionResponse> {
    const blockedId = await resolveUser(slug);
    if (!blockedId) return { success: false, error: "not_found" };
    if (blockedId === userId) return { success: false, error: "self" };

    await db.transaction(async (tx) => {
        await tx.insert(blocksTable).values({ userId, blockedId }).onConflictDoNothing();
        // Drop friendship / pending requests in both directions.
        await tx
            .delete(friendsTable)
            .where(
                or(
                    and(
                        eq(friendsTable.userId, userId),
                        eq(friendsTable.friendId, blockedId),
                    ),
                    and(
                        eq(friendsTable.userId, blockedId),
                        eq(friendsTable.friendId, userId),
                    ),
                ),
            );
    });
    return { success: true };
}

/** Lifts `userId`'s block on `slug` (no relationship is restored). */
export async function unblockUser(
    userId: string,
    slug: string,
): Promise<FriendActionResponse> {
    const blockedId = await resolveUser(slug);
    if (!blockedId) return { success: false, error: "not_found" };
    await db
        .delete(blocksTable)
        .where(and(eq(blocksTable.userId, userId), eq(blocksTable.blockedId, blockedId)));
    return { success: true };
}

/** The accounts `userId` has blocked (for the Social panel's Blocked list). */
export async function getBlocked(userId: string): Promise<BlockedUser[]> {
    const rows = await db
        .select({ slug: usersTable.slug, username: usersTable.username })
        .from(blocksTable)
        .innerJoin(usersTable, eq(usersTable.id, blocksTable.blockedId))
        .where(eq(blocksTable.userId, userId));
    return rows.map((r) => ({ slug: r.slug, username: r.username || r.slug }));
}
