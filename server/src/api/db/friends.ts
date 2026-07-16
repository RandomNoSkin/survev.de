import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type {
    Friend,
    FriendActionResponse,
    RecentPlayer,
} from "../../../../shared/types/user";
import { isBlockedBetween } from "./blocks";
import { db } from "./index";
import { friendsTable, matchDataTable, usersTable } from "./schema";

/** Resolves a slug to a user id (null if no such user). */
async function resolveUser(slug: string): Promise<string | null> {
    const [row] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.slug, slug.trim().toLowerCase()));
    return row?.id ?? null;
}

/** Marks a (userId → friendId) row as accepted, inserting it if missing. */
async function upsertAccepted(userId: string, friendId: string) {
    await db
        .insert(friendsTable)
        .values({ userId, friendId, status: "accepted" })
        .onConflictDoUpdate({
            target: [friendsTable.userId, friendsTable.friendId],
            set: { status: "accepted" },
        });
}

/**
 * Sends a friend request to `slug`. Idempotent: no-op if already friends or already
 * requested. If the other player has already requested the caller, this accepts that
 * request instead (mutual requests auto-accept).
 */
export async function sendFriendRequest(
    userId: string,
    slug: string,
): Promise<FriendActionResponse> {
    const friendId = await resolveUser(slug);
    if (!friendId) return { success: false, error: "not_found" };
    if (friendId === userId) return { success: false, error: "self" };
    // A block in either direction stops friend requests.
    if (await isBlockedBetween(userId, friendId)) {
        return { success: false, error: "blocked" };
    }

    // Already have a row from me → friend or pending: nothing to do.
    const [mine] = await db
        .select({ status: friendsTable.status })
        .from(friendsTable)
        .where(and(eq(friendsTable.userId, userId), eq(friendsTable.friendId, friendId)));
    if (mine) return { success: true };

    // They already requested me → accept it (mutual).
    const [theirs] = await db
        .select({ status: friendsTable.status })
        .from(friendsTable)
        .where(and(eq(friendsTable.userId, friendId), eq(friendsTable.friendId, userId)));
    if (theirs && theirs.status === "pending") {
        await upsertAccepted(friendId, userId);
        await upsertAccepted(userId, friendId);
        return { success: true };
    }

    await db
        .insert(friendsTable)
        .values({ userId, friendId, status: "pending" })
        .onConflictDoNothing();
    return { success: true };
}

/** Accepts a pending request the caller received from `slug`. */
export async function acceptFriendRequest(
    userId: string,
    slug: string,
): Promise<FriendActionResponse> {
    const requesterId = await resolveUser(slug);
    if (!requesterId) return { success: false, error: "not_found" };

    const [req] = await db
        .select({ status: friendsTable.status })
        .from(friendsTable)
        .where(
            and(
                eq(friendsTable.userId, requesterId),
                eq(friendsTable.friendId, userId),
                eq(friendsTable.status, "pending"),
            ),
        );
    if (!req) return { success: false, error: "no_request" };

    await upsertAccepted(requesterId, userId);
    await upsertAccepted(userId, requesterId);
    return { success: true };
}

/**
 * Removes any relationship between the caller and `slug` — unfriend, decline an incoming
 * request, or cancel an outgoing one (deletes rows in both directions, any status).
 */
export async function removeFriend(
    userId: string,
    slug: string,
): Promise<FriendActionResponse> {
    const otherId = await resolveUser(slug);
    if (!otherId) return { success: false, error: "not_found" };
    await db
        .delete(friendsTable)
        .where(
            or(
                and(eq(friendsTable.userId, userId), eq(friendsTable.friendId, otherId)),
                and(eq(friendsTable.userId, otherId), eq(friendsTable.friendId, userId)),
            ),
        );
    return { success: true };
}

/** The caller's accepted friends (most-recently-added first). */
export async function getFriends(userId: string): Promise<Friend[]> {
    const rows = await db
        .select({ slug: usersTable.slug, username: usersTable.username })
        .from(friendsTable)
        .innerJoin(usersTable, eq(usersTable.id, friendsTable.friendId))
        .where(and(eq(friendsTable.userId, userId), eq(friendsTable.status, "accepted")))
        .orderBy(desc(friendsTable.createdAt));
    return rows.map((r) => ({ slug: r.slug, username: r.username }));
}

