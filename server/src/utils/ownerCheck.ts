import { eq } from "drizzle-orm";
import { db } from "../api/db";
import { usersTable } from "../api/db/schema";
import { Config } from "../config";
import { chatLogger } from "./betterLogger";

/** Whether the account is an owner (DB flag, not the shown tag - owners can hide that). */
export async function isOwnerAccount(userId: string | null | undefined): Promise<boolean> {
    if (!Config.database.enabled || !userId) return false;
    try {
        const [row] = await db
            .select({ owner: usersTable.owner })
            .from(usersTable)
            .where(eq(usersTable.id, userId));
        return row?.owner ?? false;
    } catch (err) {
        chatLogger.error("Failed to check owner flag:", err);
        return false;
    }
}
