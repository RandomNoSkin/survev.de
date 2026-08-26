import { GameConfig } from "../../../shared/gameConfig";
import {
    parseReplay,
    parseTracks,
    type ReplayFrame,
    type ReplayMeta,
} from "../../../shared/net/replay";
import { v2 } from "../../../shared/utils/v2";
import { api } from "../api";
import type { Game } from "../game";
import type { AdvancedSpectator } from "../ui/advancedSpectator";
import { ReplayGodView } from "./godView";
import { ReplayRecorder } from "./replayRecorder";
import { ReplayUI } from "./replayUI";

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

interface Pov {
    playerId: number;
    playerName: string;
}

/** Decompresses gzip bytes using the browser's native DecompressionStream. */
async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
    if (typeof DecompressionStream === "undefined") {
        throw new Error(
            "This browser does not support replay decompression (DecompressionStream).",
        );
    }
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/**
 * Plays back recorded per-player replays by feeding the recorded server frames into
 * `Game.m_handleIncomingBuffer` on a timeline — reusing the entire normal decode +
 * render pipeline.
 *
 * Multiple POVs: a game records one file per real player. The viewer can switch POV
 * (arrow keys / bar buttons), which loads that player's file and jumps to the same
 * absolute moment (aligned via each recording's `startTs`), like spectating live.
 * Because the stream is delta-compressed (no random access), any backward jump / POV
 * switch tears the game down and re-feeds from the start up to the target time.
 */
export class ReplayPlayer {
    private povs: Pov[] = [];
    private povIndex = 0;

    // Currently-loaded recording.
    private frames: ReplayFrame[] = [];
    private meta?: ReplayMeta;
    private cumTimes: number[] = [];
    private offset = 0;
    private duration = 0;

    // Playback state.
    private idx = 0;
    private elapsed = 0;
    private paused = false;
    private speed = 1;
    private lastNow = 0;
    private rafId = 0;
    private destroyed = false;
    /** True while a POV switch is fetching/rebuilding — pauses frame feeding. */
    private switching = false;
    /** Protocol-mismatch alert shown once (POV switches re-run the check). */
    private protocolWarned = false;

    private ui: ReplayUI;
    private keyHandler: (e: KeyboardEvent) => void;
    private recorder?: ReplayRecorder;
    /** Guards against a second getDisplayMedia() call while the permission prompt is still open. */
    private isStartingRecording = false;
    /** Spectate-UI hidden state to restore once a tab-capture recording ends. */
    private preRecordSpectateUiHidden = false;
    /** God-view tracks (all players' pos/health); undefined for older recordings. */
    private godView?: ReplayGodView;

    constructor(
        private game: Game,
        private token: string,
        private initialPov?: number,
    ) {
        this.ui = new ReplayUI(
            {
                onTogglePause: () => this.togglePause(),
                onSetSpeed: (s) => this.setSpeed(s),
                onSeekFraction: (f) => this.seekTo(f * this.duration),
                onPrevPov: () => void this.switchPov(-1),
                onNextPov: () => void this.switchPov(1),
                onToggleRecord: () => void this.toggleRecord(),
            },
            SPEEDS,
        );

        // Bridge for the manual "Hide Spectate UI" keybind (game.ts) - Game has no
        // direct reference to the replay bar, so it calls this hook instead.
        this.game.m_onToggleSpectateUiHidden = (hidden) => this.ui.setVisible(!hidden);

        // Bridge for the Spectator-tab replay-control keybinds (game.ts) - same
        // reasoning, Game has no direct reference to the ReplayPlayer instance.
        this.game.m_replayControls = {
            togglePause: () => this.togglePause(),
            adjustSpeed: (dir) => this.adjustSpeed(dir),
            skip: (deltaMs) => this.skip(deltaMs),
            stepFrame: (dir) => this.stepFrame(dir),
        };

        this.keyHandler = (e: KeyboardEvent) => {
            // Don't hijack keys while typing in a form control (e.g. the speed dropdown).
            const tag = (e.target as HTMLElement | null)?.tagName;
            if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
            if (e.key === "ArrowLeft") {
                e.preventDefault();
                void this.switchPov(-1);
            } else if (e.key === "ArrowRight") {
                e.preventDefault();
                void this.switchPov(1);
            } else if (e.key === " " || e.code === "Space") {
                // Space toggles pause. preventDefault stops the page scrolling and also
                // suppresses the synthetic click if a control happens to be focused
                // (which would otherwise double-toggle).
                e.preventDefault();
                if (!e.repeat) this.togglePause();
            }
        };
    }

