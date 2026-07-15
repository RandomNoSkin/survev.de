import { and, eq, sql } from "drizzle-orm";
import { GameConfig } from "../../../../shared/gameConfig";
import { db } from "./index";
import { computeMatchXp, matchBoostMultiplier } from "./passReconcile";
import { setPassXp } from "./passXp";
import { gameModerationTable, matchDataTable, userXpTable } from "./schema";

export type GameModStatus = "sus" | "botted" | "clear";

interface XpDelta {
    passType: string;
    xpDelta: number;
}

/**
 * The XP a single (game, user) contributed, per pass the user participates in.
 *
 * Only games where the user appears exactly once count toward XP (same dedupe as
 * the reconcile / get_pass), so multi-entry games yield an empty list — they never
 * granted XP in the first place. The delta is applied per pass, gated to passes
 * whose season contains the game, exactly mirroring how the reconcile attributes a
 * match to each pass (with that pass's boost).
 */
async function computeGameXpDeltas(gameId: string, userId: string): Promise<XpDelta[]> {
    const rows = await db
        .select({
            kills: sql<number>`max(${matchDataTable.kills})`,
            damage: sql<number>`max(${matchDataTable.damageDealt})`,
            timeAlive: sql<number>`max(${matchDataTable.timeAlive})`,
            rank: sql<number>`min(${matchDataTable.rank})`,
            mapId: sql<number>`max(${matchDataTable.mapId})`,
            createdAt: sql<Date>`max(${matchDataTable.createdAt})`,
            cnt: sql<number>`count(*)`,
        })
        .from(matchDataTable)
        .where(and(eq(matchDataTable.gameId, gameId), eq(matchDataTable.userId, userId)));

    const r = rows[0];
    if (!r || Number(r.cnt) !== 1) return [];

    const stat = {
        kills: Number(r.kills),
        damage: Number(r.damage),
        timeAlive: Number(r.timeAlive),
        rank: Number(r.rank),
        mapId: Number(r.mapId),
    };
    const baseXp = computeMatchXp(stat);
    const gameTime = new Date(r.createdAt).getTime();

    const allPasses = (GameConfig.serverSettings as any).passes as
        | Record<string, { seasonStart: string; seasonEnd: string }>
        | undefined;

    // Every pass the user has progress in — a game counts toward a pass only if it
    // falls inside that pass's season.
    const passes = await db
        .select({ passType: userXpTable.passType })
        .from(userXpTable)
        .where(eq(userXpTable.userId, userId));

    return passes
        .filter((p) => {
            const cfg = allPasses?.[p.passType];
            if (!cfg) return true; // no season config → assume applicable
            return (
                gameTime >= new Date(cfg.seasonStart).getTime() &&
                gameTime <= new Date(cfg.seasonEnd).getTime()
            );
        })
        .map((p) => ({
            passType: p.passType,
            xpDelta:
                Math.round(
                    baseXp * matchBoostMultiplier(p.passType, stat.mapId, r.createdAt) * 1e5,
                ) / 1e5,
        }))
        .filter((d) => d.xpDelta > 0);
}

/** Sets `voided` on all of this player's rows in the game. */
async function setVoided(gameId: string, userId: string, voided: boolean): Promise<void> {
    await db
        .update(matchDataTable)
        .set({ voided })
        .where(and(eq(matchDataTable.gameId, gameId), eq(matchDataTable.userId, userId)));
}

/** Lowers each affected pass's XP by the game's contribution and cascades cosmetics + fries. */
async function revokeXp(gameId: string, userId: string): Promise<XpDelta[]> {
    const deltas = await computeGameXpDeltas(gameId, userId);
    await setVoided(gameId, userId, true);
    for (const d of deltas) {
        const rec = await db.query.userXpTable.findFirst({
            where: and(
                eq(userXpTable.userId, userId),
                eq(userXpTable.passType, d.passType),
            ),
        });
        if (!rec) continue;
        const newXp = Math.max(0, Number(rec.xp) - d.xpDelta);
        await setPassXp(userId, d.passType, newXp);
    }
    return deltas;
}

