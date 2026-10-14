import $ from "jquery";
import {
    CUSTOM_LOADOUT_AMMOS,
    CUSTOM_LOADOUT_BACKPACKS,
    CUSTOM_LOADOUT_CHESTS,
    CUSTOM_LOADOUT_GRENADES,
    CUSTOM_LOADOUT_GUNS,
    CUSTOM_LOADOUT_HEALS,
    CUSTOM_LOADOUT_HELMETS,
    CUSTOM_LOADOUT_MELEES,
    CUSTOM_LOADOUT_NAME_MAX_LEN,
    CUSTOM_LOADOUT_PERKS,
    CUSTOM_LOADOUT_SCOPES,
    type CustomLoadoutConfig,
    DEFAULT_CUSTOM_LOADOUT,
} from "../../../shared/defs/customLoadout";
import { type GunDef, GunDefs } from "../../../shared/defs/gameObjects/gunDefs";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import { skinLabel, weaponSkinBase, weaponVariantLabel } from "../../../shared/defs/weaponStats";
import { GameConfig, type InventoryItem } from "../../../shared/gameConfig";
import { helpers } from "../helpers";
import type { Localization } from "./localization";

type Section = "weapons" | "armor" | "scopes" | "ammo" | "throwables" | "heals" | "perks";
type WeaponSlot = 0 | 1 | 2;
type GunCategory = "all" | "rifle" | "smg" | "shotgun" | "sniper" | "pistol" | "special";

const SECTIONS: { id: Section; label: string }[] = [
    { id: "weapons", label: "Weapons" },
    { id: "armor", label: "Armor" },
    { id: "scopes", label: "Scopes" },
    { id: "ammo", label: "Ammo" },
    { id: "throwables", label: "Throwables" },
    { id: "heals", label: "Healing" },
    { id: "perks", label: "Perks" },
];

const GUN_CATEGORIES: { id: GunCategory; label: string }[] = [
    { id: "all", label: "All" },
    { id: "rifle", label: "Rifles" },
    { id: "smg", label: "SMGs" },
    { id: "shotgun", label: "Shotguns" },
    { id: "sniper", label: "Snipers & DMRs" },
    { id: "pistol", label: "Pistols" },
    { id: "special", label: "Special" },
];

const SLOT_LABELS = ["Primary", "Secondary", "Melee"];

/** Buckets guns the way players think about them; gun defs only carry ammo/fire mode. */
function gunCategory(type: string): GunCategory {
    const def = GunDefs[type] as GunDef & { pistol?: boolean; isLauncher?: boolean };
    const ammo = def.ammo as string;
    if (def.isLauncher || ["flare", "potato_ammo", "bugle_ammo"].includes(ammo)) return "special";
    if (def.pistol) return "pistol";
    if (ammo === "12gauge") return "shotgun";
    if (ammo === "9mm" || ammo === "45acp") {
        return def.fireMode === "single" && ammo === "45acp" ? "sniper" : "smg";
    }
    return def.fireMode === "single" ? "sniper" : "rifle";
}

function levelOf(type: string) {
    return Number.parseInt((type || "x0").slice(-1), 10) || 0;
}

export interface LoadoutEditorHost {
    localization: Localization;
    /** Fresh lookup every time: lobby state messages replace the room data object. */
    getLoadout(index: number): CustomLoadoutConfig | undefined;
    getLabel(index: number): string;
    getDefaultLabel(index: number): string;
    canEdit(): boolean;
    /** Persist + broadcast after a mutation. */
    onChange(): void;
}

/** Full-screen editor for one private-lobby custom loadout, replacing the long inline
 *  dropdown builder with picture tiles grouped by category. */
export class LoadoutEditorModal {
    private root: JQuery<HTMLElement>;
    private index: number | null = null;
    private section: Section = "weapons";
    private weaponSlot: WeaponSlot = 0;
    private gunCategory: GunCategory = "all";
    private search = "";
    /** Unselected perks whose description the user opened. */
    private expandedPerks = new Set<string>();
    /** Clear button is armed (waiting for the confirming click) until this time. */
    private clearArmedUntil = 0;

    constructor(private host: LoadoutEditorHost) {
        this.root = $("<div/>", { id: "loadout-editor", class: "loadout-editor-overlay" });
        this.root.on("mousedown", (e) => {
            if (e.target === this.root[0]) this.close();
        });
        $(document).on("keydown.loadoutEditor", (e) => {
            if (this.isOpen && e.key === "Escape") this.close();
        });
        $("body").append(this.root);
    }