    /** Fetches the POV list + the initial POV's file, then starts playback. */
    async load(): Promise<void> {
        const povs = await this.fetchJson(
            `/api/replay/povs?token=${encodeURIComponent(this.token)}`,
        );
        this.povs = (povs.players ?? []) as Pov[];
        if (!this.povs.length) {
            throw new Error("This recording has no player POVs.");
        }
        // A player-scoped (Premium self-service) token only ever lists one POV -
        // switching is meaningless then, so don't show dead buttons for it.
        this.ui.setPovButtonsVisible(this.povs.length > 1);
        const startIdx = this.povs.findIndex((p) => p.playerId === this.initialPov);
        this.povIndex = startIdx >= 0 ? startIdx : 0;

        await this.loadPovFile(this.povs[this.povIndex].playerId);
        this.game.m_replayMode = true;
        await this.loadTracks();
        this.idx = 0;
        this.elapsed = 0;
        this.updateTitle();

        window.addEventListener("keydown", this.keyHandler);
        this.lastNow = 0;
        this.rafId = requestAnimationFrame(this.loop);
    }

    private async fetchJson(path: string): Promise<any> {
        const res = await fetch(api.resolveUrl(path));
        if (!res.ok) throw new Error(`Replay request failed (${res.status})`);
        return res.json();
    }

    /**
     * Loads the optional god-view track file (all players' pos/health). Absent on
     * older recordings → a 404 just leaves the god view off (existing behaviour).
     */
    private async loadTracks(): Promise<void> {
        try {
            const url = api.resolveUrl(
                `/api/replay/tracks?token=${encodeURIComponent(this.token)}`,
            );
            const res = await fetch(url);
            if (!res.ok) return; // 404 for recordings without tracks
            this.godView = new ReplayGodView(
                parseTracks(await gunzip(await res.arrayBuffer())),
            );
        } catch (err) {
            console.warn("Replay god-view tracks unavailable:", err);
        }
    }

