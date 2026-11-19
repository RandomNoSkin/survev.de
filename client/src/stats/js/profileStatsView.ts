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
import { statsMapOptions } from "./statsMaps";

/** A gun needs this many matches to count as "best gun" (one lucky match isn't it). */
const BEST_GUN_MIN_GAMES = 3;

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
/** Display name (as in the map filter), else the enum name. */
const mapLabel = (id: number) =>
    statsMapOptions().find((m) => m.mapId === id)?.name ?? (MapId[id] ?? `Map ${id}`).toString();

type OverviewStat = { key: keyof UserProfileOverview; label: string; show: (v: number) => string; lowerIsBetter?: boolean };

/** The overview numbers by category, how they read, and whether lower is better. */
const OVERVIEW: { title: string; stats: OverviewStat[] }[] = [
    {
        title: "Results",
        stats: [
            { key: "games", label: "Matches", show: fmt },
            { key: "wins", label: "Wins", show: fmt },
            { key: "winRate", label: "Win rate", show: (v) => `${v}%` },
            { key: "avgImpact", label: "Ø impact", show: fmt },
        ],
    },
    {
        title: "Combat",
        stats: [
            { key: "kills", label: "Kills", show: fmt },
            { key: "kd", label: "K/D", show: (v) => v.toFixed(2) },
            { key: "avgKills", label: "Ø kills", show: (v) => v.toFixed(2) },
            { key: "maxKills", label: "Most kills", show: fmt },
        ],
    },
    {
        title: "Damage",
        stats: [
            { key: "avgDamage", label: "Ø damage", show: fmt },
            { key: "maxDamage", label: "Most damage", show: fmt },
            { key: "accuracy", label: "Accuracy", show: (v) => `${v}%` },
        ],
    },
    {
        title: "Teamplay & time",
        stats: [
            { key: "assists", label: "Assists", show: fmt },
            { key: "revives", label: "Revives", show: fmt },
            { key: "avgTimeAlive", label: "Ø time alive", show: time },
            { key: "totalTimeAlive", label: "Time played", show: time },
        ],
    },
];