    get isOpen() {
        return this.index !== null;
    }

    open(index: number, section: Section = "weapons") {
        this.index = index;
        this.section = section;
        this.weaponSlot = 0;
        this.clearArmedUntil = 0;
        this.gunCategory = "all";
        this.search = "";
        this.root.css("display", "flex");
        this.render();
    }

    close() {
        this.index = null;
        this.root.css("display", "none").empty();
    }

    /** Re-render after outside state changes, keeping scroll and search focus. */
    refresh() {
        if (!this.isOpen) return;
        if (!this.loadout) {
            this.close();
            return;
        }
        this.render();
    }

    private get loadout() {
        return this.index === null ? undefined : this.host.getLoadout(this.index);
    }

    private get editable() {
        return this.host.canEdit();
    }

    private label(type: string) {
        if (!type) return "None";
        const def = GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined;
        const name = this.host.localization.translate(`game-${type}`) || def?.name || type;
        // weapons sharing a name (winter skins, [+] grenade modes...) get told apart
        const skinOf = weaponSkinBase(type);
        const extra = skinOf ? skinLabel(type, skinOf) : weaponVariantLabel(type);
        return extra ? `${name} (${extra})` : name;
    }

    private img(type: string) {
        const src = type ? helpers.getSvgFromGameType(type) : "";
        return src
            ? `<div class="loadout-editor-img" style="background-image:url('${src}')"></div>`
            : '<div class="loadout-editor-img loadout-editor-img-none">&#8709;</div>';
    }

    private maxOf(item: string) {
        const loadout = this.loadout!;
        const sizes = GameConfig.bagSizes[item as InventoryItem];
        return sizes ? sizes[levelOf(loadout.backpack)] : 0;
    }

    private mutate(fn: (loadout: CustomLoadoutConfig) => void) {
        const loadout = this.loadout;
        if (!loadout || !this.editable) return;
        fn(loadout);
        this.host.onChange();
        this.render();
    }

    // ---- rendering ----

    private render() {
        const loadout = this.loadout;
        if (!loadout || this.index === null) return;

        const scrollTop = this.root.find(".loadout-editor-content").scrollTop() ?? 0;
        const searchFocused = document.activeElement?.classList.contains("loadout-editor-search");

        const modal = $("<div/>", { class: "loadout-editor" });
        modal.append(this.renderHeader());
        modal.append(this.renderSlotBar(loadout));
        const body = $("<div/>", { class: "loadout-editor-body" });
        body.append(this.renderNav());
        const content = $("<div/>", { class: "loadout-editor-content" });
        content.append(this.renderSection(loadout));
        body.append(content);
        modal.append(body);

        const footer = $("<div/>", { class: "loadout-editor-footer" });
        if (!this.editable) {
            footer.append($("<span/>", {
                class: "loadout-editor-readonly",
                text: "Only the lobby leader can change loadouts.",
            }));
        } else {
            footer.append(this.renderClearButton());
        }
        const done = $("<a/>", { class: "btn-green btn-darken menu-option loadout-editor-done", text: "Done" });
        done.on("click", () => this.close());
        footer.append(done);
        modal.append(footer);

        this.root.empty().append(modal);
        this.root.find(".loadout-editor-content").scrollTop(scrollTop);
        if (searchFocused) {
            const input = this.root.find<HTMLInputElement>(".loadout-editor-search")[0];
            input?.focus();
            input?.setSelectionRange(input.value.length, input.value.length);
        }
    }

    /** Two-step so a stray click can't wipe a loadout: arm, then confirm within 3s. */
    private renderClearButton() {
        const armed = this.clearArmedUntil > Date.now();
        const btn = $("<a/>", {
            class: `loadout-editor-clear${armed ? " armed" : ""}`,
            text: armed ? "Click again to clear" : "Clear loadout",
        });
        btn.on("click", () => {
            if (this.clearArmedUntil > Date.now()) {
                this.clearArmedUntil = 0;
                // items only - the name and the lobby-wide switches (Arena Mode etc.,
                // stored on the first loadout) stay as they are
                this.mutate((l) => {
                    l.weapons = [...DEFAULT_CUSTOM_LOADOUT.weapons];
                    l.helmet = DEFAULT_CUSTOM_LOADOUT.helmet;
                    l.chest = DEFAULT_CUSTOM_LOADOUT.chest;
                    l.backpack = DEFAULT_CUSTOM_LOADOUT.backpack;
                    l.scope = DEFAULT_CUSTOM_LOADOUT.scope;
                    l.perks = [];
                    l.inventory = {};
                });
                return;
            }
            this.clearArmedUntil = Date.now() + 3000;
            this.render();
            setTimeout(() => {
                if (this.isOpen && this.clearArmedUntil && this.clearArmedUntil <= Date.now()) {
                    this.clearArmedUntil = 0;
                    this.render();
                }
            }, 3100);
        });
        return btn;
    }

