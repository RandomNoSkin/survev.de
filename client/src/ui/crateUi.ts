import $ from "jquery";
import {
    CRATE_TYPES,
    CrateDefs,
    type CrateOverride,
    type CrateType,
    crateOverrides,
    getCrateChances,
    getFriesChance,
    getKeyDef,
    getKeyTypes,
    keyOpensCrate,
} from "../../../shared/defs/crateConfig";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import { getItemRarity } from "../../../shared/defs/shopConfig";
import type { Account } from "../account";
import type { AudioManager } from "../audioManager";
import { api } from "../api";
import { helpers } from "../helpers";
import type { Localization } from "./localization";

const RARITY_COLORS = ["#c5c5c5", "#c5c5c5", "#12ff00", "#00deff", "#f600ff", "#d96100"];
const RARITY_NAMES = ["Stock", "Common", "Uncommon", "Rare", "Epic", "Mythic"];
const FRIES_COLOR = "#f2c230";
const FRIES_IMG = "img/gui/golden-fries.svg";

/** Knocks while the crate shakes (ms after the start) - closer together as it builds up. */
const KNOCK_TIMES = [120, 480, 780, 1000, 1180, 1320, 1430, 1520];

/** What the reveal shows: an item, or a Golden Fries payout. */
interface RevealDrop {
    img: string;
    transform?: string;
    color: string;
    label: string;
    name: string;
    sound: string;
}

/** The crate shakes at least this long, even when the server answers sooner. */
const SHAKE_MS = 1600;

const ERRORS: Record<string, string> = {
    no_key: "No usable key - keys listed on the market or up for auction can't be used.",
    wrong_key: "That key can't open this crate.",
    too_fast: "Slow down a little.",
    empty_crate: "This crate is empty right now.",
};

