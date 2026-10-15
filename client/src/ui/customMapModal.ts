import $ from "jquery";
import {
    CUSTOM_MAP_CATEGORIES,
    CUSTOM_MAP_COLORS,
    CUSTOM_MAP_LIMITS,
    type CustomMapColor,
    type CustomMapPlace,
    type CustomMapCategory,
    type CustomMapConfig,
    type CustomMapLootEntry,
    type CustomMapObjectLoot,
    customMapCategory,
    customMapObjectLabel,
    DEFAULT_CUSTOM_MAP,
    defaultObjectLoot,
    hasObjectLoot,
    isCustomMapBuilding,
    isCustomMapSpawnable,
    isLootItem,
    validateCustomMap,
} from "../../../shared/defs/customMap";
import { RawMapObjectDefs } from "../../../shared/defs/mapObjectDefs";
import { GameObjectDefs } from "../../../shared/defs/register";
import { collider } from "../../../shared/utils/collider";
import { mapHelpers } from "../../../shared/utils/mapHelpers";
import { objectPreviewImg } from "./buildingPreview";
import { api } from "../api";
import type { ConfigManager } from "../config";
import { helpers } from "../helpers";

type Tab = "general" | "terrain" | "nature" | "zone" | "buildings" | "layout" | "loot" | "advanced";

interface Template {
    id: string;
    label: string;
    size: number;
    sizeSmall: number;
    riverWidths: number[][];
    smoothness: number;
    lakes: number;
    fixedSpawns: Record<string, number | { odds: number } | { small: number; large: number }>;
    densitySpawns: Record<string, number>;
    randomSpawns: { spawns: string[]; choose: number }[];
    shoreInset?: number;
    places?: CustomMapPlace[];
    colors?: Partial<Record<CustomMapColor, number>>;
}

/** `advanced` tabs only show with detailed creation switched on. */
const TABS: { id: Tab; label: string; advanced?: boolean }[] = [
    { id: "general", label: "General" },
    { id: "terrain", label: "Terrain" },
    { id: "nature", label: "Nature" },
    { id: "zone", label: "Zone & Drops" },
    { id: "buildings", label: "Buildings", advanced: true },
    { id: "layout", label: "Layout", advanced: true },
    { id: "loot", label: "Loot", advanced: true },
    { id: "advanced", label: "Objects", advanced: true },
];

/** Shown before detailed creation switches on; one at random. */
const ADVANCED_WARNINGS = [
    { title: "Are you sure?", text: "Are you sure you wanna throw your life away like that?" },
    { title: "Point of no return", text: "If you enable this option you might be dragged down a hole you'll never recover from." },
    { title: "Hold on", text: "People who flipped this switch were last seen tuning the weight of a single bandage at 4 am." },
    { title: "Final warning", text: "Your friends will be waiting in the lobby. Forever. While you place exactly 37 bushes." },
    { title: "Think about your family", text: "They still remember you. The version of you that went outside." },
    { title: "Warning: rabbit hole", text: "It starts with one extra warehouse. It never ends with one extra warehouse." },
    { title: "Is this a cry for help?", text: "Blink twice if someone is forcing you to balance loot tables." },
    { title: "Hydration check", text: "Grab a glass of water first. You won't be getting up for a while." },
    { title: "Medical notice", text: "Side effects may include insomnia, loot weight obsession and an irrational hatred of stone_04." },
    { title: "Sure about that?", text: "The red zone is coming for you either way. This just makes it personal." },
    { title: "Last chance", text: "The basic settings were nice to you. They never asked for anything. And now you leave them like this?" },
    { title: "Career change detected", text: "Congratulations on your new unpaid job as a full-time map designer." },
    { title: "Hmm.", text: "Every great map maker started exactly here. Most of them are still here." },
    { title: "Proceed with caution", text: "Somewhere out there a pan is crying because you'll make it 0.001% rarer." },
    { title: "You've been warned", text: "Your lobby will be in the queue longer than a Comp player waiting for a squad." },
    { title: "Point of no return", text: "There is no 'quick tweak'. There has never been a 'quick tweak'." },
    { title: "Error 418", text: "I'm a teapot, and even I know this is a bad idea." },
    { title: "Hold up", text: "Did your mom say you could have 2,500 barrels?" },
    { title: "Plot twist", text: "You won't be playing the map. The map will be playing you." },
    { title: "Fun fact", text: "This button has a 100% addiction rate among the people who pressed it. That's everyone." },
];

const COLOR_LABELS: Record<CustomMapColor, string> = {
    grass: "Grass",
    beach: "Beach",
    water: "Water",
    riverbank: "Riverbank",
};

const CATEGORY_LABELS: Record<CustomMapCategory, string> = {
    trees: "Trees",
    rocks: "Rocks",
    bushes: "Bushes",
    loot: "Crates & containers",
    props: "Other obstacles",
    groundLoot: "Ground loot",
};

const objDefs = RawMapObjectDefs as unknown as Record<string, { type?: string }>;
const byLabel = (a: string, b: string) => customMapObjectLabel(a).localeCompare(customMapObjectLabel(b));
const ALL_OBJECTS = Object.keys(objDefs).filter(isCustomMapSpawnable).sort(byLabel);
/** Every object a Nature category covers, for the per-object amounts. */
const NATURE_OBJECTS = Object.fromEntries(
    CUSTOM_MAP_CATEGORIES.map((cat) => [cat, ALL_OBJECTS.filter((type) => customMapCategory(type) === cat)]),
) as Record<CustomMapCategory, string[]>;

function itemLabel(type: string) {
    const def = GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined;
    return def?.name || customMapObjectLabel(type);
}
const LOOT_ITEMS = GameObjectDefs.getAllTypes().filter(isLootItem).sort((a, b) => itemLabel(a).localeCompare(itemLabel(b)));

/** Everything whose loot pools can be changed (crates, containers, ground loot spots...). */
const LOOT_OBJECTS = Object.keys(objDefs).filter(hasObjectLoot).sort(byLabel);

/** The pools players actually think about; the rest sit behind "show all". */
const KEY_POOLS = [
    "tier_world", "tier_container", "tier_guns", "tier_ammo", "tier_scopes", "tier_armor",
    "tier_packs", "tier_medical", "tier_throwables", "tier_surviv", "tier_soviet",
];
const POOL_LABELS: Record<string, string> = {
    tier_world: "Ground loot",
    tier_container: "Crates",
    tier_guns: "Guns",
    tier_ammo: "Ammo",
    tier_scopes: "Scopes",
    tier_armor: "Armor",
    tier_packs: "Backpacks",
    tier_medical: "Healing",
    tier_throwables: "Throwables",
    tier_surviv: "Surviv crates",
    tier_soviet: "Soviet crates",
};
function poolLabel(tier: string) {
    return POOL_LABELS[tier] ?? customMapObjectLabel(tier.replace(/^tier_/, ""));
}
/** Rendering ~1000 rows with steppers is slow; past this the list asks for a search. */
const LIST_LIMIT = 150;

export interface CustomMapHost {
    config: ConfigManager;
    isLeader(): boolean;
    /** The map the lobby currently uses (members only get to look at this one). */
    getActive(): CustomMapConfig | undefined;
    /** undefined = the lobby stops using a custom map */
    setActive(map: CustomMapConfig | undefined): void;
}

/** Saved custom map configs (per browser) plus an editor; the leader picks one for the lobby. */
export class CustomMapModal {
    private root: JQuery<HTMLElement>;
    private open_ = false;
    private selected = 0;
    private tab: Tab = "general";
    private search = "";
    private listFilter: "all" | "template" | "changed" = "all";
    private templates: Template[] = [];
    /** Buildings some map spawns whole (from the server; parts are left out). */
    private wholeBuildings: string[] = [];
    /** Obstacles/loot spots some map places on their own - no parts of buildings (from the server). */
    private standaloneObjects: string[] = [];
    private standaloneSet = new Set<string>();
    /** Loot pools per template, fetched on demand. */
    private lootData: Record<string, Record<string, CustomMapLootEntry[]>> = {};
    private lootLoading = new Set<string>();
    private lootTier = "tier_guns";
    private lootShowAll = false;
    private natureShowAll = false;
    /** Layout tab: what a click on the map does / places, and the picked marker. */
    private layoutMode: "objects" | "places" = "objects";
    private layoutType = "";
    private layoutSearch = "";
    private layoutSelected = -1;
    private layoutKind: "buildings" | "objects" = "buildings";
    private lootSearch = "";
    private templatesLoading = false;
    private armed: "delete" | "reset" | undefined;
    private armedUntil = 0;

    constructor(private host: CustomMapHost) {
        this.root = $("<div/>", { class: "loadout-editor-overlay custom-map-overlay" });
        this.root.on("mousedown", (e) => {
            if (e.target === this.root[0]) this.close();
        });
        $(document).on("keydown.customMap", (e) => {
            if (this.open_ && e.key === "Escape") this.close();
        });
        $("body").append(this.root);
    }

    get isOpen() {
        return this.open_;
    }

    open() {
        this.open_ = true;
        this.tab = "general";
        this.search = "";
        this.selected = Math.min(this.selected, Math.max(0, this.saved().length - 1));
        this.root.css("display", "flex");
        this.loadTemplates();
        this.render();
    }

    close() {
        this.open_ = false;
        this.root.css("display", "none").empty();
    }

    refresh() {
        if (!this.open_) return;
        // lobby state arriving mid-typing (name, amounts) would rebuild the field away
        const el = document.activeElement;
        if (el instanceof HTMLInputElement && this.root[0].contains(el) && !el.classList.contains("loadout-editor-search")) {
            return;
        }
        this.render();
    }

    private loadTemplates() {
        if (this.templates.length || this.templatesLoading) return;
        this.templatesLoading = true;
        fetch(api.resolveUrl("/api/custom-map/templates"), { cache: "no-cache" })
            .then((r) => r.json())
            .then((data: { templates: Template[]; wholeBuildings?: string[]; standaloneObjects?: string[] }) => {
                this.templates = data.templates ?? [];
                this.wholeBuildings = (data.wholeBuildings ?? []).sort(byLabel);
                this.standaloneObjects = (data.standaloneObjects ?? []).sort(byLabel);
                this.standaloneSet = new Set(this.standaloneObjects);
            })
            .catch(() => {})
            .finally(() => {
                this.templatesLoading = false;
                this.render();
            });
    }

    // ---- data ----

    private saved(): CustomMapConfig[] {
        const list = this.host.config.get("customMaps");
        // saved by older versions lack newer fields; validating fills the defaults
        return Array.isArray(list) ? list.map((m) => validateCustomMap(m)) : [];
    }

    private save(list: CustomMapConfig[]) {
        this.host.config.set("customMaps", list);
    }

    private get editable() {
        return this.host.isLeader();
    }

    /** What the editor shows: the selected saved map (leader) or the lobby's map. */
    private current(): CustomMapConfig | undefined {
        if (!this.editable) return this.host.getActive();
        return this.saved()[this.selected];
    }

