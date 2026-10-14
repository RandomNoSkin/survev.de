import $ from "jquery";
import { MapId } from "../../../../shared/gameConfig.ts";
import {
    STATS_COMPARE_RE,
    STATS_MONTH_RE,
    STATS_PERIOD_LABELS,
    STATS_PERIODS,
    type StatsPeriod,
    statsCompareOptionsHtml,
    statsMonthOptionsHtml,
    statsRangeLabel,
} from "../../../../shared/statsPeriods.ts";
import type {
    ServerStatsMetrics,
    ServerStatsRequest,
    ServerStatsResponse,
} from "../../../../shared/types/stats";
import { api } from "../../api";
import { helpers } from "../../helpers";
import type { App } from "./app";
import { barChart, CHART_COLORS, doughnutChart, type LineSeries, lineChart } from "./charts";

const TEAM_MODE_LABEL: Record<number, string> = { 1: "Solo", 2: "Duo", 4: "Squad" };
const TEAM_MODE_COLOR: Record<number, string> = {
    1: CHART_COLORS[0],
    2: CHART_COLORS[1],
    4: CHART_COLORS[2],
};

const LIVE_POLL_MS = 10_000;

function esc(s: unknown): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
const fmt = (n: number) => n.toLocaleString("en-US");
const teamModeLabel = (m: number) => TEAM_MODE_LABEL[m] ?? `Mode ${m}`;
const mapLabel = (id: number) => (MapId[id] ?? `Map ${id}`).toString();
const duration = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

/** One comparable number: how it's shown and whether "more" is good. */
const METRICS: { key: keyof ServerStatsMetrics; label: string; show: (v: number) => string }[] = [
    { key: "games", label: "Matches", show: fmt },
    { key: "participations", label: "Player-matches", show: fmt },
    { key: "uniquePlayers", label: "Unique players", show: fmt },
    { key: "registeredPlayers", label: "Registered players", show: fmt },
    { key: "avgPlayersPerGame", label: "Ø players / match", show: (v) => v.toFixed(1) },
    { key: "avgDurationSec", label: "Ø match length", show: duration },
    { key: "killsPerPlayer", label: "Kills / player", show: (v) => v.toFixed(2) },
    { key: "damagePerPlayer", label: "Damage / player", show: fmt },
];

/** "+12.5%" against the period before; nothing when there's nothing to compare. */
function delta(cur: number, prev: number | undefined): string {
    if (prev === undefined) return "";
    if (prev === 0) return cur === 0 ? `<span class="ss-delta">±0%</span>` : `<span class="ss-delta up">new</span>`;
    const pct = ((cur - prev) / prev) * 100;
    const cls = Math.abs(pct) < 0.5 ? "" : pct > 0 ? "up" : "down";
    const arrow = cls === "up" ? "▲" : cls === "down" ? "▼" : "";
    return `<span class="ss-delta ${cls}" title="before: ${esc(prev)}">${arrow} ${pct > 0 ? "+" : ""}${pct.toFixed(1)}%</span>`;
}

/** Formats a bucket ISO timestamp into a short axis label appropriate for the bucket size. */
function bucketLabel(iso: string, bucket: ServerStatsResponse["bucket"]): string {
    const d = new Date(iso);
    if (bucket === "hour") return `${String(d.getHours()).padStart(2, "0")}:00`;
    if (bucket === "month") return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    return d.toLocaleDateString("en-US", { day: "2-digit", month: "2-digit" });
}

interface Query {
    period: StatsPeriod;
    season?: string;
    /** a calendar month "YYYY-MM" - wins over the period */
    month?: string;
    compare?: string;
    teamMode?: number;
    region?: string;
    mapId?: number;
}

/**
 * Server-wide statistics: a period (24h / 7d / 30d / 12 months / a season / all time)
 * compared with the one before it, filterable by mode, region and map, with the
 * breakdowns side by side. Public, lives at `/stats/?view=server`.
 */
export class ServerStatsView {
    loading = false;
    error = false;
    query: Query = { period: "week" };
    data: ServerStatsResponse | null = null;
    private liveTimer: number | null = null;

    el = $('<div id="server-stats-view"></div>');

    constructor(readonly app: App) {}