/** Adds the stored deltas back and un-voids the rows (exact inverse of revokeXp). */
async function restoreXp(gameId: string, userId: string, deltas: XpDelta[]): Promise<void> {
    await setVoided(gameId, userId, false);
    for (const d of deltas) {
        const rec = await db.query.userXpTable.findFirst({
            where: and(
                eq(userXpTable.userId, userId),
                eq(userXpTable.passType, d.passType),
            ),
        });
        const base = rec ? Number(rec.xp) : 0;
        await setPassXp(userId, d.passType, base + d.xpDelta);
    }
}

async function upsertModeration(
    gameId: string,
    userId: string,
    status: "sus" | "botted" | "removed",
    adminSlug: string,
    note: string,
    xpDeltas: XpDelta[],
): Promise<void> {
    await db
        .insert(gameModerationTable)
        .values({ gameId, userId, status, note, markedBy: adminSlug, xpDeltas })
        .onConflictDoUpdate({
            target: [gameModerationTable.gameId, gameModerationTable.userId],
            set: { status, note, markedBy: adminSlug, markedAt: new Date(), xpDeltas },
        });
}

/**
 * Applies (or clears) a moderation status for one player in one game, keeping their
 * pass XP consistent across every transition:
 *   - "botted" → revoke the player's XP from this game (plus the pass cosmetics and
 *     Golden Fries earned from it) and store the exact per-pass deltas for a precise
 *     un-bott. No-op if already botted.
 *   - "sus"    → watchlist label only; if the player was botted, restore XP first.
 *   - "clear"  → remove the flag; if it was botted, restore the revoked XP.
 */
export async function setGamePlayerModeration(
    gameId: string,
    userId: string,
    status: GameModStatus,
    adminSlug: string,
    note = "",
): Promise<{ status: "sus" | "botted" | null; deltas: XpDelta[] }> {
    const existing = await db.query.gameModerationTable.findFirst({
        where: and(
            eq(gameModerationTable.gameId, gameId),
            eq(gameModerationTable.userId, userId),
        ),
    });
    const wasBotted = existing?.status === "botted";

    if (status === "clear") {
        if (wasBotted) await restoreXp(gameId, userId, existing!.xpDeltas);
        if (existing) {
            await db
                .delete(gameModerationTable)
                .where(
                    and(
                        eq(gameModerationTable.gameId, gameId),
                        eq(gameModerationTable.userId, userId),
                    ),
                );
        }
        return { status: null, deltas: [] };
    }

    if (status === "sus") {
        if (wasBotted) await restoreXp(gameId, userId, existing!.xpDeltas);
        await upsertModeration(gameId, userId, "sus", adminSlug, note, []);
        return { status: "sus", deltas: [] };
    }

    // status === "botted"
    if (wasBotted) {
        return { status: "botted", deltas: existing!.xpDeltas };
    }
    const deltas = await revokeXp(gameId, userId);
    await upsertModeration(gameId, userId, "botted", adminSlug, note, deltas);
    return { status: "botted", deltas };
}

/**
 * Permanently removes a game from the leaderboard and all stats: first revokes the
 * XP (plus the pass cosmetics and Golden Fries earned from it) from every real
 * account that gained XP in the game — otherwise deleting the source rows would
 * leave phantom pass levels — then hard-deletes the game's `match_data` rows and any
 * moderation flags. Irreversible (the rows are gone), unlike "botted".
 */
export async function deleteGame(
    gameId: string,
): Promise<{ players: number; xpRemoved: number; rowsDeleted: number }> {
    const userRows = await db
        .selectDistinct({ userId: matchDataTable.userId })
        .from(matchDataTable)
        .where(
            and(eq(matchDataTable.gameId, gameId), sql`${matchDataTable.userId} <> ''`),
        );

    let players = 0;
    let xpRemoved = 0;
    for (const { userId } of userRows) {
        if (!userId) continue;
        const deltas = await computeGameXpDeltas(gameId, userId);
        if (!deltas.length) continue;
        players++;
        for (const d of deltas) {
            const rec = await db.query.userXpTable.findFirst({
                where: and(
                    eq(userXpTable.userId, userId),
                    eq(userXpTable.passType, d.passType),
                ),
            });
            if (!rec) continue;
            await setPassXp(userId, d.passType, Math.max(0, Number(rec.xp) - d.xpDelta));
            xpRemoved += d.xpDelta;
        }
    }

    const deleted = await db
        .delete(matchDataTable)
        .where(eq(matchDataTable.gameId, gameId))
        .returning({ gameId: matchDataTable.gameId });
    await db.delete(gameModerationTable).where(eq(gameModerationTable.gameId, gameId));

    return {
        players,
        xpRemoved: Math.round(xpRemoved * 100) / 100,
        rowsDeleted: deleted.length,
    };
}