    private template(): Template | undefined {
        const cfg = this.current();
        return this.templates.find((t) => t.id === cfg?.template);
    }

    private mutate(fn: (cfg: CustomMapConfig) => void) {
        if (!this.editable) return;
        const list = this.saved();
        const cfg = list[this.selected];
        if (!cfg) return;
        fn(cfg);
        list[this.selected] = validateCustomMap(cfg);
        this.save(list);
        // keep the lobby in sync while editing the map it's using
        if (this.isActive(list[this.selected])) this.host.setActive(list[this.selected]);
        this.render();
    }

    private isActive(cfg: CustomMapConfig | undefined) {
        const active = this.host.getActive();
        return !!cfg && !!active && (active.name ?? "") === (cfg.name ?? "");
    }

    // ---- rendering ----

    private render() {
        if (!this.open_) return;
        const scrollTop = this.root.find(".loadout-editor-content").scrollTop() ?? 0;
        const focusedSearch = document.activeElement?.classList.contains("loadout-editor-search");

        const modal = $("<div/>", { class: "loadout-editor custom-map-editor" });
        const header = $("<div/>", { class: "loadout-editor-header" });
        header.append($("<div/>", { class: "loadout-editor-title", text: "Custom Maps" }));
        const close = $("<a/>", { class: "loadout-editor-close", html: "&times;" });
        close.on("click", () => this.close());
        header.append(close);
        modal.append(header);

        const body = $("<div/>", { class: "loadout-editor-body" });
        body.append(this.renderSavedList());
        const main = $("<div/>", { class: "custom-map-main" });
        const cfg = this.current();
        if (cfg) {
            main.append(this.renderTabs(cfg));
            const content = $("<div/>", { class: "loadout-editor-content" });
            content.append(this.renderTab(cfg));
            main.append(content);
        } else if (this.editable) {
            const empty = $("<div/>", { class: "loadout-editor-empty custom-map-empty", text: "No saved maps yet." });
            empty.append($("<a/>", { class: "btn-green btn-darken menu-option custom-map-create", text: "Create map" })
                .on("click", () => this.createMap()));
            main.append(empty);
        } else {
            main.append($("<div/>", { class: "loadout-editor-empty", text: "No custom map selected." }));
        }
        body.append(main);
        modal.append(body);
        modal.append(this.renderFooter(cfg));

        this.root.empty().append(modal);
        this.root.find(".loadout-editor-content").scrollTop(scrollTop);
        if (focusedSearch) {
            const input = this.root.find<HTMLInputElement>(".loadout-editor-search")[0];
            input?.focus();
            input?.setSelectionRange(input.value.length, input.value.length);
        }
    }

    private summary(cfg: CustomMapConfig) {
        const t = this.templates.find((x) => x.id === cfg.template);
        const size = cfg.size || t?.size;
        return `${t?.label ?? cfg.template}${size ? ` · ${size}×${size}` : ""}`;
    }

    private renderSavedList() {
        const side = $("<div/>", { class: "loadout-editor-nav custom-map-saved" });
        if (!this.editable) {
            const active = this.host.getActive();
            side.append($("<div/>", { class: "loadout-editor-subtitle", text: "Lobby map" }));
            if (active) {
                side.append($("<div/>", {
                    class: "custom-map-saved-item active",
                    html: `<div class="custom-map-saved-name">${helpers.htmlEscape(active.name || "Custom map")}</div><div class="custom-map-saved-meta">${helpers.htmlEscape(this.summary(active))}</div>`,
                }));
            }
            return side;
        }
        side.append($("<div/>", { class: "loadout-editor-subtitle", text: "Saved maps" }));
        this.saved().forEach((cfg, i) => {
            const item = $("<div/>", {
                class: `custom-map-saved-item${i === this.selected ? " selected" : ""}`,
                html: `<div class="custom-map-saved-name">${helpers.htmlEscape(cfg.name || `Map ${i + 1}`)}${this.isActive(cfg) ? ' <span class="custom-map-active-badge">in lobby</span>' : ""}</div><div class="custom-map-saved-meta">${helpers.htmlEscape(this.summary(cfg))}</div>`,
            });
            item.on("click", () => {
                this.selected = i;
                this.search = "";
                this.armed = undefined;
                this.render();
            });
            side.append(item);
        });
        if (this.saved().length < CUSTOM_MAP_LIMITS.maxSaved) {
            const add = $("<a/>", { class: "private-lobby-add-loadout-btn custom-map-new", text: "+ New map" });
            add.on("click", () => this.createMap());
            side.append(add);
        }
        return side;
    }

    private createMap() {
        const list = this.saved();
        if (list.length >= CUSTOM_MAP_LIMITS.maxSaved) return;
        const names = new Set(list.map((m) => m.name));
        let n = list.length + 1;
        while (names.has(`Map ${n}`)) n++;
        list.push(validateCustomMap({ ...DEFAULT_CUSTOM_MAP, name: `Map ${n}` }));
        this.save(list);
        this.selected = list.length - 1;
        this.tab = "general";
        this.render();
    }

    /** Two-click confirm for destructive footer buttons. */
    private armedButton(key: "delete" | "reset", label: string, confirmLabel: string, onConfirm: () => void) {
        const armed = this.armed === key && this.armedUntil > Date.now();
        const btn = $("<a/>", {
            class: `loadout-editor-clear${armed ? " armed" : ""}`,
            text: armed ? confirmLabel : label,
        });
        btn.on("click", () => {
            if (this.armed === key && this.armedUntil > Date.now()) {
                this.armed = undefined;
                onConfirm();
                this.render();
                return;
            }
            this.armed = key;
            this.armedUntil = Date.now() + 3000;
            this.render();
            setTimeout(() => {
                if (this.armed && this.armedUntil <= Date.now()) {
                    this.armed = undefined;
                    this.render();
                }
            }, 3100);
        });
        return btn;
    }

    private renderTabs(cfg: CustomMapConfig) {
        // switched off (or another map selected) while on a detailed tab
        if (!cfg.advanced && TABS.find((t) => t.id === this.tab)?.advanced) this.tab = "general";
        const tabs = $("<div/>", { class: "loadout-editor-chips custom-map-tabs" });
        for (const t of TABS) {
            if (t.advanced && !cfg.advanced) continue;
            const chip = $("<a/>", { class: `loadout-editor-chip${t.id === this.tab ? " active" : ""}`, text: t.label });
            chip.on("click", () => {
                this.tab = t.id;
                this.search = "";
                this.listFilter = "all";
                this.render();
            });
            tabs.append(chip);
        }

        const sw = $("<div/>", { class: "custom-map-advanced-switch", title: "Per-object amounts, buildings, loot pools, advanced rivers" });
        sw.append($("<span/>", { text: "Advanced creation" }));
        const toggle = $("<a/>", {
            class: `private-lobby-setting-toggle${cfg.advanced ? " private-lobby-setting-toggle-on" : ""}${this.editable ? "" : " private-lobby-setting-toggle-disabled"}`,
            text: cfg.advanced ? "ON" : "OFF",
        });
        if (this.editable) {
            toggle.on("click", () => {
                if (cfg.advanced) {
                    this.mutate((c) => {
                        c.advanced = false;
                    });
                } else {
                    this.confirmAdvanced();
                }
            });
        }
        sw.append(toggle);
        tabs.append(sw);
        return tabs;
    }

    private confirmAdvanced() {
        const warning = ADVANCED_WARNINGS[Math.floor(Math.random() * ADVANCED_WARNINGS.length)];
        const overlay = $("<div/>", { class: "custom-map-confirm-overlay" });
        const box = $("<div/>", { class: "custom-map-confirm" });
        box.append($("<div/>", { class: "custom-map-confirm-title", text: warning.title }));
        box.append($("<div/>", { class: "custom-map-confirm-text", text: warning.text }));
        const buttons = $("<div/>", { class: "custom-map-confirm-buttons" });
        const close = () => overlay.remove();
        buttons.append($("<a/>", { class: "btn-darken menu-option custom-map-done", text: "Take me back" }).on("click", close));
        buttons.append($("<a/>", { class: "btn-green btn-darken menu-option", text: "Down the hole" }).on("click", () => {
            close();
            this.mutate((c) => {
                c.advanced = true;
            });
        }));
        box.append(buttons);
        overlay.append(box);
        overlay.on("click", (e) => {
            if (e.target === overlay[0]) close();
        });
        this.root.find(".custom-map-editor").append(overlay);
    }

    private renderFooter(cfg: CustomMapConfig | undefined) {
        const footer = $("<div/>", { class: "loadout-editor-footer" });
        if (!this.editable) {
            footer.append($("<span/>", {
                class: "loadout-editor-readonly",
                text: "Only the lobby leader can change the map.",
            }));
        } else if (cfg) {
            footer.append(this.armedButton("delete", "Delete map", "Click again to delete", () => {
                const list = this.saved();
                const [removed] = list.splice(this.selected, 1);
                this.save(list);
                this.selected = Math.max(0, Math.min(this.selected, list.length - 1));
                // a deleted map is gone for the lobby too
                if (this.isActive(removed)) this.host.setActive(undefined);
            }));
            footer.append(this.armedButton("reset", "Reset", "Click again to reset", () => {
                // back to the plain template: keeps only the name and the template
                this.mutate((c) => {
                    Object.assign(c, structuredClone(DEFAULT_CUSTOM_MAP), { name: c.name, template: c.template });
                });
            }).attr("title", "Undo every change: the map becomes exactly its template again"));
            const dup = $("<a/>", { class: "loadout-editor-chip", text: "Duplicate" });
            dup.on("click", () => {
                const list = this.saved();
                if (list.length >= CUSTOM_MAP_LIMITS.maxSaved) return;
                const copy = validateCustomMap({ ...structuredClone(cfg), name: `${cfg.name || "Map"} copy` });
                list.splice(this.selected + 1, 0, copy);
                this.save(list);
                this.selected++;
                this.render();
            });
            footer.append(dup);
            const use = $("<a/>", {
                class: "btn-green btn-darken menu-option loadout-editor-done",
                text: this.isActive(cfg) ? "In use" : "Use in lobby",
            });
            if (this.isActive(cfg)) use.addClass("btn-disabled");
            use.on("click", () => {
                this.host.setActive(validateCustomMap(cfg));
                this.render();
            });
            footer.append(use);
        }
        const done = $("<a/>", { class: "btn-darken menu-option loadout-editor-done custom-map-done", text: "Done" });
        done.on("click", () => this.close());
        footer.append(done);
        return footer;
    }