    private renderHeader() {
        const header = $("<div/>", { class: "loadout-editor-header" });
        const loadout = this.loadout!;
        if (this.editable) {
            const name = $<HTMLInputElement>("<input/>", {
                class: "loadout-editor-name",
                type: "text",
                maxLength: CUSTOM_LOADOUT_NAME_MAX_LEN,
                placeholder: this.host.getDefaultLabel(this.index!),
            });
            name.val(loadout.name ?? "");
            name.on("change", () => {
                const value = (name.val() as string).trim().slice(0, CUSTOM_LOADOUT_NAME_MAX_LEN);
                this.mutate((l) => {
                    l.name = value || undefined;
                });
            });
            name.on("keydown", (e) => {
                if (e.key === "Enter") name.trigger("blur");
                e.stopPropagation();
            });
            header.append(name);
        } else {
            header.append($("<div/>", {
                class: "loadout-editor-title",
                text: this.host.getLabel(this.index!),
            }));
        }
        const close = $("<a/>", { class: "loadout-editor-close", html: "&times;" });
        close.on("click", () => this.close());
        header.append(close);
        return header;
    }

    /** In-game style overview; clicking a slot jumps to where it's edited. */
    private renderSlotBar(loadout: CustomLoadoutConfig) {
        const bar = $("<div/>", { class: "loadout-editor-slots" });
        const slot = (type: string, caption: string, onClick: () => void, active: boolean) => {
            const el = $("<div/>", {
                class: `loadout-editor-slot${active ? " active" : ""}${type ? "" : " empty"}`,
                title: `${caption}: ${this.label(type)}`,
                html: `${this.img(type)}<div class="loadout-editor-slot-caption">${helpers.htmlEscape(caption)}</div>`,
            });
            el.on("click", onClick);
            return el;
        };
        const group = (...els: JQuery[]) => $("<div/>", { class: "loadout-editor-slot-group" }).append(...els);

        bar.append(group(
            ...([0, 1, 2] as WeaponSlot[]).map((i) =>
                slot(loadout.weapons[i], SLOT_LABELS[i], () => {
                    this.section = "weapons";
                    this.weaponSlot = i;
                    this.search = "";
                    this.render();
                }, this.section === "weapons" && this.weaponSlot === i)),
        ));
        const toArmor = () => {
            this.section = "armor";
            this.render();
        };
        bar.append(group(
            slot(loadout.helmet, "Helmet", toArmor, this.section === "armor"),
            slot(loadout.chest, "Vest", toArmor, this.section === "armor"),
            slot(loadout.backpack || "backpack00", "Backpack", toArmor, this.section === "armor"),
        ));
        bar.append(group(slot(loadout.scope || "1xscope", "Scope", () => {
            this.section = "scopes";
            this.render();
        }, this.section === "scopes")));
        // perks are unlimited: show the first few, then a "+N" overflow slot
        const toPerks = () => {
            this.section = "perks";
            this.search = "";
            this.render();
        };
        const perksActive = this.section === "perks";
        const shownPerks = loadout.perks.slice(0, 3);
        const perkSlots = shownPerks.length
            ? shownPerks.map((p) => slot(p, this.label(p), toPerks, perksActive))
            : [slot("", "Perks", toPerks, perksActive)];
        const hidden = loadout.perks.length - shownPerks.length;
        if (hidden > 0) {
            const more = $("<div/>", {
                class: `loadout-editor-slot loadout-editor-slot-more${perksActive ? " active" : ""}`,
                title: loadout.perks.slice(3).map((p) => this.label(p)).join(", "),
                html: `<div class="loadout-editor-slot-more-count">+${hidden}</div><div class="loadout-editor-slot-caption">more</div>`,
            });
            more.on("click", toPerks);
            perkSlots.push(more);
        }
        bar.append(group(...perkSlots));
        return bar;
    }

