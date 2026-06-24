/**
 * Tiny dependency-free SVG chart builders for the server-stats page. Each returns an
 * SVG string (responsive via viewBox) so it can be dropped straight into the DOM. No
 * runtime/interactivity beyond native `<title>` hover tooltips.
 */

export const CHART_COLORS = [
    "#5b9bff",
    "#46d39a",
    "#ffb454",
    "#ff6b6b",
    "#b48ead",
    "#4dd0e1",
    "#f7a3c8",
    "#9ccc65",
];

function esc(s: string): string {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

const fmt = (n: number) => n.toLocaleString("en-US");

export interface BarDatum {
    label: string;
    value: number;
}

/** Vertical bar chart (e.g. games per map / region). */
export function barChart(data: BarDatum[], color = CHART_COLORS[0]): string {
    const W = 600;
    const H = 300;
    const padL = 44;
    const padB = 56;
    const padT = 16;
    const padR = 12;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const max = Math.max(1, ...data.map((d) => d.value));
    const n = Math.max(1, data.length);
    const slot = plotW / n;
    const barW = Math.min(60, slot * 0.62);

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="svg-chart" preserveAspectRatio="xMidYMid meet">`;
    // y grid + labels (4 steps)
    for (let i = 0; i <= 4; i++) {
        const y = padT + (plotH * i) / 4;
        const val = Math.round((max * (4 - i)) / 4);
        svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="svg-grid"/>`;
        svg += `<text x="${padL - 6}" y="${y + 4}" class="svg-axis" text-anchor="end">${fmt(val)}</text>`;
    }
    data.forEach((d, i) => {
        const h = (d.value / max) * plotH;
        const x = padL + slot * i + (slot - barW) / 2;
        const y = padT + plotH - h;
        svg += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="${color}"><title>${esc(d.label)}: ${fmt(d.value)}</title></rect>`;
        svg += `<text x="${x + barW / 2}" y="${y - 4}" class="svg-axis" text-anchor="middle">${fmt(d.value)}</text>`;
        svg += `<text x="${x + barW / 2}" y="${H - padB + 18}" class="svg-axis" text-anchor="middle">${esc(d.label)}</text>`;
    });
    svg += "</svg>";
    return svg;
}

export interface LineSeries {
    label: string;
    color: string;
    points: number[];
}

/** Multi-series line chart sharing one set of x labels (e.g. games + players over time). */
export function lineChart(series: LineSeries[], xLabels: string[]): string {
    const W = 600;
    const H = 300;
    const padL = 48;
    const padB = 48;
    const padT = 16;
    const padR = 14;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const len = Math.max(1, xLabels.length);
    const max = Math.max(1, ...series.flatMap((s) => s.points));
    const xAt = (i: number) => padL + (len <= 1 ? plotW / 2 : (plotW * i) / (len - 1));
    const yAt = (v: number) => padT + plotH - (v / max) * plotH;

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="svg-chart" preserveAspectRatio="xMidYMid meet">`;
    for (let i = 0; i <= 4; i++) {
        const y = padT + (plotH * i) / 4;
        const val = Math.round((max * (4 - i)) / 4);
        svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="svg-grid"/>`;
        svg += `<text x="${padL - 6}" y="${y + 4}" class="svg-axis" text-anchor="end">${fmt(val)}</text>`;
    }
    // sparse x labels (max ~8)
    const step = Math.ceil(len / 8);
    xLabels.forEach((lbl, i) => {
        if (i % step !== 0 && i !== len - 1) return;
        svg += `<text x="${xAt(i)}" y="${H - padB + 18}" class="svg-axis" text-anchor="middle">${esc(lbl)}</text>`;
    });
    for (const s of series) {
        const pts = s.points.map((v, i) => `${xAt(i)},${yAt(v)}`).join(" ");
        svg += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
        s.points.forEach((v, i) => {
            svg += `<circle cx="${xAt(i)}" cy="${yAt(v)}" r="2.6" fill="${s.color}"><title>${esc(xLabels[i] ?? "")} — ${esc(s.label)}: ${fmt(v)}</title></circle>`;
        });
    }
    svg += "</svg>";
    return svg;
}

export interface DoughnutSegment {
    label: string;
    value: number;
    color: string;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** Doughnut chart with a side legend (e.g. games by team mode). */
export function doughnutChart(segments: DoughnutSegment[]): string {
    const W = 600;
    const H = 300;
    const cx = 150;
    const cy = H / 2;
    const rO = 110;
    const rI = 62;
    const total = segments.reduce((a, s) => a + s.value, 0);

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="svg-chart" preserveAspectRatio="xMidYMid meet">`;
    if (total <= 0) {
        svg += `<circle cx="${cx}" cy="${cy}" r="${rO}" fill="none" stroke="#2a2a3a" stroke-width="${rO - rI}"/>`;
        svg += `<text x="${cx}" y="${cy + 4}" class="svg-axis" text-anchor="middle">No data</text></svg>`;
        return svg;
    }
    let angle = 0;
    for (const s of segments) {
        const frac = s.value / total;
        const end = angle + frac * 360;
        // Full-circle single segment: draw a ring (arc path can't span 360°).
        if (frac >= 0.9999) {
            svg += `<circle cx="${cx}" cy="${cy}" r="${(rO + rI) / 2}" fill="none" stroke="${s.color}" stroke-width="${rO - rI}"><title>${esc(s.label)}: ${fmt(s.value)} (100%)</title></circle>`;
        } else {
            const [x1, y1] = polar(cx, cy, rO, end);
            const [x2, y2] = polar(cx, cy, rO, angle);
            const [x3, y3] = polar(cx, cy, rI, angle);
            const [x4, y4] = polar(cx, cy, rI, end);
            const large = end - angle <= 180 ? 0 : 1;
            svg +=
                `<path d="M ${x1} ${y1} A ${rO} ${rO} 0 ${large} 0 ${x2} ${y2} ` +
                `L ${x3} ${y3} A ${rI} ${rI} 0 ${large} 1 ${x4} ${y4} Z" fill="${s.color}">` +
                `<title>${esc(s.label)}: ${fmt(s.value)} (${Math.round(frac * 100)}%)</title></path>`;
        }
        angle = end;
    }
    // legend
    let ly = cy - segments.length * 14;
    const lx = 310;
    for (const s of segments) {
        const pct = Math.round((s.value / total) * 100);
        svg += `<rect x="${lx}" y="${ly}" width="14" height="14" rx="3" fill="${s.color}"/>`;
        svg += `<text x="${lx + 22}" y="${ly + 12}" class="svg-legend">${esc(s.label)} — ${fmt(s.value)} (${pct}%)</text>`;
        ly += 28;
    }
    svg += "</svg>";
    return svg;
}