    private renderTab(cfg: CustomMapConfig) {
        switch (this.tab) {
            case "general":
                return this.renderGeneral(cfg);
            case "terrain":
                return this.renderTerrain(cfg);
            case "nature":
                return this.renderNature(cfg);
            case "zone":
                return this.renderZone(cfg);
            case "layout":
                return this.renderLayout(cfg);
            case "buildings":
                return this.renderBuildings(cfg);
            case "loot":
                return this.renderLoot(cfg);
            case "advanced":
                return this.renderObjectList(cfg, this.objectsTabList(cfg), {
                    hint: "Single objects a map can place on their own (whole buildings are in Buildings). Amount = exact count; density = per land area like the templates use for trees and rocks.",
                    withDensity: true,
                });
        }
    }

    // ---- form helpers ----

    private field(label: string, control: JQuery, hint?: string) {
        const row = $("<div/>", { class: "custom-map-field" });
        row.append($("<div/>", { class: "custom-map-field-label", text: label }));
        row.append(control);
        if (hint) row.append($("<div/>", { class: "loadout-editor-hint", text: hint }));
        return row;
    }

    private slider(value: number, min: number, max: number, step: number, fmt: (v: number) => string, onSet: (v: number) => void) {
        const wrap = $("<div/>", { class: "custom-map-slider" });
        const input = $<HTMLInputElement>("<input/>", { type: "range", min, max, step });
        input.val(value);
        const out = $("<span/>", { class: "custom-map-slider-value", text: fmt(value) });
        if (this.editable) {
            input.on("input", () => out.text(fmt(Number(input.val()))));
            input.on("change", () => onSet(Number(input.val())));
        } else {
            input.prop("disabled", true);
        }
        wrap.append(input, out);
        return wrap;
    }

    private chips<T extends string>(options: { id: T; label: string }[], value: T, onSet: (v: T) => void) {
        const wrap = $("<div/>", { class: "loadout-editor-chips" });
        for (const o of options) {
            const chip = $("<a/>", { class: `loadout-editor-chip${o.id === value ? " active" : ""}`, text: o.label });
            if (this.editable) chip.on("click", () => onSet(o.id));
            wrap.append(chip);
        }
        return wrap;
    }

    private stepper(value: number | undefined, placeholder: string, max: number, step: number, onSet: (v: number | undefined) => void) {
        const wrap = $("<div/>", { class: "loadout-editor-stepper" });
        const minus = $("<a/>", { class: "loadout-editor-step", text: "−" });
        const input = $<HTMLInputElement>("<input/>", { class: "loadout-editor-count", type: "number", min: 0, max, placeholder });
        if (value !== undefined) input.val(value);
        const plus = $("<a/>", { class: "loadout-editor-step", text: "+" });
        const base = () => (value ?? (Number(placeholder) || 0));
        if (this.editable) {
            minus.on("click", () => onSet(Math.max(0, base() - step)));
            plus.on("click", () => onSet(Math.min(max, base() + step)));
            input.on("change", () => {
                const raw = String(input.val()).trim();
                onSet(raw === "" ? undefined : Math.max(0, Math.min(max, Number(raw) || 0)));
            });
            input.on("keydown", (e) => e.stopPropagation());
        } else {
            input.prop("disabled", true);
        }
        wrap.append(minus, input, plus);
        return wrap;
    }

    // ---- tabs ----

    private renderGeneral(cfg: CustomMapConfig) {
        const wrap = $("<div/>", { class: "custom-map-form" });
        const name = $<HTMLInputElement>("<input/>", {
            class: "loadout-editor-search custom-map-name",
            type: "text",
            maxLength: CUSTOM_MAP_LIMITS.nameMaxLen,
            placeholder: "Map name",
        });
        name.val(cfg.name ?? "");
        if (this.editable) {
            name.on("change", () => this.mutate((c) => {
                c.name = (name.val() as string).trim() || undefined;
            }));
            name.on("keydown", (e) => {
                if (e.key === "Enter") name.trigger("blur");
                e.stopPropagation();
            });
        } else {
            name.prop("disabled", true);
        }
        wrap.append(this.field("Name", name));

        const select = $<HTMLSelectElement>("<select/>", { class: "private-lobby-setting-select custom-map-select" });
        const options = this.templates.length ? this.templates : [{ id: cfg.template, label: cfg.template } as Template];
        for (const t of options) {
            select.append($("<option/>", { value: t.id, text: `${t.label} (${t.size}×${t.size})`, selected: t.id === cfg.template }));
        }
        if (this.editable) {
            select.on("change", () => this.mutate((c) => {
                c.template = select.val() as string;
            }));
        } else {
            select.prop("disabled", true);
        }
        wrap.append(this.field(
            "Template",
            select,
            "The map you start from: its look, buildings, nature and loot.",
        ));

        wrap.append(this.field("Game mode", this.chips(
            [{ id: "lobby", label: "Lobby mode" }, { id: "template", label: "Template's own" }],
            cfg.rules,
            (v) => this.mutate((c) => {
                c.rules = v;
            }),
        ), cfg.rules === "lobby"
            ? "Rules of the mode picked in the lobby (e.g. 1v1: its loadout, arena rules) on this map."
            : "Plays exactly like the template would when picked normally (e.g. Faction: faction mode)."));

        if (!cfg.advanced) {
            wrap.append(this.field("Buildings", this.chips(
                [{ id: "keep", label: "Template's buildings" }, { id: "drop", label: "No buildings" }],
                cfg.templateBuildings ? "keep" : "drop",
                (v) => this.mutate((c) => {
                    c.templateBuildings = v === "keep";
                }),
            ), "Picking single buildings and amounts: Advanced creation."));
        }

        const t = this.template();
        const custom = cfg.size > 0;
        wrap.append(this.field("Size", this.chips(
            [{ id: "template", label: `Template${t ? ` (${t.size})` : ""}` }, { id: "custom", label: "Custom" }],
            custom ? "custom" : "template",
            (v) => this.mutate((c) => {
                c.size = v === "custom" ? (t?.size ?? 512) : 0;
            }),
        )));
        if (custom) {
            const L = CUSTOM_MAP_LIMITS;
            wrap.append(this.slider(cfg.size, L.minSize, L.maxSize, 16, (v) => `${v} × ${v}`, (v) =>
                this.mutate((c) => {
                    c.size = v;
                })));
            wrap.append($("<div/>", {
                class: "loadout-editor-hint",
                text: "Nature and loot density scale with the area; exact building amounts don't, so huge buildings may not all fit on small maps.",
            }));
        }

        const newSeed = () => 1 + Math.floor(Math.random() * (CUSTOM_MAP_LIMITS.maxSeed - 1));
        wrap.append(this.field("Layout", this.chips(
            [{ id: "random", label: "New map every match" }, { id: "fixed", label: "Same map every match" }],
            cfg.seed ? "fixed" : "random",
            (v) => this.mutate((c) => {
                c.seed = v === "fixed" ? newSeed() : 0;
            }),
        ), cfg.seed ? "Same seed = same terrain, rivers and object positions every match (as long as the settings stay the same)." : undefined));
        if (cfg.seed) {
            const row = $("<div/>", { class: "custom-map-seed" });
            const input = $<HTMLInputElement>("<input/>", { class: "loadout-editor-search custom-map-seed-input", type: "number", min: 1, max: CUSTOM_MAP_LIMITS.maxSeed });
            input.val(cfg.seed);
            const roll = $("<a/>", { class: "loadout-editor-chip", text: "🎲 New seed" });
            if (this.editable) {
                input.on("change", () => this.mutate((c) => {
                    c.seed = Math.max(1, Number(input.val()) || 1);
                }));
                input.on("keydown", (e) => e.stopPropagation());
                roll.on("click", () => this.mutate((c) => {
                    c.seed = newSeed();
                }));
            } else {
                input.prop("disabled", true);
            }
            row.append($("<span/>", { class: "custom-map-row-label", text: "seed" }), input, roll);
            wrap.append(row);
        }
        return wrap;
    }

    private renderTerrain(cfg: CustomMapConfig) {
        const wrap = $("<div/>", { class: "custom-map-form" });
        const t = this.template();
        const tplRivers = t ? (t.riverWidths.find((w) => w.length) ?? []).length : undefined;
        wrap.append(this.field("Rivers", this.chips(
            [
                { id: "template", label: `Template${tplRivers !== undefined ? ` (${tplRivers})` : ""}` },
                { id: "none", label: "None" },
                { id: "simple", label: "Simple" },
                ...(cfg.advanced ? [{ id: "advanced" as const, label: "Advanced" }] : []),
            ],
            cfg.rivers.mode,
            (v) => this.mutate((c) => {
                c.rivers.mode = v;
            }),
        )));
        const L = CUSTOM_MAP_LIMITS;
        if (cfg.rivers.mode === "simple") {
            wrap.append(this.field("Number of rivers", this.stepper(cfg.rivers.count, "", L.maxRivers, 1, (v) =>
                this.mutate((c) => {
                    c.rivers.count = v ?? 0;
                }))));
            wrap.append(this.field("Width", this.slider(cfg.rivers.width, L.minRiverWidth, L.maxRiverWidth, 1, (v) => `${v}`, (v) =>
                this.mutate((c) => {
                    c.rivers.width = v;
                }))));
        }
        if (cfg.rivers.mode === "advanced") {
            cfg.rivers.widths.forEach((w, i) => {
                const row = $("<div/>", { class: "custom-map-river" });
                row.append(this.slider(w, L.minRiverWidth, L.maxRiverWidth, 1, (v) => `width ${v}`, (v) =>
                    this.mutate((c) => {
                        c.rivers.widths[i] = v;
                    })));
                if (this.editable && cfg.rivers.widths.length > 1) {
                    const rm = $("<a/>", { class: "private-lobby-setting-remove", title: "Remove river" });
                    rm.on("click", () => this.mutate((c) => {
                        c.rivers.widths.splice(i, 1);
                    }));
                    row.append(rm);
                }
                wrap.append(this.field(`River ${i + 1}`, row));
            });
            if (this.editable && cfg.rivers.widths.length < L.maxRivers) {
                const add = $("<a/>", { class: "private-lobby-add-loadout-btn", text: "+ Add river" });
                add.on("click", () => this.mutate((c) => {
                    c.rivers.widths.push(c.rivers.widths.at(-1) ?? 12);
                }));
                wrap.append(add);
            }
            wrap.append(this.field("Smoothness", this.slider(cfg.rivers.smoothness, 0, 3, 0.1, (v) => v.toFixed(1), (v) =>
                this.mutate((c) => {
                    c.rivers.smoothness = v;
                })), "Lower = straighter rivers, higher = more winding."));
            wrap.append(this.field("Lakes", this.chips(
                [{ id: "on", label: `Keep template lakes${t ? ` (${t.lakes})` : ""}` }, { id: "off", label: "No lakes" }],
                cfg.rivers.lakes ? "on" : "off",
                (v) => this.mutate((c) => {
                    c.rivers.lakes = v === "on";
                }),
            )));
        }

        wrap.append($("<div/>", { class: "custom-map-section-title", text: "Colors" }));
        const colors = $("<div/>", { class: "custom-map-colors" });
        for (const key of CUSTOM_MAP_COLORS) {
            const value = cfg.colors[key] ?? t?.colors?.[key];
            const item = $("<label/>", { class: `custom-map-color${cfg.colors[key] !== undefined ? " changed" : ""}` });
            const input = $<HTMLInputElement>("<input/>", { type: "color" });
            input.val(value !== undefined ? `#${value.toString(16).padStart(6, "0")}` : "#000000");
            if (this.editable) {
                input.on("change", () => this.mutate((c) => {
                    c.colors[key] = Number.parseInt(String(input.val()).slice(1), 16);
                }));
            } else {
                input.prop("disabled", true);
            }
            item.append(input, $("<span/>", { text: COLOR_LABELS[key] }));
            if (cfg.colors[key] !== undefined && this.editable) {
                item.append($("<a/>", { class: "custom-map-row-reset", text: "reset" }).on("click", (e) => {
                    e.preventDefault();
                    this.mutate((c) => {
                        delete c.colors[key];
                    });
                }));
            }
            colors.append(item);
        }
        wrap.append(colors);
        return wrap;
    }

