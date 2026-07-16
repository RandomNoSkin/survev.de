import $ from "jquery";
import slugify from "slugify";
import {
    type GameDamageEvent,
    type GameMapFile,
    type GamePlayerStats,
    type GameViewMeta,
    type ParsedTracks,
    parseTracks,
} from "../../../../shared/net/replay";
import type { MatchDataRequest, MatchDataResponse } from "../../../../shared/types/stats";
import { api } from "../../api";
import { helpers } from "../../helpers";
import { type GodViewPlayer, ReplayGodView } from "../../replay/godView";
import type { App } from "./app";
import { showMatchLoadout } from "./loadoutModal";

/** Decompresses gzip bytes using the browser's native DecompressionStream. */
async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
    if (typeof DecompressionStream === "undefined") {
        throw new Error(
            "This browser cannot decompress game data (DecompressionStream).",
        );
    }
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function esc(s: unknown): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function fmtTime(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Stable, well-spread colour per team id (solo → one team per player). */
function colorForTeam(teamId: number): string {
    const hue = (((teamId * 47) % 360) + 360) % 360;
    return `hsl(${hue}, 70%, 50%)`;
}

/** 0xRRGGBB number → CSS hex string. */
function hexColor(n: number): string {
    return `#${((n >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`;
}

const SPEEDS = [0.5, 1, 2, 4, 8];
const CANVAS_PX = 760;
const DAMAGE_FLASH_MS = 1500;

interface PathPoint {
    t: number;
    x: number;
    y: number;
}
interface PlayerMeta {
    name: string;
    teamId: number;
    color: string;
}

/**
 * Detailed per-game view: structural map (water/island/buildings/obstacles) + every
 * player's movement path from the god-view tracks, a time scrubber that animates
 * positions/HP, an end-stats table and a damage log focused on the subject player
 * (the player whose match this was opened from). `/stats/?game=&region=&player=`.
 */
export class GameView {
    el = $('<div id="game-view-view"></div>');

    loading = false;
    error = "";

    private parsed: ParsedTracks | null = null;
    private godView: ReplayGodView | null = null;
    private events: GameDamageEvent[] = [];
    private stats: GamePlayerStats[] = [];
    private map: GameMapFile | null = null;
    /** Cosmetics each player had equipped in this match, keyed by name (see `fetchLoadouts`). */
    private loadouts = new Map<string, string[]>();
    private meta = new Map<number, PlayerMeta>();
    private paths = new Map<number, PathPoint[]>();
    private deaths = new Map<number, PathPoint>();
    private mapW = 0;
    private mapH = 0;
    private duration = 0;
    private subjectId: number | null = null;

    private t = 0;
    private playing = false;
    private speed = 1;
    private focusId: number | null = null;

    private rafId = 0;
    private lastNow = 0;
    private canvas?: HTMLCanvasElement;
    private mapLayer?: HTMLCanvasElement;
    private tf = {
        x: (v: number) => v,
        y: (v: number) => v,
        scale: 1,
    };

    constructor(readonly app: App) {}

    load() {
        const gameId = helpers.getParameterByName("game");
        const region = helpers.getParameterByName("region");
        this.loading = true;
        this.error = "";
        this.renderShell();

        if (!gameId || !region) {
            this.loading = false;
            this.error = "Invalid game link.";
            this.renderShell();
            return;
        }

        Promise.all([
            this.fetchTracks(region, gameId),
            this.fetchMeta(region, gameId),
            this.fetchLoadouts(gameId),
        ])
            .then(() => this.build())
            .catch((err) => {
                console.error("Game view load failed:", err);
                this.error =
                    "Detailed data isn't available for this match (it may be too old or wasn't recorded).";
            })
            .finally(() => {
                this.loading = false;
                this.renderShell();
                if (this.parsed) this.start();
            });
    }

    private async fetchTracks(region: string, gameId: string) {
        const url = api.resolveUrl(
            `/api/game_view/tracks?region=${encodeURIComponent(region)}&gameId=${encodeURIComponent(gameId)}`,
        );
        const res = await fetch(url);
        if (!res.ok) throw new Error(`tracks ${res.status}`);
        this.parsed = parseTracks(await gunzip(await res.arrayBuffer()));
    }

    private async fetchMeta(region: string, gameId: string) {
        try {
            const url = api.resolveUrl(
                `/api/game_view/meta?region=${encodeURIComponent(region)}&gameId=${encodeURIComponent(gameId)}`,
            );
            const res = await fetch(url);
            if (res.ok) {
                const data: GameViewMeta = await res.json();
                this.events = Array.isArray(data.events) ? data.events : [];
                this.stats = Array.isArray(data.players) ? data.players : [];
                this.map = data.map ?? null;
            }
        } catch {
            /* meta is optional — paths still work without it */
        }
    }

    /**
     * Per-player match loadouts, from the DB rather than the replay side-files. The damage
     * file numbers players by `__id` and match_data by `matchDataId`, so the two rosters are
     * joined by name — the same key the subject lookup uses. A name that isn't unique within
     * the match is dropped rather than risk attributing the wrong loadout to a player.
     * Loadouts of accounts marked private come back empty and simply show no button.
     */
    private async fetchLoadouts(gameId: string) {
        try {
            const res = await fetch(api.resolveUrl("/api/match_data"), {
                method: "POST",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify({ gameId } satisfies MatchDataRequest),
            });
            if (!res.ok) return;
            const rows: MatchDataResponse = await res.json();
            const ambiguous = new Set<string>();
            for (const r of rows) {
                if (this.loadouts.has(r.username)) ambiguous.add(r.username);
                this.loadouts.set(r.username, r.equipped_cosmetics ?? []);
            }
            for (const name of ambiguous) this.loadouts.delete(name);
        } catch {
            /* loadouts are optional — the rest of the view works without them */
        }
    }

    private build() {
        const parsed = this.parsed;
        if (!parsed) return;

        this.godView = new ReplayGodView(parsed);

        // Player roster: prefer the end-stats roster (complete), fall back to tracks meta.
        for (const p of parsed.meta.players) {
            this.meta.set(p.id, {
                name: p.name,
                teamId: p.teamId,
                color: colorForTeam(p.teamId),
            });
        }
        for (const p of this.stats) {
            this.meta.set(p.id, {
                name: p.name,
                teamId: p.teamId,
                color: colorForTeam(p.teamId),
            });
        }

        // Resolve the subject player (whose match we came from) by slug.
        const subjectSlug = helpers.getParameterByName("player");
        if (subjectSlug) {
            for (const [id, m] of this.meta) {
                if (slugify(m.name || "") === subjectSlug) {
                    this.subjectId = id;
                    break;
                }
            }
        }

        this.mapW = this.map?.width ?? parsed.meta.width ?? 0;
        this.mapH = this.map?.height ?? parsed.meta.height ?? 0;

        let maxT = 0;
        for (const s of parsed.samples) {
            maxT = Math.max(maxT, s.tMs);
            for (const e of s.entries) {
                if (!this.mapW) this.mapW = Math.max(this.mapW, Math.ceil(e.x) + 1);
                if (!this.mapH) this.mapH = Math.max(this.mapH, Math.ceil(e.y) + 1);
                if (e.dead) {
                    if (!this.deaths.has(e.id)) {
                        this.deaths.set(e.id, { t: s.tMs, x: e.x, y: e.y });
                    }
                    continue;
                }
                let path = this.paths.get(e.id);
                if (!path) {
                    path = [];
                    this.paths.set(e.id, path);
                }
                path.push({ t: s.tMs, x: e.x, y: e.y });
            }
        }
        this.duration = maxT;
        if (this.mapW <= 0) this.mapW = 1024;
        if (this.mapH <= 0) this.mapH = 1024;
        this.t = 0;

        this.computeTransform();
        this.prerenderMap();
    }

    private computeTransform() {
        const px = CANVAS_PX;
        const pad = 10;
        const scale = Math.min((px - 2 * pad) / this.mapW, (px - 2 * pad) / this.mapH);
        const ox = (px - this.mapW * scale) / 2;
        const oy = (px - this.mapH * scale) / 2;
        this.tf = {
            x: (wx: number) => ox + wx * scale,
            // survev world y is up; canvas y is down → flip.
            y: (wy: number) => oy + (this.mapH - wy) * scale,
            scale,
        };
    }

    /** Pre-renders the static structural map once into an offscreen canvas. */
    private prerenderMap() {
        const layer = document.createElement("canvas");
        layer.width = CANVAS_PX;
        layer.height = CANVAS_PX;
        const ctx = layer.getContext("2d");
        if (!ctx) return;
        const tf = this.tf;

        const poly = (pts: [number, number][]) => {
            ctx.beginPath();
            pts.forEach(([x, y], i) => {
                const cx = tf.x(x);
                const cy = tf.y(y);
                if (i === 0) ctx.moveTo(cx, cy);
                else ctx.lineTo(cx, cy);
            });
            ctx.closePath();
        };

        const m = this.map;
        const waterCol = m ? hexColor(m.colors.water) : "#3f6ea3";
        const beachCol = m ? hexColor(m.colors.beach) : "#d9c89a";
        const grassCol = m ? hexColor(m.colors.grass) : "#80af49";

        // Water background.
        ctx.fillStyle = waterCol;
        ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);

        if (m) {
            // Island = shore polygon (beach sand), grass polygon (grass) on top.
            ctx.fillStyle = beachCol;
            poly(m.shore);
            ctx.fill();
            ctx.fillStyle = grassCol;
            poly(m.grass);
            ctx.fill();

            // Rivers.
            ctx.strokeStyle = waterCol;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            for (const r of m.rivers) {
                if (r.points.length < 2) continue;
                ctx.lineWidth = Math.max(1, r.width * tf.scale);
                ctx.beginPath();
                r.points.forEach(([x, y], i) => {
                    const cx = tf.x(x);
                    const cy = tf.y(y);
                    if (i === 0) ctx.moveTo(cx, cy);
                    else ctx.lineTo(cx, cy);
                });
                ctx.stroke();
            }

            // Per-object minimap shapes (already sorted by draw order).
            for (const sh of m.shapes) {
                ctx.fillStyle = hexColor(sh.c);
                if (sh.t === 0) {
                    ctx.beginPath();
                    ctx.arc(
                        tf.x(sh.x),
                        tf.y(sh.y),
                        Math.max(0.6, sh.r * tf.scale),
                        0,
                        Math.PI * 2,
                    );
                    ctx.fill();
                } else {
                    // world rect (min corner + size); flip y → top-left in canvas.
                    ctx.fillRect(
                        tf.x(sh.x),
                        tf.y(sh.y + sh.h),
                        sh.w * tf.scale,
                        sh.h * tf.scale,
                    );
                }
            }

            // Place names.
            ctx.fillStyle = "rgba(255,255,255,0.85)";
            ctx.strokeStyle = "rgba(0,0,0,0.55)";
            ctx.lineWidth = 2;
            ctx.textAlign = "center";
            ctx.font = "bold 12px Arial, sans-serif";
            for (const pl of m.places) {
                const cx = tf.x(pl.x);
                const cy = tf.y(pl.y);
                ctx.strokeText(pl.name, cx, cy);
                ctx.fillText(pl.name, cx, cy);
            }
            ctx.textAlign = "left";
        } else {
            // No structural map (older recording): plain land rectangle.
            ctx.fillStyle = grassCol;
            ctx.fillRect(
                tf.x(0),
                tf.y(this.mapH),
                this.mapW * tf.scale,
                this.mapH * tf.scale,
            );
        }
        // Map border.
        ctx.strokeStyle = "rgba(0,0,0,0.4)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(
            tf.x(0),
            tf.y(this.mapH),
            this.mapW * tf.scale,
            this.mapH * tf.scale,
        );

        this.mapLayer = layer;
    }

    private draw() {
        const canvas = this.canvas;
        if (!canvas || !this.parsed) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const tf = this.tf;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (this.mapLayer) ctx.drawImage(this.mapLayer, 0, 0);

        // movement paths
        for (const [id, path] of this.paths) {
            if (path.length < 2) continue;
            const m = this.meta.get(id);
            const focused = this.focusId === id;
            const dim = this.focusId !== null && !focused;
            ctx.globalAlpha = dim ? 0.12 : focused ? 0.95 : 0.55;
            ctx.strokeStyle = m?.color ?? "#888";
            ctx.lineWidth = focused ? 2.5 : 1.4;
            ctx.beginPath();
            for (let i = 0; i < path.length; i++) {
                const cx = tf.x(path[i].x);
                const cy = tf.y(path[i].y);
                if (i === 0) ctx.moveTo(cx, cy);
                else ctx.lineTo(cx, cy);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // death markers
        for (const [id, d] of this.deaths) {
            if (this.focusId !== null && this.focusId !== id) continue;
            const cx = tf.x(d.x);
            const cy = tf.y(d.y);
            ctx.strokeStyle = "#c0392b";
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(cx - 4, cy - 4);
            ctx.lineTo(cx + 4, cy + 4);
            ctx.moveTo(cx + 4, cy - 4);
            ctx.lineTo(cx - 4, cy + 4);
            ctx.stroke();
        }

        // current positions at scrubber time
        this.godView?.update((this.parsed.meta.startTs ?? 0) + this.t);
        const current = this.godView?.current ?? new Map<number, GodViewPlayer>();

        // recent damage links involving the subject
        for (const ev of this.events) {
            if (this.t - ev.t < 0 || this.t - ev.t > DAMAGE_FLASH_MS) continue;
            if (
                this.subjectId !== null &&
                ev.victimId !== this.subjectId &&
                ev.sourceId !== this.subjectId
            )
                continue;
            const v = current.get(ev.victimId);
            const s = ev.sourceId ? current.get(ev.sourceId) : undefined;
            if (!v || !s) continue;
            const alpha = 1 - (this.t - ev.t) / DAMAGE_FLASH_MS;
            const dealt = ev.sourceId === this.subjectId;
            ctx.globalAlpha = Math.max(0.15, alpha) * 0.85;
            ctx.strokeStyle = dealt ? "#2ecc71" : "#e74c3c";
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(tf.x(s.pos.x), tf.y(s.pos.y));
            ctx.lineTo(tf.x(v.pos.x), tf.y(v.pos.y));
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        for (const gp of current.values()) {
            if (gp.dead) continue;
            const m = this.meta.get(gp.id);
            const focused = this.focusId === gp.id;
            const subject = this.subjectId === gp.id;
            const dim = this.focusId !== null && !focused;
            const cx = tf.x(gp.pos.x);
            const cy = tf.y(gp.pos.y);
            ctx.globalAlpha = dim ? 0.25 : 1;
            ctx.fillStyle = m?.color ?? "#444";
            ctx.beginPath();
            ctx.arc(cx, cy, focused || subject ? 6 : 4, 0, Math.PI * 2);
            ctx.fill();
            if (subject) {
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = 2;
                ctx.stroke();
            }
            if (focused || subject || this.focusId === null) {
                ctx.fillStyle = "#10240f";
                ctx.font = "11px 'Roboto Condensed', sans-serif";
                ctx.fillText(m?.name ?? "?", cx + 8, cy + 3);
            }
            ctx.globalAlpha = 1;
        }

        this.el.find("#gv-time").text(`${fmtTime(this.t)} / ${fmtTime(this.duration)}`);
        const scrub = this.el.find("#gv-scrub")[0] as HTMLInputElement | undefined;
        if (scrub && document.activeElement !== scrub) scrub.value = String(this.t);
    }

    private start() {
        cancelAnimationFrame(this.rafId);
        this.lastNow = 0;
        this.rafId = requestAnimationFrame(this.loop);
    }
    private loop = (now: number) => {
        if (!document.body.contains(this.el[0])) {
            cancelAnimationFrame(this.rafId);
            return;
        }
        if (this.lastNow === 0) this.lastNow = now;
        const dt = now - this.lastNow;
        this.lastNow = now;
        if (this.playing) {
            this.t += dt * this.speed;
            if (this.t >= this.duration) {
                this.t = this.duration;
                this.playing = false;
                this.el.find("#gv-play").text("▶");
            }
        }
        this.draw();
        this.rafId = requestAnimationFrame(this.loop);
    };

    // ── side panel HTML ──────────────────────────────────────────────────────
    private legendHtml(): string {
        const rows = [...this.meta.entries()]
            .filter(([id]) => this.paths.has(id) || this.deaths.has(id))
            .map(([id, m]) => {
                const dead = this.deaths.has(id);
                const active = this.focusId === id ? " gv-legend-active" : "";
                const you =
                    this.subjectId === id ? ' <span class="gv-you">you</span>' : "";
                return `<div class="gv-legend-row${active}" data-pid="${id}">
                    <span class="gv-swatch" style="background:${m.color}"></span>
                    <span class="gv-legend-name">${esc(m.name)}${you}</span>
                    ${dead ? '<span class="gv-legend-dead">☠</span>' : ""}
                </div>`;
            })
            .join("");
        return `<div class="gv-legend">${rows || '<div class="gv-empty">No players</div>'}</div>`;
    }

    private endStatsHtml(): string {
        if (!this.stats.length) return '<div class="gv-empty">No stats</div>';
        // Older matches predate loadout recording — drop the column entirely for them.
        const anyLoadout = [...this.loadouts.values()].some((c) => c.length);
        const rows = [...this.stats]
            .sort((a, b) => (a.rank || 999) - (b.rank || 999))
            .map((p) => {
                const acc =
                    p.shots > 0 ? `${Math.round((p.hits / p.shots) * 100)}%` : "—";
                const hl = this.subjectId === p.id ? " gv-stats-you" : "";
                const loadout = !anyLoadout
                    ? ""
                    : this.loadouts.get(p.name)?.length
                      ? `<td><span class="gv-loadout-btn" data-pid="${p.id}">View</span></td>`
                      : `<td class="gv-loadout-none">—</td>`;
                return `<tr class="${hl}">
                    <td>#${p.rank || "—"}</td>
                    <td class="gv-stats-name">${esc(p.name)}</td>
                    <td>${p.kills}</td>
                    <td>${p.damageDealt}</td>
                    <td>${p.damageTaken}</td>
                    <td>${fmtTime(p.timeAlive * 1000)}</td>
                    <td>${p.shots}</td>
                    <td>${p.hits}</td>
                    <td>${acc}</td>
                    ${loadout}
                </tr>`;
            })
            .join("");
        return `<table class="gv-stats-table"><thead><tr>
            <th>#</th><th>Player</th><th>K</th><th>Dmg</th><th>Took</th><th>Alive</th><th>Shots</th><th>Hits</th><th>Acc</th>${anyLoadout ? "<th>Loadout</th>" : ""}
        </tr></thead><tbody>${rows}</tbody></table>`;
    }

    private damageHtml(): string {
        const hasSubject = this.subjectId !== null;
        const evs = hasSubject
            ? this.events.filter(
                  (e) => e.sourceId === this.subjectId || e.victimId === this.subjectId,
              )
            : this.events;
        if (!evs.length) {
            return `<div class="gv-empty">${hasSubject ? "No damage for this player." : "No damage recorded."}</div>`;
        }
        const rows = evs
            .map((e) => {
                const dealt = e.sourceId === this.subjectId;
                const cls = hasSubject ? (dealt ? "gv-dmg-dealt" : "gv-dmg-recv") : "";
                const who = hasSubject
                    ? esc(dealt ? e.victimName : e.sourceName)
                    : `${esc(e.sourceName)} → ${esc(e.victimName)}`;
                const arrow = hasSubject ? (dealt ? "→" : "←") : "";
                return `<tr class="${cls}">
                    <td>${fmtTime(e.t)}</td>
                    <td>${arrow} ${who}</td>
                    <td>${esc(e.weapon || "—")}</td>
                    <td>${Math.round(e.amount)}</td>
                </tr>`;
            })
            .join("");
        return `<table class="gv-dmg-table"><thead><tr><th>Time</th><th>${hasSubject ? "Opponent" : "From → To"}</th><th>Weapon</th><th>Dmg</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    private renderShell() {
        let body: string;
        if (this.loading) {
            body = `<div class="col-12 spinner-wrapper-leaderboard"><div class="spinner"></div></div>`;
        } else if (this.error || !this.parsed) {
            body = `<div class="gv-error">${esc(this.error || "Failed to load match.")}</div>`;
        } else {
            const speedOpts = SPEEDS.map(
                (s) =>
                    `<option value="${s}"${s === this.speed ? " selected" : ""}>${s}×</option>`,
            ).join("");
            body = `<div class="gv-layout">
                <div class="gv-main">
                    <canvas id="gv-canvas" width="${CANVAS_PX}" height="${CANVAS_PX}" class="gv-canvas"></canvas>
                    <div class="gv-controls">
                        <button id="gv-play" class="gv-btn">▶</button>
                        <select id="gv-speed" class="gv-speed">${speedOpts}</select>
                        <input id="gv-scrub" class="gv-scrub" type="range" min="0" max="${Math.max(1, Math.round(this.duration))}" step="100" value="0">
                        <span id="gv-time" class="gv-time">0:00 / ${fmtTime(this.duration)}</span>
                    </div>
                </div>
                <div class="gv-side">
                    <div class="gv-side-title">Players</div>
                    ${this.legendHtml()}
                    <div class="gv-side-title">Damage</div>
                    <div class="gv-dmg-wrap">${this.damageHtml()}</div>
                </div>
            </div>
            <div class="gv-stats-block">
                <div class="gv-side-title">End stats</div>
                <div class="gv-stats-wrap">${this.endStatsHtml()}</div>
            </div>`;
        }

        this.el.html(`<div class="game-view container">
            <div class="gv-header">
                <div class="gv-title">GAME VIEW</div>
                <a class="gv-back" href="javascript:history.back()">← Back</a>
            </div>
            ${body}
        </div>`);

        if (!this.loading && this.parsed) this.bind();
    }

    private bind() {
        this.canvas = this.el.find("#gv-canvas")[0] as HTMLCanvasElement;

        this.el.find("#gv-play").on("click", () => {
            this.playing = !this.playing;
            if (this.playing && this.t >= this.duration) this.t = 0;
            this.lastNow = 0;
            this.el.find("#gv-play").text(this.playing ? "⏸" : "▶");
        });
        this.el.find("#gv-speed").on("change", (e) => {
            this.speed = Number($(e.target).val()) || 1;
        });
        this.el.find("#gv-scrub").on("input", (e) => {
            this.t = Number($(e.target).val()) || 0;
            this.playing = false;
            this.el.find("#gv-play").text("▶");
            this.draw();
        });
        // "View" in the End stats table — the cosmetics that player wore in this match.
        this.el.find(".gv-loadout-btn").on("click", (e) => {
            const pid = Number($(e.currentTarget).attr("data-pid"));
            const name = this.meta.get(pid)?.name ?? "";
            showMatchLoadout(name, this.loadouts.get(name) ?? []);
        });

        this.el.find(".gv-legend-row").on("click", (e) => {
            const pid = Number($(e.currentTarget).attr("data-pid"));
            this.focusId = this.focusId === pid ? null : pid;
            this.el.find(".gv-legend-row").removeClass("gv-legend-active");
            if (this.focusId !== null) {
                this.el
                    .find(`.gv-legend-row[data-pid="${this.focusId}"]`)
                    .addClass("gv-legend-active");
            }
            this.draw();
        });

        this.draw();
    }
}
