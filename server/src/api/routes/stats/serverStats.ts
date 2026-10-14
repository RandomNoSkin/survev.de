import { type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type StatsRange, statsRangeFor, statsSeasons } from "../../../../../shared/statsPeriods";
import {
    type ServerStatsMetrics,
    type ServerStatsResponse,
    zServerStatsRequest,
} from "../../../../../shared/types/stats";
import { Config } from "../../../config";
import type { Context } from "../..";
import { server } from "../../apiServer";
import {
    databaseEnabledMiddleware,
    rateLimitMiddleware,
    validateParams,
} from "../../auth/middleware";
import { getRedisClient } from "../../cache";
import { db } from "../../db";

export const serverStatsRouter = new Hono<Context>();

const CACHE_TTL = 300; // 5 min — these are full-table aggregates, keep DB load low.

type Historical = Omit<ServerStatsResponse, "live" | "generatedAt">;

const n = (v: unknown) => Number(v ?? 0);
const round1 = (v: number) => Math.round(v * 10) / 10;

interface Filters {
    teamMode?: number;
    region?: string;
    mapId?: number;
}

/** WHERE for a time window plus the page's filters (all values bound, never inlined). */
function whereFor(from: number | null, to: number, f: Filters): SQL {
    const conds: SQL[] = [sql`created_at < to_timestamp(${to / 1000})`];
    if (from !== null) conds.push(sql`created_at >= to_timestamp(${from / 1000})`);
    if (f.teamMode !== undefined) conds.push(sql`team_mode = ${f.teamMode}`);
    if (f.region !== undefined) conds.push(sql`region = ${f.region}`);
    if (f.mapId !== undefined) conds.push(sql`map_id = ${f.mapId}`);
    return sql.join(conds, sql` AND `);
}

/** Grouping columns - fixed internal names, never user input. */
type Dim = "team_mode" | "region" | "map_id";

interface MetricsRow extends ServerStatsMetrics {
    key: string;
}

/**
 * The activity numbers for a window, overall (dim undefined) or per mode/region/map.
 * Match length = the longest survival in a game (the winner's time alive).
 */
async function metrics(where: SQL, dim?: Dim): Promise<MetricsRow[]> {
    // overall: no grouping at all (Postgres won't GROUP BY a constant)
    const col = dim ? sql.raw(dim) : sql`'all'`;
    const groupG = dim ? sql`GROUP BY ${col}, game_id` : sql`GROUP BY game_id`;
    const groupK = dim ? sql`GROUP BY k` : sql``;
    const groupM = dim ? sql`GROUP BY ${col}` : sql``;
    const res = await db.execute(sql`
        WITH g AS (
            SELECT ${col} AS k, game_id, MAX(time_alive) AS dur
            FROM match_data WHERE ${where}
            ${groupG}
        ), d AS (
            SELECT ${dim ? sql`k` : sql`'all' AS k`}, AVG(dur) AS avg_dur FROM g ${groupK}
        ), m AS (
            SELECT ${col} AS k,
                COUNT(*) AS participations,
                COUNT(DISTINCT game_id) AS games,
                COUNT(DISTINCT NULLIF(encoded_ip, '')) AS unique_players,
                COUNT(DISTINCT NULLIF(user_id, '')) AS registered,
                COALESCE(SUM(kills), 0) AS kills,
                COALESCE(AVG(damage_dealt), 0) AS avg_damage
            FROM match_data WHERE ${where}
            ${groupM}
        )
        SELECT m.*, COALESCE(d.avg_dur, 0) AS avg_dur FROM m LEFT JOIN d ON d.k = m.k
    `);
    return (res.rows as Record<string, unknown>[]).map((r) => {
        const games = n(r.games);
        const participations = n(r.participations);
        return {
            key: String(r.k),
            games,
            participations,
            uniquePlayers: n(r.unique_players),
            registeredPlayers: n(r.registered),
            avgPlayersPerGame: games ? round1(participations / games) : 0,
            avgDurationSec: Math.round(n(r.avg_dur)),
            kills: n(r.kills),
            killsPerPlayer: participations ? Math.round((n(r.kills) / participations) * 100) / 100 : 0,
            damagePerPlayer: Math.round(n(r.avg_damage)),
        };
    });
}