    /** How many of `type` the template places on a map of the config's size (undefined = none). */
    private templateAmount(cfg: CustomMapConfig, type: string): number | undefined {
        const t = this.template();
        if (!t) return undefined;
        let n = 0;
        let has = false;
        const fixed = t.fixedSpawns[type];
        if (typeof fixed === "number") n += fixed;
        else if (fixed && "odds" in fixed) n += fixed.odds;
        else if (fixed) n += fixed.large;
        if (fixed !== undefined) has = true;
        const density = t.densitySpawns[type];
        if (density !== undefined) {
            // same formula as the server's density spawns, minus river area
            const land = Math.max(0, (cfg.size || t.size) - 2 * (t.shoreInset ?? 48)) ** 2;
            n += (density * land) / 250000;
            has = true;
        }
        if (!has) return undefined;
        const cat = customMapCategory(type);
        return cat ? n * cfg.density[cat] : n;
    }

    /** Basic nature: one amount per category, relative to the template. */
    private renderNatureBasic(cfg: CustomMapConfig) {
        const wrap = $("<div/>", { class: "custom-map-form" });
        wrap.append($("<div/>", {
            class: "loadout-editor-hint",
            text: "Relative to the template: 100% = unchanged, 0% = none at all. Exact amounts per object: Advanced creation.",
        }));
        for (const cat of CUSTOM_MAP_CATEGORIES) {
            wrap.append(this.field(CATEGORY_LABELS[cat], this.slider(
                cfg.density[cat],
                0,
                CUSTOM_MAP_LIMITS.maxDensityMult,
                0.05,
                (v) => (v === 0 ? "none" : `${Math.round(v * 100)}%`),
                (v) => this.mutate((c) => {
                    c.density[cat] = v;
                }),
            )));
        }
        return wrap;
    }