    /** Fetches + decompresses + parses one POV's recording into the current-recording fields. */
    private async loadPovFile(playerId: number): Promise<void> {
        const url = api.resolveUrl(
            `/api/replay?token=${encodeURIComponent(this.token)}&playerId=${playerId}`,
        );
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load replay POV (${res.status})`);
        const parsed = parseReplay(await gunzip(await res.arrayBuffer()));

        this.frames = parsed.frames;
        this.meta = parsed.meta;
        this.game.m_gameId = this.meta.gameId;
        if (this.meta.protocolVersion !== GameConfig.protocolVersion) {
            console.warn(
                `Replay protocol ${this.meta.protocolVersion} differs from client ${GameConfig.protocolVersion} — playback may be inaccurate.`,
            );
            // Landing here means no archived client build matched this recording
            // (the dashboard would have opened /archive/<version>/ otherwise) — the
            // stream will likely misdecode, so tell the viewer why it looks broken.
            if (!this.protocolWarned) {
                this.protocolWarned = true;
                alert(
                    `This replay was recorded on protocol ${this.meta.protocolVersion}, ` +
                        `but this client uses protocol ${GameConfig.protocolVersion} — ` +
                        `playback will likely be broken. If an archived client build ` +
                        `exists for that version, open the replay via the dashboard.`,
                );
            }
        }

        let acc = 0;
        this.cumTimes = this.frames.map((f) => (acc += f.dtMs));
        this.offset = this.frames.length ? this.frames[0].dtMs : 0;
        this.duration = Math.max(0, acc - this.offset);
    }

    private loop = (now: number): void => {
        if (this.destroyed) return;
        if (this.lastNow === 0) this.lastNow = now;
        const real = now - this.lastNow;
        this.lastNow = now;

        if (!this.paused && !this.switching) {
            this.elapsed += real * this.speed;
            this.feedUpTo(this.elapsed);
            if (this.idx >= this.frames.length) {
                this.elapsed = this.duration;
                this.paused = true; // hold on the final frame
            }
        }

        if (this.godView) {
            this.godView.update(this.currentAbsTime());
            this.game.m_replayGodView = this.godView.current;
        }

        // Expose pause state so the game can freeze player-status aging — otherwise the
        // stale-update fade would make teammate minimap markers vanish while paused.
        this.game.m_replayPaused = this.paused;

        this.ui.update(this.elapsed, this.duration, this.paused, this.speed);
        this.rafId = requestAnimationFrame(this.loop);
    };

    /** Feeds every frame whose scheduled time has been reached. */
    private feedUpTo(timeMs: number): void {
        while (
            this.idx < this.frames.length &&
            this.cumTimes[this.idx] - this.offset <= timeMs
        ) {
            this.game.m_handleIncomingBuffer(this.frames[this.idx].bytes);
            this.idx++;
        }
    }

    /** Absolute (wall-clock) time of the moment currently shown, for cross-POV alignment. */
    private currentAbsTime(): number {
        return (this.meta?.startTs ?? 0) + this.offset + this.elapsed;
    }

    private togglePause(): void {
        this.paused = !this.paused;
        if (!this.paused && this.idx >= this.frames.length) {
            this.seekTo(0); // resume from the end → restart
        }
    }

    private setSpeed(speed: number): void {
        if (SPEEDS.includes(speed)) this.speed = speed;
    }

    /** Steps to the next/previous entry in the SPEEDS list (keybind path). */
    private adjustSpeed(dir: 1 | -1): void {
        const i = SPEEDS.indexOf(this.speed);
        this.setSpeed(SPEEDS[clamp(i + dir, 0, SPEEDS.length - 1)]);
    }

    /** Skips the current POV forward/backward by a fixed step (keybind path). */
    private skip(deltaMs: number): void {
        this.seekTo(this.elapsed + deltaMs);
    }

    /**
     * Steps exactly one recorded frame forward/backward, pausing first if needed.
     * Forward just feeds the next frame; backward rebuilds to the previous frame's
     * timestamp (delta-compressed stream, no random access - see rebuildTo).
     */
    private stepFrame(dir: 1 | -1): void {
        if (!this.frames.length || this.switching) return;
        this.paused = true;
        if (dir > 0) {
            if (this.idx >= this.frames.length) return;
            const target = this.cumTimes[this.idx] - this.offset;
            this.feedUpTo(target);
            this.elapsed = target;
        } else {
            const prevIdx = Math.max(0, this.idx - 2);
            const target = prevIdx > 0 ? this.cumTimes[prevIdx] - this.offset : 0;
            this.rebuildTo(target);
        }
    }

    /**
     * Seeks within the current POV. Forward fast-forwards by feeding frames; backward
     * rebuilds from the start (delta-compressed stream, no random access).
     */
    private seekTo(targetMs: number): void {
        const target = clamp(targetMs, 0, this.duration);
        if (target < this.elapsed) {
            this.rebuildTo(target);
        } else {
            this.feedUpTo(target);
            this.elapsed = target;
        }
    }

    /** Switches to another player's POV, aligned to the current moment. */
    private async switchPov(delta: number): Promise<void> {
        if (this.switching || this.povs.length <= 1) return;
        this.switching = true;
        const absTime = this.currentAbsTime();
        try {
            this.povIndex = (this.povIndex + delta + this.povs.length) % this.povs.length;
            await this.loadPovFile(this.povs[this.povIndex].playerId);
            // Same wall-clock moment in the new recording's timeline.
            const target = clamp(
                absTime - (this.meta?.startTs ?? 0) - this.offset,
                0,
                this.duration,
            );
            this.rebuildTo(target);
            this.updateTitle();
        } catch (err) {
            console.error("Replay POV switch failed:", err);
        } finally {
            this.switching = false;
        }
    }

    /**
     * Rebuilds the game from frame 0 up to `target` ms (needed for any backward jump
     * or POV switch, since the stream is delta-compressed), preserving the viewer's
     * advanced-spectator settings across the teardown/re-init.
     */
    private rebuildTo(target: number): void {
        const adv = this.captureAdvSpec();
        try {
            this.game.free();
        } catch (err) {
            console.error("Replay rebuild error:", err);
        }
        this.game.m_replayMode = true;
        this.idx = 0;
        this.elapsed = 0;
        this.feedUpTo(target);
        this.elapsed = target;
        this.restoreAdvSpec(adv);
    }

    /** Snapshots the user-facing advanced-spectator toggles before a rebuild. */
    private captureAdvSpec(): Partial<AdvancedSpectator> | null {
        const a = this.game.m_advSpec;
        if (!a) return null;
        return {
            enabled: a.enabled,
            freecam: a.freecam,
            transparentSurfaces: a.transparentSurfaces,
            enemiesOnMap: a.enemiesOnMap,
            zoom: a.zoom,
            espLines: a.espLines,
            enemyLabels: a.enemyLabels,
            nadeEsp: a.nadeEsp,
            layer: a.layer,
            zoomLevel: a.zoomLevel,
            freecamInitialized: a.freecamInitialized,
            freecamPos: v2.copy(a.freecamPos),
        };
    }

    /** Re-applies the snapshot onto the freshly-rebuilt game's advanced spectator. */
    private restoreAdvSpec(snap: Partial<AdvancedSpectator> | null): void {
        const a = this.game.m_advSpec;
        if (!snap || !a) return;
        Object.assign(a, snap);
        this.game.m_uiManager?.updateAdvancedSpectatorUi();
    }

    /**
     * Starts/stops recording the replay to a downloadable video file. Prefers a tab
     * capture (full DOM UI + sound, one picker prompt); falls back to a canvas
     * capture with the game audio muxed in where `getDisplayMedia` is unavailable.
     */
    private async toggleRecord(): Promise<void> {
        if (this.isStartingRecording) return; // permission prompt already pending
        try {
            if (this.recorder?.isRecording) {
                this.recorder.stop();
                return; // UI is restored by the recorder's onStop below
            }
            const canvas = document.querySelector<HTMLCanvasElement>("#cvs");
            if (!canvas) {
                console.error("Replay recording: game canvas (#cvs) not found.");
                return;
            }
            const recorder = new ReplayRecorder(canvas, this.recordFileName());
            // The browser's own "Stop sharing" bar can end a tab capture without the
            // ⏺ button — keep the control-bar state in sync either way, and always
            // restore whatever the spectate-UI visibility was before recording
            // started (tab-capture recordings force it hidden so the video is clean).
            recorder.onStop = () => {
                this.ui.setRecording(false);
                if (recorder.mode === "tab") {
                    this.ui.setVisible(true);
                    this.game.m_uiManager.setSpectateUiHidden(this.preRecordSpectateUiHidden);
                }
            };
            this.recorder = recorder;
            this.isStartingRecording = true;
            const result = await recorder.start();
            this.isStartingRecording = false;
            if (result === "ok") {
                this.ui.setRecording(true);
                if (recorder.mode === "tab") {
                    this.preRecordSpectateUiHidden = this.game.m_uiManager.spectateUiHidden;
                    this.ui.setVisible(false);
                    this.game.m_uiManager.setSpectateUiHidden(true);
                }
            } else {
                this.recorder = undefined;
                this.ui.setRecording(false);
                if (result !== "cancelled") {
                    alert("Video recording is not supported in this browser.");
                }
            }
        } catch (err) {
            this.isStartingRecording = false;
            console.error("Replay recording toggle failed:", err);
            this.ui.setRecording(false);
        }
    }

    /** Builds a filesystem-safe video file name from the current recording's metadata. */
    private recordFileName(): string {
        const safe = (s: string) =>
            (s || "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40);
        const name = safe(this.meta?.playerName ?? "");
        const map = safe(this.meta?.mapName ?? "");
        const id = (this.meta?.gameId ?? "").slice(0, 8);
        return `replay-${name}-${map}-${id}`.replace(/-+$/g, "") || "replay";
    }

    private updateTitle(): void {
        const name = this.meta?.playerName ?? "?";
        const map = this.meta?.mapName ?? "";
        const pos =
            this.povs.length > 1 ? `  (${this.povIndex + 1}/${this.povs.length})` : "";
        this.ui.setTitle(`▶ ${name} · ${map}${pos}`);
    }

    destroy(): void {
        this.destroyed = true;
        if (this.rafId) cancelAnimationFrame(this.rafId);
        window.removeEventListener("keydown", this.keyHandler);
        this.game.m_replayGodView = null;
        this.game.m_replayPaused = false;
        this.game.m_onToggleSpectateUiHidden = undefined;
        this.game.m_replayControls = undefined;
        // Finalize any in-progress recording so the file is still saved.
        this.recorder?.stop();
        this.ui.destroy();
    }
}