const EMPTY: ServerStatsMetrics = {
    games: 0,
    participations: 0,
    uniquePlayers: 0,
    registeredPlayers: 0,
    avgPlayersPerGame: 0,
    avgDurationSec: 0,
    kills: 0,
    killsPerPlayer: 0,
    damagePerPlayer: 0,
};

const strip = ({ key: _key, ...m }: MetricsRow): ServerStatsMetrics => m;

/** Start of the bucket `t` falls in - like Postgres date_trunc in UTC (weeks start Monday). */
function truncUtc(t: number, unit: StatsRange["bucket"]): Date {
    const d = new Date(t);
    if (unit === "hour") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()));
    if (unit === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    if (unit === "week") day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return day;
}

function nextBucket(d: Date, unit: StatsRange["bucket"]): Date {
    const n = new Date(d);
    if (unit === "hour") n.setUTCHours(n.getUTCHours() + 1);
    else if (unit === "day") n.setUTCDate(n.getUTCDate() + 1);
    else if (unit === "week") n.setUTCDate(n.getUTCDate() + 7);
    else n.setUTCMonth(n.getUTCMonth() + 1);
    return n;
}

/** Every bucket of the window, with 0 where nothing was played (a gap is a real 0). */
function fillBuckets(
    rows: { bucket: string; games: number; players: number }[],
    from: number | null,
    to: number,
    unit: StatsRange["bucket"],
) {
    const start = from ?? (rows[0] ? new Date(rows[0].bucket).getTime() : null);
    if (start === null) return rows;
    const byKey = new Map(rows.map((r) => [new Date(r.bucket).getTime(), r]));
    const out: typeof rows = [];
    for (let b = truncUtc(start, unit); b.getTime() < to && out.length < 1000; b = nextBucket(b, unit)) {
        out.push(byKey.get(b.getTime()) ?? { bucket: b.toISOString(), games: 0, players: 0 });
    }
    return out;
}

async function timeseries(where: SQL, bucket: StatsRange["bucket"]) {
    // the unit is a fixed internal enum - inlined so SELECT/GROUP BY/ORDER BY render the
    // same expression (a bound parameter makes Postgres reject the GROUP BY)
    // in UTC whatever the DB session zone is, to line up with fillBuckets
    const b = sql.raw(`(date_trunc('${bucket}', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`);
    const res = await db.execute(sql`
        SELECT ${b} AS bucket, COUNT(DISTINCT game_id) AS games, COUNT(*) AS players
        FROM match_data WHERE ${where} GROUP BY ${b} ORDER BY ${b}
    `);
    return (res.rows as Record<string, unknown>[]).map((r) => ({
        bucket: new Date(r.bucket as string).toISOString(),
        games: n(r.games),
        players: n(r.players),
    }));
}

let optionsCache: { at: number; value: Historical["options"] } | null = null;

/** Every mode / region / map that has games at all (for the filter dropdowns). */
async function filterOptions(): Promise<Historical["options"]> {
    if (optionsCache && Date.now() - optionsCache.at < 3600_000) return optionsCache.value;
    const [modes, regions, maps] = await Promise.all([
        db.execute(sql`SELECT DISTINCT team_mode AS v FROM match_data`),
        db.execute(sql`SELECT DISTINCT region AS v FROM match_data`),
        db.execute(sql`SELECT DISTINCT map_id AS v FROM match_data`),
    ]);
    const value = {
        teamModes: (modes.rows as { v: number }[]).map((r) => n(r.v)).sort((a, b) => a - b),
        regions: [
            ...new Set([...(regions.rows as { v: string }[]).map((r) => r.v), ...Object.keys(Config.regions)]),
        ].sort(),
        mapIds: (maps.rows as { v: number }[]).map((r) => n(r.v)).sort((a, b) => a - b),
    };
    optionsCache = { at: Date.now(), value };
    return value;
}

