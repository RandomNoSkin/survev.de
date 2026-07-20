import $ from "jquery";
import { MapId } from "../../../../shared/gameConfig.ts";
import type {
    ServerStatsInterval,
    ServerStatsResponse,
} from "../../../../shared/types/stats";
import { api } from "../../api";
import { helpers } from "../../helpers";
import type { App } from "./app";
import { barChart, CHART_COLORS, doughnutChart, lineChart } from "./charts";

const INTERVALS: { value: ServerStatsInterval; label: string }[] = [
    { value: "daily", label: "Daily" },
    { value: "weekly", label: "Weekly" },
    { value: "monthly", label: "Monthly" },
    { value: "yearly", label: "Yearly" },
    { value: "alltime", label: "All-time" },
];

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
        .replace(/>/g, "&gt;");
}
const fmt = (n: number) => n.toLocaleString("en-US");
const teamModeLabel = (m: number) => TEAM_MODE_LABEL[m] ?? `Mode ${m}`;
const mapLabel = (id: number) => (MapId[id] ?? `Map ${id}`).toString();

/** Formats a bucket ISO timestamp into a short axis label appropriate for the interval. */
function bucketLabel(iso: string, interval: ServerStatsInterval): string {
    const d = new Date(iso);
    if (interval === "daily") {
        return `${String(d.getHours()).padStart(2, "0")}:00`;
    }
    if (interval === "yearly" || interval === "alltime") {
        return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    }
    return d.toLocaleDateString("en-US", { day: "2-digit", month: "2-digit" });
}

/**
 * Server-wide statistics view: totals, breakdowns and time-series charts (per
 * daily/weekly/monthly/yearly/all-time) plus a live players/games block that polls
 * `/api/site_info`. Public, lives at `/stats/?view=server`.
 */
export class ServerStatsView {
    loading = false;
    error = false;
    interval: ServerStatsInterval = "weekly";
    data: ServerStatsResponse | null = null;
    private liveTimer: number | null = null;

    el = $('<div id="server-stats-view"></div>');

    constructor(readonly app: App) {}

    load() {
        const t = helpers.getParameterByName<ServerStatsInterval>("t");
        this.interval = INTERVALS.some((i) => i.value === t) ? t : "weekly";
        this.loading = true;
        this.error = false;

        $.ajax({
            url: api.resolveUrl("/api/server_stats"),
            type: "POST",
            data: JSON.stringify({ interval: this.interval }),
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

    private onChangeInterval(value: string) {
        window.history.pushState("", "", `?view=server&t=${value}`);
        this.load();
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

    private card(label: string, value: number, accent?: string): string {
        const style = accent ? ` style="color:${accent}"` : "";
        return `<div class="ss-card"><div class="ss-card-value"${style}>${fmt(value)}</div><div class="ss-card-label">${esc(label)}</div></div>`;
    }

    private breakdownTable(
        title: string,
        rows: { label: string; games: number; participations?: number }[],
    ): string {
        const hasPart = rows.some((r) => r.participations !== undefined);
        const head = `<tr><th>${esc(title)}</th><th>Games</th>${hasPart ? "<th>Players</th>" : ""}</tr>`;
        const body = rows.length
            ? rows
                  .map(
                      (r) =>
                          `<tr><td>${esc(r.label)}</td><td>${fmt(r.games)}</td>${hasPart ? `<td>${fmt(r.participations ?? 0)}</td>` : ""}</tr>`,
                  )
                  .join("")
            : `<tr><td colspan="3" class="ss-empty">No data</td></tr>`;
        return `<table class="ss-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }

    render() {
        const intervalOpts = INTERVALS.map(
            (i) =>
                `<option value="${i.value}"${i.value === this.interval ? " selected" : ""}>${i.label}</option>`,
        ).join("");

        let body: string;
        if (this.loading) {
            body = `<div class="ss-content"><div class="col-12 spinner-wrapper-leaderboard"><div class="spinner"></div></div></div>`;
        } else if (this.error || !this.data) {
            body = `<div class="ss-content"><div class="ss-error">Failed to load server stats.</div></div>`;
        } else {
            const d = this.data;
            const byTeam = [...d.byTeamMode].sort((a, b) => b.games - a.games);
            const byMap = [...d.byMap].sort((a, b) => b.games - a.games);
            const byRegion = [...d.byRegion].sort((a, b) => b.games - a.games);

            const lineSvg = lineChart(
                [
                    {
                        label: "Games",
                        color: CHART_COLORS[0],
                        points: d.timeseries.map((t) => t.games),
                    },
                    {
                        label: "Players",
                        color: CHART_COLORS[1],
                        points: d.timeseries.map((t) => t.players),
                    },
                ],
                d.timeseries.map((t) => bucketLabel(t.bucket, d.interval)),
            );
            const doughnutSvg = doughnutChart(
                byTeam.map((t) => ({
                    label: teamModeLabel(t.teamMode),
                    value: t.games,
                    color: TEAM_MODE_COLOR[t.teamMode] ?? CHART_COLORS[3],
                })),
            );
            const mapSvg = barChart(
                byMap.map((m) => ({ label: mapLabel(m.mapId), value: m.games })),
                CHART_COLORS[2],
            );
            const regionSvg = barChart(
                byRegion.map((r) => ({ label: r.region.toUpperCase(), value: r.games })),
                CHART_COLORS[3],
            );

            body = `<div class="ss-content">
                <div class="ss-cards">
                    ${this.card("Games", d.totals.games)}
                    ${this.card("Player-Games", d.totals.participations)}
                    ${this.card("Unique Players", d.totals.uniquePlayers)}
                    ${this.card("Registered", d.totals.registeredPlayers)}
                </div>
                <div class="ss-chart-block">
                    <div class="ss-chart-title">Activity over time</div>
                    ${lineSvg}
                </div>
                <div class="ss-chart-grid">
                    <div class="ss-chart-block">
                        <div class="ss-chart-title">Games by mode</div>
                        ${doughnutSvg}
                        ${this.breakdownTable(
                            "Mode",
                            byTeam.map((t) => ({
                                label: teamModeLabel(t.teamMode),
                                games: t.games,
                                participations: t.participations,
                            })),
                        )}
                    </div>
                    <div class="ss-chart-block">
                        <div class="ss-chart-title">Games by map</div>
                        ${mapSvg}
                        ${this.breakdownTable(
                            "Map",
                            byMap.map((m) => ({
                                label: mapLabel(m.mapId),
                                games: m.games,
                            })),
                        )}
                    </div>
                </div>
                <div class="ss-chart-block">
                    <div class="ss-chart-title">Games by region</div>
                    ${regionSvg}
                    ${this.breakdownTable(
                        "Region",
                        byRegion.map((r) => ({
                            label: r.region.toUpperCase(),
                            games: r.games,
                            participations: r.participations,
                        })),
                    )}
                </div>
            </div>`;
        }

        const live = this.data?.live;
        const html = `<div class="server-stats container">
            <div class="ss-header">
                <div class="ss-title">SERVER STATISTICS</div>
                <div class="ss-controls">
                    <label for="server-stats-time">Period</label>
                    <select id="server-stats-time" class="form-control ss-select">${intervalOpts}</select>
                </div>
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
        this.el.find("#server-stats-time").on("change", (e) => {
            this.onChangeInterval(($(e.target).val() as string) ?? "weekly");
        });
    }
}