    private renderNav() {
        const nav = $("<div/>", { class: "loadout-editor-nav" });
        for (const s of SECTIONS) {
            const item = $("<a/>", {
                class: `loadout-editor-nav-item${s.id === this.section ? " active" : ""}`,
                text: s.label,
            });
            item.on("click", () => {
                this.section = s.id;
                this.search = "";
                this.render();
            });
            nav.append(item);
        }
        return nav;
    }

    private renderSection(loadout: CustomLoadoutConfig) {
        switch (this.section) {
            case "weapons":
                return this.renderWeapons(loadout);
            case "armor":
                return this.renderArmor(loadout);
            case "scopes":
                return this.renderScopes(loadout);
            case "ammo":
                return this.renderCounts(loadout, [...CUSTOM_LOADOUT_AMMOS],
                    "Weapons already come with their own ammo; add more of any type here.");
            case "throwables":
                return this.renderCounts(loadout, [...CUSTOM_LOADOUT_GRENADES]);
            case "heals":
                return this.renderCounts(loadout, [...CUSTOM_LOADOUT_HEALS]);
            case "perks":
                return this.renderPerks(loadout);
        }
    }

    private tile(type: string, selected: boolean, onClick: (() => void) | null, extra = "") {
        const el = $("<div/>", {
            class: `loadout-editor-tile${selected ? " selected" : ""}${onClick && this.editable ? "" : " readonly"}`,
            title: this.label(type),
            html: `${this.img(type)}<div class="loadout-editor-tile-name">${helpers.htmlEscape(this.label(type))}</div>${extra}`,
        });
        if (onClick && this.editable) el.on("click", onClick);
        return el;
    }

    private renderWeapons(loadout: CustomLoadoutConfig) {
        const wrap = $("<div/>");
        const slotTabs = $("<div/>", { class: "loadout-editor-chips" });
        for (const i of [0, 1, 2] as WeaponSlot[]) {
            const chip = $("<a/>", {
                class: `loadout-editor-chip${i === this.weaponSlot ? " active" : ""}`,
                text: SLOT_LABELS[i],
            });
            chip.on("click", () => {
                this.weaponSlot = i;
                this.search = "";
                this.render();
            });
            slotTabs.append(chip);
        }
        wrap.append(slotTabs);

        const isMelee = this.weaponSlot === 2;
        const tools = $("<div/>", { class: "loadout-editor-tools" });
        if (!isMelee) {
            const cats = $("<div/>", { class: "loadout-editor-chips small" });
            for (const c of GUN_CATEGORIES) {
                const chip = $("<a/>", {
                    class: `loadout-editor-chip${c.id === this.gunCategory ? " active" : ""}`,
                    text: c.label,
                });
                chip.on("click", () => {
                    this.gunCategory = c.id;
                    this.render();
                });
                cats.append(chip);
            }
            tools.append(cats);
        }
        const search = $<HTMLInputElement>("<input/>", {
            class: "loadout-editor-search",
            type: "text",
            placeholder: isMelee ? "Search melee..." : "Search guns...",
        });
        search.val(this.search);
        search.on("keydown", (e) => e.stopPropagation());
        tools.append(search);
        wrap.append(tools);

        const grid = $("<div/>", { class: "loadout-editor-grid" });
        const fillGrid = () => {
            grid.empty();
            const q = this.search.trim().toLowerCase();
            // a search looks through every gun, not just the selected category
            const pool = isMelee
                ? CUSTOM_LOADOUT_MELEES
                : CUSTOM_LOADOUT_GUNS.filter(
                      (g) => q || this.gunCategory === "all" || gunCategory(g) === this.gunCategory,
                  );
            const current = loadout.weapons[this.weaponSlot];
            const sorted = [...pool].sort((a, b) => this.label(a).localeCompare(this.label(b)));
            const items = ["", ...sorted].filter(
                (t) => !q || (t && (this.label(t).toLowerCase().includes(q) || t.includes(q))),
            );
            for (const type of items) {
                grid.append(this.tile(type, type === current, () => this.setWeapon(type)));
            }
            if (!items.length) grid.append($("<div/>", { class: "loadout-editor-empty", text: "Nothing matches." }));
        };
        // only the grid re-renders while typing, so the input keeps focus
        search.on("input", () => {
            this.search = search.val() as string;
            fillGrid();
        });
        fillGrid();
        wrap.append(grid);
        return wrap;
    }

