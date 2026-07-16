import { PassDefs } from "../../../../shared/defs/gameObjects/passDefs";
import {
    reconcilePassGoldenFries,
    revokePassGoldenFriesAbove,
} from "./goldenFries";
import { db } from "./index";
import { getPassLevelAndXp } from "./passReconcile";
import { grantPassItems, revokePassItemsAbove } from "./passGrants";
import { userXpTable } from "./schema";

/**
 * Sets a pass's XP to an absolute value and brings everything derived from it in
 * line: the stored level, the reconcile anchor, the owned pass cosmetics AND the
 * pass Golden Fries.
 *
 * This is the single cascade shared by the admin "set XP" endpoint and the
 * moderation bott/un-bott revoke. Steps:
 *   1. Upsert `user_xp` with the new xp + derived level, and anchor the reconcile
 *      (`reconcileBaseXp = xp`, `reconcileFrom = now`) so the value sticks — old
 *      matches aren't re-counted, new ones still accrue.
 *   2. Grant every pass cosmetic up to the level, revoke any above it.
 *   3. Grant every pass Golden Fries reward up to the level, revoke any above it.
 * All grant/revoke helpers are idempotent, so calling this repeatedly (or to raise
 * the value again on un-bott) converges to the exact correct state.
 */
export async function setPassXp(
    userId: string,
    passType: string,
    xp: number,
): Promise<{
    level: number;
    granted: number;
    revoked: number;
    friesGranted: number;
    friesRevoked: number;
}> {
    const now = new Date();
    const level = PassDefs[passType] ? getPassLevelAndXp(passType, xp).level : 0;

    await db
        .insert(userXpTable)
        .values({
            userId,
            passType,
            level,
            xp: String(xp),
            reconcileBaseXp: String(xp),
            reconcileFrom: now,
        })
        .onConflictDoUpdate({
            target: [userXpTable.userId, userXpTable.passType],
            set: {
                level,
                xp: String(xp),
                reconcileBaseXp: String(xp),
                reconcileFrom: now,
                lastUpdated: now,
            },
        });

    // Cosmetics: line owned items up with the derived level.
    const granted = await grantPassItems(userId, passType, level);
    const revoked = await revokePassItemsAbove(userId, passType, level);
    // Golden Fries: same, but for the currency rewards (the piece the old inline
    // set-xp handler was missing).
    const friesGranted = await reconcilePassGoldenFries(userId, passType, level);
    const friesRevoked = await revokePassGoldenFriesAbove(userId, passType, level);

    return { level, granted, revoked, friesGranted, friesRevoked };
}
