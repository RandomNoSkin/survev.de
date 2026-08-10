import { sql } from "drizzle-orm";
import { getImpactRank, IMPACT_RANKS } from "../../../../shared/impactScore.ts";
import { Config } from "../../config.ts";
import { server } from "../apiServer.ts";
import { db } from "./index.ts";
import { type RatingTiersTable, ratingTiersTable, regionGroupsTable } from "./schema.ts";

/**
 * Minimum region-scoped rated (impact-scored) games an account needs before it's counted
 * towards a cohort's percentile tiers — keeps a lucky/unlucky small sample from skewing the
 * S/F cutoffs. Below this, an account still gets a tier via the same cutoffs (see
 * `getRatingTier`), just isn't part of what defines them.
 */
const MIN_GAMES = 30;

/**
 * Minimum qualifying (>=MIN_GAMES) accounts a (teamMode, region) cohort needs before it gets
 * percentile tiers at all. Below this, splitting by mode+region leaves too few people for
 * NTILE(9) to mean anything (e.g. a handful of accounts a few points apart getting spread
 * across F..S by rank alone) — the cohort falls back to the static IMPACT_RANKS ladder
 * instead (see `getRatingTier`) until enough accounts qualify.
 */
const MIN_COHORT_SIZE = 20;

/** Number of percentile buckets, matching IMPACT_RANKS' F..S ladder. */
const TIER_COUNT = IMPACT_RANKS.length;

interface RatingTier {
    name: string;
    min: number;
}

// Percentile-tier cutoffs are a slow-moving daily statistic (00:00 cron + boot warm, see
// index.ts), same pattern as cosmeticStats.ts — no per-request computation.
let cache = new Map<string, RatingTier[]>();

function cacheKey(teamMode: number, region: string): string {
    return `${teamMode}:${region}`;
}

/**
 * Resolves the letter tier for a rating in a given (teamMode, region) cohort. Falls back to
 * the static IMPACT_RANKS thresholds when that cohort has no cached percentile data yet (e.g.
 * right after deploy, or a cohort too small to have qualified anyone) so Rank never just goes
 * blank. Null in/out, same as `getImpactRank`.
 */
export function getRatingTier(
    teamMode: number,
    region: string,
    rating: number | null | undefined,
): string | null {
    if (rating === null || rating === undefined) return null;

    const tiers = cache.get(cacheKey(teamMode, region));
    if (!tiers || tiers.length === 0) return getImpactRank(rating);

    let rank = tiers[0].name;
    for (const tier of tiers) {
        if (rating >= tier.min) rank = tier.name;
    }
    return rank;
}

/**
 * Keeps region_groups in sync with Config.regions (deployment-only config, not queryable from
 * SQL directly) so region-scoped rating queries can just JOIN it instead of re-deriving the
 * mapping. Regions that match_data still references but that dropped out of config (renamed/
 * retired) get a self-mapped row so they don't silently fall out of a cohort.
 */
async function syncRegionGroups(): Promise<void> {
    const rows = Object.entries(Config.regions).map(([region, def]) => ({
        region,
        groupName: def.group ?? region,
    }));

    if (rows.length > 0) {
        await db
            .insert(regionGroupsTable)
            .values(rows)
            .onConflictDoUpdate({
                target: regionGroupsTable.region,
                set: { groupName: sql`excluded.group_name` },
            });
    }

    await db.execute(sql`
        INSERT INTO region_groups (region, group_name)
        SELECT DISTINCT md.region, md.region
        FROM match_data md
        LEFT JOIN region_groups rg ON rg.region = md.region
        WHERE rg.region IS NULL
        ON CONFLICT (region) DO NOTHING
    `);
}

/**
 * Recomputes each account's primary region group (the group it plays the most rated matches
 * in) and the percentile tier cutoffs per (teamMode, region group), then publishes the result
 * to the in-memory cache used by `getRatingTier`. Run once at boot and once a day by the
 * midnight cron in index.ts.
 */
