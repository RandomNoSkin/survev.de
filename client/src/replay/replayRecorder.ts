import { CreateJS } from "../lib/createJS";

/**
 * Records the replay to a downloadable video file using the browser's MediaRecorder
 * API. Runs entirely in the admin's browser, so it never touches the (small) game
 * server. Two capture modes, best first:
 *
 * 1. Tab capture (`getDisplayMedia` with `preferCurrentTab`): records the whole tab —
 *    game canvas AND the DOM overlays (killfeed, HUD bars, menus) — plus the tab's
 *    audio. Needs one browser picker prompt; Chrome/Edge preselect the current tab.
 *    Cancelling the picker cancels the recording (no silent fallback).
 * 2. Canvas capture (`canvas.captureStream`): used when `getDisplayMedia` is
 *    unavailable. Captures only the WebGL canvas (game world + PIXI HUD) — DOM
 *    overlays don't appear — with the game's WebAudio mix muxed in as the audio
 *    track, so at least the sound is always included.
 *
 * Container/codec: prefers MP4 (avc1) where the browser supports it (recent Chrome,
 * Safari), otherwise falls back to WebM. The output file extension follows whichever
 * type was actually used.
 */

/** Candidate containers/codecs for a recording with an audio track, best first. */
const MIME_CANDIDATES_AV: Array<{ mime: string; ext: string }> = [
    { mime: 'video/mp4;codecs="avc1,mp4a.40.2"', ext: "mp4" },
    { mime: 'video/mp4;codecs="avc1,opus"', ext: "mp4" },
    { mime: 'video/webm;codecs="vp9,opus"', ext: "webm" },
    { mime: 'video/webm;codecs="vp8,opus"', ext: "webm" },
    { mime: "video/webm", ext: "webm" },
];

/** Candidates for a video-only recording (no audio track could be captured). */
const MIME_CANDIDATES_VIDEO: Array<{ mime: string; ext: string }> = [
    { mime: "video/mp4;codecs=avc1", ext: "mp4" },
    { mime: "video/webm;codecs=vp9", ext: "webm" },
    { mime: "video/webm;codecs=vp8", ext: "webm" },
    { mime: "video/webm", ext: "webm" },
];

export type RecorderStartResult = "ok" | "cancelled" | "unsupported" | "error";

export class ReplayRecorder {
    private recorder?: MediaRecorder;
    private stream?: MediaStream;
    private chunks: Blob[] = [];
    private mime = "";
    private ext = "webm";
    /** True while the game-audio output capture is tapped (canvas mode only). */
    private capturingGameAudio = false;
    /** Invoked whenever the recording ends — stop(), an error, or the browser's own "Stop sharing" UI. */
    onStop?: () => void;

    constructor(
        private canvas: HTMLCanvasElement,
        private fileBaseName: string,
        private fps = 60,
    ) {}

    /** True if this browser exposes both MediaRecorder and canvas.captureStream. */
    static isSupported(): boolean {
        return (
            typeof MediaRecorder !== "undefined" &&
            typeof HTMLCanvasElement !== "undefined" &&
            typeof HTMLCanvasElement.prototype.captureStream === "function"
        );
    }

    get isRecording(): boolean {
        return this.recorder?.state === "recording";
    }

    /** Picks the first supported container/codec; returns false if none are usable. */
    private pickMime(withAudio: boolean): boolean {
        const candidates = withAudio ? MIME_CANDIDATES_AV : MIME_CANDIDATES_VIDEO;
        for (const c of candidates) {
            if (MediaRecorder.isTypeSupported(c.mime)) {
                this.mime = c.mime;
                this.ext = c.ext;
                return true;
            }
        }
        return false;
    }

    /**
     * Tab capture: the whole tab (canvas + DOM UI) with its audio. Throws on user
     * cancel (NotAllowedError/AbortError) — the caller treats that as "cancelled",
     * NOT as a reason to silently fall back to a canvas-only recording.
     */
    private async captureTab(): Promise<MediaStream> {
        return await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: this.fps },
            audio: true,
            // Chromium-only hints (ignored elsewhere): offer/preselect the current
            // tab in the picker and keep its audio available.
            preferCurrentTab: true,
            selfBrowserSurface: "include",
            systemAudio: "include",
        } as DisplayMediaStreamOptions);
    }

    /** Canvas capture (game canvas only) with the game's WebAudio mix muxed in. */
    private captureCanvas(): MediaStream {
        const stream = this.canvas.captureStream(this.fps);
        try {
            const audio = CreateJS.Sound.startOutputCapture();
            const track = audio.getAudioTracks()[0];
            if (track) {
                stream.addTrack(track);
                this.capturingGameAudio = true;
            }
        } catch (err) {
            console.warn("Recording without game audio (capture failed):", err);
        }
        return stream;
    }

    /**
     * Begins recording. Anything but "ok" means nothing is being recorded:
     * "cancelled" = the user dismissed the tab picker (not an error, no alert
     * warranted), "unsupported"/"error" = the browser can't record.
     */
    async start(): Promise<RecorderStartResult> {
        if (this.isRecording) return "ok";
        if (typeof MediaRecorder === "undefined") {
            console.error("Replay recording is not supported in this browser.");
            return "unsupported";
        }
        try {
            if (typeof navigator.mediaDevices?.getDisplayMedia === "function") {
                try {
                    this.stream = await this.captureTab();
                } catch (err) {
                    console.info("Tab capture cancelled/unavailable:", err);
                    return "cancelled"; // picker dismissed — don't record anything
                }
            } else if (ReplayRecorder.isSupported()) {
                this.stream = this.captureCanvas();
            } else {
                console.error("Replay recording is not supported in this browser.");
                return "unsupported";
            }

            const hasAudio = this.stream.getAudioTracks().length > 0;
            if (!this.pickMime(hasAudio)) {
                this.cleanup();
                return "unsupported";
            }

            this.chunks = [];
            this.recorder = new MediaRecorder(this.stream, {
                mimeType: this.mime,
                videoBitsPerSecond: 8_000_000,
                audioBitsPerSecond: 128_000,
            });
            this.recorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.chunks.push(e.data);
            };
            this.recorder.onstop = () => this.download();
            // The browser's own "Stop sharing" bar also ends a tab capture — finish
            // the file then instead of recording a frozen stream.
            this.stream.getVideoTracks()[0]?.addEventListener("ended", () => this.stop());
            this.recorder.start(1000); // flush a chunk every second
            return "ok";
        } catch (err) {
            console.error("Failed to start replay recording:", err);
            this.cleanup();
            return "error";
        }
    }

    /** Stops recording; the file download is triggered by the recorder's `onstop`. */
    stop(): void {
        if (this.recorder && this.recorder.state !== "inactive") {
            this.recorder.stop();
        }
    }

    private download(): void {
        try {
            if (this.chunks.length) {
                const blob = new Blob(this.chunks, { type: this.mime });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${this.fileBaseName}.${this.ext}`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            }
        } catch (err) {
            console.error("Failed to save replay recording:", err);
        } finally {
            this.cleanup();
        }
    }

    private cleanup(): void {
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = undefined;
        this.recorder = undefined;
        this.chunks = [];
        if (this.capturingGameAudio) {
            this.capturingGameAudio = false;
            try {
                CreateJS.Sound.stopOutputCapture();
            } catch {
                /* audio graph already torn down */
            }
        }
        this.onStop?.();
    }
}
