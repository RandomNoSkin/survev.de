import $ from "jquery";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import { MapId } from "../../../../shared/gameConfig.ts";
import {
    STATS_PERIOD_LABELS,
    STATS_PERIODS,
    type StatsPeriod,
    statsCompareOptionsHtml,
    statsMonthOptionsHtml,
    statsRangeLabel,
} from "../../../../shared/statsPeriods.ts";
import type {
    UserProfileOverview,
    UserProfileStatsRequest,
    UserProfileStatsResponse,
} from "../../../../shared/types/stats";
import { api } from "../../api";
import { helpers } from "../../helpers";
import { CHART_COLORS, lineChart } from "./charts";

const TEAM_MODE_LABEL: Record<number, string> = { 1: "Solo", 2: "Duo", 4: "Squad" };

function esc(s: unknown): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
const fmt = (v: number) => v.toLocaleString("en-US");
const time = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m ${Math.round(sec % 60)}s`;
};
const weaponName = (type: string) =>
    (GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined)?.name ?? type;
/** Item icons are relative to the game root - the stats page lives under /stats/. */
const iconUrl = (type: string) => {
    const src = helpers.getSvgFromGameType(type);
    return src.startsWith("img/") ? `/${src}` : src;
};
const mapLabel = (id: number) => (MapId[id] ?? `Map ${id}`).toString();

/** The overview numbers, how they read, and whether lower is better. */
const OVERVIEW: { key: keyof UserProfileOverview; label: string; show: (v: number) => string; lowerIsBetter?: boolean }[] = [
    { key: "games", label: "Matches", show: fmt },
    { key: "wins", label: "Wins", show: fmt },
    { key: "winRate", label: "Win rate", show: (v) => `${v}%` },
    { key: "kills", label: "Kills", show: fmt },
    { key: "kd", label: "K/D", show: (v) => v.toFixed(2) },
    { key: "avgKills", label: "Ø kills", show: (v) => v.toFixed(2) },
    { key: "avgDamage", label: "Ø damage", show: fmt },
    { key: "accuracy", label: "Accuracy", show: (v) => `${v}%` },
    { key: "avgRank", label: "Ø placement", show: (v) => `#${v}`, lowerIsBetter: true },
    { key: "top5", label: "Top 5", show: fmt },
    { key: "assists", label: "Assists", show: fmt },
    { key: "revives", label: "Revives", show: fmt },
    { key: "maxKills", label: "Most kills", show: fmt },
    { key: "maxDamage", label: "Most damage", show: fmt },
    { key: "avgTimeAlive", label: "Ø time alive", show: time },
    { key: "totalTimeAlive", label: "Time played", show: time },
    { key: "avgImpact", label: "Ø impact", show: fmt },
];

function delta(cur: number, prev: number | null | undefined, lowerIsBetter?: boolean): string {
    if (prev === null || prev === undefined) return "";
    if (prev === 0) return cur === 0 ? "" : `<span class="ps-delta up">new</span>`;
    const pct = ((cur - prev) / Math.abs(prev)) * 100;
    if (Math.abs(pct) < 0.5) return `<span class="ps-delta">±0%</span>`;
    const better = lowerIsBetter ? pct < 0 : pct > 0;
    return `<span class="ps-delta ${better ? "up" : "down"}" title="before: ${esc(prev)}">${pct > 0 ? "▲ +" : "▼ "}${pct.toFixed(1)}%</span>`;
}

/**
 * The "Stats" tab of a player profile: everything about how they play, for a chosen
 * period (with the one before for comparison) and mode. Premium profiles only; others
 * get a note instead.
 */
export class ProfileStatsView {
    data: UserProfileStatsResponse | null = null;
    loading = false;
    error = false;
    period: StatsPeriod = "alltime";
    season?: string;
    /** a calendar month "YYYY-MM" - wins over the period */
    month?: string;
    compare?: string;
    teamMode?: number;
    private slug = "";
    private weaponSort: "kills" | "damage" | "games" | "accuracy" = "kills";

    constructor(private onChange: () => void) {}

    load(slug: string) {
        if (slug !== this.slug) {
            this.slug = slug;
            this.data = null;
        }
        this.fetch();
    }

    get loaded() {
        return this.data !== null || this.loading;
    }

