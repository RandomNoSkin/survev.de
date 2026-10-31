import type * as net from "../../../shared/net/net";
import { util } from "../../../shared/utils/util";

/**
 * Server-side cheat signals, read from each player's inputs. Only ever flags a player
 * as "sus" for staff to look at (see Game.antiCheatFlags -> save_game) - nothing here
 * kicks or bans, so every check errs towards not firing.
 *
 *  - touch_desktop: a desktop client steering with the touch joystick (auto-dodge /
 *    auto-melee scripts do), worst when it flips between keys and touch within ms
 *  - spinbot: the aim turning round and round at a machine-steady speed, for a long
 *    time - players spinning for fun turn unevenly (and not for long)
 *  - snap_aim: the aim jumping away right as a shot starts and back to where it was
 *    a moment later (silent aim - the "trezor client" one holds the target until the
 *    shot's input is acked, then jumps back) - a human flick stays on the target
 *  - cheat_name: a name a known cheat forces on its users
 *  - esp_track: the aim following an enemy the player can't see - under another
 *    building's roof, on another floor / underground, in smoke, or just off the screen
 *    (the server sends a few units beyond it). ESP draws those (the client gets them,
 *    it just doesn't show them); a human can't track them.
 *  - offscreen_aim: the aim resting on an enemy that isn't on the screen yet - also
 *    when they walk straight at the player, which esp_track (it needs them to move
 *    around the player) doesn't see
 */
export type CheatSignal = "touch_desktop" | "spinbot" | "snap_aim" | "cheat_name" | "esp_track" | "offscreen_aim";

/** Names cheat scripts lock their users to (compared trimmed, case-insensitive). */
export const KNOWN_CHEAT_NAMES = ["trezor client"];

/** Score at which a signal flags the player (once per game). */
export const CHEAT_THRESHOLDS: Record<CheatSignal, number> = {
    touch_desktop: 60,
    /** 10 per steady 3 s window: ~18 s of bot-like spinning */
    spinbot: 60,
    snap_aim: 25,
    cheat_name: 1,
    /** seconds of tracking hidden, moving enemies */
    esp_track: 15,
    /** seconds of aiming at enemies not on the screen yet */
    offscreen_aim: 20,
};

const TOUCH_TICK_SCORE = 1;
/** keys and touch steering both within this window: no human switches that fast */
const TOUCH_SWITCH_MS = 100;
const TOUCH_SWITCH_SCORE = 5;

const SPIN_WINDOW_MS = 3000;
/** sustained turning in one direction within the window, in full turns (~0.8/s) */
const SPIN_TURNS = 2.5;
const SPIN_SCORE = 10;
/** the turning per input may vary at most this much (coefficient of variation): a
 *  script adds the same angle every frame, a hand on a mouse / stick doesn't */
const SPIN_MAX_CV = 0.2;
/** share of the inputs in the window that must turn the same way */
const SPIN_MIN_SAME_DIR = 0.95;

/** the aim jumps at least this far as the shot starts... */
const SNAP_OUT_RAD = (60 * Math.PI) / 180;
/** ...and within this long jumps (at least SNAP_BACK_JUMP_RAD in one input) back to
 *  within SNAP_BACK_RAD of where it was - a slow drag back doesn't count */
const SNAP_WINDOW_MS = 1500;
const SNAP_BACK_RAD = (15 * Math.PI) / 180;
const SNAP_BACK_JUMP_RAD = (45 * Math.PI) / 180;
const SNAP_SCORE = 5;
/** snaps only count once they're this share of all shots - not the odd flick back */
const SNAP_MIN_RATIO = 0.2;