    private setWeapon(type: string) {
        const slot = this.weaponSlot;
        this.mutate((l) => {
            l.weapons[slot] = type;
            // a gun comes with its own ammo, topped up to its spawn amount
            const gunDef = slot < 2 && type ? (GunDefs[type] as GunDef | undefined) : undefined;
            if (gunDef) {
                const ammo = gunDef.ammo as InventoryItem;
                const sizes = GameConfig.bagSizes[ammo];
                if (sizes) {
                    const max = sizes[levelOf(l.backpack)];
                    l.inventory[ammo] = Math.max(l.inventory[ammo] ?? 0, Math.min(gunDef.ammoSpawnCount, max));
                }
            }
        });
    }

    private renderArmor(loadout: CustomLoadoutConfig) {
        const wrap = $("<div/>");
        const row = (title: string, types: string[], current: string, set: (l: CustomLoadoutConfig, v: string) => void) => {
            wrap.append($("<div/>", { class: "loadout-editor-subtitle", text: title }));
            const grid = $("<div/>", { class: "loadout-editor-grid compact" });
            for (const type of types) {
                grid.append(this.tile(type, type === current, () => this.mutate((l) => set(l, type))));
            }
            wrap.append(grid);
        };
        row("Helmet", CUSTOM_LOADOUT_HELMETS, loadout.helmet, (l, v) => (l.helmet = v));
        row("Vest", CUSTOM_LOADOUT_CHESTS, loadout.chest, (l, v) => (l.chest = v));
        row("Backpack", CUSTOM_LOADOUT_BACKPACKS, loadout.backpack || "backpack00", (l, v) => {
            l.backpack = v;
            // a smaller bag can't hold what the bigger one did
            for (const [item, amount] of Object.entries(l.inventory)) {
                const sizes = GameConfig.bagSizes[item as InventoryItem];
                if (sizes && amount !== undefined) {
                    l.inventory[item as InventoryItem] = Math.min(amount, sizes[levelOf(v)]);
                }
            }
        });
        wrap.append($("<div/>", {
            class: "loadout-editor-hint",
            text: "The backpack decides how much ammo, throwables and healing fit.",
        }));
        return wrap;
    }

    private renderScopes(loadout: CustomLoadoutConfig) {
        const wrap = $("<div/>");
        wrap.append($("<div/>", {
            class: "loadout-editor-hint",
            text: "Click to carry a scope; the star marks the one that's active on spawn. 1x is always carried.",
        }));
        const grid = $("<div/>", { class: "loadout-editor-grid compact" });
        const active = loadout.scope || "1xscope";
        for (const scope of CUSTOM_LOADOUT_SCOPES) {
            const carried = scope === "1xscope" || !!loadout.inventory[scope];
            const star = carried
                ? `<div class="loadout-editor-star${scope === active ? " on" : ""}" title="Active on spawn">&#9733;</div>`
                : "";
            const tile = this.tile(scope, carried, () =>
                this.mutate((l) => {
                    if (scope === "1xscope") return;
                    if (l.inventory[scope]) {
                        delete l.inventory[scope];
                        if (l.scope === scope) l.scope = "1xscope";
                    } else {
                        l.inventory[scope] = 1;
                    }
                }),
                star,
            );
            tile.find(".loadout-editor-star").on("click", (e) => {
                e.stopPropagation();
                this.mutate((l) => {
                    l.scope = scope;
                });
            });
            grid.append(tile);
        }
        wrap.append(grid);
        return wrap;
    }

    private renderCounts(loadout: CustomLoadoutConfig, items: string[], hint?: string) {
        const wrap = $("<div/>");
        if (hint) wrap.append($("<div/>", { class: "loadout-editor-hint", text: hint }));
        const grid = $("<div/>", { class: "loadout-editor-grid counts" });
        for (const item of items) {
            const max = this.maxOf(item);
            const count = loadout.inventory[item as InventoryItem] ?? 0;
            const set = (n: number) =>
                this.mutate((l) => {
                    const v = Math.max(0, Math.min(max, Math.round(n)));
                    if (v > 0) l.inventory[item as InventoryItem] = v;
                    else delete l.inventory[item as InventoryItem];
                });
            const tile = this.tile(item, count > 0, null);
            const stepper = $("<div/>", { class: "loadout-editor-stepper" });
            const minus = $("<a/>", { class: "loadout-editor-step", text: "−" });
            const value = $<HTMLInputElement>("<input/>", {
                class: "loadout-editor-count",
                type: "number",
                min: 0,
                max,
            });
            value.val(count);
            const plus = $("<a/>", { class: "loadout-editor-step", text: "+" });
            const maxBtn = $("<a/>", { class: "loadout-editor-max", text: "Max" });
            if (this.editable) {
                // grenades/heals step by 1, ammo by roughly a magazine
                const step = max >= 60 ? 10 : 1;
                minus.on("click", () => set(count - step));
                plus.on("click", () => set(count + step));
                maxBtn.on("click", () => set(count === max ? 0 : max));
                value.on("change", () => set(Number(value.val()) || 0));
                value.on("keydown", (e) => e.stopPropagation());
            } else {
                value.prop("disabled", true);
            }
            stepper.append(minus, value, plus);
            tile.append(stepper);
            tile.append($("<div/>", { class: "loadout-editor-max-row" }).append(
                $("<span/>", { text: `max ${max}` }),
                this.editable ? maxBtn : $(),
            ));
            grid.append(tile);
        }
        wrap.append(grid);
        return wrap;
    }