/** The caller's accepted friends with their account id + last-game time (for the friends
 *  list's "last played / spectate" column). */
export async function getFriendsDetailed(
    userId: string,
): Promise<
    Array<{ slug: string; username: string; userId: string; lastGame: number | null }>
> {
    const rows = await db
        .select({
            slug: usersTable.slug,
            username: usersTable.username,
            friendId: friendsTable.friendId,
        })
        .from(friendsTable)
        .innerJoin(usersTable, eq(usersTable.id, friendsTable.friendId))
        .where(and(eq(friendsTable.userId, userId), eq(friendsTable.status, "accepted")))
        .orderBy(desc(friendsTable.createdAt));
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.friendId);
    const lastRows = await db
        .select({
            userId: matchDataTable.userId,
            last: sql<number>`extract(epoch from max(${matchDataTable.createdAt})) * 1000`,
        })
        .from(matchDataTable)
        .where(inArray(matchDataTable.userId, ids))
        .groupBy(matchDataTable.userId);
    const lastMap = new Map<string, number>();
    for (const l of lastRows) {
        if (l.userId && l.last != null) lastMap.set(l.userId, Number(l.last));
    }

    return rows.map((r) => ({
        slug: r.slug,
        username: r.username,
        userId: r.friendId,
        lastGame: lastMap.get(r.friendId) ?? null,
    }));
}

/** Friend requests the caller has received (pending), showing the requester. */
export async function getIncomingRequests(userId: string): Promise<Friend[]> {
    const rows = await db
        .select({ slug: usersTable.slug, username: usersTable.username })
        .from(friendsTable)
        .innerJoin(usersTable, eq(usersTable.id, friendsTable.userId))
        .where(and(eq(friendsTable.friendId, userId), eq(friendsTable.status, "pending")))
        .orderBy(desc(friendsTable.createdAt));
    return rows.map((r) => ({ slug: r.slug, username: r.username }));
}

/** Friend requests the caller has sent (pending), showing the addressee. */
export async function getOutgoingRequests(userId: string): Promise<Friend[]> {
    const rows = await db
        .select({ slug: usersTable.slug, username: usersTable.username })
        .from(friendsTable)
        .innerJoin(usersTable, eq(usersTable.id, friendsTable.friendId))
        .where(and(eq(friendsTable.userId, userId), eq(friendsTable.status, "pending")))
        .orderBy(desc(friendsTable.createdAt));
    return rows.map((r) => ({ slug: r.slug, username: r.username }));
}

/**
 * The last `limit` distinct accounts the caller recently played with (same team) or
 * against (different team), most-recent first. Guests (no account) are skipped. Bounded by
 * scanning only the caller's most recent games.
 */
export async function getRecentPlayers(
    userId: string,
    limit = 10,
): Promise<RecentPlayer[]> {
    const myGames = await db
        .select({
            gameId: matchDataTable.gameId,
            teamId: matchDataTable.teamId,
        })
        .from(matchDataTable)
        .where(eq(matchDataTable.userId, userId))
        .orderBy(desc(matchDataTable.createdAt))
        .limit(25);
    if (myGames.length === 0) return [];

    const myTeamByGame = new Map<string, number>();
    for (const g of myGames) {
        if (!myTeamByGame.has(g.gameId)) myTeamByGame.set(g.gameId, g.teamId);
    }
    const gameIds = [...myTeamByGame.keys()];

    const others = await db
        .select({
            gameId: matchDataTable.gameId,
            otherId: matchDataTable.userId,
            teamId: matchDataTable.teamId,
            slug: usersTable.slug,
            username: usersTable.username,
        })
        .from(matchDataTable)
        .innerJoin(usersTable, eq(usersTable.id, matchDataTable.userId))
        .where(
            and(
                inArray(matchDataTable.gameId, gameIds),
                ne(matchDataTable.userId, userId),
            ),
        )
        .orderBy(desc(matchDataTable.createdAt));

    const seen = new Set<string>();
    const recent: RecentPlayer[] = [];
    for (const o of others) {
        const id = o.otherId ?? "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const myTeam = myTeamByGame.get(o.gameId);
        recent.push({
            slug: o.slug,
            username: o.username,
            relation: myTeam != null && o.teamId === myTeam ? "with" : "against",
        });
        if (recent.length >= limit) break;
    }
    return recent;
}