function pct(chance: number): string {
    const p = chance * 100;
    if (p === 0) return "0%";
    if (p < 0.1) return "<0.1%";
    return p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

/**
 * The Crates tab of the loadout menu: key counts, the three crates with their drop
 * chances, and the opening animation (shake → pop with a light in the rarity colour →
 * the item rises out). Keys are plain inventory items, so the counts come straight from
 * the account's items.
 */
export class CrateUi {
    private panel = $("#loadout-crates-panel");
    // moved to <body> so it covers the whole screen (the loadout panel is transformed,
    // which would pin a fixed child to the panel instead of the viewport)
    private overlay = $("#crate-open-overlay").appendTo(document.body);
    /** Crate whose drop list is expanded. */
    private chancesOpen: CrateType | null = null;
    private opening = false;
    visible = false;
    /** Set by main.ts; the crate plays no sounds without it. */
    audioManager: AudioManager | null = null;
    private knockTimers: ReturnType<typeof setTimeout>[] = [];

    /** True while the fullscreen opening animation is showing (read every frame by main.ts). */
    overlayOpen = false;

    constructor(
        private account: Account,
        private localization: Localization,
    ) {
        this.overlay.on("click", ".crate-open-close", () => this.closeOverlay());
        this.overlay.on("click", ".crate-open-again", (e) => {
            const crate = $(e.currentTarget).data("crate") as CrateType;
            const key = $(e.currentTarget).data("key") as string;
            this.open(crate, key);
        });
        this.panel.on("click", ".crate-open-btn", (e) => {
            const btn = $(e.currentTarget);
            this.open(btn.data("crate") as CrateType, btn.data("key") as string);
        });
        this.panel.on("click", ".crate-chances-toggle", (e) => {
            const crate = $(e.currentTarget).data("crate") as CrateType;
            this.chancesOpen = this.chancesOpen === crate ? null : crate;
            this.render();
        });
        account.addEventListener("items", () => {
            if (this.visible && !this.opening) this.render();
        });
    }

    show() {
        this.visible = true;
        this.panel.css("display", "flex");
        this.render();
        // pools / weights can be edited live in the moderation dashboard
        $.ajax(api.resolveUrl("/api/crate_config")).done((data: { overrides?: Record<string, CrateOverride> }) => {
            if (!data?.overrides) return;
            crateOverrides.set(data.overrides);
            if (this.visible && !this.opening) this.render();
        });
    }

    hide() {
        this.visible = false;
        this.panel.css("display", "none");
    }

    private keyCounts(): Map<string, number> {
        const counts = new Map<string, number>();
        for (const t of getKeyTypes()) counts.set(t, 0);
        for (const it of this.account.items ?? []) {
            if (counts.has(it.type)) counts.set(it.type, counts.get(it.type)! + 1);
        }
        return counts;
    }

    private itemName(type: string): string {
        const def = GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined;
        return this.localization.translate(`game-${type}`) || def?.name || type;
    }

    private render() {
        const counts = this.keyCounts();
        this.panel.empty();

        const keys = $("<div/>", { class: "crate-keys" });
        for (const [type, n] of counts) {
            keys.append(
                $("<div/>", { class: `crate-key${n ? "" : " crate-key-none"}`, title: getKeyDef(type)?.lore }).append(
                    $("<div/>", {
                        class: "crate-key-icon",
                        css: { "background-image": `url(${helpers.getSvgFromGameType(type)})` },
                    }),
                    $("<div/>", { class: "crate-key-name", text: this.itemName(type) }),
                    $("<div/>", { class: "crate-key-count", text: `×${n}` }),
                ),
            );
        }
        this.panel.append(keys);

        const row = $("<div/>", { class: "crate-row" });
        for (const crate of CRATE_TYPES) row.append(this.renderCrate(crate, counts));
        this.panel.append(row);

        if (this.chancesOpen) this.panel.append(this.renderChances(this.chancesOpen));
        this.panel.append(
            $("<div/>", {
                class: "crate-hint",
                text: "A key opens its own crate and every weaker one. Keys can be traded on the market.",
            }),
        );
    }

    private renderCrate(crate: CrateType, counts: Map<string, number>) {
        const def = CrateDefs[crate];
        const usable = getKeyTypes().filter((k) => keyOpensCrate(k, crate));
        const card = $("<div/>", { class: `crate-card crate-card-${crate}` });
        card.append(
            $("<div/>", { class: "crate-card-img", css: { "background-image": `url(${def.img})` } }),
            $("<div/>", { class: "crate-card-name", text: def.name }),
        );
        const buttons = $("<div/>", { class: "crate-card-buttons" });
        let any = false;
        for (const k of usable) {
            const n = counts.get(k) ?? 0;
            if (!n) continue;
            any = true;
            buttons.append(
                $("<div/>", {
                    class: "crate-open-btn btn-darken",
                    "data-crate": crate,
                    "data-key": k,
                    title: `Use a ${this.itemName(k)} (${n} left)`,
                }).append(
                    $("<span/>", {
                        class: "crate-open-btn-key",
                        css: { "background-image": `url(${helpers.getSvgFromGameType(k)})` },
                    }),
                    $("<span/>", { text: "Open" }),
                ),
            );
        }
        if (!any) {
            const weakest = usable[0];
            buttons.append(
                $("<div/>", {
                    class: "crate-need-key",
                    text: weakest ? `Needs a ${this.itemName(weakest)}` : "No key",
                }),
            );
        }
        card.append(buttons);
        card.append(
            $("<div/>", {
                class: `crate-chances-toggle${this.chancesOpen === crate ? " crate-chances-toggle-on" : ""}`,
                "data-crate": crate,
                text: this.chancesOpen === crate ? "Hide drop chances ▲" : "Drop chances ▼",
            }),
        );
        return card;
    }

    private renderChances(crate: CrateType) {
        const box = $("<div/>", { class: "crate-chances" });
        box.append($("<div/>", { class: "crate-chances-title", text: `${CrateDefs[crate].name} - drop chances` }));
        const fries = getFriesChance(crate);
        if (fries) {
            box.append(
                $("<div/>", { class: "crate-chance-group" }).append(
                    $("<div/>", { class: "crate-chance-head", css: { color: FRIES_COLOR } }).append(
                        $("<span/>", { class: "crate-chance-fries" }).append(
                            $("<span/>", { class: "crate-chance-fries-icon", css: { "background-image": `url(${FRIES_IMG})` } }),
                            $("<span/>", { text: `Golden Fries · ${fries.min}–${fries.max}` }),
                        ),
                        $("<span/>", { class: "crate-chance-pct", text: pct(fries.chance) }),
                    ),
                ),
            );
        }
        for (const c of getCrateChances(crate)) {
            const color = RARITY_COLORS[c.rarity] ?? "#c5c5c5";
            const group = $("<div/>", { class: "crate-chance-group" });
            group.append(
                $("<div/>", { class: "crate-chance-head", css: { color } }).append(
                    $("<span/>", { text: RARITY_NAMES[c.rarity] ?? "" }),
                    $("<span/>", { class: "crate-chance-pct", text: pct(c.chance) }),
                ),
            );
            const grid = $("<div/>", { class: "crate-chance-items" });
            const each = c.chance / c.items.length;
            for (const type of c.items) {
                grid.append(
                    $("<div/>", {
                        class: "crate-chance-item",
                        title: `${this.itemName(type)} - ${pct(each)}`,
                        css: {
                            "background-image": `url(${helpers.getSvgFromGameType(type)})`,
                            "border-color": color,
                        },
                    }),
                );
            }
            group.append(grid);
            box.append(group);
        }
        return box;
    }

    private open(crate: CrateType, key: string) {
        if (this.opening || !CrateDefs[crate]) return;
        this.opening = true;
        const def = CrateDefs[crate];
        const keysBefore = this.keyCounts().get(key) ?? 0;
        this.overlay
            .html("")
            // per-crate backdrop (wood / soviet / airdrop), see app.css
            .attr("class", `crate-open-bg-${crate}`)
            .css("--crate-color", "")
            .append(
                $("<div/>", { class: "crate-open-stage" }).append(
                    $("<div/>", { class: "crate-open-floor" }),
                    $("<div/>", { class: "crate-open-beam" }),
                    $("<div/>", { class: "crate-open-flash" }),
                    $("<div/>", {
                        class: "crate-open-crate crate-shaking",
                        css: { "background-image": `url(${def.img})` },
                    }),
                    $("<div/>", { class: "crate-open-item" }),
                ),
                $("<div/>", { class: "crate-open-info" }),
            )
            .css("display", "flex");
        this.overlayOpen = true;

        // wooden / soviet crates knock like wood, the airdrop like metal
        const material = crate === "airdrop" ? "metal" : "wood";
        this.knockTimers = KNOCK_TIMES.map((t) =>
            setTimeout(() => this.sfx(`${material}_bullet_hit_0${1 + Math.floor(Math.random() * 4)}`, "hits"), t),
        );

        const started = Date.now();
        this.account.openCrate(crate, key, (err, res) => {
            const wait = Math.max(0, SHAKE_MS - (Date.now() - started));
            setTimeout(() => {
                this.stopKnocks();
                if (err || !res?.success || (!res.item && !res.fries)) {
                    this.opening = false;
                    this.overlay.find(".crate-open-crate").removeClass("crate-shaking");
                    this.overlay.find(".crate-open-info").append(
                        $("<div/>", {
                            class: "crate-open-error",
                            text: ERRORS[res?.error ?? ""] ?? "Something went wrong, try again.",
                        }),
                        $("<div/>", { class: "crate-open-close btn-darken", text: "Close" }),
                    );
                    this.account.loadProfile();
                    return;
                }
                let drop: RevealDrop;
                if (res.item) {
                    const rarity = getItemRarity(res.item.type);
                    drop = {
                        img: helpers.getSvgFromGameType(res.item.type),
                        transform: helpers.getCssTransformFromGameType(res.item.type),
                        color: RARITY_COLORS[rarity] ?? "#c5c5c5",
                        label: RARITY_NAMES[rarity] ?? "",
                        name: this.itemName(res.item.type),
                        sound: "perk_pickup_01",
                    };
                } else {
                    drop = {
                        img: FRIES_IMG,
                        color: FRIES_COLOR,
                        label: "Golden Fries",
                        name: `+${res.fries!.toLocaleString("en-US")} 🍟`,
                        sound: "loot_drop_01",
                    };
                }
                this.reveal(crate, key, drop, keysBefore - 1);
            }, wait);
        });
    }

    private reveal(crate: CrateType, key: string, drop: RevealDrop, left: number) {
        const def = CrateDefs[crate];
        const color = drop.color;
        const stage = this.overlay.find(".crate-open-stage");
        stage.css("--crate-color", color);
        // the backdrop picks up a glow in the rarity colour too
        this.overlay.css("--crate-color", color).addClass("crate-open-lit");
        const crateEl = stage.find(".crate-open-crate").removeClass("crate-shaking");
        if (def.openImg) crateEl.css("background-image", `url(${def.openImg})`);
        crateEl.addClass("crate-popped");
        this.sfx(crate === "airdrop" ? "airdrop_open_01" : Math.random() < 0.5 ? "crate_break_01" : "crate_break_02", "sfx");
        // the drop's own sound as it rises out of the crate
        setTimeout(() => this.sfx(drop.sound, "ui"), 250);
        stage.addClass("crate-open-revealed");
        stage.find(".crate-open-item").css({
            "background-image": `url(${drop.img})`,
            transform: drop.transform ?? "",
        });

        // the reveal is done - now the new item (and the used-up key) may show in the menu
        this.account.loadProfile();

        setTimeout(() => {
            this.opening = false;
            const info = this.overlay.find(".crate-open-info");
            info.append(
                $("<div/>", { class: "crate-open-rarity", text: drop.label, css: { color } }),
                $("<div/>", { class: "crate-open-name", text: drop.name }),
            );
            const btns = $("<div/>", { class: "crate-open-buttons" });
            if (left > 0) {
                btns.append(
                    $("<div/>", {
                        class: "crate-open-again btn-darken",
                        "data-crate": crate,
                        "data-key": key,
                        text: `Open another (${left} left)`,
                    }),
                );
            }
            btns.append($("<div/>", { class: "crate-open-close btn-darken", text: "Close" }));
            info.append(btns);
        }, 700);
    }

    /** Plays a game sound; `channel` must be the one the sound is defined in (soundDefs),
     *  the sound id is name + channel. */
    private sfx(name: string, channel: "hits" | "sfx" | "ui") {
        this.audioManager?.playSound(name, { channel });
    }

    private stopKnocks() {
        for (const t of this.knockTimers) clearTimeout(t);
        this.knockTimers = [];
    }

    private closeOverlay() {
        if (this.opening) return;
        this.overlay.css("display", "none").html("");
        this.overlayOpen = false;
        if (this.visible) this.render();
    }
}
