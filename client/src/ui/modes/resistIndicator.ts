import $ from "jquery";

/**
 * Arena modes: the damage resistance running on the player (soda, pill, Takedown, a
 * revive - ArenaResistMsg), in place of the adrenaline bar while it runs (that one is
 * always full in the arena): "−30% damage", a bar that runs down, the seconds left.
 */
export class ResistIndicator {
    private el = $("<div/>", { id: "ui-arena-resist" }).hide();
    private pct = $("<span/>", { class: "arena-resist-pct" });
    private time = $("<span/>", { class: "arena-resist-time" });
    private bar = $("<i/>");
    private until = 0;
    private total = 1;
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor() {
        this.el.append(
            $("<span/>", { class: "arena-resist-icon", "aria-hidden": "true" }),
            this.pct,
            $("<div/>", { class: "arena-resist-bar" }).append(this.bar),
            this.time,
        );
        this.el.attr("title", "Less damage taken");
    }

    /** A new state from the server (reduction 0: none). */
    set(reduction: number, seconds: number) {
        if (!this.el.parent().length) {
            const host = $("#hud-wrap-boostBar");
            (host.length ? host : $(document.body)).append(this.el);
        }
        if (reduction <= 0 || seconds <= 0) {
            this.stop();
            return;
        }
        this.pct.text(`−${Math.round(reduction * 100)}% damage`);
        this.until = performance.now() + seconds * 1000;
        this.total = seconds;
        this.el.show();
        this.el.parent().addClass("arena-resist-on");
        this.tick();
        if (!this.timer) this.timer = setInterval(() => this.tick(), 100);
    }

    private tick() {
        const left = (this.until - performance.now()) / 1000;
        if (left <= 0) {
            this.stop();
            return;
        }
        this.time.text(`${Math.ceil(left)}s`);
        this.bar.css("width", `${Math.max(0, Math.min(100, (left / this.total) * 100))}%`);
    }

    private stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.el.hide();
        this.el.parent().removeClass("arena-resist-on");
    }

    destroy() {
        this.stop();
        this.el.parent().removeClass("arena-resist-on");
        this.el.remove();
    }
}