/**
 * Removes ONE player from a game WITHOUT deleting it: their user_id is moved to
 * `removed_user_id` and user_id is blanked, turning their rows into guest rows. The
 * game then disappears from that account's stats AND every leaderboard (all of which
 * filter user_id <> ''), while the game and the other players stay intact. The XP the
 * player gained from the game is revoked too (unless a prior "botted" already did it),
 * so no phantom pass levels remain. Fully reversible via {@link restoreUserToGame}.
 */
export async function removeUserFromGame(
    gameId: string,
    userId: string,
    adminSlug: string,
    note = "",
): Promise<{ status: "removed"; deltas: XpDelta[] }> {
    const existing = await db.query.gameModerationTable.findFirst({
        where: and(
            eq(gameModerationTable.gameId, gameId),
            eq(gameModerationTable.userId, userId),
        ),
    });
    if (existing?.status === "removed") {
        return { status: "removed", deltas: existing.xpDeltas };
    }

    // Deltas of the game for this player (rows still carry user_id at this point).
    const deltas = await computeGameXpDeltas(gameId, userId);
    // If the game was already "botted", its XP was already revoked — don't double it.
    const alreadyRevoked = existing?.status === "botted";
    if (!alreadyRevoked) {
        for (const d of deltas) {
            const rec = await db.query.userXpTable.findFirst({
                where: and(
                    eq(userXpTable.userId, userId),
                    eq(userXpTable.passType, d.passType),
                ),
            });
            if (!rec) continue;
            await setPassXp(userId, d.passType, Math.max(0, Number(rec.xp) - d.xpDelta));
        }
    }

    // Detach: move user_id → removed_user_id, blank user_id. Clear the botted flag too
    // (removal is now the exclusion mechanism); restore re-adds the deltas either way.
    await db
        .update(matchDataTable)
        .set({ removedUserId: userId, userId: "", voided: false })
        .where(and(eq(matchDataTable.gameId, gameId), eq(matchDataTable.userId, userId)));

    await upsertModeration(gameId, userId, "removed", adminSlug, note, deltas);
    return { status: "removed", deltas };
}

/** Inverse of {@link removeUserFromGame}: re-attaches the player and restores their XP. */
export async function restoreUserToGame(
    gameId: string,
    userId: string,
): Promise<{ deltas: XpDelta[] }> {
    const existing = await db.query.gameModerationTable.findFirst({
        where: and(
            eq(gameModerationTable.gameId, gameId),
            eq(gameModerationTable.userId, userId),
        ),
    });
    if (!existing || existing.status !== "removed") return { deltas: [] };

    // Re-attach: removed_user_id → user_id.
    await db
        .update(matchDataTable)
        .set({ userId, removedUserId: null })
        .where(
            and(
                eq(matchDataTable.gameId, gameId),
                eq(matchDataTable.removedUserId, userId),
            ),
        );

    // Add the game's XP back.
    for (const d of existing.xpDeltas) {
        const rec = await db.query.userXpTable.findFirst({
            where: and(
                eq(userXpTable.userId, userId),
                eq(userXpTable.passType, d.passType),
            ),
        });
        const base = rec ? Number(rec.xp) : 0;
        await setPassXp(userId, d.passType, base + d.xpDelta);
    }

    await db
        .delete(gameModerationTable)
        .where(
            and(
                eq(gameModerationTable.gameId, gameId),
                eq(gameModerationTable.userId, userId),
            ),
        );
    return { deltas: existing.xpDeltas };
}