/** how often the ESP check runs per player */
const ESP_CHECK_MS = 100;
/** only enemies this close (world units, about a screen; more when scoped in) */
const ESP_RANGE = 45;
/** closer than this you can hear / guess them */
const ESP_MIN_DIST = 8;
/** hidden at least this long first: tracking someone who just stepped inside is fair */
const ESP_HIDDEN_FOR_MS = 2000;
/** ...and not shooting (their bullets give them away) */
const ESP_SHOT_GRACE_MS = 1500;
/** aim within max(this, target size at that distance) of the enemy */
const ESP_AIM_TOL_RAD = (4 * Math.PI) / 180;
/** a tracking run counts from this long, and only if the enemy moved this far around
 *  the player meanwhile (so a static aim at a door doesn't) */
const ESP_MIN_TRACK_MS = 700;
const ESP_MIN_SWEEP_RAD = (12 * Math.PI) / 180;
/** offscreen_aim: tighter aim, held at least this long (no movement needed) */
const OFFSCREEN_AIM_TOL_RAD = (2.5 * Math.PI) / 180;
const OFFSCREEN_MIN_AIM_MS = 1000;
/** ...on an enemy unseen for this long (not one you just watched walk off, or camping
 *  where you know they are) who moves at least OFFSCREEN_MIN_MOVE meanwhile */
const OFFSCREEN_HIDDEN_FOR_MS = 5000;
const OFFSCREEN_MIN_MOVE = 1.5;
/** an enemy this far past the screen edge counts as off it (their body is ~1 unit) */
const OFFSCREEN_MARGIN = 1;

export interface EspPlayer {
    __id: number;
    pos: { x: number; y: number };
    dir: { x: number; y: number };
    layer: number;
    teamId: number;
    dead: boolean;
    insideSmoke: boolean;
    /** the building whose roof is over them (undefined outdoors) */
    occupiedBuilding?: unknown;
    /** Date.now() of their last shot */
    lastShotAt: number;
    /** view radius along the longer screen side, world units (see Player.zoom) */
    zoom: number;
    portrait: boolean;
}

/**
 * Is `dx`/`dy` (target - viewer) off the viewer's screen? The client shows `zoom`
 * units along its longer side and keeps 16:9 for the culling (see Player.sendMsgs) -
 * the server sends ~4 units beyond that, which is all an ESP has to draw.
 */
export function offscreenFrom(viewer: EspPlayer, dx: number, dy: number): boolean {
    const long = viewer.zoom + OFFSCREEN_MARGIN;
    const short = viewer.zoom / (16 / 9) + OFFSCREEN_MARGIN;
    const [hx, hy] = viewer.portrait ? [short, long] : [long, short];
    return Math.abs(dx) > hx || Math.abs(dy) > hy;
}

/** Can `viewer` actually see `target` on an unmodified client? */
export function hiddenFrom(viewer: EspPlayer, target: EspPlayer, dist: number): boolean {
    if (offscreenFrom(viewer, target.pos.x - viewer.pos.x, target.pos.y - viewer.pos.y)) return true;
    if (!util.sameLayer(viewer.layer, target.layer)) return true;
    if (target.occupiedBuilding && target.occupiedBuilding !== viewer.occupiedBuilding) return true;
    if (target.insideSmoke && !viewer.insideSmoke && dist > ESP_MIN_DIST) return true;
    return false;
}

function angleDiff(a: number, b: number) {
    let d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
}

interface EspRun {
    start: number;
    last: number;
    bearing: number;
    sweep: number;
    /** ms of it already scored */
    credited: number;
}

export interface AntiCheatSummary {
    scores: Partial<Record<CheatSignal, number>>;
    /** worst score / its threshold - 1 and up means flagged */
    maxRatio: number;
    shots: number;
    snaps: number;
    espLongestMs: number;
    offscreenLongestMs: number;
}

interface EspTargetState {
    /** when the player could last see them */
    seenAt: number;
    /** current tracking run (esp_track) */
    run?: EspRun;
    /** current aim at them while off the screen (offscreen_aim) */
    pre?: OffscreenAim;
}

interface OffscreenAim {
    start: number;
    last: number;
    /** ms of it already scored */
    credited: number;
    /** where they were when it started, and how far they got from there */
    from: { x: number; y: number };
    moved: number;
}

export interface CheatInputSource {
    isMobile: boolean;
    name: string;
}

