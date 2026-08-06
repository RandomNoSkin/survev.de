import { pathToFileURL } from "node:url";
import { isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { Config } from "../../config";
import * as schema from "./schema";
import { matchDataTable } from "./schema";

// Standalone connection, see the same note in mapIdBackfill.ts for why (avoids
// ApiServer's background refreshRegionModes() noise on a one-off script).
const pool = new pg.Pool({ ...Config.database });
const db = drizzle({ client: pool, schema });

/**
 * One-time reset for `match_data.impact_score` / `impact_breakdown`. The impact-score
 * formula (shared/impactScore.ts) changed several times in quick succession — lobby-size
 * scaling, opportunity-based revive/save credit, share-based kill/damage, cover credit —
 * so rows written under an earlier version aren't comparable to rows written under the
 * current one, and there's no way to retroactively recompute them (the raw per-match
 * inputs like enemyCount/totalRoundDamage/reviveOpportunities were never stored, only the
 * derived score+breakdown). Nulling them out is safe: it only drops derived data, and new
 * games keep scoring normally from here — `computeImpactScore` returns null anyway for any
 * map without `impactWeight` set, so this is just forcing every existing row back to that
 * same "not yet scored" state.
 */
export async function resetImpactScores({ apply }: { apply: boolean }): Promise<number> {
    const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(matchDataTable)
        .where(isNotNull(matchDataTable.impactScore));

    if (!apply) {
        return count;
    }

    const result = await db
        .update(matchDataTable)
        .set({ impactScore: null, impactBreakdown: null })
        .where(isNotNull(matchDataTable.impactScore))
        .returning({ id: matchDataTable.gameId });

    return result.length;
}

// Runnable directly: `tsx src/api/db/resetImpactScores.ts [--apply]`
// (see `db:reset-impact-scores`). Without --apply this only reports how many rows would
// be touched; pass --apply to actually null them out.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2).filter((a) => a !== "--");
    const apply = args.includes("--apply");

    resetImpactScores({ apply })
        .then((n) => {
            const verb = apply ? "reset" : "would reset (dry run, pass --apply to write)";
            console.log(`impact score ${verb}: ${n} match_data rows`);
        })
        .catch((err) => {
            console.error("impact score reset failed:", err);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}
