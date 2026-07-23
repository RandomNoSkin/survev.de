/**
 * Minimal playback overlay for replay mode: title, play/pause, a speed dropdown,
 * a clickable progress bar and a time readout. Pure DOM, appended to <body>.
 */
export interface ReplayUICallbacks {
    onTogglePause(): void;
    onSetSpeed(speed: number): void;
    onSeekFraction(fraction: number): void;
    onPrevPov(): void;
    onNextPov(): void;
    onToggleRecord(): void;
}

function fmtTime(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export class ReplayUI {
    private root: HTMLDivElement;
    private prevPovBtn: HTMLButtonElement;
    private nextPovBtn: HTMLButtonElement;
    private playBtn: HTMLButtonElement;
    private speedSelect: HTMLSelectElement;
    private recBtn: HTMLButtonElement;
    private barFill: HTMLDivElement;
    private timeLabel: HTMLSpanElement;
    private titleLabel: HTMLSpanElement;

    constructor(
        private cb: ReplayUICallbacks,
        speeds: number[],
    ) {
        const root = document.createElement("div");
        root.id = "replay-bar";
        root.style.cssText = [
            "position:fixed",
            "left:50%",
            "top:18px",
            "transform:translateX(-50%)",
            "z-index:1000",
            "display:flex",
            "align-items:center",
            "gap:12px",
            "padding:8px 14px",
            "background:rgba(8,8,16,0.82)",
            "border:1px solid #2a2a4a",
            "border-radius:10px",
            "color:#c8c8e0",
            "font-family:system-ui,sans-serif",
            "font-size:13px",
            "box-shadow:0 4px 18px rgba(0,0,0,0.5)",
            "user-select:none",
        ].join(";");

        const btnCss =
            "background:#14142a;border:1px solid #2a2a4a;color:#c8c8e0;border-radius:6px;" +
            "padding:4px 10px;cursor:pointer;font-family:inherit;font-size:13px;min-width:34px;";

        // POV switching (◀ / ▶) — also bound to the arrow keys by the player.
        const prevPovBtn = document.createElement("button");
        prevPovBtn.style.cssText = btnCss;
        prevPovBtn.textContent = "◀";
        prevPovBtn.title = "Previous POV (←)";
        prevPovBtn.onclick = () => this.cb.onPrevPov();

        const nextPovBtn = document.createElement("button");
        nextPovBtn.style.cssText = btnCss;
        nextPovBtn.textContent = "▶";
        nextPovBtn.title = "Next POV (→)";
        nextPovBtn.onclick = () => this.cb.onNextPov();

        this.titleLabel = document.createElement("span");
        this.titleLabel.style.cssText =
            "color:#5577ff;font-weight:600;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

        this.prevPovBtn = prevPovBtn;
        this.nextPovBtn = nextPovBtn;

        this.playBtn = document.createElement("button");
        this.playBtn.style.cssText = btnCss;
        this.playBtn.textContent = "⏸";
        this.playBtn.onclick = () => this.cb.onTogglePause();

        this.speedSelect = document.createElement("select");
        this.speedSelect.style.cssText = btnCss + "min-width:56px;";
        this.speedSelect.title = "Playback speed";
        for (const s of speeds) {
            const opt = document.createElement("option");
            opt.value = String(s);
            opt.textContent = `${s}×`;
            opt.style.cssText = "background:#14142a;color:#c8c8e0;";
            this.speedSelect.appendChild(opt);
        }
        this.speedSelect.onchange = () =>
            this.cb.onSetSpeed(Number(this.speedSelect.value));

        // Record the replay to a downloadable video (toggles start/stop). Tab capture
        // (full UI + sound) where supported — pick "This tab" in the browser prompt.
        this.recBtn = document.createElement("button");
        this.recBtn.style.cssText = btnCss;
        this.recBtn.textContent = "⏺";
        this.recBtn.title = "Record video (pick “This tab” for UI + sound)";
        this.recBtn.onclick = () => this.cb.onToggleRecord();

        const bar = document.createElement("div");
        bar.style.cssText =
            "position:relative;width:280px;height:8px;background:#1e1e3a;border-radius:4px;cursor:pointer;";
        bar.onclick = (e) => {
            const rect = bar.getBoundingClientRect();
            this.cb.onSeekFraction(
                Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
            );
        };
        this.barFill = document.createElement("div");
        this.barFill.style.cssText =
            "position:absolute;left:0;top:0;height:100%;width:0;background:#3355ee;border-radius:4px;pointer-events:none;";
        bar.appendChild(this.barFill);

        this.timeLabel = document.createElement("span");
        this.timeLabel.style.cssText =
            "font-variant-numeric:tabular-nums;min-width:84px;text-align:right;color:#9a9ac0;";
        this.timeLabel.textContent = "0:00 / 0:00";

        root.append(
            this.prevPovBtn,
            this.nextPovBtn,
            this.titleLabel,
            this.playBtn,
            this.speedSelect,
            this.recBtn,
            bar,
            this.timeLabel,
        );
        document.body.appendChild(root);
        this.root = root;
    }

    setTitle(text: string) {
        this.titleLabel.textContent = text;
    }

    /** Reflects recording state on the record button (label + red highlight). */
    setRecording(active: boolean) {
        this.recBtn.textContent = active ? "⏹" : "⏺";
        this.recBtn.title = active ? "Stop recording" : "Record video";
        this.recBtn.style.background = active ? "#7a1e1e" : "#14142a";
        this.recBtn.style.borderColor = active ? "#b03030" : "#2a2a4a";
    }

    update(elapsedMs: number, durationMs: number, paused: boolean, speed: number) {
        this.playBtn.textContent = paused ? "▶" : "⏸";
        if (Number(this.speedSelect.value) !== speed) {
            this.speedSelect.value = String(speed);
        }
        const frac = durationMs > 0 ? Math.min(1, elapsedMs / durationMs) : 0;
        this.barFill.style.width = `${frac * 100}%`;
        this.timeLabel.textContent = `${fmtTime(elapsedMs)} / ${fmtTime(durationMs)}`;
    }

    destroy() {
        this.root.remove();
    }
}