export class CheatMonitor {
    scores: Record<CheatSignal, number> = {
        touch_desktop: 0,
        spinbot: 0,
        snap_aim: 0,
        cheat_name: 0,
        esp_track: 0,
        offscreen_aim: 0,
    };
    /** signals that reached their threshold, in the order they did */
    flagged: CheatSignal[] = [];

    private lastKeyMoveAt = -Infinity;
    private lastTouchMoveAt = -Infinity;

    private lastAngle: number | undefined;
    /** signed turning per input, for the spin window */
    private turns: { at: number; d: number }[] = [];
    private spinCooldownUntil = 0;

    /** aim before a shot that jumped away - checked on the inputs after it */
    private pendingSnap: { before: number; at: number } | undefined;
    private nameChecked = false;
    shots = 0;
    snaps = 0;

    private espCheckedAt = 0;
    /** per enemy: when the player could last see them, and the current tracking run */
    private espTargets = new Map<number, EspTargetState>();
    /** longest single tracking run of a hidden enemy, ms */
    espLongestMs = 0;
    /** longest single aim at an enemy off the screen, ms */
    offscreenLongestMs = 0;

    constructor(private source: CheatInputSource) {}

    /** Returns the signal that just reached its threshold, if one did. */
    onInput(msg: net.InputMsg, now: number): CheatSignal | undefined {
        const flaggedBefore = this.flagged.length;
        this.check(msg, now);
        return this.flagged.length > flaggedBefore ? this.flagged[this.flagged.length - 1] : undefined;
    }

    private check(msg: net.InputMsg, now: number) {
        if (!this.nameChecked) {
            this.nameChecked = true;
            if (KNOWN_CHEAT_NAMES.includes(this.source.name.trim().toLowerCase())) this.add("cheat_name", 1);
        }
        this.checkTouch(msg, now);

        const dir = msg.toMouseDir;
        if (!dir || (dir.x === 0 && dir.y === 0)) return;
        const angle = Math.atan2(dir.y, dir.x);
        const prev = this.lastAngle;
        this.lastAngle = angle;
        if (prev === undefined) return;
        const d = angleDiff(angle, prev);

        this.checkSnap(msg, now, prev, angle, d);
        this.checkSpin(now, d);
    }

    private checkTouch(msg: net.InputMsg, now: number) {
        if (this.source.isMobile) return;
        const keys = msg.moveLeft || msg.moveRight || msg.moveUp || msg.moveDown;
        const touch = msg.touchMoveActive && msg.touchMoveLen > 0;
        if (keys) {
            // back on the keys right after touch steering
            if (!touch && now - this.lastTouchMoveAt < TOUCH_SWITCH_MS) this.add("touch_desktop", TOUCH_SWITCH_SCORE);
            this.lastKeyMoveAt = now;
        }
        if (!touch) return;
        this.lastTouchMoveAt = now;
        this.add("touch_desktop", TOUCH_TICK_SCORE);
        if (keys || now - this.lastKeyMoveAt < TOUCH_SWITCH_MS) {
            this.add("touch_desktop", TOUCH_SWITCH_SCORE);
        }
    }

    private checkSnap(msg: net.InputMsg, now: number, prev: number, angle: number, d: number) {
        if (this.pendingSnap && now - this.pendingSnap.at > SNAP_WINDOW_MS) this.pendingSnap = undefined;
        if (this.pendingSnap && Math.abs(d) > SNAP_BACK_JUMP_RAD) {
            if (Math.abs(angleDiff(angle, this.pendingSnap.before)) < SNAP_BACK_RAD) {
                this.snaps++;
                this.add("snap_aim", SNAP_SCORE);
            }
            this.pendingSnap = undefined;
        }
        if (msg.shootStart) {
            this.shots++;
            // a burst while the aim is held keeps the first shot's "before"
            if (!this.pendingSnap && Math.abs(d) > SNAP_OUT_RAD) this.pendingSnap = { before: prev, at: now };
        }
    }

