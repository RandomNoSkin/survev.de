import { eq, inArray } from "drizzle-orm";
import type { RoleTag } from "../../../../shared/types/user";
import { db } from "./index";
import { clanMembersTable, clansTable, usersTable } from "./schema";

/**
 * Fills in each player's clan [TAG] + colour right before the players are sent to a game
 * server (matchmaking, team menu and private lobbies all pass through here), and applies
 * their "In-game name tag" setting: "role" drops the clan tag, "clan" drops the role tag
 * (only when they actually have a clan, otherwise their role tag stays).
 */
export async function withClanTags(
    players: { userId: string | null; roleTag?: RoleTag; clanTag?: { tag: string; color: number } | null }[],
): Promise<void> {
    const ids = [...new Set(players.map((p) => p.userId).filter((id): id is string => !!id))];
    if (!ids.length) return;
    try {
        const rows = await db
            .select({
                userId: usersTable.id,
                tagDisplay: usersTable.tagDisplay,
                tag: clansTable.tag,
                color: clansTable.tagColor,
            })
            .from(usersTable)
            .leftJoin(clanMembersTable, eq(clanMembersTable.userId, usersTable.id))
            .leftJoin(clansTable, eq(clansTable.id, clanMembersTable.clanId))
            .where(inArray(usersTable.id, ids));
        const byUser = new Map(rows.map((r) => [r.userId, r]));
        for (const p of players) {
            const r = p.userId ? byUser.get(p.userId) : undefined;
            const clan = r?.tag ? { tag: r.tag, color: r.color ?? 0 } : null;
            p.clanTag = r?.tagDisplay === "role" ? null : clan;
            if (r?.tagDisplay === "clan" && clan) p.roleTag = null;
        }
    } catch {
        // a tag is cosmetic - never hold a game start up for it
    }
}
