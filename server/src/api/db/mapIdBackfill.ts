import { pathToFileURL } from "node:url";
import { and, gte, lt, sql } from "drizzle-orm";
import { db } from "./index";
import { ipLogsTable, matchDataTable } from "./schema";

/**
 * One-time fix for match_data/ip_logs rows written before the upstream merge in 6780659a
 * re-typed the `MapId` enum (shared/gameConfig.ts) in a different member order than the
 * fork previously had. Rows created before that point stored `map_id` under the OLD
 * numbering; read today they resolve to the wrong mode (e.g. old Comp games show as 2v2).
 * This remaps those old values back to what they mean under the current enum. Only rows
 * with `created_at < cutoff` and a `map_id` in the affected range (10-16) are touched;
 * everything else (unaffected ids, and rows already written after the fix) is left alone.
 * Idempotent for a fixed cutoff: rows outside [10,16] are no-ops, and re-running with the
 * same cutoff re-applies the same CASE mapping to the same already-corrected rows only if
 * you re-run against still-old data — do not run this twice with different cutoffs without
 * re-checking the counts first.
 */
const OLD_TO_NEW_MAP_ID = sql`CASE map_id
    WHEN 10 THEN 12
    WHEN 11 THEN 16
    WHEN 12 THEN 10
    WHEN 13 THEN 11
    WHEN 14 THEN 15
    WHEN 15 THEN 14
    WHEN 16 THEN 13
    ELSE map_id
END`;

const AFFECTED_RANGE = and(gte(matchDataTable.mapId, 10), lt(matchDataTable.mapId, 17));
const AFFECTED_RANGE_LOGS = and(gte(ipLogsTable.mapId, 10), lt(ipLogsTable.mapId, 17));

export async function backfillMapIds(
    cutoff: Date,
    { apply }: { apply: boolean },
): Promise<{ matchData: number; ipLogs: number }> {
    const [matchDataRows] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(matchDataTable)
        .where(and(lt(matchDataTable.createdAt, cutoff), AFFECTED_RANGE));
    const [ipLogRows] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(ipLogsTable)
        .where(and(lt(ipLogsTable.createdAt, cutoff), AFFECTED_RANGE_LOGS));

    if (!apply) {
        return { matchData: matchDataRows.count, ipLogs: ipLogRows.count };
    }

    const matchDataResult = await db
        .update(matchDataTable)
        .set({ mapId: OLD_TO_NEW_MAP_ID })
        .where(and(lt(matchDataTable.createdAt, cutoff), AFFECTED_RANGE))
        .returning({ id: matchDataTable.gameId });
    const ipLogsResult = await db
        .update(ipLogsTable)
        .set({ mapId: OLD_TO_NEW_MAP_ID })
        .where(and(lt(ipLogsTable.createdAt, cutoff), AFFECTED_RANGE_LOGS))
        .returning({ id: ipLogsTable.id });

    return { matchData: matchDataResult.length, ipLogs: ipLogsResult.length };
}

// Runnable directly: `tsx src/api/db/mapIdBackfill.ts <cutoff-iso-timestamp> [--apply]`
// (see `db:backfill-map-ids`). Without --apply this only reports how many rows would be
// touched; pass --apply once the cutoff has been double-checked against the actual
// production deploy time of 6780659a.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const cutoffArg = process.argv[2];
    const apply = process.argv.includes("--apply");
    if (!cutoffArg) {
        console.error(
            "Usage: tsx src/api/db/mapIdBackfill.ts <cutoff-iso-timestamp> [--apply]",
        );
        process.exit(1);
    }
    const cutoff = new Date(cutoffArg);
    if (Number.isNaN(cutoff.getTime())) {
        console.error(`Invalid cutoff timestamp: ${cutoffArg}`);
        process.exit(1);
    }

    backfillMapIds(cutoff, { apply })
        .then((r) => {
            const verb = apply ? "fixed" : "would fix (dry run, pass --apply to write)";
            console.log(
                `map_id backfill ${verb}: ${r.matchData} match_data rows, ${r.ipLogs} ip_logs rows (cutoff ${cutoff.toISOString()})`,
            );
            process.exit(0);
        })
        .catch((err) => {
            console.error("map_id backfill failed:", err);
            process.exit(1);
        });
}