const SECTIONS = [
    { id: "overview", label: "Overview" },
    { id: "weapons", label: "Weapons" },
    { id: "duels", label: "1v1" },
    { id: "modes", label: "Modes & maps" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

/** Opponents need this many duels to count as nemesis / favourite victim. */
const DUEL_HIGHLIGHT_MIN = 5;

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
    /** only this map (MapId) */
    mapId?: number;
    private slug = "";
    /** the category tab shown */
    section: Section = "overview";
    private weaponSort: "avgDamage" | "kills" | "damage" | "games" | "accuracy" = "avgDamage";

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
            mapId: this.mapId,
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
        const maps = [opt("", "All maps", this.mapId === undefined), ...statsMapOptions().map((m) => opt(String(m.mapId), m.name, m.mapId === this.mapId))].join("");
        const modes = [opt("", "All modes", this.teamMode === undefined), ...[1, 2, 4].map((m) => opt(String(m), TEAM_MODE_LABEL[m], m === this.teamMode))].join("");

        const card = (m: OverviewStat) => {
            const v = ov[m.key];
            if (v === null) return "";
            const p = prev ? prev[m.key] : undefined;
            return `<div class="ps-card">
                <div class="ps-card-value">${m.show(v as number)}</div>
                <div class="ps-card-label">${esc(m.label)}</div>
                ${prev && p !== null ? `<div class="ps-card-prev">${delta(v as number, p as number, m.lowerIsBetter)}</div>` : ""}
            </div>`;
        };
        const cards = OVERVIEW.map((g) => {
            const inner = g.stats.map(card).join("");
            return inner ? `<div class="ps-group"><div class="ps-group-title">${esc(g.title)}</div><div class="ps-cards">${inner}</div></div>` : "";
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
        // the bar shows the column sorted by, relative to the top weapon
        const maxSorted = Math.max(1, ...weapons.map((w) => w[sortKey] ?? 0));
        const sortHead = (key: typeof sortKey, label: string) =>
            `<th class="ps-sort${sortKey === key ? " active" : ""}" data-sort="${key}">${label}</th>`;

        // favourite = the gun used in the most matches, best = most damage per match
        const guns = weapons.filter((w) => (GameObjectDefs.typeToDefSafe(w.weaponType) as { type?: string } | undefined)?.type === "gun");
        const favourite = [...guns].sort((a, b) => b.games - a.games || b.kills - a.kills || b.damage - a.damage)[0];
        const best = guns.filter((w) => w.games >= BEST_GUN_MIN_GAMES).sort((a, b) => b.avgDamage - a.avgDamage)[0];
        const highlight = (title: string, w: (typeof weapons)[number] | undefined, value: string, empty: string) =>
            `<div class="ps-gun">
                <div class="ps-gun-title">${title}</div>
                ${w
                    ? `<div class="ps-gun-body"><span class="ps-gun-icon" style="background-image:url('${iconUrl(w.weaponType)}')"></span>
                        <div><div class="ps-gun-name">${esc(weaponName(w.weaponType))}</div><div class="ps-gun-value">${value}</div></div></div>`
                    : `<div class="ps-gun-empty">${empty}</div>`}
            </div>`;
        const gunHighlights = guns.length
            ? `<div class="ps-guns">
                ${highlight("Favourite gun", favourite, favourite ? `${fmt(favourite.games)} matches · ${fmt(favourite.kills)} kills` : "", "–")}
                ${highlight("Best gun", best, best ? `Ø ${fmt(best.avgDamage)} damage per match · ${fmt(best.games)} matches` : "", `Needs ${BEST_GUN_MIN_GAMES}+ matches with a gun`)}
            </div>`
            : "";

        const weaponTable = weapons.length
            ? `${gunHighlights}<table class="ps-table"><thead><tr><th>Weapon</th>${sortHead("avgDamage", "Ø damage")}${sortHead("kills", "Kills")}${sortHead("damage", "Damage")}<th>Best match</th>${sortHead("games", "Matches")}${sortHead("accuracy", "Accuracy")}</tr></thead><tbody>${weapons
                  .map(
                      (w) => `<tr>
                    <td><div class="ps-weapon"><span class="ps-weapon-icon" style="background-image:url('${iconUrl(w.weaponType)}')"></span><b>${esc(weaponName(w.weaponType))}</b></div>
                        <div class="ps-bar"><span style="width:${Math.round(((w[sortKey] ?? 0) / maxSorted) * 100)}%"></span></div></td>
                    <td>${fmt(w.avgDamage)}</td><td>${fmt(w.kills)}</td><td>${fmt(w.damage)}</td><td>${fmt(w.maxDamage)}</td><td>${fmt(w.games)}</td>
                    <td>${w.accuracy === null ? "–" : `${w.accuracy}%`}</td></tr>`,
                  )
                  .join("")}</tbody></table>`
            : `<div class="ps-empty">No weapon data in this period yet - weapon stats are recorded from the latest update on.</div>`;

        // head-to-head: clean 1v1 kills in local mode (no third party involved)
        const duels = d.duels ?? [];
        const duelWins = duels.reduce((a, o) => a + o.wins, 0);
        const duelTotal = duels.reduce((a, o) => a + o.duels, 0);
        // nemesis = the regular you lose to most, favourite victim = the one you beat most
        const regulars = duels.filter((o) => o.duels >= DUEL_HIGHLIGHT_MIN);
        const nemesis = [...regulars].sort((a, b) => a.winRate - b.winRate || b.duels - a.duels).find((o) => o.winRate < 50);
        const victim = [...regulars].sort((a, b) => b.winRate - a.winRate || b.duels - a.duels).find((o) => o.winRate > 50);
        const opponentCard = (title: string, o: (typeof duels)[number] | undefined, value: string, empty: string) =>
            `<div class="ps-card">
                <div class="ps-card-value ps-card-name">${o ? `<a href="/stats/?slug=${encodeURIComponent(o.slug)}">${esc(o.username)}</a>` : "–"}</div>
                <div class="ps-card-label">${title}</div>
                <div class="ps-card-prev">${o ? value : empty}</div>
            </div>`;
        const duelCards = duels.length
            ? `<div class="ps-cards">
                <div class="ps-card"><div class="ps-card-value">${fmt(duelTotal)}</div><div class="ps-card-label">Duels</div></div>
                <div class="ps-card"><div class="ps-card-value">${fmt(duelWins)} / ${fmt(duelTotal - duelWins)}</div><div class="ps-card-label">Won / lost</div></div>
                <div class="ps-card"><div class="ps-card-value">${Math.round((duelWins / duelTotal) * 1000) / 10}%</div><div class="ps-card-label">Win rate</div></div>
                ${opponentCard("Rival", duels[0], `${fmt(duels[0].duels)} duels`, "")}
                ${opponentCard("Nemesis", nemesis, nemesis ? `${nemesis.winRate}% won` : "", `nobody you lose to (${DUEL_HIGHLIGHT_MIN}+ duels)`)}
                ${opponentCard("Favourite victim", victim, victim ? `${victim.winRate}% won` : "", `nobody you beat (${DUEL_HIGHLIGHT_MIN}+ duels)`)}
            </div>`
            : "";
        const duelTable = d.duelsHidden
            ? `<div class="ps-empty">This player turned 1v1 tracking off.</div>`
            : d.duels === undefined
            ? `<div class="ps-empty">1v1 duels are only tracked in local mode - pick "All maps" or Local and "All modes" or Solo.</div>`
            : duels.length
            ? `<table class="ps-table"><thead><tr><th>Opponent</th><th>Duels</th><th>Wins</th><th>Losses</th><th>Win rate</th></tr></thead><tbody>${duels
                  .map(
                      (o) => `<tr>
                    <td><a class="ps-duel-name" href="/stats/?slug=${encodeURIComponent(o.slug)}">${esc(o.username)}</a>
                        <div class="ps-duel-bar"><span class="won" style="width:${o.winRate}%"></span></div></td>
                    <td>${fmt(o.duels)}</td><td class="ps-duel-w">${fmt(o.wins)}</td><td class="ps-duel-l">${fmt(o.losses)}</td><td>${o.winRate}%</td></tr>`,
                  )
                  .join("")}</tbody></table>`
            : `<div class="ps-empty">No 1v1 duels in this period yet. Counted in local mode when a kill was a clean 1v1 - no third player hit either of you in the 15 seconds before.</div>`;

        const modeRows = (d.byMode ?? []).map((r) => `<tr><td><b>${esc(TEAM_MODE_LABEL[r.teamMode] ?? `Mode ${r.teamMode}`)}</b></td><td>${fmt(r.games)}</td><td>${fmt(r.wins)}</td><td>${r.winRate}%</td><td>${fmt(r.kills)}</td><td>${r.kd.toFixed(2)}</td><td>${fmt(r.avgDamage)}</td></tr>`).join("");
        const mapRows = (d.byMap ?? []).map((r) => `<tr><td><b>${esc(mapLabel(r.mapId))}</b></td><td>${fmt(r.games)}</td><td>${fmt(r.wins)}</td><td>${r.winRate}%</td><td>${fmt(r.kills)}</td><td>${fmt(r.avgDamage)}</td></tr>`).join("");

        return `<div class="ps-wrap">
            <div class="header-extra ps-header">STATS<span class="ps-premium">★ PREMIUM</span></div>
            <div class="ps-controls">
                <select class="form-control ps-select" id="ps-period">${periods}</select>
                ${seasons}
                <select class="form-control ps-select" id="ps-month">${statsMonthOptionsHtml(this.month)}</select>
                <select class="form-control ps-select" id="ps-mode">${modes}</select>
                <select class="form-control ps-select" id="ps-map">${maps}</select>
                ${d.range?.from != null ? `<select class="form-control ps-select" id="ps-compare">${statsCompareOptionsHtml(this.compare)}</select>` : ""}
                ${this.loading ? `<span class="ps-updating">updating…</span>` : ""}
                ${d.prevRange ? `<span class="ps-hint">compared with ${esc(statsRangeLabel(d.prevRange.from, d.prevRange.to))}</span>` : ""}
            </div>
            <div class="ps-tabs">${SECTIONS.map((t) => `<button class="ps-tab${t.id === this.section ? " active" : ""}" data-section="${t.id}">${t.label}</button>`).join("")}</div>
            ${ov.games === 0 && this.section !== "duels" ? `<div class="ps-box ps-center">No matches in this period.</div>`
            : this.section === "overview" ? `${cards}
            <div class="ps-box"><div class="ps-title">Activity <span class="ps-legend"><i style="background:${CHART_COLORS[0]}"></i>Matches <i style="background:${CHART_COLORS[1]}"></i>Kills <i style="background:${CHART_COLORS[2]}"></i>Wins</span></div>${chart}</div>`
            : this.section === "weapons" ? `<div class="ps-box"><div class="ps-title">Weapons</div>${weaponTable}</div>`
            : this.section === "duels" ? `${duelCards}<div class="ps-box"><div class="ps-title">1v1 <span class="ps-hint">clean duels in local mode, by opponent</span></div>${duelTable}</div>`
            : `
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
        root.find("#ps-map").on("change", (e) => {
            const v = $(e.target).val() as string;
            this.mapId = v === "" ? undefined : Number(v);
            this.fetch();
        });
        root.find(".ps-tab").on("click", (e) => {
            this.section = $(e.currentTarget).attr("data-section") as Section;
            this.onChange();
        });
        root.find(".ps-sort").on("click", (e) => {
            this.weaponSort = $(e.currentTarget).attr("data-sort") as typeof this.weaponSort;
            this.onChange();
        });
    }
}
