import { GameConfig } from "../../../shared/gameConfig";
import {
    parseReplay,
    type ReplayFrame,
    type ReplayMeta,
} from "../../../shared/net/replay";
import { v2 } from "../../../shared/utils/v2";
import { api } from "../api";
import type { Game } from "../game";
import type { AdvancedSpectator } from "../ui/advancedSpectator";
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

    private ui: ReplayUI;
    private keyHandler: (e: KeyboardEvent) => void;

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
            },
            SPEEDS,
        );

        this.keyHandler = (e: KeyboardEvent) => {
            if (e.key === "ArrowLeft") {
                e.preventDefault();
                void this.switchPov(-1);
            } else if (e.key === "ArrowRight") {
                e.preventDefault();
                void this.switchPov(1);
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
        const startIdx = this.povs.findIndex((p) => p.playerId === this.initialPov);
        this.povIndex = startIdx >= 0 ? startIdx : 0;

        await this.loadPovFile(this.povs[this.povIndex].playerId);
        this.game.m_replayMode = true;
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
        if (this.meta.protocolVersion !== GameConfig.protocolVersion) {
            console.warn(
                `Replay protocol ${this.meta.protocolVersion} differs from client ${GameConfig.protocolVersion} — playback may be inaccurate.`,
            );
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
        this.ui.destroy();
    }
}