export async function computeRatingTiers(): Promise<void> {
    if (!Config.database.enabled) return;

    await syncRegionGroups();

    // For every account with at least one rated match, set primary_region to whichever region
    // group it has the most rated matches in.
    await db.execute(sql`
        WITH region_counts AS (
            SELECT md.user_id AS user_id,
                   rg.group_name AS group_name,
                   ROW_NUMBER() OVER (
                       PARTITION BY md.user_id ORDER BY COUNT(*) DESC
                   ) AS rn
            FROM match_data md
            JOIN region_groups rg ON rg.region = md.region
            WHERE md.impact_score IS NOT NULL AND md.user_id <> ''
            GROUP BY md.user_id, rg.group_name
        )
        UPDATE users
        SET primary_region = region_counts.group_name
        FROM region_counts
        WHERE users.id = region_counts.user_id AND region_counts.rn = 1
    `);

    // Split each (teamMode, region) cohort's qualifying (>=MIN_GAMES) accounts into
    // TIER_COUNT equal-size buckets by their region-scoped average rating.
    const buckets = await db.execute<{
        team_mode: number;
        region: string;
        bucket: number;
        min_score: string;
        sample_size: string;
    }>(sql`
        WITH qualified AS (
            SELECT md.user_id AS user_id,
                   md.team_mode AS team_mode,
                   u.primary_region AS region,
                   AVG(md.impact_score) AS rating
            FROM match_data md
            JOIN region_groups rg ON rg.region = md.region
            JOIN users u ON u.id = md.user_id
            WHERE md.impact_score IS NOT NULL
              AND rg.group_name = u.primary_region
              AND md.user_id <> ''
            GROUP BY md.user_id, md.team_mode, u.primary_region
            HAVING COUNT(*) >= ${MIN_GAMES}
        ),
        ranked AS (
            SELECT team_mode, region, rating,
                   NTILE(${TIER_COUNT}) OVER (
                       PARTITION BY team_mode, region ORDER BY rating
                   ) AS bucket
            FROM qualified
        )
        SELECT team_mode, region, bucket, MIN(rating) AS min_score, COUNT(*) AS sample_size
        FROM ranked
        GROUP BY team_mode, region, bucket
    `);

    // Group buckets by cohort first so undersized cohorts (see MIN_COHORT_SIZE) can be
    // dropped as a whole — otherwise they'd get a token entry in rating_tiers/cache and
    // getRatingTier would use it instead of falling back to the static ladder.
    const byCohort = new Map<
        string,
        { teamMode: number; region: string; buckets: RatingTiersTable[]; totalSize: number }
    >();
    for (const row of buckets.rows) {
        const tierName = IMPACT_RANKS[row.bucket - 1]?.name;
        if (!tierName) continue; // NTILE can't exceed TIER_COUNT, but guard anyway
        const key = cacheKey(row.team_mode, row.region);
        const cohort = byCohort.get(key) ?? {
            teamMode: row.team_mode,
            region: row.region,
            buckets: [],
            totalSize: 0,
        };
        const sampleSize = Number(row.sample_size);
        cohort.buckets.push({
            teamMode: row.team_mode,
            region: row.region,
            tierName,
            minScore: Number(row.min_score),
            sampleSize,
        });
        cohort.totalSize += sampleSize;
        byCohort.set(key, cohort);
    }

    const newCache = new Map<string, RatingTier[]>();
    const rows: RatingTiersTable[] = [];
    for (const [key, cohort] of byCohort) {
        if (cohort.totalSize < MIN_COHORT_SIZE) continue;
        const tiers = cohort.buckets
            .map((b) => ({ name: b.tierName, min: b.minScore }))
            .sort((a, b) => a.min - b.min);
        newCache.set(key, tiers);
        rows.push(...cohort.buckets);
    }

    await db.transaction(async (tx) => {
        await tx.delete(ratingTiersTable);
        if (rows.length > 0) {
            await tx.insert(ratingTiersTable).values(rows);
        }
    });

    cache = newCache;
    server.logger.info(
        `Recomputed rating tiers: ${rows.length} tier rows across ${newCache.size} (mode, region) cohorts`,
    );
}

/** Warm the cache once at boot so Rank has data before the first midnight recompute. */
export function warmRatingTiers(): void {
    void computeRatingTiers().catch((err) => {
        server.logger.error("Failed to warm rating tiers", err);
    });
}
