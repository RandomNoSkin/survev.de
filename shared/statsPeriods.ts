import { GameConfig } from "./gameConfig";

/**
 * Time windows for the stats pages (server stats, player profiles). Rolling windows
 * ending now, a battle-pass season, or everything - each with the window before it
 * for comparisons.
 */
export const STATS_PERIODS = ["day", "week", "month", "year", "season", "alltime"] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

export const STATS_PERIOD_LABELS: Record<StatsPeriod, string> = {
    day: "Last 24 hours",
    week: "Last 7 days",
    month: "Last 30 days",
    year: "Last 12 months",
    season: "Season",
    alltime: "All time",
};

export interface StatsSeason {
    /** pass id, e.g. "pass_survivr4" */
    id: string;
    /** "Season 4" */
    label: string;
    start: number;
    end: number;
}

/** Every battle-pass season, oldest first. */
export function statsSeasons(): StatsSeason[] {
    return Object.entries(GameConfig.serverSettings.passes)
        .map(([id, cfg]) => ({ id, start: new Date(cfg.seasonStart).getTime(), end: new Date(cfg.seasonEnd).getTime() }))
        .sort((a, b) => a.start - b.start)
        .map((s, i) => ({ ...s, label: `Season ${i + 1}` }));
}

export interface StatsRange {
    /** epoch ms; null = from the beginning */
    from: number | null;
    to: number;
    /** the window before, same length (null: nothing to compare with) */
    prevFrom: number | null;
    prevTo: number | null;
    /** time series granularity */
    bucket: "hour" | "day" | "week" | "month";
    /** for "season": the season shown */
    season?: StatsSeason;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** The window for a period (seasonId: which season, default the current one). */
export function statsRange(period: StatsPeriod, seasonId?: string, now = Date.now()): StatsRange {
    const rolling = (len: number, bucket: StatsRange["bucket"]): StatsRange => ({
        from: now - len,
        to: now,
        prevFrom: now - 2 * len,
        prevTo: now - len,
        bucket,
    });
    switch (period) {
        case "day":
            return rolling(DAY, "hour");
        case "week":
            return rolling(7 * DAY, "day");
        case "month":
            return rolling(30 * DAY, "day");
        case "year":
            return rolling(365 * DAY, "month");
        case "season": {
            const seasons = statsSeasons();
            const idx = Math.max(
                0,
                seasonId
                    ? seasons.findIndex((s) => s.id === seasonId)
                    : seasons.findIndex((s) => s.id === GameConfig.serverSettings.currentPass),
            );
            const season = seasons[idx];
            const to = Math.min(season.end, now);
            const prev = seasons[idx - 1];
            // compare with the same stretch of the season before (a running season vs.
            // a whole finished one would always look worse)
            const elapsed = Math.max(0, to - season.start);
            return {
                from: season.start,
                to,
                prevFrom: prev ? prev.start : null,
                prevTo: prev ? Math.min(prev.end, prev.start + elapsed) : null,
                bucket: elapsed > 100 * DAY ? "week" : "day",
                season,
            };
        }
        default:
            return { from: null, to: now, prevFrom: null, prevTo: null, bucket: "month" };
    }
}

/** A calendar month as "YYYY-MM" (UTC). */
export const STATS_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface StatsMonth {
    /** "2026-10" */
    id: string;
    /** "October 2026" */
    label: string;
    start: number;
    end: number;
}

export function statsMonth(id: string): StatsMonth {
    const [y, m] = id.split("-").map(Number);
    const start = Date.UTC(y, m - 1, 1);
    const end = Date.UTC(y, m, 1);
    const label = new Date(start).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    return { id, label, start, end };
}

/** The last `count` calendar months, newest (the current one) first. */
export function statsMonths(count = 24, now = Date.now()): StatsMonth[] {
    const d = new Date(now);
    const out: StatsMonth[] = [];
    for (let i = 0; i < count; i++) {
        const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
        out.push(statsMonth(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`));
    }
    return out;
}

/**
 * What to compare with: "prev" (the window before, default), "lastyear" (the same
 * window a year earlier), "none", "month:YYYY-MM" or "season:<passId>".
 */
export type StatsCompare = string;

export const STATS_COMPARE_RE = /^(prev|lastyear|none|month:\d{4}-(0[1-9]|1[0-2])|season:[\w-]{1,40})$/;

const shiftYear = (t: number, by: number) => {
    const d = new Date(t);
    d.setUTCFullYear(d.getUTCFullYear() + by);
    return d.getTime();
};

/** Replaces the comparison window of a range by the chosen one. */
export function applyStatsCompare(range: StatsRange, compare?: StatsCompare): StatsRange {
    if (!compare || compare === "prev") return range;
    const none = { ...range, prevFrom: null, prevTo: null };
    if (compare === "none" || range.from === null) return none;
    const len = range.to - range.from;
    if (compare === "lastyear") {
        return { ...range, prevFrom: shiftYear(range.from, -1), prevTo: shiftYear(range.to, -1) };
    }
    // a fixed month / season: from its start, as long as the shown window (a running
    // month vs. a whole finished one would always look worse)
    let target: { start: number; end: number } | undefined;
    if (compare.startsWith("month:")) target = statsMonth(compare.slice(6));
    else if (compare.startsWith("season:")) target = statsSeasons().find((s) => s.id === compare.slice(7));
    if (!target) return none;
    return { ...range, prevFrom: target.start, prevTo: Math.min(target.end, target.start + len) };
}

/** statsRange plus the optional calendar month (wins over the period) and comparison. */
export function statsRangeFor(
    q: { period: StatsPeriod; season?: string; month?: string; compare?: StatsCompare },
    now = Date.now(),
): StatsRange & { month?: StatsMonth } {
    if (q.month && STATS_MONTH_RE.test(q.month)) {
        const month = statsMonth(q.month);
        const to = Math.min(month.end, now);
        const prev = statsMonth(new Date(month.start - 1).toISOString().slice(0, 7));
        const range: StatsRange = {
            from: month.start,
            to,
            prevFrom: prev.start,
            prevTo: Math.min(prev.end, prev.start + Math.max(0, to - month.start)),
            bucket: "day",
        };
        return { ...applyStatsCompare(range, q.compare), month };
    }
    return applyStatsCompare(statsRange(q.period, q.season, now), q.compare);
}

/** The choices for a "compare with" select, grouped (group "" = top level). */
export function statsCompareChoices(): { value: StatsCompare; label: string; group: string }[] {
    return [
        { value: "prev", label: "vs. period before", group: "" },
        { value: "lastyear", label: "vs. same time last year", group: "" },
        { value: "none", label: "No comparison", group: "" },
        ...statsMonths().map((m) => ({ value: `month:${m.id}`, label: `vs. ${m.label}`, group: "Month" })),
        ...[...statsSeasons()].reverse().map((s) => ({ value: `season:${s.id}`, label: `vs. ${s.label}`, group: "Season" })),
    ];
}

/** "Sep 1 – Sep 14, 2026" for a window (end exclusive). */
export function statsRangeLabel(from: number, to: number): string {
    const f = (t: number, year: boolean) =>
        new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) });
    const last = to - 1;
    const sameYear = new Date(from).getFullYear() === new Date(last).getFullYear();
    return `${f(from, !sameYear)} – ${f(last, true)}`;
}

/** Builds the <option>s (with optgroups) of a compare select. */
export function statsCompareOptionsHtml(selected: StatsCompare | undefined): string {
    const sel = selected ?? "prev";
    let html = "";
    let group = "";
    for (const c of statsCompareChoices()) {
        if (c.group !== group) {
            if (group) html += "</optgroup>";
            group = c.group;
            html += `<optgroup label="${group}">`;
        }
        html += `<option value="${c.value}"${c.value === sel ? " selected" : ""}>${c.label}</option>`;
    }
    return group ? `${html}</optgroup>` : html;
}

/** Builds the <option>s of a calendar month select ("" = no month). */
export function statsMonthOptionsHtml(selected: string | undefined, emptyLabel = "Any month"): string {
    return [
        `<option value=""${selected ? "" : " selected"}>${emptyLabel}</option>`,
        ...statsMonths().map((m) => `<option value="${m.id}"${m.id === selected ? " selected" : ""}>${m.label}</option>`),
    ].join("");
}