    private fetch() {
        this.loading = true;
        this.error = false;
        const body: UserProfileStatsRequest = {
            slug: this.slug,
            period: this.period,
            season: this.period === "season" ? this.season : undefined,
            month: this.month,
            compare: this.compare,
            teamMode: this.teamMode,
        };
        $.ajax({
            url: api.resolveUrl("/api/user_profile_stats"),
            type: "POST",
            data: JSON.stringify(body),
            contentType: "application/json; charset=utf-8",
            success: (data: UserProfileStatsResponse) => {
                this.data = data;
            },
            error: () => {
                this.error = true;
            },
            complete: () => {
                this.loading = false;
                this.onChange();
            },
        });
        this.onChange();
    }

    html(): string {
        const d = this.data;
        if (!d && this.loading) return `<div class="ps-box ps-center"><div class="spinner"></div></div>`;
        if (this.error || !d) return `<div class="ps-box ps-center">Couldn't load the stats.</div>`;
        if (!d.premium) {
            return `<div class="ps-box ps-locked">
                <div class="ps-locked-icon">★</div>
                <div class="ps-locked-title">Extended stats are a Premium feature</div>
                <div class="ps-locked-text">Players with Premium get a full stats page here - weapons, accuracy, modes, maps and how they develop, by day, week, month, year or season. Visible to everyone.</div>
            </div>`;
        }
        const ov = d.overview!;
        const prev = d.previous ?? null;

        const opt = (value: string, label: string, sel: boolean) =>
            `<option value="${esc(value)}"${sel ? " selected" : ""}>${esc(label)}</option>`;
        const periods =
            (this.month ? opt("", "Calendar month", true) : "") +
            STATS_PERIODS.map((p) => opt(p, STATS_PERIOD_LABELS[p], !this.month && p === this.period)).join("");
        const seasons =
            !this.month && this.period === "season" && d.seasons?.length
                ? `<select class="form-control ps-select" id="ps-season">${[...d.seasons]
                      .reverse()
                      .map((s) => opt(s.id, s.label, s.id === (this.season ?? d.season)))
                      .join("")}</select>`
                : "";
        const modes = [opt("", "All modes", this.teamMode === undefined), ...[1, 2, 4].map((m) => opt(String(m), TEAM_MODE_LABEL[m], m === this.teamMode))].join("");

        const cards = OVERVIEW.map((m) => {
            const v = ov[m.key];
            if (v === null) return "";
            const p = prev ? prev[m.key] : undefined;
            return `<div class="ps-card">
                <div class="ps-card-value">${m.show(v as number)}</div>
                <div class="ps-card-label">${esc(m.label)}</div>
                ${prev && p !== null ? `<div class="ps-card-prev">${delta(v as number, p as number, m.lowerIsBetter)}</div>` : ""}
            </div>`;
        }).join("");

        const activity = d.activity ?? [];
        const bucketLabel = (iso: string) => {
            const t = new Date(iso);
            return d.bucket === "hour"
                ? `${String(t.getHours()).padStart(2, "0")}:00`
                : d.bucket === "month"
                  ? t.toLocaleDateString("en-US", { month: "short", year: "2-digit" })
                  : t.toLocaleDateString("en-US", { day: "2-digit", month: "2-digit" });
        };
        const chart = activity.length > 1
            ? lineChart(
                  [
                      { label: "Matches", color: CHART_COLORS[0], points: activity.map((a) => a.games) },
                      { label: "Kills", color: CHART_COLORS[1], points: activity.map((a) => a.kills) },
                      { label: "Wins", color: CHART_COLORS[2], points: activity.map((a) => a.wins) },
                  ],
                  activity.map((a) => bucketLabel(a.bucket)),
              )
            : `<div class="ps-empty">Not enough matches in this period for a curve.</div>`;

        const sortKey = this.weaponSort;
        const weapons = [...(d.weapons ?? [])].sort((a, b) => (b[sortKey] ?? -1) - (a[sortKey] ?? -1));
        const maxKills = Math.max(1, ...weapons.map((w) => w.kills));
        const sortHead = (key: typeof sortKey, label: string) =>
            `<th class="ps-sort${sortKey === key ? " active" : ""}" data-sort="${key}">${label}</th>`;
        const weaponTable = weapons.length
            ? `<table class="ps-table"><thead><tr><th>Weapon</th>${sortHead("kills", "Kills")}${sortHead("damage", "Damage")}<th>Ø damage</th><th>Best match</th>${sortHead("games", "Matches")}${sortHead("accuracy", "Accuracy")}</tr></thead><tbody>${weapons
                  .map(
                      (w) => `<tr>
                    <td><div class="ps-weapon"><span class="ps-weapon-icon" style="background-image:url('${iconUrl(w.weaponType)}')"></span><b>${esc(weaponName(w.weaponType))}</b></div>
                        <div class="ps-bar"><span style="width:${Math.round((w.kills / maxKills) * 100)}%"></span></div></td>
                    <td>${fmt(w.kills)}</td><td>${fmt(w.damage)}</td><td>${fmt(w.avgDamage)}</td><td>${fmt(w.maxDamage)}</td><td>${fmt(w.games)}</td>
                    <td>${w.accuracy === null ? "–" : `${w.accuracy}%`}</td></tr>`,
                  )
                  .join("")}</tbody></table>`
            : `<div class="ps-empty">No weapon data in this period yet - weapon stats are recorded from the latest update on.</div>`;

        const modeRows = (d.byMode ?? []).map((r) => `<tr><td><b>${esc(TEAM_MODE_LABEL[r.teamMode] ?? `Mode ${r.teamMode}`)}</b></td><td>${fmt(r.games)}</td><td>${fmt(r.wins)}</td><td>${r.winRate}%</td><td>${fmt(r.kills)}</td><td>${r.kd.toFixed(2)}</td><td>${fmt(r.avgDamage)}</td></tr>`).join("");
        const mapRows = (d.byMap ?? []).map((r) => `<tr><td><b>${esc(mapLabel(r.mapId))}</b></td><td>${fmt(r.games)}</td><td>${fmt(r.wins)}</td><td>${r.winRate}%</td><td>${fmt(r.kills)}</td><td>${fmt(r.avgDamage)}</td></tr>`).join("");

        return `<div class="ps-wrap">
            <div class="header-extra ps-header">STATS<span class="ps-premium">★ PREMIUM</span></div>
            <div class="ps-controls">
                <select class="form-control ps-select" id="ps-period">${periods}</select>
                ${seasons}
                <select class="form-control ps-select" id="ps-month">${statsMonthOptionsHtml(this.month)}</select>
                <select class="form-control ps-select" id="ps-mode">${modes}</select>
                ${d.range?.from != null ? `<select class="form-control ps-select" id="ps-compare">${statsCompareOptionsHtml(this.compare)}</select>` : ""}
                ${this.loading ? `<span class="ps-updating">updating…</span>` : ""}
                ${d.prevRange ? `<span class="ps-hint">compared with ${esc(statsRangeLabel(d.prevRange.from, d.prevRange.to))}</span>` : ""}
            </div>
            ${ov.games === 0 ? `<div class="ps-box ps-center">No matches in this period.</div>` : `
            <div class="ps-cards">${cards}</div>
            <div class="ps-box"><div class="ps-title">Activity <span class="ps-legend"><i style="background:${CHART_COLORS[0]}"></i>Matches <i style="background:${CHART_COLORS[1]}"></i>Kills <i style="background:${CHART_COLORS[2]}"></i>Wins</span></div>${chart}</div>
            <div class="ps-box"><div class="ps-title">Weapons</div>${weaponTable}</div>
            <div class="ps-grid">
                <div class="ps-box"><div class="ps-title">By mode</div>
                    <table class="ps-table"><thead><tr><th>Mode</th><th>Matches</th><th>Wins</th><th>Win rate</th><th>Kills</th><th>K/D</th><th>Ø damage</th></tr></thead><tbody>${modeRows}</tbody></table></div>
                <div class="ps-box"><div class="ps-title">By map</div>
                    <table class="ps-table"><thead><tr><th>Map</th><th>Matches</th><th>Wins</th><th>Win rate</th><th>Kills</th><th>Ø damage</th></tr></thead><tbody>${mapRows}</tbody></table></div>
            </div>`}
        </div>`;
    }

    /** Wires the controls inside `root` after html() was inserted. */
    bind(root: JQuery) {
        root.find("#ps-period").on("change", (e) => {
            const v = $(e.target).val() as string;
            if (!v) return;
            this.period = v as StatsPeriod;
            this.month = undefined;
            this.fetch();
        });
        root.find("#ps-month").on("change", (e) => {
            this.month = ($(e.target).val() as string) || undefined;
            this.fetch();
        });
        root.find("#ps-compare").on("change", (e) => {
            this.compare = $(e.target).val() as string;
            this.fetch();
        });
        root.find("#ps-season").on("change", (e) => {
            this.season = $(e.target).val() as string;
            this.fetch();
        });
        root.find("#ps-mode").on("change", (e) => {
            const v = $(e.target).val() as string;
            this.teamMode = v === "" ? undefined : Number(v);
            this.fetch();
        });
        root.find(".ps-sort").on("click", (e) => {
            this.weaponSort = $(e.currentTarget).attr("data-sort") as typeof this.weaponSort;
            this.onChange();
        });
    }
}