    private checkSpin(now: number, d: number) {
        // spin scripts are desktop cheats; a thumb circling the aim stick isn't one
        if (this.source.isMobile) return;
        this.turns.push({ at: now, d });
        while (this.turns.length && now - this.turns[0].at > SPIN_WINDOW_MS) this.turns.shift();
        if (now < this.spinCooldownUntil) return;
        // only steady turning counts: the net rotation, not back-and-forth wiggling
        let net = 0;
        for (const t of this.turns) net += t.d;
        if (Math.abs(net) >= SPIN_TURNS * 2 * Math.PI && this.spinIsSteady(Math.sign(net))) {
            this.add("spinbot", SPIN_SCORE);
            // one score per window, not per input
            this.spinCooldownUntil = now + SPIN_WINDOW_MS;
            this.turns = [];
        }
    }

    /** The turning in the window is machine-even: (almost) every input turns the same way,
     *  by (almost) the same angle. */
    private spinIsSteady(dir: number) {
        const steps = this.turns.map((t) => t.d * dir);
        if (steps.filter((s) => s > 0).length < steps.length * SPIN_MIN_SAME_DIR) return false;
        const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
        const sd = Math.sqrt(steps.reduce((a, s) => a + (s - mean) ** 2, 0) / steps.length);
        return sd / mean <= SPIN_MAX_CV;
    }

    private add(signal: CheatSignal, score: number) {
        this.scores[signal] += score;
        if (signal === "snap_aim" && this.snaps / Math.max(1, this.shots) < SNAP_MIN_RATIO) return;
        if (this.scores[signal] >= CHEAT_THRESHOLDS[signal] && !this.flagged.includes(signal)) {
            this.flagged.push(signal);
        }
    }

    /**
     * ESP: does the player's aim follow enemies they can't see? Called every tick,
     * runs every ESP_CHECK_MS. Returns the signal if it just reached its threshold.
     */
    onTick(viewer: EspPlayer, enemies: Iterable<EspPlayer>, now: number): CheatSignal | undefined {
        if (now - this.espCheckedAt < ESP_CHECK_MS) return undefined;
        const dt = this.espCheckedAt ? now - this.espCheckedAt : ESP_CHECK_MS;
        this.espCheckedAt = now;
        const flaggedBefore = this.flagged.length;
        const aim = Math.atan2(viewer.dir.y, viewer.dir.x);
        const present = new Set<number>();

        for (const t of enemies) {
            if (t === viewer || t.dead || t.teamId === viewer.teamId) continue;
            const dx = t.pos.x - viewer.pos.x;
            const dy = t.pos.y - viewer.pos.y;
            const dist = Math.hypot(dx, dy);
            // scoped in, the band just off the screen is further out
            if (dist > Math.max(ESP_RANGE, viewer.zoom + 6)) continue;
            present.add(t.__id);
            let state = this.espTargets.get(t.__id);
            if (!state) {
                state = { seenAt: now };
                this.espTargets.set(t.__id, state);
            }
            const hidden = dist > ESP_MIN_DIST && now - t.lastShotAt > ESP_SHOT_GRACE_MS && hiddenFrom(viewer, t, dist);
            if (!hidden) {
                state.seenAt = now;
                this.endEspRun(state);
                this.endOffscreenAim(state);
                continue;
            }
            if (now - state.seenAt < ESP_HIDDEN_FOR_MS) continue;

            const bearing = Math.atan2(dy, dx);
            const err = Math.abs(angleDiff(aim, bearing));
            // resting on an enemy that isn't on the screen (yet)
            if (
                now - state.seenAt >= OFFSCREEN_HIDDEN_FOR_MS
                && offscreenFrom(viewer, dx, dy)
                && err <= Math.max(OFFSCREEN_AIM_TOL_RAD, Math.atan2(1, dist))
            ) {
                if (!state.pre) state.pre = { start: now - dt, last: now, credited: 0, from: { x: t.pos.x, y: t.pos.y }, moved: 0 };
                else {
                    state.pre.last = now;
                    state.pre.moved = Math.max(state.pre.moved, Math.hypot(t.pos.x - state.pre.from.x, t.pos.y - state.pre.from.y));
                }
                this.creditOffscreenAim(state.pre);
            } else {
                this.endOffscreenAim(state);
            }

            const tol = Math.max(ESP_AIM_TOL_RAD, Math.atan2(1.5, dist));
            if (Math.abs(angleDiff(aim, bearing)) <= tol) {
                if (!state.run) state.run = { start: now - dt, last: now, bearing, sweep: 0, credited: 0 };
                else {
                    state.run.sweep += Math.abs(angleDiff(bearing, state.run.bearing));
                    state.run.bearing = bearing;
                    state.run.last = now;
                }
                this.creditEspRun(state.run);
            } else {
                this.endEspRun(state);
            }
        }
        // out of range / gone: their runs end too
        for (const [id, state] of this.espTargets) {
            if (present.has(id)) continue;
            this.endEspRun(state);
            this.endOffscreenAim(state);
            this.espTargets.delete(id);
        }
        return this.flagged.length > flaggedBefore ? this.flagged[this.flagged.length - 1] : undefined;
    }