    private renderNature(cfg: CustomMapConfig) {
        if (!cfg.advanced) return this.renderNatureBasic(cfg);
        const wrap = $("<div/>");
        wrap.append($("<div/>", {
            class: "loadout-editor-hint",
            text: "Exact amount per object. Empty = what the template places (≈ for a map of this size).",
        }));

        const tools = $("<div/>", { class: "loadout-editor-tools" });
        tools.append(this.chips(
            [
                { id: "template", label: "In template" },
                { id: "all", label: "All objects" },
            ],
            this.natureShowAll ? "all" : "template",
            (v) => {
                this.natureShowAll = v === "all";
                this.render();
            },
        ).addClass("small"));
        const search = $<HTMLInputElement>("<input/>", { class: "loadout-editor-search", type: "text", placeholder: "Search..." });
        search.val(this.search);
        search.on("keydown", (e) => e.stopPropagation());
        tools.append(search);
        wrap.append(tools);

        const body = $("<div/>");
        const fill = () => {
            body.empty();
            const q = this.search.trim().toLowerCase();
            let any = false;
            for (const cat of CUSTOM_MAP_CATEGORIES) {
                const rows = NATURE_OBJECTS[cat]
                    .map((type) => ({ type, amount: this.templateAmount(cfg, type) }))
                    .filter(({ type, amount }) => {
                        // building parts (walls, furniture) only make sense inside their building
                        if (this.standaloneSet.size && !this.standaloneSet.has(type) && !(type in cfg.spawns)) return false;
                        if (q) return customMapObjectLabel(type).toLowerCase().includes(q) || type.includes(q);
                        return this.natureShowAll || amount !== undefined || type in cfg.spawns;
                    })
                    .sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1) || byLabel(a.type, b.type));
                if (!rows.length) continue;
                any = true;
                body.append(this.renderNatureHeader(cfg, cat, rows));
                const list = $("<div/>", { class: "custom-map-list" });
                for (const r of rows.slice(0, LIST_LIMIT)) list.append(this.renderNatureRow(cfg, r.type, r.amount));
                if (rows.length > LIST_LIMIT) {
                    list.append($("<div/>", {
                        class: "loadout-editor-empty",
                        text: `${rows.length - LIST_LIMIT} more - search to narrow it down.`,
                    }));
                }
                body.append(list);
            }
            if (!any) body.append($("<div/>", { class: "loadout-editor-empty", text: "Nothing matches." }));
        };
        search.on("input", () => {
            this.search = search.val() as string;
            fill();
        });
        fill();
        wrap.append(body);
        return wrap;
    }

    private renderNatureHeader(cfg: CustomMapConfig, cat: CustomMapCategory, rows: { type: string; amount?: number }[]) {
        const total = rows.reduce((sum, r) => sum + (cfg.spawns[r.type] ?? r.amount ?? 0), 0);
        const head = $("<div/>", { class: "custom-map-nature-head" });
        head.append($("<span/>", { class: "custom-map-field-label", text: CATEGORY_LABELS[cat] }));
        head.append($("<span/>", { class: "custom-map-row-meta", text: `≈ ${Math.round(total)} total` }));
        if (this.editable) {
            const clearCat = (mult: number) => this.mutate((c) => {
                c.density[cat] = mult;
                for (const type of NATURE_OBJECTS[cat]) delete c.spawns[type];
            });
            head.append($("<a/>", { class: "loadout-editor-chip", text: "None" }).on("click", () => clearCat(0)));
            head.append($("<a/>", { class: "loadout-editor-chip", text: "Template" }).on("click", () => clearCat(1)));
        }
        return head;
    }

    private renderNatureRow(cfg: CustomMapConfig, type: string, amount: number | undefined) {
        const changed = type in cfg.spawns;
        const row = $("<div/>", { class: `custom-map-row${changed ? " changed" : ""}` });
        row.append(objectPreviewImg(type, 64, "custom-map-loot-icon"));
        const info = $("<div/>", { class: "custom-map-row-info" });
        info.append($("<div/>", { class: "custom-map-row-name", text: customMapObjectLabel(type), title: type }));
        info.append($("<div/>", {
            class: "custom-map-row-meta",
            text: amount === undefined ? "not in template" : `template: ≈ ${amount < 1 && amount > 0 ? amount.toFixed(2) : Math.round(amount)}`,
        }));
        row.append(info);
        row.append(this.stepper(cfg.spawns[type], String(Math.round(amount ?? 0)), CUSTOM_MAP_LIMITS.maxSpawnCount, 10, (v) =>
            this.mutate((c) => {
                if (v === undefined) delete c.spawns[type];
                else c.spawns[type] = v;
            })));
        if (changed && this.editable) {
            const reset = $("<a/>", { class: "custom-map-row-reset", text: "reset", title: "Back to the template's amount" });
            reset.on("click", () => this.mutate((c) => {
                delete c.spawns[type];
            }));
            row.append(reset);
        }
        return row;
    }

    // ---- zone, airdrops, spawns ----

    private renderZone(cfg: CustomMapConfig) {
        const wrap = $("<div/>", { class: "custom-map-form" });
        const L = CUSTOM_MAP_LIMITS;

        wrap.append($("<div/>", { class: "custom-map-section-title", text: "Red zone" }));
        wrap.append(this.field("Zone", this.chips(
            [{ id: "on", label: "On" }, { id: "off", label: "Off" }],
            cfg.gas.enabled ? "on" : "off",
            (v) => this.mutate((c) => {
                c.gas.enabled = v === "on";
            }),
        ), cfg.gas.enabled ? undefined : "No zone at all - the match only ends when one team is left. Mode airdrops come with the zone's circles, so they stay away too (custom airdrops still drop)."));
        if (cfg.gas.enabled) {
            wrap.append(this.field("Speed", this.slider(cfg.gas.speed, L.gasMinSpeed, L.gasMaxSpeed, 0.05, (v) => `${Math.round(v * 100)}%`, (v) =>
                this.mutate((c) => {
                    c.gas.speed = v;
                })), "200% = every wait and every move takes half as long."));
            wrap.append(this.field("Damage", this.slider(cfg.gas.damage, 0, L.gasMaxDamage, 0.05, (v) => (v === 0 ? "none" : `${Math.round(v * 100)}%`), (v) =>
                this.mutate((c) => {
                    c.gas.damage = v;
                }))));
            if (cfg.advanced) {
                wrap.append(this.field("Circles", this.stepper(cfg.gas.circles, String(L.gasMaxCircles), L.gasMaxCircles, 1, (v) =>
                    this.mutate((c) => {
                        c.gas.circles = Math.max(1, v ?? L.gasMaxCircles);
                    })), `How many times it shrinks until fully closed (normal: ${L.gasMaxCircles}).`));
            }
        }

        wrap.append($("<div/>", { class: "custom-map-section-title", text: "Airdrops" }));
        wrap.append(this.field("Airdrops", this.chips(
            [{ id: "rules", label: "Game mode's" }, { id: "none", label: "None" }, { id: "custom", label: "Custom" }],
            cfg.airdrops.mode,
            (v) => this.mutate((c) => {
                c.airdrops.mode = v;
            }),
        )));
        if (cfg.airdrops.mode === "custom") {
            const time = (v: number) => (v >= 60 ? `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")} min` : `${v} s`);
            wrap.append(this.field("Timing", this.chips(
                [{ id: "times", label: "At set times" }, { id: "interval", label: "Every X" }],
                cfg.airdrops.timing,
                (v) => this.mutate((c) => {
                    c.airdrops.timing = v;
                }),
            )));
            if (cfg.airdrops.timing === "times") {
                wrap.append(this.renderDropTimes(cfg));
            } else {
                wrap.append(this.field("Number of drops", this.stepper(cfg.airdrops.count, "0", L.maxAirdrops, 1, (v) =>
                    this.mutate((c) => {
                        c.airdrops.count = v ?? 0;
                    }))));
                wrap.append(this.field("First drop after", this.slider(cfg.airdrops.firstAt, 0, 600, 5, time, (v) =>
                    this.mutate((c) => {
                        c.airdrops.firstAt = v;
                    }))));
                wrap.append(this.field("Then every", this.slider(cfg.airdrops.interval, 5, 600, 5, time, (v) =>
                    this.mutate((c) => {
                        c.airdrops.interval = v;
                    }))));
            }
            wrap.append(this.field("Gold crate chance", this.slider(cfg.airdrops.goldChance, 0, 100, 1, (v) => `${v}%`, (v) =>
                this.mutate((c) => {
                    c.airdrops.goldChance = v;
                }))));
        }

        if (cfg.advanced) {
            wrap.append($("<div/>", { class: "custom-map-section-title", text: "Spawns" }));
            wrap.append(this.field("Player spawns", this.chips(
                [{ id: "mode", label: "Game mode's" }, { id: "custom", label: "Custom" }],
                cfg.spawn.custom ? "custom" : "mode",
                (v) => this.mutate((c) => {
                    c.spawn.custom = v === "custom";
                }),
            )));
            if (cfg.spawn.custom) {
                wrap.append(this.field("Distance to other players", this.slider(cfg.spawn.playerDistance, 0, L.maxSpawnDistance, 10, (v) => `${v}`, (v) =>
                    this.mutate((c) => {
                        c.spawn.playerDistance = v;
                    })), "Kept when possible; on a crowded map players still spawn closer."));
                wrap.append(this.field("Distance to the edge", this.slider(cfg.spawn.edgeDistance, 0, L.maxSpawnDistance / 2, 10, (v) => `${v}`, (v) =>
                    this.mutate((c) => {
                        c.spawn.edgeDistance = v;
                    }))));
                wrap.append(this.field("No spawns around the center", this.slider(cfg.spawn.centerFree, 0, L.maxSpawnDistance / 2, 10, (v) => (v === 0 ? "off" : `radius ${v}`), (v) =>
                    this.mutate((c) => {
                        c.spawn.centerFree = v;
                    }))));
            }
        }
        return wrap;
    }

    /** One row per airdrop: when it comes (m:ss after the match starts). */
    private renderDropTimes(cfg: CustomMapConfig) {
        const L = CUSTOM_MAP_LIMITS;
        const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
        // "1:30", "90" or "1:30 min" -> seconds
        const parse = (raw: string) => {
            const m = raw.trim().match(/^(\d{1,2})(?::(\d{1,2}))?/);
            if (!m) return undefined;
            const s = m[2] !== undefined ? Number(m[1]) * 60 + Number(m[2]) : Number(m[1]);
            return Math.min(L.maxAirdropTime, Math.max(0, s));
        };

        const wrap = $("<div/>", { class: "custom-map-field" });
        wrap.append($("<div/>", { class: "custom-map-field-label", text: "Drops" }));
        const list = $("<div/>", { class: "custom-map-drop-times" });
        cfg.airdrops.times.forEach((t, i) => {
            const row = $("<div/>", { class: "custom-map-drop-time" });
            row.append($("<span/>", { class: "custom-map-row-label", text: `#${i + 1} at` }));
            const input = $<HTMLInputElement>("<input/>", { class: "loadout-editor-search custom-map-time-input", type: "text", placeholder: "m:ss" });
            input.val(fmt(t));
            if (this.editable) {
                input.on("change", () => {
                    const s = parse(String(input.val()));
                    if (s === undefined) {
                        input.val(fmt(t));
                        return;
                    }
                    this.mutate((c) => {
                        c.airdrops.times[i] = s;
                    });
                });
                input.on("keydown", (e) => {
                    if (e.key === "Enter") input.trigger("blur");
                    e.stopPropagation();
                });
                row.append(input);
                row.append($("<span/>", { class: "custom-map-row-label", text: "min" }));
                row.append($("<a/>", { class: "private-lobby-setting-remove", title: "Remove drop" }).on("click", () =>
                    this.mutate((c) => {
                        c.airdrops.times.splice(i, 1);
                    })));
            } else {
                input.prop("disabled", true);
                row.append(input);
            }
            list.append(row);
        });
        if (!cfg.airdrops.times.length) {
            list.append($("<div/>", { class: "loadout-editor-hint", text: "No drops yet." }));
        }
        wrap.append(list);
        if (this.editable && cfg.airdrops.times.length < L.maxAirdrops) {
            wrap.append($("<a/>", { class: "private-lobby-add-loadout-btn custom-map-add-drop", text: "+ Add drop" }).on("click", () =>
                this.mutate((c) => {
                    const last = c.airdrops.times.at(-1);
                    c.airdrops.times.push(Math.min(L.maxAirdropTime, last === undefined ? 90 : last + 60));
                })));
        }
        wrap.append($("<div/>", { class: "loadout-editor-hint", text: "Time after the match starts, e.g. 1:30 or 90 (seconds)." }));
        return wrap;
    }

    // ---- layout: fixed placements and place names on a map preview ----

    private layoutPlaces(cfg: CustomMapConfig): CustomMapPlace[] {
        return cfg.places ?? this.template()?.places ?? [];
    }

    private renderLayout(cfg: CustomMapConfig) {
        const wrap = $("<div/>", { class: "custom-map-layout" });
        const t = this.template();
        const size = cfg.size || t?.size || 512;
        const inset = (t?.shoreInset ?? 48) / size;
        const color = (key: CustomMapColor, fallback: number) =>
            `#${(cfg.colors[key] ?? t?.colors?.[key] ?? fallback).toString(16).padStart(6, "0")}`;

        // -- map --
        const CANVAS = 440;
        const canvas = $<HTMLCanvasElement>("<canvas/>", { class: "custom-map-layout-canvas" });
        canvas.attr({ width: CANVAS, height: CANVAS });
        const el = canvas[0];
        const ctx = el.getContext("2d")!;
        const places = this.layoutPlaces(cfg).map((p) => ({ ...p }));
        const placements = cfg.placements.map((p) => ({ ...p }));
        const isPlaces = this.layoutMode === "places";
        const items = () => (isPlaces ? places : placements);

        // footprint in map fractions (0..1) of an object
        const footprint = (type: string) => {
            let col: ReturnType<typeof mapHelpers.getBoundingCollider> | undefined;
            try {
                col = mapHelpers.getBoundingCollider(type);
            } catch {
                col = undefined;
            }
            if (!col) return { w: 4 / size, h: 4 / size };
            const aabb = collider.toAabb(col);
            return { w: (aabb.max.x - aabb.min.x) / size, h: (aabb.max.y - aabb.min.y) / size };
        };

        const draw = () => {
            ctx.fillStyle = color("water", 0x3282ab);
            ctx.fillRect(0, 0, CANVAS, CANVAS);
            ctx.fillStyle = color("beach", 0xcdb35b);
            ctx.fillRect(inset * CANVAS, inset * CANVAS, (1 - 2 * inset) * CANVAS, (1 - 2 * inset) * CANVAS);
            const g = inset + 18 / size;
            ctx.fillStyle = color("grass", 0x80af49);
            ctx.fillRect(g * CANVAS, g * CANVAS, (1 - 2 * g) * CANVAS, (1 - 2 * g) * CANVAS);
            // grid like the in-game map
            ctx.strokeStyle = "rgba(0, 0, 0, 0.12)";
            ctx.lineWidth = 1;
            const step = (64 / size) * CANVAS;
            for (let x = step; x < CANVAS; x += step) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, CANVAS);
                ctx.moveTo(0, x);
                ctx.lineTo(CANVAS, x);
                ctx.stroke();
            }

            placements.forEach((p, i) => {
                const f = footprint(p.type);
                const w = Math.max(6, f.w * CANVAS);
                const h = Math.max(6, f.h * CANVAS);
                const sel = !isPlaces && i === this.layoutSelected;
                ctx.fillStyle = sel ? "rgba(124, 252, 0, 0.75)" : isCustomMapBuilding(p.type) ? "rgba(90, 60, 40, 0.85)" : "rgba(60, 60, 60, 0.85)";
                ctx.strokeStyle = sel ? "#fff" : "rgba(0, 0, 0, 0.6)";
                ctx.fillRect(p.x * CANVAS - w / 2, p.y * CANVAS - h / 2, w, h);
                ctx.strokeRect(p.x * CANVAS - w / 2, p.y * CANVAS - h / 2, w, h);
            });

            ctx.font = "bold 13px Roboto Condensed, Arial, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            places.forEach((p, i) => {
                const sel = isPlaces && i === this.layoutSelected;
                ctx.lineWidth = 3;
                ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
                ctx.strokeText(p.name, p.x * CANVAS, p.y * CANVAS);
                ctx.fillStyle = sel ? "#7cfc00" : isPlaces ? "#fff" : "rgba(255, 255, 255, 0.55)";
                ctx.fillText(p.name, p.x * CANVAS, p.y * CANVAS);
            });
        };
        draw();

        const toMap = (e: MouseEvent) => {
            const r = el.getBoundingClientRect();
            return {
                x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
                y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
            };
        };
        const hit = (pos: { x: number; y: number }) => {
            const list = items();
            for (let i = list.length - 1; i >= 0; i--) {
                const p = list[i];
                let hw = 10 / CANVAS;
                let hh = 10 / CANVAS;
                if (isPlaces) {
                    hw = (ctx.measureText((p as CustomMapPlace).name).width / 2 + 4) / CANVAS;
                } else {
                    const f = footprint((p as { type: string }).type);
                    hw = Math.max(hw, f.w / 2);
                    hh = Math.max(hh, f.h / 2);
                }
                if (Math.abs(pos.x - p.x) <= hw && Math.abs(pos.y - p.y) <= hh) return i;
            }
            return -1;
        };

        const commit = () => this.mutate((c) => {
            if (isPlaces) c.places = places;
            else c.placements = placements;
        });

        if (this.editable) {
            let drag: { idx: number; moved: boolean } | undefined;
            el.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                const idx = hit(toMap(e));
                if (idx < 0) return;
                items().splice(idx, 1);
                this.layoutSelected = -1;
                commit();
            });
            el.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                const pos = toMap(e);
                const idx = hit(pos);
                if (idx >= 0) {
                    this.layoutSelected = idx;
                    drag = { idx, moved: false };
                    draw();
                    return;
                }
                if (isPlaces) {
                    if (places.length >= CUSTOM_MAP_LIMITS.maxPlaces) return;
                    places.push({ name: `Place ${places.length + 1}`, ...pos });
                    this.layoutSelected = places.length - 1;
                } else {
                    if (!this.layoutType || placements.length >= CUSTOM_MAP_LIMITS.maxPlacements) return;
                    placements.push({ type: this.layoutType, ...pos });
                    this.layoutSelected = placements.length - 1;
                }
                commit();
            });
            el.addEventListener("mousemove", (e) => {
                if (!drag) return;
                const item = items()[drag.idx];
                Object.assign(item, toMap(e));
                drag.moved = true;
                draw();
            });
            const end = () => {
                if (drag?.moved) commit();
                drag = undefined;
            };
            el.addEventListener("mouseup", end);
            el.addEventListener("mouseleave", end);
        }

        const left = $("<div/>", { class: "custom-map-layout-map" });
        left.append(canvas);
        left.append($("<div/>", {
            class: "loadout-editor-hint",
            text: isPlaces
                ? "Click the map to add a place name, drag to move, right-click to remove."
                : "Click the map to place the picked object, drag to move, right-click to remove. Objects move a little if the spot is blocked (river, other building).",
        }));
        wrap.append(left);

        // -- side panel --
        const side = $("<div/>", { class: "custom-map-layout-side" });
        side.append(this.chips(
            [{ id: "objects", label: `Placed (${placements.length})` }, { id: "places", label: "Place names" }],
            this.layoutMode,
            (v) => {
                this.layoutMode = v;
                this.layoutSelected = -1;
                this.render();
            },
        ));

        if (isPlaces) {
            side.append(this.field("Names", this.chips(
                [{ id: "template", label: "Template's" }, { id: "custom", label: "Custom" }],
                cfg.places ? "custom" : "template",
                (v) => this.mutate((c) => {
                    c.places = v === "custom" ? this.layoutPlaces(c).map((p) => ({ ...p })) : undefined;
                }),
            )));
            const list = $("<div/>", { class: "custom-map-list" });
            places.forEach((p, i) => {
                const row = $("<div/>", { class: `custom-map-row${i === this.layoutSelected ? " changed" : ""}` });
                const input = $<HTMLInputElement>("<input/>", {
                    class: "loadout-editor-search",
                    type: "text",
                    maxLength: CUSTOM_MAP_LIMITS.placeNameMaxLen,
                });
                input.val(p.name);
                if (this.editable) {
                    input.on("change", () => {
                        const name = String(input.val()).trim();
                        if (!name) return;
                        places[i].name = name;
                        commit();
                    });
                    input.on("keydown", (e) => {
                        if (e.key === "Enter") input.trigger("blur");
                        e.stopPropagation();
                    });
                } else {
                    input.prop("disabled", true);
                }
                row.append(input);
                if (this.editable) {
                    row.append($("<a/>", { class: "private-lobby-setting-remove", title: "Remove" }).on("click", () => {
                        places.splice(i, 1);
                        this.layoutSelected = -1;
                        commit();
                    }));
                }
                list.append(row);
            });
            if (!places.length) list.append($("<div/>", { class: "loadout-editor-empty", text: "No place names." }));
            side.append(list);
            if (!cfg.places) {
                side.append($("<div/>", { class: "loadout-editor-hint", text: "Editing a name or the map switches to Custom." }));
            }
        } else {
            const search = $<HTMLInputElement>("<input/>", { class: "loadout-editor-search", type: "text", placeholder: "Search objects..." });
            search.val(this.layoutSearch);
            search.on("keydown", (e) => e.stopPropagation());
            const picker = $("<div/>", { class: "custom-map-layout-picker" });
            side.append(this.chips(
                [{ id: "buildings", label: "Buildings" }, { id: "objects", label: "Objects" }],
                this.layoutKind,
                (v) => {
                    this.layoutKind = v;
                    this.render();
                },
            ).addClass("small"));
            const pool = this.layoutKind === "buildings" ? this.wholeBuildings : this.standaloneObjects;
            const fill = () => {
                picker.empty();
                const q = this.layoutSearch.trim().toLowerCase();
                const matches = pool.filter((type) => !q || customMapObjectLabel(type).toLowerCase().includes(q) || type.includes(q));
                for (const type of matches.slice(0, 60)) {
                    const item = $("<div/>", { class: `custom-map-layout-item${type === this.layoutType ? " selected" : ""}` });
                    item.append(objectPreviewImg(type, 64, ""));
                    item.append($("<span/>", { text: customMapObjectLabel(type), title: type }));
                    item.on("click", () => {
                        this.layoutType = type;
                        picker.find(".selected").removeClass("selected");
                        item.addClass("selected");
                    });
                    picker.append(item);
                }
                if (!matches.length) picker.append($("<div/>", { class: "loadout-editor-empty", text: "Nothing matches." }));
            };
            search.on("input", () => {
                this.layoutSearch = search.val() as string;
                fill();
            });
            fill();
            side.append(search, picker);
            if (this.editable && placements.length) {
                side.append($("<a/>", { class: "loadout-editor-clear", text: "Remove all placed objects" }).on("click", () => {
                    this.layoutSelected = -1;
                    this.mutate((c) => {
                        c.placements = [];
                    });
                }));
            }
        }
        wrap.append(side);
        return wrap;
    }

    // ---- buildings ----

    private renderBuildings(cfg: CustomMapConfig) {
        const wrap = $("<div/>");
        wrap.append(this.field("Template buildings", this.chips(
            [{ id: "keep", label: "Keep" }, { id: "drop", label: "Remove all" }],
            cfg.templateBuildings ? "keep" : "drop",
            (v) => this.mutate((c) => {
                c.templateBuildings = v === "keep";
            }),
        ), "Remove all = only the buildings you set below get placed."));

        const tools = $("<div/>", { class: "loadout-editor-tools" });
        tools.append(this.chips(
            [
                { id: "all", label: "All" },
                { id: "template", label: "In template" },
                { id: "changed", label: "Changed" },
            ],
            this.listFilter,
            (v) => {
                this.listFilter = v;
                this.render();
            },
        ).addClass("small"));
        const search = $<HTMLInputElement>("<input/>", { class: "loadout-editor-search", type: "text", placeholder: "Search buildings..." });
        search.val(this.search);
        search.on("keydown", (e) => e.stopPropagation());
        tools.append(search);
        wrap.append(tools);

        const grid = $("<div/>", { class: "custom-map-building-grid" });
        const fill = () => {
            grid.empty();
            if (!this.wholeBuildings.length) {
                if (this.templatesLoading) {
                    grid.append($("<div/>", { class: "loadout-editor-empty", html: '<div class="ui-spinner"></div>' }));
                    return;
                }
                const retry = $("<button/>", { class: "btn-hollow", text: "Retry" }).on("click", () => {
                    this.templates = [];
                    this.loadTemplates();
                    this.render();
                });
                grid.append(
                    $("<div/>", { class: "loadout-editor-empty", text: "Couldn't load buildings. " }).append(retry),
                );
                return;
            }
            const q = this.search.trim().toLowerCase();
            const items = this.wholeBuildings.filter((type) => {
                if (q && !customMapObjectLabel(type).toLowerCase().includes(q) && !type.includes(q)) return false;
                if (this.listFilter === "changed") return type in cfg.spawns;
                if (this.listFilter === "template") return !!this.templateInfo(type);
                return true;
            });
            for (const type of items) grid.append(this.renderBuildingTile(cfg, type));
            if (!items.length) grid.append($("<div/>", { class: "loadout-editor-empty", text: "Nothing matches." }));
        };
        search.on("input", () => {
            this.search = search.val() as string;
            fill();
        });
        fill();
        wrap.append(grid);
        return wrap;
    }

    private renderBuildingTile(cfg: CustomMapConfig, type: string) {
        const changed = type in cfg.spawns;
        const tile = $("<div/>", { class: `custom-map-building${changed ? " changed" : ""}` });
        tile.append(objectPreviewImg(type, 96, "custom-map-building-img"));
        tile.append($("<div/>", { class: "custom-map-row-name", text: customMapObjectLabel(type), title: type }));
        const tpl = this.templateInfo(type);
        tile.append($("<div/>", { class: "custom-map-row-meta", text: tpl ? `template: ${tpl}` : "not in template" }));
        const fixed = this.template()?.fixedSpawns[type];
        tile.append(this.stepper(cfg.spawns[type], typeof fixed === "number" ? String(fixed) : "0", CUSTOM_MAP_LIMITS.maxBuildingCount, 1, (v) =>
            this.mutate((c) => {
                if (v === undefined) delete c.spawns[type];
                else c.spawns[type] = v;
            })));
        if (changed && this.editable) {
            const reset = $("<a/>", { class: "custom-map-row-reset", text: "reset" });
            reset.on("click", () => this.mutate((c) => {
                delete c.spawns[type];
            }));
            tile.append(reset);
        }
        return tile;
    }

    // ---- loot pools ----

    private lootTemplate(cfg: CustomMapConfig): Record<string, CustomMapLootEntry[]> | undefined {
        const data = this.lootData[cfg.template];
        if (data || this.lootLoading.has(cfg.template)) return data;
        this.lootLoading.add(cfg.template);
        fetch(api.resolveUrl(`/api/custom-map/loot?template=${encodeURIComponent(cfg.template)}`), { cache: "no-cache" })
            .then((r) => r.json())
            .then((res: { lootTable?: Record<string, CustomMapLootEntry[]> }) => {
                this.lootData[cfg.template] = res.lootTable ?? {};
                this.render();
            })
            .catch(() => {})
            .finally(() => this.lootLoading.delete(cfg.template));
        return undefined;
    }

    private pool(cfg: CustomMapConfig, tier: string): CustomMapLootEntry[] {
        return cfg.loot[tier] ?? this.lootData[cfg.template]?.[tier] ?? [];
    }

    /** Edits copy the template pool into the config on first touch. */
    private editPool(tier: string, fn: (entries: CustomMapLootEntry[]) => void) {
        this.mutate((c) => {
            const before = this.pool(c, tier);
            const entries = structuredClone(before);
            fn(entries);
            // a new pool starts as a lone "Nothing" placeholder; the first real
            // entry replaces it
            const own = !(tier in (this.lootData[c.template] ?? {}));
            if (own && before.length === 1 && before[0].name === "" && entries.length > 1 && entries[0].name === "") {
                entries.shift();
            }
            c.loot[tier] = entries;
        });
    }

    private renderLoot(cfg: CustomMapConfig) {
        const wrap = $("<div/>", { class: "custom-map-loot" });
        const data = this.lootTemplate(cfg);
        if (!data) {
            wrap.append($("<div/>", { class: "loadout-editor-empty", html: '<div class="ui-spinner"></div>' }));
            return wrap;
        }
        const tiers = Object.keys({ ...data, ...cfg.loot });
        if (!tiers.includes(this.lootTier)) this.lootTier = tiers.includes("tier_guns") ? "tier_guns" : tiers[0];

        const side = $("<div/>", { class: "custom-map-pools" });
        const own = tiers.filter((t) => !(t in data)).sort();
        if (own.length) {
            side.append($("<div/>", { class: "loadout-editor-subtitle", text: "Your pools" }));
            for (const tier of own) side.append(this.poolItem(cfg, tier));
        }
        if (this.editable) side.append(this.renderNewPool(cfg, tiers));
        side.append($("<div/>", { class: "loadout-editor-subtitle", text: "Loot pools" }));
        const key = KEY_POOLS.filter((t) => tiers.includes(t));
        const shown = this.lootShowAll ? [...key, ...tiers.filter((t) => !key.includes(t) && !own.includes(t)).sort()] : key;
        for (const tier of shown) side.append(this.poolItem(cfg, tier));
        const more = $("<a/>", {
            class: "custom-map-row-reset",
            text: this.lootShowAll ? "Show main pools only" : `Show all ${tiers.length} pools`,
        });
        more.on("click", () => {
            this.lootShowAll = !this.lootShowAll;
            this.render();
        });
        side.append(more);
        wrap.append(side);
        wrap.append(this.renderPoolDetail(cfg, this.lootTier, tiers));
        return wrap;
    }

    private poolItem(cfg: CustomMapConfig, tier: string) {
        const item = $("<div/>", {
            class: `custom-map-pool${tier === this.lootTier ? " selected" : ""}${tier in cfg.loot ? " changed" : ""}`,
            text: poolLabel(tier),
            title: tier,
        });
        item.on("click", () => {
            this.lootTier = tier;
            this.lootSearch = "";
            this.render();
        });
        return item;
    }

    /** "+ New pool": a name becomes tier_<name>, starting empty (drops nothing). */
    private renderNewPool(cfg: CustomMapConfig, tiers: string[]) {
        const wrap = $("<div/>", { class: "custom-map-new-pool" });
        const input = $<HTMLInputElement>("<input/>", { class: "loadout-editor-search", type: "text", placeholder: "+ New pool name", maxLength: 30 });
        const create = () => {
            const slug = String(input.val()).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
            if (!slug) return;
            const tier = `tier_${slug}`;
            this.lootTier = tier;
            if (tiers.includes(tier)) {
                this.render();
                return;
            }
            if (Object.keys(cfg.loot).length >= CUSTOM_MAP_LIMITS.maxLootPools) return;
            this.mutate((c) => {
                c.loot[tier] = [{ name: "", count: 1, weight: 1 }];
            });
        };
        input.on("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") create();
        });
        wrap.append(input);
        return wrap;
    }

    private renderPoolDetail(cfg: CustomMapConfig, tier: string, tiers: string[]) {
        const detail = $("<div/>", { class: "custom-map-pool-detail" });
        const head = $("<div/>", { class: "custom-map-pool-head" });
        head.append($("<div/>", { class: "custom-map-field-label", text: poolLabel(tier) }));
        head.append($("<span/>", { class: "custom-map-row-meta", text: tier }));
        const ownPool = !(tier in (this.lootData[cfg.template] ?? {}));
        if (tier in cfg.loot && this.editable) {
            const reset = $("<a/>", { class: "custom-map-row-reset", text: ownPool ? "delete pool" : "reset pool" });
            reset.on("click", () => this.mutate((c) => {
                delete c.loot[tier];
                if (!ownPool) return;
                // nothing may keep rolling a pool that is gone
                for (const [type, rolls] of Object.entries(c.objectLoot)) {
                    c.objectLoot[type] = rolls.filter((r) => r.tier !== tier);
                }
                for (const entries of Object.values(c.loot)) {
                    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].name === tier) entries.splice(i, 1);
                }
            }));
            head.append(reset);
        }
        detail.append(head);
        detail.append($("<div/>", {
            class: "loadout-editor-hint",
            text: "Each roll picks one entry by weight. Entries pointing at another pool roll that pool instead.",
        }));

        const entries = this.pool(cfg, tier);
        const total = entries.reduce((n, e) => n + e.weight, 0) || 1;
        const rows = $("<div/>", { class: "custom-map-list" });
        entries.forEach((e, i) => {
            const row = $("<div/>", { class: "custom-map-row custom-map-loot-row" });
            const isTier = e.name.startsWith("tier_");
            if (!e.name) {
                row.append($("<div/>", { class: "custom-map-loot-icon loadout-editor-img-none", html: "&#8709;" }));
            } else if (isTier) {
                row.append($("<div/>", { class: "custom-map-loot-icon custom-map-loot-tier", html: "&#8618;" }));
            } else {
                row.append($("<div/>", {
                    class: "custom-map-loot-icon",
                    css: { "background-image": `url('${helpers.getSvgFromGameType(e.name)}')` },
                }));
            }
            const info = $("<div/>", { class: "custom-map-row-info" });
            const name = $("<div/>", { class: "custom-map-row-name", text: !e.name ? "Nothing" : isTier ? `Pool: ${poolLabel(e.name)}` : itemLabel(e.name) });
            if (isTier && tiers.includes(e.name)) {
                name.addClass("custom-map-link");
                name.on("click", () => {
                    this.lootTier = e.name;
                    this.render();
                });
            }
            info.append(name);
            info.append($("<div/>", { class: "custom-map-row-meta", text: `${((e.weight / total) * 100).toFixed(e.weight / total < 0.01 ? 2 : 1)}% chance` }));
            row.append(info);

            if (e.name && !isTier) {
                const count = $("<div/>", { class: "custom-map-row-control" });
                count.append($("<span/>", { class: "custom-map-row-label", text: "count" }));
                count.append(this.numberInput(e.count, 1, CUSTOM_MAP_LIMITS.maxLootCount, (v) =>
                    this.editPool(tier, (list) => {
                        list[i].count = v;
                    })));
                row.append(count);
            }
            const weight = $("<div/>", { class: "custom-map-row-control" });
            weight.append($("<span/>", { class: "custom-map-row-label", text: "weight" }));
            weight.append(this.numberInput(e.weight, 0, CUSTOM_MAP_LIMITS.maxLootWeight, (v) =>
                this.editPool(tier, (list) => {
                    list[i].weight = v;
                })));
            row.append(weight);
            if (this.editable) {
                const rm = $("<a/>", { class: "private-lobby-setting-remove", title: "Remove" });
                rm.on("click", () => this.editPool(tier, (list) => {
                    list.splice(i, 1);
                }));
                row.append(rm);
            }
            rows.append(row);
        });
        detail.append(rows);
        if (this.editable) detail.append(this.renderAddLoot(cfg, tier, tiers));
        detail.append(this.renderPoolOutcome(cfg, tier));
        detail.append(this.renderDroppedBy(cfg, tier));
        return detail;
    }

    /** Chance per roll of every final item, with pools pointing at pools followed through. */
    private resolvePool(cfg: CustomMapConfig, tier: string) {
        const out = new Map<string, number>();
        const walk = (t: string, p: number, stack: string[]) => {
            if (stack.includes(t) || stack.length > 8) return; // loops get cut on the server too
            const entries = this.pool(cfg, t);
            const total = entries.reduce((n, e) => n + Math.max(0, e.weight), 0);
            if (total <= 0) {
                out.set("", (out.get("") ?? 0) + p);
                return;
            }
            for (const e of entries) {
                const q = (p * Math.max(0, e.weight)) / total;
                if (q <= 0) continue;
                if (e.name.startsWith("tier_")) walk(e.name, q, [...stack, t]);
                else out.set(e.name, (out.get(e.name) ?? 0) + q);
            }
        };
        walk(tier, 1, []);
        return [...out.entries()].sort((a, b) => b[1] - a[1]);
    }

    private renderPoolOutcome(cfg: CustomMapConfig, tier: string) {
        const wrap = $("<div/>", { class: "custom-map-pool-section" });
        wrap.append($("<div/>", { class: "custom-map-section-title", text: "What one roll drops" }));
        const resolved = this.resolvePool(cfg, tier);
        const nested = this.pool(cfg, tier).some((e) => e.name.startsWith("tier_"));
        wrap.append($("<div/>", {
            class: "loadout-editor-hint",
            text: nested ? "Pools inside this pool already worked in." : "Same as the list above, as final chances.",
        }));
        const grid = $("<div/>", { class: "custom-map-outcome" });
        const LIMIT = 24;
        for (const [name, p] of resolved.slice(0, LIMIT)) {
            const item = $("<div/>", { class: "custom-map-outcome-item", title: name || "nothing" });
            item.append(name
                ? $("<div/>", { class: "custom-map-loot-icon", css: { "background-image": `url('${helpers.getSvgFromGameType(name)}')` } })
                : $("<div/>", { class: "custom-map-loot-icon loadout-editor-img-none", html: "&#8709;" }));
            item.append($("<span/>", { text: name ? itemLabel(name) : "Nothing" }));
            item.append($("<b/>", { text: `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%` }));
            grid.append(item);
        }
        if (resolved.length > LIMIT) {
            grid.append($("<div/>", { class: "custom-map-row-meta", text: `+ ${resolved.length - LIMIT} more, each under ${(resolved[LIMIT][1] * 100).toFixed(2)}%` }));
        }
        wrap.append(grid);
        return wrap;
    }

    /** The objects (crates, containers, ground loot spots...) that roll this pool, editable. */
    private renderDroppedBy(cfg: CustomMapConfig, tier: string) {
        const wrap = $("<div/>", { class: "custom-map-pool-section" });
        wrap.append($("<div/>", { class: "custom-map-section-title", text: "Dropped by" }));
        const rolls = (c: CustomMapConfig, type: string) => c.objectLoot[type] ?? defaultObjectLoot(type);
        const users = LOOT_OBJECTS.filter((type) => rolls(cfg, type).some((r) => r.tier === tier));
        const inMap = new Set(Object.keys({ ...this.template()?.fixedSpawns, ...this.template()?.densitySpawns }));
        users.sort((a, b) => Number(inMap.has(b)) - Number(inMap.has(a)) || byLabel(a, b));
        wrap.append($("<div/>", {
            class: "loadout-editor-hint",
            text: "Opening one rolls this pool min-max times. Changing it here changes that object everywhere on this map (also inside buildings).",
        }));

        const editRolls = (type: string, fn: (list: CustomMapObjectLoot[]) => void) => this.mutate((c) => {
            const list = structuredClone(rolls(c, type));
            fn(list);
            c.objectLoot[type] = list;
        });

        const list = $("<div/>", { class: "custom-map-list" });
        const LIMIT = 40;
        for (const type of users.slice(0, LIMIT)) {
            const idx = rolls(cfg, type).findIndex((r) => r.tier === tier);
            const r = rolls(cfg, type)[idx];
            const row = $("<div/>", { class: `custom-map-row${type in cfg.objectLoot ? " changed" : ""}` });
            row.append(objectPreviewImg(type, 64, "custom-map-loot-icon"));
            const info = $("<div/>", { class: "custom-map-row-info" });
            info.append($("<div/>", { class: "custom-map-row-name", text: customMapObjectLabel(type), title: type }));
            const others = rolls(cfg, type).filter((x) => x.tier !== tier).map((x) => poolLabel(x.tier));
            info.append($("<div/>", {
                class: "custom-map-row-meta",
                text: [inMap.has(type) ? "on this map" : "", others.length ? `also: ${others.join(", ")}` : ""].filter(Boolean).join(" · ") || " ",
            }));
            row.append(info);
            const L = CUSTOM_MAP_LIMITS;
            const min = $("<div/>", { class: "custom-map-row-control" });
            min.append($("<span/>", { class: "custom-map-row-label", text: "min" }));
            min.append(this.numberInput(r.min, 0, L.maxObjectLootRolls, (v) => editRolls(type, (l) => {
                l[idx].min = Math.round(v);
                l[idx].max = Math.max(l[idx].max, l[idx].min);
            })));
            const max = $("<div/>", { class: "custom-map-row-control" });
            max.append($("<span/>", { class: "custom-map-row-label", text: "max" }));
            max.append(this.numberInput(r.max, 0, L.maxObjectLootRolls, (v) => editRolls(type, (l) => {
                l[idx].max = Math.round(v);
                l[idx].min = Math.min(l[idx].min, l[idx].max);
            })));
            row.append(min, max);
            if (this.editable) {
                row.append($("<a/>", { class: "private-lobby-setting-remove", title: "Stop dropping this pool" }).on("click", () =>
                    editRolls(type, (l) => {
                        l.splice(idx, 1);
                    })));
                if (type in cfg.objectLoot) {
                    row.append($("<a/>", { class: "custom-map-row-reset", text: "reset" }).on("click", () => this.mutate((c) => {
                        delete c.objectLoot[type];
                    })));
                }
            }
            list.append(row);
        }
        if (users.length > LIMIT) list.append($("<div/>", { class: "loadout-editor-empty", text: `${users.length - LIMIT} more objects use this pool.` }));
        if (!users.length) list.append($("<div/>", { class: "loadout-editor-empty", text: "Nothing drops this pool yet - add an object below." }));
        wrap.append(list);

        if (this.editable) {
            const search = $<HTMLInputElement>("<input/>", { class: "loadout-editor-search", type: "text", placeholder: "+ Let an object drop this pool (search crates, containers...)" });
            const results = $("<div/>", { class: "custom-map-layout-picker" });
            search.on("keydown", (e) => e.stopPropagation());
            search.on("input", () => {
                results.empty();
                const q = String(search.val()).trim().toLowerCase();
                if (!q) return;
                const matches = LOOT_OBJECTS.filter((type) =>
                    !users.includes(type) && (customMapObjectLabel(type).toLowerCase().includes(q) || type.includes(q))).slice(0, 20);
                for (const type of matches) {
                    const item = $("<div/>", { class: "custom-map-layout-item" });
                    item.append(objectPreviewImg(type, 64, ""));
                    item.append($("<span/>", { text: customMapObjectLabel(type), title: type }));
                    item.on("click", () => editRolls(type, (l) => {
                        if (l.length < CUSTOM_MAP_LIMITS.maxObjectLootEntries) l.push({ tier, min: 1, max: 1 });
                    }));
                    results.append(item);
                }
                if (!matches.length) results.append($("<div/>", { class: "loadout-editor-empty", text: "Nothing matches." }));
            });
            wrap.append(search, results);
        }
        return wrap;
    }

    private numberInput(value: number, min: number, max: number, onSet: (v: number) => void) {
        const input = $<HTMLInputElement>("<input/>", { class: "loadout-editor-count custom-map-number", type: "number", min, max, step: "any" });
        input.val(value);
        if (this.editable) {
            input.on("change", () => onSet(Math.max(min, Math.min(max, Number(input.val()) || 0))));
            input.on("keydown", (e) => e.stopPropagation());
        } else {
            input.prop("disabled", true);
        }
        return input;
    }

    private renderAddLoot(cfg: CustomMapConfig, tier: string, tiers: string[]) {
        const add = $("<div/>", { class: "custom-map-add-loot" });
        const tools = $("<div/>", { class: "loadout-editor-tools" });
        const search = $<HTMLInputElement>("<input/>", { class: "loadout-editor-search", type: "text", placeholder: "Add item: search..." });
        search.val(this.lootSearch);
        search.on("keydown", (e) => e.stopPropagation());
        tools.append(search);
        const nothing = $("<a/>", { class: "loadout-editor-chip", text: "+ Nothing" });
        nothing.on("click", () => this.editPool(tier, (list) => {
            list.push({ name: "", count: 1, weight: 1 });
        }));
        tools.append(nothing);
        const poolSelect = $<HTMLSelectElement>("<select/>", { class: "custom-map-select custom-map-pool-select" });
        poolSelect.append($("<option/>", { value: "", text: "+ Pool..." }));
        for (const t of tiers.filter((t) => t !== tier).sort()) poolSelect.append($("<option/>", { value: t, text: poolLabel(t) }));
        poolSelect.on("change", () => {
            const t = poolSelect.val() as string;
            if (t) this.editPool(tier, (list) => {
                list.push({ name: t, count: 1, weight: 1 });
            });
        });
        tools.append(poolSelect);
        add.append(tools);

        const results = $("<div/>", { class: "loadout-editor-grid compact" });
        const fill = () => {
            results.empty();
            const q = this.lootSearch.trim().toLowerCase();
            if (!q) return;
            const matches = LOOT_ITEMS.filter((t) => itemLabel(t).toLowerCase().includes(q) || t.includes(q)).slice(0, 24);
            for (const type of matches) {
                const tile = $("<div/>", {
                    class: "loadout-editor-tile",
                    title: type,
                    html: `<div class="loadout-editor-img" style="background-image:url('${helpers.getSvgFromGameType(type)}')"></div><div class="loadout-editor-tile-name">${helpers.htmlEscape(itemLabel(type))}</div>`,
                });
                tile.on("click", () => {
                    this.lootSearch = "";
                    this.editPool(tier, (list) => {
                        list.push({ name: type, count: 1, weight: 1 });
                    });
                });
                results.append(tile);
            }
            if (!matches.length) results.append($("<div/>", { class: "loadout-editor-empty", text: "No item matches." }));
        };
        search.on("input", () => {
            this.lootSearch = search.val() as string;
            fill();
        });
        fill();
        add.append(results);
        return add;
    }

    private templateInfo(type: string): string {
        const t = this.template();
        if (!t) return "";
        const fixed = t.fixedSpawns[type];
        const parts: string[] = [];
        if (typeof fixed === "number") parts.push(`${fixed}`);
        else if (fixed && "odds" in fixed) parts.push(`${Math.round(fixed.odds * 100)}% chance`);
        else if (fixed) parts.push(`${fixed.small}/${fixed.large}`);
        if (t.densitySpawns[type] !== undefined) parts.push(`density ${t.densitySpawns[type]}`);
        if (t.randomSpawns.some((r) => r.spawns.includes(type))) parts.push("random pool");
        return parts.join(" · ");
    }

    private renderObjectList(
        cfg: CustomMapConfig,
        pool: string[],
        opts: { hint: string; withDensity?: boolean },
    ) {
        const wrap = $("<div/>");
        wrap.append($("<div/>", { class: "loadout-editor-hint", text: opts.hint }));

        const tools = $("<div/>", { class: "loadout-editor-tools" });
        tools.append(this.chips(
            [
                { id: "all", label: "All" },
                { id: "template", label: "In template" },
                { id: "changed", label: "Changed" },
            ],
            this.listFilter,
            (v) => {
                this.listFilter = v;
                this.render();
            },
        ).addClass("small"));
        const search = $<HTMLInputElement>("<input/>", { class: "loadout-editor-search", type: "text", placeholder: "Search..." });
        search.val(this.search);
        search.on("keydown", (e) => e.stopPropagation());
        tools.append(search);
        wrap.append(tools);

        const list = $("<div/>", { class: "custom-map-list" });
        const fill = () => {
            list.empty();
            const q = this.search.trim().toLowerCase();
            const items = pool.filter((type) => {
                if (q && !customMapObjectLabel(type).toLowerCase().includes(q) && !type.includes(q)) return false;
                if (this.listFilter === "changed") return type in cfg.spawns || type in cfg.densityOverrides;
                if (this.listFilter === "template") return !!this.templateInfo(type);
                return true;
            });
            for (const type of items.slice(0, LIST_LIMIT)) list.append(this.renderObjectRow(cfg, type, !!opts.withDensity));
            if (items.length > LIST_LIMIT) {
                list.append($("<div/>", {
                    class: "loadout-editor-empty",
                    text: `${items.length - LIST_LIMIT} more - search to narrow it down.`,
                }));
            }
            if (!items.length) list.append($("<div/>", { class: "loadout-editor-empty", text: "Nothing matches." }));
        };
        search.on("input", () => {
            this.search = search.val() as string;
            fill();
        });
        fill();
        wrap.append(list);
        return wrap;
    }

    /** Objects tab: standalone objects, plus anything already set on this map. */
    private objectsTabList(cfg: CustomMapConfig) {
        const set = new Set(this.standaloneObjects);
        for (const type of [...Object.keys(cfg.spawns), ...Object.keys(cfg.densityOverrides)]) {
            if (!isCustomMapBuilding(type)) set.add(type);
        }
        return [...set].sort(byLabel);
    }

    private renderObjectRow(cfg: CustomMapConfig, type: string, withDensity: boolean) {
        const changed = type in cfg.spawns || type in cfg.densityOverrides;
        const row = $("<div/>", { class: `custom-map-row${changed ? " changed" : ""}` });
        row.append(objectPreviewImg(type, 64, "custom-map-loot-icon"));
        const info = $("<div/>", { class: "custom-map-row-info" });
        info.append($("<div/>", { class: "custom-map-row-name", text: customMapObjectLabel(type) }));
        const tpl = this.templateInfo(type);
        info.append($("<div/>", { class: "custom-map-row-meta", text: tpl ? `template: ${tpl}` : "not in template" }));
        row.append(info);

        const fixed = this.template()?.fixedSpawns[type];
        const placeholder = typeof fixed === "number" ? String(fixed) : "0";
        const L = CUSTOM_MAP_LIMITS;
        const amount = $("<div/>", { class: "custom-map-row-control" });
        amount.append($("<span/>", { class: "custom-map-row-label", text: "amount" }));
        amount.append(this.stepper(cfg.spawns[type], placeholder, L.maxSpawnCount, 1, (v) =>
            this.mutate((c) => {
                if (v === undefined) delete c.spawns[type];
                else c.spawns[type] = v;
            })));
        row.append(amount);

        if (withDensity) {
            const tplDensity = this.template()?.densitySpawns[type];
            const density = $("<div/>", { class: "custom-map-row-control" });
            density.append($("<span/>", { class: "custom-map-row-label", text: "density" }));
            density.append(this.stepper(cfg.densityOverrides[type], tplDensity !== undefined ? String(tplDensity) : "0", L.maxDensityOverride, 5, (v) =>
                this.mutate((c) => {
                    if (v === undefined) delete c.densityOverrides[type];
                    else c.densityOverrides[type] = v;
                })));
            row.append(density);
        }

        if (changed && this.editable) {
            const reset = $("<a/>", { class: "custom-map-row-reset", text: "reset", title: "Back to the template's amount" });
            reset.on("click", () => this.mutate((c) => {
                delete c.spawns[type];
                delete c.densityOverrides[type];
            }));
            row.append(reset);
        }
        return row;
    }
}
