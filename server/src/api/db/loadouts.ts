import { eq, inArray } from "drizzle-orm";
import loadout, { type Loadout } from "../../../../shared/utils/loadout";
import { server } from "../apiServer";
import { db } from "./index";
import { itemsTable, usersTable } from "./schema";

/**
 * Loads each user's saved loadout and strips out any cosmetic they no longer own.
 *
 * The saved loadout in `usersTable.loadout` is only re-validated when the player
 * explicitly saves it, so a skin that was traded/rented away still sits equipped there.
 * Every game-join path (find_game, team menu, private lobby) hands that stored loadout
 * straight to the game server, which trusts it outright — letting a player spawn with a
 * cosmetic they no longer own ("trade a skin around and everyone keeps using it for
 * free"). Running the stored loadout back through {@link loadout.validateWithAvailableItems}
 * against currently-owned items makes ownership authoritative at join time.
 *
 * Also self-heals the stored loadout when it changed, so the account's saved state and
 * the loadout menu reflect reality on the next load (only writes when something was
 * actually stripped/normalized).
 *
 * @returns the validated loadouts keyed by userId (order not guaranteed).
 */
export async function getOwnedLoadouts(
    userIds: string[],
): Promise<Array<{ userId: string; loadout: Loadout }>> {
    if (userIds.length === 0) return [];

    const [users, items] = await Promise.all([
        db
            .select({ userId: usersTable.id, loadout: usersTable.loadout })
            .from(usersTable)
            .where(inArray(usersTable.id, userIds)),
        db
            .select({ userId: itemsTable.userId, type: itemsTable.type })
            .from(itemsTable)
            .where(inArray(itemsTable.userId, userIds)),
    ]);

    const itemsByUser = new Map<string, Array<{ type: string }>>();
    for (const item of items) {
        let list = itemsByUser.get(item.userId);
        if (!list) {
            list = [];
            itemsByUser.set(item.userId, list);
        }
        list.push({ type: item.type });
    }

    const result: Array<{ userId: string; loadout: Loadout }> = [];
    const heals: Array<{ userId: string; loadout: Loadout }> = [];
    for (const u of users) {
        const owned = itemsByUser.get(u.userId) ?? [];
        const validated = loadout.validateWithAvailableItems(u.loadout, owned);
        if (loadout.modified(u.loadout, validated)) {
            heals.push({ userId: u.userId, loadout: validated });
        }
        result.push({ userId: u.userId, loadout: validated });
    }

    if (heals.length > 0) {
        try {
            await Promise.all(
                heals.map((h) =>
                    db
                        .update(usersTable)
                        .set({ loadout: h.loadout })
                        .where(eq(usersTable.id, h.userId)),
                ),
            );
        } catch (err) {
            // A failed self-heal is non-fatal: the returned (stripped) loadout is still
            // used for this join, we just didn't persist the correction this time.
            server.logger.error("getOwnedLoadouts: failed to self-heal loadouts", err);
        }
    }

    return result;
}
