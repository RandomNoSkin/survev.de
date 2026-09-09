import { and, eq, inArray } from "drizzle-orm";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import { db } from "./index";
import { creatorItemGrantsTable, itemsTable, usersTable } from "./schema";

/**
 * Creator-credit cosmetics: a game object def can declare `creatorDiscordId`, meaning
 * the Discord user with that id designed/contributed the item and should own a free
 * copy of it. Grants are recorded in `creator_item_grants` (one row per item type, since
 * a cosmetic has exactly one creator) so each item is only ever granted once - a server
 * restart re-scanning every def must not re-grant it, and the creator later
 * selling/trading the item away must not cause a later scan to re-grant it for free.
 *
 * If the creator hasn't linked that Discord account yet when this runs, the item is
 * left ungranted (no ledger row written) so a later restart grants it once they sign in.
 */
export async function grantCreatorItems(): Promise<{ granted: number; pending: number }> {
    const creditedTypes: { type: string; creatorDiscordId: string }[] = [];
    for (const type of GameObjectDefs.getAllTypes()) {
        const def = GameObjectDefs.typeToDefSafe(type) as
            | { creatorDiscordId?: string }
            | undefined;
        if (def?.creatorDiscordId) {
            creditedTypes.push({ type, creatorDiscordId: def.creatorDiscordId });
        }
    }
    if (creditedTypes.length === 0) return { granted: 0, pending: 0 };

    const alreadyGranted = await db
        .select({ itemType: creatorItemGrantsTable.itemType })
        .from(creatorItemGrantsTable)
        .where(
            inArray(
                creatorItemGrantsTable.itemType,
                creditedTypes.map((c) => c.type),
            ),
        );
    const grantedTypes = new Set(alreadyGranted.map((g) => g.itemType));
    const toGrant = creditedTypes.filter((c) => !grantedTypes.has(c.type));
    if (toGrant.length === 0) return { granted: 0, pending: 0 };

    const discordIds = [...new Set(toGrant.map((c) => c.creatorDiscordId))];
    const creators = await db
        .select({ id: usersTable.id, authId: usersTable.authId })
        .from(usersTable)
        .where(
            and(inArray(usersTable.authId, discordIds), eq(usersTable.linkedDiscord, true)),
        );
    const userIdByDiscordId = new Map(creators.map((c) => [c.authId, c.id]));

    let granted = 0;
    let pending = 0;
    const now = Date.now();
    for (const { type, creatorDiscordId } of toGrant) {
        const userId = userIdByDiscordId.get(creatorDiscordId);
        if (!userId) {
            pending++;
            continue;
        }

        const wasGranted = await db.transaction(async (tx) => {
            // Insert the grant marker FIRST: its PK (item_type) is the lock, so a
            // concurrent/duplicate run that loses the race grants no item below.
            const inserted = await tx
                .insert(creatorItemGrantsTable)
                .values({ itemType: type, userId })
                .onConflictDoNothing()
                .returning({ itemType: creatorItemGrantsTable.itemType });
            if (inserted.length === 0) return false;

            // If the creator already owns an instance of this type (unlocked it
            // themselves, bought it, got it from a pass, was given it manually, ...),
            // don't hand out a duplicate - just record the grant so future scans
            // leave them alone.
            const owned = await tx
                .select({ id: itemsTable.id })
                .from(itemsTable)
                .where(and(eq(itemsTable.userId, userId), eq(itemsTable.type, type)))
                .limit(1);

            if (owned.length === 0) {
                await tx.insert(itemsTable).values({
                    userId,
                    type,
                    source: "Creator",
                    timeAcquired: now,
                });
            }
            return true;
        });
        if (wasGranted) granted++;
    }

    return { granted, pending };
}