    private endEspRun(state: { run?: EspRun }) {
        if (state.run) this.creditEspRun(state.run);
        state.run = undefined;
    }

    /** Scores a tracking run as it goes, once it qualifies (long enough, enemy moved). */
    private creditEspRun(run: EspRun) {
        const ms = run.last - run.start;
        if (ms < ESP_MIN_TRACK_MS || run.sweep < ESP_MIN_SWEEP_RAD) return;
        this.espLongestMs = Math.max(this.espLongestMs, ms);
        const add = ms - run.credited;
        if (add <= 0) return;
        run.credited = ms;
        this.add("esp_track", add / 1000);
    }

    private endOffscreenAim(state: EspTargetState) {
        if (state.pre) this.creditOffscreenAim(state.pre);
        state.pre = undefined;
    }

    private creditOffscreenAim(pre: OffscreenAim) {
        const ms = pre.last - pre.start;
        if (ms < OFFSCREEN_MIN_AIM_MS || pre.moved < OFFSCREEN_MIN_MOVE) return;
        const add = ms - pre.credited;
        if (add <= 0) return;
        pre.credited = ms;
        this.offscreenLongestMs = Math.max(this.offscreenLongestMs, ms);
        this.add("offscreen_aim", add / 1000);
    }

    /** Every non-zero score and how close the worst is to its threshold (1 = flagged). */
    summary(): AntiCheatSummary | undefined {
        const scores: Partial<Record<CheatSignal, number>> = {};
        let maxRatio = 0;
        for (const key of Object.keys(this.scores) as CheatSignal[]) {
            const v = Math.round(this.scores[key] * 10) / 10;
            if (v <= 0) continue;
            scores[key] = v;
            maxRatio = Math.max(maxRatio, v / CHEAT_THRESHOLDS[key]);
        }
        if (!Object.keys(scores).length) return undefined;
        return {
            scores,
            maxRatio: Math.round(maxRatio * 100) / 100,
            shots: this.shots,
            snaps: this.snaps,
            espLongestMs: this.espLongestMs,
            offscreenLongestMs: this.offscreenLongestMs,
        };
    }

    /** Note for the sus entry, or undefined when nothing was flagged. */
    report(): string | undefined {
        if (!this.flagged.length) return undefined;
        const parts = this.flagged.map((s) => {
            const extra = s === "snap_aim"
                ? `, ${this.snaps}/${this.shots} shots`
                : s === "esp_track"
                  ? `s, longest ${(this.espLongestMs / 1000).toFixed(1)}s`
                  : s === "offscreen_aim"
                    ? `s, longest ${(this.offscreenLongestMs / 1000).toFixed(1)}s`
                    : "";
            return `${s} (score ${this.scores[s]}${extra})`;
        });
        return `auto: ${parts.join(", ")}`;
    }
}
