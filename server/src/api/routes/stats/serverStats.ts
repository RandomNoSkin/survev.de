import { and, count, gte, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
    type ServerStatsInterval,
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
import { matchDataTable } from "../../db/schema";

export const serverStatsRouter = new Hono<Context>();

const CACHE_TTL = 300; // 5 min — these are full-table aggregates, keep DB load low.

/** Lower bound for each interval; `alltime` has none. */
const intervalStart: Record<Exclude<ServerStatsInterval, "alltime">, SQL> = {
    daily: sql`NOW() - INTERVAL '1 day'`,
    weekly: sql`NOW() - INTERVAL '7 days'`,
    monthly: sql`NOW() - INTERVAL '30 days'`,
    yearly: sql`NOW() - INTERVAL '1 year'`,
};

/** date_trunc unit for the time series, chosen to keep the bucket count reasonable. */
function bucketUnit(interval: ServerStatsInterval): "hour" | "day" | "month" {
    if (interval === "daily") return "hour";
    if (interval === "yearly" || interval === "alltime") return "month";
    return "day"; // weekly, monthly
}

type Historical = Pick<
    ServerStatsResponse,
    "totals" | "byTeamMode" | "byRegion" | "byMap" | "timeseries"
>;

const n = (v: unknown) => Number(v ?? 0);

async function computeHistorical(interval: ServerStatsInterval): Promise<Historical> {
    const where =
        interval === "alltime"
            ? undefined
            : and(gte(matchDataTable.createdAt, intervalStart[interval]));

    const games = sql<number>`COUNT(DISTINCT ${matchDataTable.gameId})`;

    const [totalsRow] = await db
        .select({
            games,
            participations: count(),
            uniquePlayers: sql<number>`COUNT(DISTINCT NULLIF(${matchDataTable.encodedIp}, ''))`,
            registeredPlayers: sql<number>`COUNT(DISTINCT NULLIF(${matchDataTable.userId}, ''))`,
        })
        .from(matchDataTable)
        .where(where);

    const byTeamMode = await db
        .select({ teamMode: matchDataTable.teamMode, games, participations: count() })
        .from(matchDataTable)
        .where(where)
        .groupBy(matchDataTable.teamMode);

    const byRegion = await db
        .select({ region: matchDataTable.region, games, participations: count() })
        .from(matchDataTable)
        .where(where)
        .groupBy(matchDataTable.region);

    const byMap = await db
        .select({ mapId: matchDataTable.mapId, games })
        .from(matchDataTable)
        .where(where)
        .groupBy(matchDataTable.mapId);

    // Inline the unit (a fixed internal enum, not user input) so the SELECT/GROUP BY/
    // ORDER BY render the *same* expression — a bound $1 makes Postgres treat them as
    // different expressions and reject the GROUP BY.
    const bucket = sql`date_trunc(${sql.raw(`'${bucketUnit(interval)}'`)}, ${matchDataTable.createdAt})`;
    const timeseries = await db
        .select({ bucket, games, players: count() })
        .from(matchDataTable)
        .where(where)
        .groupBy(bucket)
        .orderBy(bucket);

    return {
        totals: {
            games: n(totalsRow?.games),
            participations: n(totalsRow?.participations),
            uniquePlayers: n(totalsRow?.uniquePlayers),
            registeredPlayers: n(totalsRow?.registeredPlayers),
        },
        byTeamMode: byTeamMode.map((r) => ({
            teamMode: n(r.teamMode),
            games: n(r.games),
            participations: n(r.participations),
        })),
        byRegion: byRegion.map((r) => ({
            region: r.region,
            games: n(r.games),
            participations: n(r.participations),
        })),
        byMap: byMap.map((r) => ({ mapId: n(r.mapId), games: n(r.games) })),
        timeseries: timeseries.map((r) => ({
            bucket: new Date(r.bucket as string | number | Date).toISOString(),
            games: n(r.games),
            players: n(r.players),
        })),
    };
}

async function getCached(interval: ServerStatsInterval): Promise<Historical | null> {
    if (!Config.cachingEnabled) return null;
    try {
        const client = await getRedisClient();
        const raw = await client.get(`serverstats:v1:${interval}`);
        return raw ? (JSON.parse(raw) as Historical) : null;
    } catch {
        return null; // cache miss / redis unavailable → fall back to a live query
    }
}

async function setCached(interval: ServerStatsInterval, data: Historical): Promise<void> {
    if (!Config.cachingEnabled) return;
    try {
        const client = await getRedisClient();
        await client.setEx(`serverstats:v1:${interval}`, CACHE_TTL, JSON.stringify(data));
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
        const { interval } = c.req.valid("json");

        let historical = await getCached(interval);
        if (!historical) {
            historical = await computeHistorical(interval);
            await setCached(interval, historical);
        }

        return c.json<ServerStatsResponse>({
            interval,
            ...historical,
            live: liveSnapshot(),
            generatedAt: Date.now(),
        });
    },
);
