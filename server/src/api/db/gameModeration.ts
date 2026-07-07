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
    status: "sus" | "botted",
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
