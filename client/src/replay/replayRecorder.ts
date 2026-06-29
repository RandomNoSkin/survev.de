/**
 * Records the replay's game canvas to a downloadable video file using the browser's
 * MediaRecorder API. Captures only the WebGL canvas (game world + PIXI HUD) — DOM
 * overlays (killfeed/menus) and the replay control bar are not part of the canvas and
 * therefore do not appear in the recording. Runs entirely in the admin's browser, so
 * it never touches the (small) game server.
 *
 * Container/codec: prefers MP4 (avc1) where the browser supports it (recent Chrome,
 * Safari), otherwise falls back to WebM. The output file extension follows whichever
 * type was actually used.
 */

const MIME_CANDIDATES: Array<{ mime: string; ext: string }> = [
    { mime: "video/mp4;codecs=avc1", ext: "mp4" },
    { mime: "video/webm;codecs=vp9", ext: "webm" },
    { mime: "video/webm;codecs=vp8", ext: "webm" },
    { mime: "video/webm", ext: "webm" },
];

export class ReplayRecorder {
    private recorder?: MediaRecorder;
    private stream?: MediaStream;
    private chunks: Blob[] = [];
    private mime = "";
    private ext = "webm";

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
    private pickMime(): boolean {
        for (const c of MIME_CANDIDATES) {
            if (MediaRecorder.isTypeSupported(c.mime)) {
                this.mime = c.mime;
                this.ext = c.ext;
                return true;
            }
        }
        return false;
    }

    /** Begins recording. Returns false (recording nothing) if unsupported or on error. */
    start(): boolean {
        if (this.isRecording) return true;
        if (!ReplayRecorder.isSupported() || !this.pickMime()) {
            console.error("Replay recording is not supported in this browser.");
            return false;
        }
        try {
            this.stream = this.canvas.captureStream(this.fps);
            this.chunks = [];
            this.recorder = new MediaRecorder(this.stream, {
                mimeType: this.mime,
                videoBitsPerSecond: 8_000_000,
            });
            this.recorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.chunks.push(e.data);
            };
            this.recorder.onstop = () => this.download();
            this.recorder.start(1000); // flush a chunk every second
            return true;
        } catch (err) {
            console.error("Failed to start replay recording:", err);
            this.cleanup();
            return false;
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
    }
}