    private readQuery(): Query {
        const p = (k: string) => helpers.getParameterByName<string>(k) || undefined;
        const num = (k: string) => {
            const v = p(k);
            return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined;
        };
        // old links used ?t=daily|weekly|...
        const legacy: Record<string, StatsPeriod> = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };
        const t = p("t");
        const period = (STATS_PERIODS as readonly string[]).includes(t ?? "")
            ? (t as StatsPeriod)
            : legacy[t ?? ""] ?? "week";
        const month = p("month");
        const compare = p("cmp");
        return {
            period,
            season: p("season"),
            month: month && STATS_MONTH_RE.test(month) ? month : undefined,
            compare: compare && STATS_COMPARE_RE.test(compare) ? compare : undefined,
            teamMode: num("mode"),
            region: p("region"),
            mapId: num("map"),
        };
    }

    private writeQuery() {
        const q = this.query;
        const parts = [`view=server`, `t=${q.period}`];
        if (q.period === "season" && q.season) parts.push(`season=${encodeURIComponent(q.season)}`);
        if (q.month) parts.push(`month=${q.month}`);
        if (q.compare && q.compare !== "prev") parts.push(`cmp=${encodeURIComponent(q.compare)}`);
        if (q.teamMode !== undefined) parts.push(`mode=${q.teamMode}`);
        if (q.region) parts.push(`region=${encodeURIComponent(q.region)}`);
        if (q.mapId !== undefined) parts.push(`map=${q.mapId}`);
        window.history.pushState("", "", `?${parts.join("&")}`);
    }

    load() {
        this.query = this.readQuery();
        this.fetch();
    }

    private fetch() {
        this.loading = true;
        this.error = false;
        const body: ServerStatsRequest = { ...this.query };
        $.ajax({
            url: api.resolveUrl("/api/server_stats"),
            type: "POST",
            data: JSON.stringify(body),
            contentType: "application/json; charset=utf-8",
            success: (data: ServerStatsResponse) => {
                this.data = data;
            },
            error: () => {
                this.error = true;
            },
            complete: () => {
                this.loading = false;
                this.render();
                this.startLivePolling();
            },
        });
        this.render();
    }

    private setQuery(change: Partial<Query>) {
        this.query = { ...this.query, ...change };
        if (this.query.period !== "season") delete this.query.season;
        this.writeQuery();
        this.fetch();
    }

    private startLivePolling() {
        this.stopLivePolling();
        this.liveTimer = window.setInterval(() => {
            // Auto-stop once the view is no longer on screen (no teardown hook exists).
            if (!document.body.contains(this.el[0])) {
                this.stopLivePolling();
                return;
            }
            $.ajax({
                url: api.resolveUrl("/api/site_info"),
                type: "GET",
                success: (info: {
                    pops?: Record<string, { playerCount: number; gameCount?: number }>;
                }) => {
                    const pops = info?.pops ?? {};
                    const regions = Object.entries(pops).map(([region, p]) => ({
                        region,
                        playerCount: p.playerCount ?? 0,
                        gameCount: p.gameCount ?? 0,
                    }));
                    this.updateLive({
                        totalPlayers: regions.reduce((a, r) => a + r.playerCount, 0),
                        totalGames: regions.reduce((a, r) => a + r.gameCount, 0),
                        regions,
                    });
                },
            });
        }, LIVE_POLL_MS);
    }

    private stopLivePolling() {
        if (this.liveTimer !== null) {
            window.clearInterval(this.liveTimer);
            this.liveTimer = null;
        }
    }

    private updateLive(live: ServerStatsResponse["live"]) {
        this.el.find("#ss-live-players").text(fmt(live.totalPlayers));
        this.el.find("#ss-live-games").text(fmt(live.totalGames));
        this.el.find("#ss-live-regions").html(
            live.regions
                .filter((r) => r.playerCount > 0 || r.gameCount > 0)
                .map(
                    (r) =>
                        `<span class="ss-live-region">${esc(r.region.toUpperCase())}: ${fmt(r.playerCount)}p / ${fmt(r.gameCount)}g</span>`,
                )
                .join(""),
        );
    }

    private controls(d: ServerStatsResponse | null): string {
        const q = this.query;
        const opt = (value: string, label: string, selected: boolean) =>
            `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
        const periods =
            (q.month ? opt("", "Calendar month", true) : "") +
            STATS_PERIODS.map((p) => opt(p, STATS_PERIOD_LABELS[p], !q.month && p === q.period)).join("");
        const seasons = d?.seasons ?? [];
        const seasonSel =
            !q.month && q.period === "season" && seasons.length
                ? `<select id="ss-season" class="form-control ss-select">${[...seasons]
                      .reverse()
                      .map((s) =>
                          opt(
                              s.id,
                              `${s.label} (${new Date(s.start).toLocaleDateString()} – ${new Date(s.end).toLocaleDateString()})`,
                              s.id === (q.season ?? d?.season),
                          ),
                      )
                      .join("")}</select>`
                : "";
        const options = d?.options ?? { teamModes: [], regions: [], mapIds: [] };
        const modes = [opt("", "All modes", q.teamMode === undefined), ...options.teamModes.map((m) => opt(String(m), teamModeLabel(m), m === q.teamMode))].join("");
        const regions = [opt("", "All servers", !q.region), ...options.regions.map((r) => opt(r, r.toUpperCase(), r === q.region))].join("");
        const maps = [opt("", "All maps", q.mapId === undefined), ...options.mapIds.map((m) => opt(String(m), mapLabel(m), m === q.mapId))].join("");
        return `<div class="ss-controls">
            <select id="ss-period" class="form-control ss-select">${periods}</select>
            ${seasonSel}
            <select id="ss-month" class="form-control ss-select">${statsMonthOptionsHtml(q.month)}</select>
            ${!d || d.range.from !== null ? `<select id="ss-compare" class="form-control ss-select">${statsCompareOptionsHtml(q.compare)}</select>` : ""}
            <select id="ss-mode" class="form-control ss-select">${modes}</select>
            <select id="ss-region" class="form-control ss-select">${regions}</select>
            <select id="ss-map" class="form-control ss-select">${maps}</select>
        </div>`;
    }

    private compareCards(d: ServerStatsResponse): string {
        const prev = d.previous ?? undefined;
        return `<div class="ss-cards">${METRICS.map((m) => `
            <div class="ss-card">
                <div class="ss-card-value">${m.show(d.totals[m.key])}</div>
                <div class="ss-card-label">${esc(m.label)}</div>
                ${prev ? `<div class="ss-card-prev">${delta(d.totals[m.key], prev[m.key])} <span>vs ${m.show(prev[m.key])}</span></div>` : ""}
            </div>`).join("")}</div>`;
    }

    /** Mode / server / map rows with every metric, sorted by matches; a click filters by it. */
    private compareTable<T extends ServerStatsMetrics>(
        title: string,
        rows: T[],
        label: (r: T) => string,
        filter: (r: T) => Partial<Query>,
    ): string {
        if (!rows.length) return `<div class="ss-empty">No data</div>`;
        const totalGames = rows.reduce((a, r) => a + r.games, 0) || 1;
        const head = `<tr><th>${esc(title)}</th>${METRICS.map((m) => `<th>${esc(m.label)}</th>`).join("")}</tr>`;
        const body = rows
            .map((r, i) => {
                const share = Math.round((r.games / totalGames) * 100);
                return `<tr class="ss-row-link" data-row="${i}" title="Show only this">
                    <td><b>${esc(label(r))}</b><div class="ss-share"><span style="width:${share}%"></span></div></td>
                    ${METRICS.map((m) => `<td>${m.show(r[m.key])}</td>`).join("")}
                </tr>`;
            })
            .join("");
        const id = `ss-tbl-${title.toLowerCase().replace(/\W+/g, "")}`;
        // remembered so the click handler can apply the row's filter
        this.rowFilters.set(id, rows.map(filter));
        return `<div class="ss-table-wrap"><table class="ss-table ss-compare" id="${id}"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
    }

    private rowFilters = new Map<string, Partial<Query>[]>();

    render() {
        this.rowFilters.clear();
        const d = this.data;
        let body: string;
        if (this.loading && !d) {
            body = `<div class="ss-content"><div class="col-12 spinner-wrapper-leaderboard"><div class="spinner"></div></div></div>`;
        } else if (this.error || !d) {
            body = `<div class="ss-content"><div class="ss-error">Failed to load server stats.</div></div>`;
        } else {
            const range = d.range.from
                ? `${new Date(d.range.from).toLocaleString()} – ${new Date(d.range.to).toLocaleString()}`
                : `until ${new Date(d.range.to).toLocaleString()}`;
            const prevRange = d.prevRange
                ? `compared with ${statsRangeLabel(d.prevRange.from, d.prevRange.to)}`
                : "nothing to compare with";

            const series: LineSeries[] = [
                { label: "Matches", color: CHART_COLORS[0], points: d.timeseries.map((t) => t.games) },
                { label: "Player-matches", color: CHART_COLORS[1], points: d.timeseries.map((t) => t.players) },
            ];
            if (d.prevTimeseries.length) {
                series.push(
                    { label: "Matches (before)", color: CHART_COLORS[0], points: d.prevTimeseries.map((t) => t.games), dashed: true },
                    { label: "Player-matches (before)", color: CHART_COLORS[1], points: d.prevTimeseries.map((t) => t.players), dashed: true },
                );
            }
            const lineSvg = lineChart(series, d.timeseries.map((t) => bucketLabel(t.bucket, d.bucket)));

            // UTC hours -> the viewer's clock
            const offset = -new Date().getTimezoneOffset() / 60;
            const hours = Array.from({ length: 24 }, (_, h) => {
                const utc = (((h - offset) % 24) + 24) % 24;
                return { label: String(h).padStart(2, "0"), value: d.hourOfDay.find((x) => x.hour === Math.round(utc))?.games ?? 0 };
            });
            const peak = hours.reduce((a, b) => (b.value > a.value ? b : a), hours[0]);

            const doughnutSvg = doughnutChart(
                d.byTeamMode.map((t) => ({
                    label: teamModeLabel(t.teamMode),
                    value: t.games,
                    color: TEAM_MODE_COLOR[t.teamMode] ?? CHART_COLORS[3],
                })),
            );

            body = `<div class="ss-content">
                <div class="ss-range">${esc(range)} · <span>${esc(prevRange)}</span>${this.loading ? ` · <i>updating…</i>` : ""}</div>
                ${this.compareCards(d)}
                <div class="ss-chart-block">
                    <div class="ss-chart-title">Activity over time ${d.prevTimeseries.length ? `<span class="ss-hint">dashed = the compared period</span>` : ""}</div>
                    ${lineSvg}
                </div>
                <div class="ss-chart-grid">
                    <div class="ss-chart-block">
                        <div class="ss-chart-title">Matches by mode</div>
                        ${doughnutSvg}
                    </div>
                    <div class="ss-chart-block">
                        <div class="ss-chart-title">Matches by hour of day <span class="ss-hint">your time · busiest ${peak.label}:00</span></div>
                        ${barChart(hours.map((h) => ({ label: h.label, value: h.value })), CHART_COLORS[2])}
                    </div>
                </div>
                <div class="ss-chart-block">
                    <div class="ss-chart-title">Modes compared <span class="ss-hint">click a row to show only it</span></div>
                    ${this.compareTable("Mode", d.byTeamMode, (r) => teamModeLabel(r.teamMode), (r) => ({ teamMode: r.teamMode }))}
                </div>
                <div class="ss-chart-block">
                    <div class="ss-chart-title">Servers compared</div>
                    ${this.compareTable("Server", d.byRegion, (r) => r.region.toUpperCase(), (r) => ({ region: r.region }))}
                </div>
                <div class="ss-chart-block">
                    <div class="ss-chart-title">Maps compared</div>
                    ${this.compareTable("Map", d.byMap, (r) => mapLabel(r.mapId), (r) => ({ mapId: r.mapId }))}
                </div>
            </div>`;
        }

        const live = this.data?.live;
        const html = `<div class="server-stats container">
            <div class="ss-header">
                <div class="ss-title">SERVER STATISTICS</div>
                ${this.controls(d)}
            </div>
            <div class="ss-live">
                <span class="ss-live-dot"></span><span class="ss-live-text">LIVE</span>
                <span class="ss-live-stat"><b id="ss-live-players">${live ? fmt(live.totalPlayers) : "—"}</b> players</span>
                <span class="ss-live-stat"><b id="ss-live-games">${live ? fmt(live.totalGames) : "—"}</b> games</span>
                <span class="ss-live-regions" id="ss-live-regions"></span>
            </div>
            ${body}
        </div>`;

        this.el.html(html);
        if (live) this.updateLive(live);
        this.el.find("#ss-period").on("change", (e) => {
            const v = $(e.target).val() as string;
            if (v) this.setQuery({ period: v as StatsPeriod, month: undefined });
        });
        this.el.find("#ss-month").on("change", (e) => this.setQuery({ month: ($(e.target).val() as string) || undefined }));
        this.el.find("#ss-compare").on("change", (e) => this.setQuery({ compare: $(e.target).val() as string }));
        this.el.find("#ss-season").on("change", (e) => this.setQuery({ season: $(e.target).val() as string }));
        this.el.find("#ss-mode").on("change", (e) => {
            const v = $(e.target).val() as string;
            this.setQuery({ teamMode: v === "" ? undefined : Number(v) });
        });
        this.el.find("#ss-region").on("change", (e) => {
            const v = $(e.target).val() as string;
            this.setQuery({ region: v || undefined });
        });
        this.el.find("#ss-map").on("change", (e) => {
            const v = $(e.target).val() as string;
            this.setQuery({ mapId: v === "" ? undefined : Number(v) });
        });
        for (const [id, filters] of this.rowFilters) {
            this.el.find(`#${id} .ss-row-link`).on("click", (e) => {
                const idx = Number($(e.currentTarget).attr("data-row"));
                if (filters[idx]) this.setQuery(filters[idx]);
            });
        }
    }
}