async function computeHistorical(req: {
    period: ServerStatsResponse["period"];
    season?: string;
    month?: string;
    compare?: string;
} & Filters): Promise<Historical> {
    const range = statsRangeFor(req);
    const filters: Filters = { teamMode: req.teamMode, region: req.region, mapId: req.mapId };
    const where = whereFor(range.from, range.to, filters);
    const prevWhere =
        range.prevFrom !== null && range.prevTo !== null
            ? whereFor(range.prevFrom, range.prevTo, filters)
            : null;

    const [totals, previous, byMode, byRegion, byMap, series, prevSeries, hours, options] =
        await Promise.all([
            metrics(where),
            prevWhere ? metrics(prevWhere) : Promise.resolve(null),
            metrics(where, "team_mode"),
            metrics(where, "region"),
            metrics(where, "map_id"),
            timeseries(where, range.bucket),
            prevWhere ? timeseries(prevWhere, range.bucket) : Promise.resolve([]),
            db.execute(sql`
                SELECT EXTRACT(HOUR FROM g.started AT TIME ZONE 'UTC') AS hour, COUNT(*) AS games
                FROM (SELECT MIN(created_at) AS started FROM match_data WHERE ${where} GROUP BY game_id) g
                GROUP BY 1 ORDER BY 1
            `),
            filterOptions(),
        ]);

    const byGames = (a: ServerStatsMetrics, b: ServerStatsMetrics) => b.games - a.games;
    return {
        period: req.period,
        range: { from: range.from, to: range.to },
        prevRange:
            range.prevFrom !== null && range.prevTo !== null
                ? { from: range.prevFrom, to: range.prevTo }
                : null,
        seasons: statsSeasons(),
        season: range.season?.id,
        month: range.month?.id,
        totals: totals[0] ? strip(totals[0]) : EMPTY,
        previous: previous ? (previous[0] ? strip(previous[0]) : EMPTY) : null,
        byTeamMode: byMode.map((r) => ({ teamMode: n(r.key), ...strip(r) })).sort(byGames),
        byRegion: byRegion.map((r) => ({ region: r.key, ...strip(r) })).sort(byGames),
        byMap: byMap.map((r) => ({ mapId: n(r.key), ...strip(r) })).sort(byGames),
        bucket: range.bucket,
        timeseries: fillBuckets(series, range.from, range.to, range.bucket),
        // aligned with the current window by index - never longer than it
        prevTimeseries:
            range.prevFrom !== null && range.prevTo !== null
                ? fillBuckets(prevSeries, range.prevFrom, range.prevTo, range.bucket).slice(
                      0,
                      fillBuckets(series, range.from, range.to, range.bucket).length,
                  )
                : [],
        hourOfDay: Array.from({ length: 24 }, (_, hour) => ({
            hour,
            games: n(
                (hours.rows as Record<string, unknown>[]).find((r) => n(r.hour) === hour)?.games,
            ),
        })),
        options,
    };
}

async function getCached(key: string): Promise<Historical | null> {
    if (!Config.cachingEnabled) return null;
    try {
        const client = await getRedisClient();
        const raw = await client.get(key);
        return raw ? (JSON.parse(raw) as Historical) : null;
    } catch {
        return null; // cache miss / redis unavailable → fall back to a live query
    }
}

async function setCached(key: string, data: Historical): Promise<void> {
    if (!Config.cachingEnabled) return;
    try {
        const client = await getRedisClient();
        await client.setEx(key, CACHE_TTL, JSON.stringify(data));
    } catch {
        /* non-fatal */
    }
}

/** Current live activity from the region heartbeats (always fresh, never cached). */
function liveSnapshot(): ServerStatsResponse["live"] {
    const pops = server.getSiteInfo().pops;
    const regions = Object.entries(pops).map(([region, p]) => ({
        region,
        playerCount: p.playerCount ?? 0,
        gameCount: p.gameCount ?? 0,
    }));
    return {
        totalPlayers: regions.reduce((a, r) => a + r.playerCount, 0),
        totalGames: regions.reduce((a, r) => a + r.gameCount, 0),
        regions,
    };
}

serverStatsRouter.post(
    "/",
    databaseEnabledMiddleware,
    rateLimitMiddleware(40, 60 * 1000),
    validateParams(zServerStatsRequest),
    async (c) => {
        const req = c.req.valid("json");
        const key = `serverstats:v5:${req.period}:${req.season ?? ""}:${req.month ?? ""}:${req.compare ?? ""}:${req.teamMode ?? ""}:${req.region ?? ""}:${req.mapId ?? ""}`;

        let historical = await getCached(key);
        if (!historical) {
            historical = await computeHistorical(req);
            await setCached(key, historical);
        }

        return c.json<ServerStatsResponse>({
            ...historical,
            live: liveSnapshot(),
            generatedAt: Date.now(),
        });
    },
);