    private perkDesc(perk: string) {
        return this.host.localization.translate(`game-${perk}-desc`);
    }

    private renderPerks(loadout: CustomLoadoutConfig) {
        const wrap = $("<div/>");
        const tools = $("<div/>", { class: "loadout-editor-tools" });
        const count = loadout.perks.length;
        tools.append($("<div/>", {
            class: "loadout-editor-hint",
            text: count ? `${count} perk${count === 1 ? "" : "s"} chosen` : "No perks chosen",
        }));
        if (count && this.editable) {
            const clear = $("<a/>", { class: "loadout-editor-chip", text: "Clear all" });
            clear.on("click", () => this.mutate((l) => {
                l.perks = [];
            }));
            tools.append(clear);
        }
        const search = $<HTMLInputElement>("<input/>", {
            class: "loadout-editor-search",
            type: "text",
            placeholder: "Search perks...",
        });
        search.val(this.search);
        search.on("keydown", (e) => e.stopPropagation());
        tools.append(search);
        wrap.append(tools);

        const list = $("<div/>", { class: "loadout-editor-perk-list" });
        const sorted = [...CUSTOM_LOADOUT_PERKS].sort((a, b) => this.label(a).localeCompare(this.label(b)));
        const fill = () => {
            list.empty();
            const q = this.search.trim().toLowerCase();
            const items = sorted.filter((p) => {
                if (!q) return true;
                // descriptions contain markup like </br>; match on the visible text
                const desc = this.perkDesc(p).replace(/<[^>]*>/g, " ").toLowerCase();
                return this.label(p).toLowerCase().includes(q) || desc.includes(q);
            });
            for (const perk of items) list.append(this.renderPerkRow(perk));
            if (!items.length) list.append($("<div/>", { class: "loadout-editor-empty", text: "No perk matches." }));
        };
        // only the list re-renders while typing, so the input keeps focus
        search.on("input", () => {
            this.search = search.val() as string;
            fill();
        });
        fill();
        wrap.append(list);
        return wrap;
    }

    /** Selected perks show their description; others expand it with the arrow. */
    private renderPerkRow(perk: string) {
        const chosen = this.loadout!.perks.includes(perk);
        const expanded = chosen || this.expandedPerks.has(perk);
        const desc = this.perkDesc(perk);
        const row = $("<div/>", {
            class: `loadout-editor-perk${chosen ? " selected" : ""}${this.editable ? "" : " readonly"}`,
        });
        const head = $("<div/>", { class: "loadout-editor-perk-head" });
        head.append($("<div/>", { class: "loadout-editor-perk-check", html: chosen ? "&#10003;" : "" }));
        head.append(this.img(perk));
        head.append($("<div/>", { class: "loadout-editor-perk-name", text: this.label(perk) }));
        if (desc && !chosen) {
            const arrow = $("<a/>", {
                class: "loadout-editor-perk-arrow",
                html: expanded ? "&#9660;" : "&#9654;",
                title: expanded ? "Hide description" : "Show description",
            });
            arrow.on("click", (e) => {
                e.stopPropagation();
                if (expanded) this.expandedPerks.delete(perk);
                else this.expandedPerks.add(perk);
                this.render();
            });
            head.append(arrow);
        }
        row.append(head);
        if (expanded && desc) {
            // localization strings are ours and carry </br> line breaks
            row.append($("<div/>", { class: "loadout-editor-perk-desc", html: desc }));
        }
        if (this.editable) {
            row.on("click", () =>
                this.mutate((l) => {
                    l.perks = chosen ? l.perks.filter((p) => p !== perk) : [...l.perks, perk];
                }),
            );
        }
        return row;
    }
}
