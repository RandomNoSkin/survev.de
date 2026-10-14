import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/register";
import {
    baseWeaponStat,
    validateWeaponStats,
    validateWeaponStatsProfile,
    WEAPON_STAT_FIELDS,
    WEAPON_STATS_MAX_PROFILES,
    WEAPON_STATS_NAME_MAX_LEN,
    type WeaponStats,
    type WeaponStatsProfile,
    skinLabel,
    weaponKind,
    weaponSkinBase,
    weaponSkins,
    weaponVariantLabel,
} from "../../../shared/defs/weaponStats";
import type { ConfigManager } from "../config";
import { helpers } from "../helpers";

export interface WeaponStatsHost {
    config: ConfigManager;
    isLeader(): boolean;
    /** The profile the lobby uses (members only get to look at this one). */
    getActive(): WeaponStatsProfile | undefined;
    /** undefined = the lobby stops changing weapon stats */
    setActive(profile: WeaponStatsProfile | undefined): void;
}

type Filter = "gun" | "melee" | "changed";

const weaponName = (type: string) =>
    (GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined)?.name ?? type;

/** Every gun and melee weapon, by name - skins not (they follow their weapon). */
const WEAPONS = GameObjectDefs.getAllTypes()
    .filter((type) => weaponKind(type) !== undefined && !weaponSkinBase(type))
    .sort((a, b) => weaponName(a).localeCompare(weaponName(b)));

const fmt = (v: number | undefined) =>
    v === undefined ? "-" : String(Math.round(v * 1000) / 1000);

/** Advanced Settings: saved weapon stat profiles (per browser); the leader picks one for the lobby. */
export class WeaponStatsModal {
    private root: JQuery<HTMLElement>;
    private open_ = false;
    private filter: Filter = "gun";
    private search = "";
    private weapon = WEAPONS.find((t) => t === "ak47") ?? WEAPONS[0];
    private selected = 0;
    private deleteArmedUntil = 0;

    constructor(private host: WeaponStatsHost) {
        this.root = $("<div/>", { class: "loadout-editor-overlay weapon-stats-overlay" });
        this.root.on("mousedown", (e) => {
            if (e.target === this.root[0]) this.close();
        });
        $(document).on("keydown.weaponStats", (e) => {
            if (this.open_ && e.key === "Escape") this.close();
        });
        $("body").append(this.root);
    }

    get isOpen() {
        return this.open_;
    }

    open() {
        this.open_ = true;
        // start on the profile the lobby uses
        const active = this.host.getActive();
        const idx = active ? this.saved().findIndex((p) => p.name === active.name) : -1;
        if (idx >= 0) this.selected = idx;
        this.selected = Math.min(this.selected, Math.max(0, this.saved().length - 1));
        this.root.css("display", "flex");
        this.render();
    }

    close() {
        this.open_ = false;
        this.root.css("display", "none").empty();
    }

    refresh() {
        if (!this.open_) return;
        // lobby state arriving mid-typing would rebuild the field away
        const el = document.activeElement;
        if (el instanceof HTMLInputElement && this.root[0].contains(el) && !el.classList.contains("loadout-editor-search")) {
            return;
        }
        this.render();
    }

    // ---- data ----

    private saved(): WeaponStatsProfile[] {
        const list = this.host.config.get("weaponStatsProfiles");
        return Array.isArray(list) ? list.map((p) => validateWeaponStatsProfile(p)) : [];
    }

    private save(list: WeaponStatsProfile[]) {
        this.host.config.set("weaponStatsProfiles", list);
    }

    private get editable() {
        return this.host.isLeader();
    }

    /** What the editor shows: the selected saved profile (leader) or the lobby's. */
    private current(): WeaponStatsProfile | undefined {
        if (!this.editable) return this.host.getActive();
        return this.saved()[this.selected];
    }

    private isActive(profile: WeaponStatsProfile | undefined) {
        const active = this.host.getActive();
        return !!profile && !!active && active.name === profile.name;
    }

    private mutateProfile(fn: (profile: WeaponStatsProfile) => void) {
        if (!this.editable) return;
        const list = this.saved();
        const profile = list[this.selected];
        if (!profile) return;
        // checked before the change: a rename keeps the lobby on this profile
        const wasActive = this.isActive(profile);
        fn(profile);
        for (const [type, o] of Object.entries(profile.stats)) {
            if (!Object.keys(o).length) delete profile.stats[type];
        }
        list[this.selected] = validateWeaponStatsProfile(profile);
        this.save(list);
        // keep the lobby in sync while editing the profile it uses
        if (wasActive) this.host.setActive(list[this.selected]);
        this.render();
    }

    private mutate(fn: (stats: WeaponStats) => void) {
        this.mutateProfile((p) => fn(p.stats));
    }

    private createProfile(from?: WeaponStatsProfile) {
        const list = this.saved();
        if (list.length >= WEAPON_STATS_MAX_PROFILES) return;
        const names = new Set(list.map((p) => p.name));
        const base = from ? `${from.name} copy` : "Weapon stats";
        let name = base.slice(0, WEAPON_STATS_NAME_MAX_LEN);
        for (let n = 2; names.has(name); n++) name = `${base.slice(0, WEAPON_STATS_NAME_MAX_LEN - 4)} ${n}`;
        const profile = validateWeaponStatsProfile({ name, stats: from ? structuredClone(from.stats) : {} });
        if (from) list.splice(this.selected + 1, 0, profile);
        else list.push(profile);
        this.save(list);
        this.selected = from ? this.selected + 1 : list.length - 1;
        this.render();
    }

    // ---- rendering ----

    private render() {
        if (!this.open_) return;
        const listScroll = this.root.find(".weapon-stats-list").scrollTop() ?? 0;
        const focusedSearch = document.activeElement?.classList.contains("loadout-editor-search");
        const profile = this.current();

        const modal = $("<div/>", { class: "loadout-editor weapon-stats-editor" });
        const header = $("<div/>", { class: "loadout-editor-header" });
        header.append($("<div/>", { class: "loadout-editor-title", text: "Weapon Stats" }));
        header.append($("<a/>", { class: "loadout-editor-close", html: "&times;" }).on("click", () => this.close()));
        modal.append(header);

        const body = $("<div/>", { class: "loadout-editor-body" });
        body.append(this.renderProfiles());
        if (profile) {
            const stats = validateWeaponStats(profile.stats);
            body.append(this.renderList(profile, stats));
            body.append($("<div/>", { class: "loadout-editor-content weapon-stats-detail" }).append(this.renderDetail(stats)));
        } else {
            const empty = $("<div/>", { class: "loadout-editor-empty custom-map-empty weapon-stats-empty" });
            if (this.editable) {
                empty.text("No saved weapon stats yet.");
                empty.append($("<a/>", { class: "btn-green btn-darken menu-option custom-map-create", text: "Create profile" })
                    .on("click", () => this.createProfile()));
            } else {
                empty.text("The lobby doesn't change weapon stats.");
            }
            body.append(empty);
        }
        modal.append(body);
        modal.append(this.renderFooter(profile));

        this.root.empty().append(modal);
        this.root.find(".weapon-stats-list").scrollTop(listScroll);
        if (focusedSearch) {
            const input = this.root.find<HTMLInputElement>(".loadout-editor-search")[0];
            input?.focus();
            input?.setSelectionRange(input.value.length, input.value.length);
        }
    }

    private renderProfiles() {
        const side = $("<div/>", { class: "loadout-editor-nav custom-map-saved weapon-stats-profiles" });
        if (!this.editable) {
            const active = this.host.getActive();
            side.append($("<div/>", { class: "loadout-editor-subtitle", text: "Lobby profile" }));
            if (active) {
                side.append($("<div/>", {
                    class: "custom-map-saved-item active",
                    html: `<div class="custom-map-saved-name">${helpers.htmlEscape(active.name)}</div><div class="custom-map-saved-meta">${changedText(active.stats)}</div>`,
                }));
            }
            return side;
        }
        side.append($("<div/>", { class: "loadout-editor-subtitle", text: "Saved profiles" }));
        this.saved().forEach((p, i) => {
            const item = $("<div/>", {
                class: `custom-map-saved-item${i === this.selected ? " selected" : ""}`,
                html: `<div class="custom-map-saved-name">${helpers.htmlEscape(p.name)}${this.isActive(p) ? ' <span class="custom-map-active-badge">in lobby</span>' : ""}</div><div class="custom-map-saved-meta">${changedText(p.stats)}</div>`,
            });
            item.on("click", () => {
                this.selected = i;
                this.deleteArmedUntil = 0;
                this.render();
            });
            side.append(item);
        });
        if (this.saved().length < WEAPON_STATS_MAX_PROFILES) {
            side.append($("<a/>", { class: "private-lobby-add-loadout-btn custom-map-new", text: "+ New profile" })
                .on("click", () => this.createProfile()));
        }
        return side;
    }

    private renderList(profile: WeaponStatsProfile, stats: WeaponStats) {
        const side = $("<div/>", { class: "loadout-editor-nav weapon-stats-nav" });

        const name = $<HTMLInputElement>("<input/>", {
            class: "loadout-editor-search weapon-stats-name",
            type: "text",
            maxLength: WEAPON_STATS_NAME_MAX_LEN,
            placeholder: "Profile name",
        });
        name.val(profile.name);
        if (this.editable) {
            name.on("change", () => {
                const value = String(name.val()).trim();
                if (!value) {
                    name.val(profile.name);
                    return;
                }
                this.mutateProfile((p) => {
                    p.name = value;
                });
            });
            name.on("keydown", (e) => {
                if (e.key === "Enter") name.trigger("blur");
                e.stopPropagation();
            });
        } else {
            name.prop("disabled", true);
        }
        side.append(name);

        const changedCount = Object.keys(stats).length;
        const chips = $("<div/>", { class: "loadout-editor-chips small" });
        for (const [id, label] of [["gun", "Guns"], ["melee", "Melee"], ["changed", `Changed (${changedCount})`]] as const) {
            chips.append($("<a/>", { class: `loadout-editor-chip${this.filter === id ? " active" : ""}`, text: label }).on("click", () => {
                this.filter = id;
                this.render();
            }));
        }
        side.append(chips);
        const search = $<HTMLInputElement>("<input/>", { class: "loadout-editor-search", type: "text", placeholder: "Search weapons..." });
        search.val(this.search);
        search.on("keydown", (e) => e.stopPropagation());
        side.append(search);

        const list = $("<div/>", { class: "weapon-stats-list" });
        const fill = () => {
            list.empty();
            const q = this.search.trim().toLowerCase();
            const items = WEAPONS.filter((type) => {
                if (q && !weaponName(type).toLowerCase().includes(q) && !type.includes(q)) return false;
                if (this.filter === "changed") return type in stats;
                return weaponKind(type) === this.filter;
            });
            for (const type of items) {
                const item = $("<div/>", {
                    class: `weapon-stats-item${type === this.weapon ? " selected" : ""}${type in stats ? " changed" : ""}`,
                });
                item.append($("<div/>", { class: "weapon-stats-icon", css: { "background-image": `url('${helpers.getSvgFromGameType(type)}')` } }));
                const label = $("<div/>", { class: "weapon-stats-item-label" });
                label.append($("<span/>", { text: weaponName(type), title: type }));
                const variant = weaponVariantLabel(type);
                if (variant) label.append($("<span/>", { class: "custom-map-row-meta", text: variant }));
                item.append(label);
                item.on("click", () => {
                    this.weapon = type;
                    this.render();
                });
                list.append(item);
            }
            if (!items.length) list.append($("<div/>", { class: "loadout-editor-empty", text: this.filter === "changed" ? "No changes yet." : "Nothing matches." }));
        };
        search.on("input", () => {
            this.search = search.val() as string;
            fill();
        });
        fill();
        side.append(list);
        return side;
    }

    private renderDetail(stats: WeaponStats) {
        const type = this.weapon;
        const kind = weaponKind(type);
        const wrap = $("<div/>", { class: "custom-map-form" });
        if (!kind) return wrap;
        const own = stats[type] ?? {};

        const head = $("<div/>", { class: "weapon-stats-head" });
        head.append($("<div/>", { class: "weapon-stats-icon big", css: { "background-image": `url('${helpers.getSvgFromGameType(type)}')` } }));
        const title = $("<div/>");
        title.append($("<div/>", { class: "weapon-stats-title", text: weaponName(type) }));
        const skins = weaponSkins(type).map((s) => skinLabel(s, type));
        title.append($("<div/>", {
            class: "custom-map-row-meta",
            text: [kind === "gun" ? "Gun" : "Melee", weaponVariantLabel(type), skins.length ? `also applies to: ${skins.join(", ")}` : ""]
                .filter(Boolean)
                .join(" · "),
        }));
        head.append(title);
        if (this.editable && type in stats) {
            head.append($("<a/>", { class: "custom-map-row-reset", text: "reset weapon" }).on("click", () =>
                this.mutate((s) => {
                    delete s[type];
                })));
        }
        wrap.append(head);

        for (const f of WEAPON_STAT_FIELDS[kind]) {
            const base = baseWeaponStat(type, f.key);
            if (base === undefined) continue;
            const value = own[f.key];
            const row = $("<div/>", { class: `custom-map-row${value !== undefined ? " changed" : ""}` });
            const info = $("<div/>", { class: "custom-map-row-info" });
            info.append($("<div/>", { class: "custom-map-row-name", text: f.label }));
            info.append($("<div/>", { class: "custom-map-row-meta", text: `normal: ${fmt(base)}${f.unit ?? ""}` }));
            row.append(info);

            const input = $<HTMLInputElement>("<input/>", {
                class: "loadout-editor-count custom-map-number weapon-stats-input",
                type: "number",
                min: f.min,
                max: f.max,
                step: f.step,
                placeholder: fmt(base),
            });
            if (value !== undefined) input.val(value);
            if (this.editable) {
                input.on("change", () => {
                    const raw = String(input.val()).trim();
                    this.mutate((s) => {
                        const o = (s[type] ??= {});
                        if (raw === "" || Number(raw) === base) delete o[f.key];
                        else o[f.key] = Number(raw);
                    });
                });
                input.on("keydown", (e) => {
                    if (e.key === "Enter") input.trigger("blur");
                    e.stopPropagation();
                });
            } else {
                input.prop("disabled", true);
            }
            row.append(input);
            row.append($("<span/>", { class: "custom-map-row-label weapon-stats-unit", text: f.unit ?? "" }));
            if (value !== undefined) {
                row.append($("<span/>", { class: "custom-map-row-meta", text: base ? `${Math.round((value / base) * 100)}%` : "" }));
                if (this.editable) {
                    row.append($("<a/>", { class: "custom-map-row-reset", text: "reset" }).on("click", () =>
                        this.mutate((s) => {
                            delete s[type]?.[f.key];
                        })));
                }
            }
            wrap.append(row);
        }
        wrap.append($("<div/>", {
            class: "loadout-editor-hint",
            text: kind === "gun"
                ? "Empty = normal. Bullet speed and range stay as they are. Dual versions (e.g. Dual M9) are separate weapons."
                : "Empty = normal. The swing animation keeps its own speed.",
        }));
        return wrap;
    }

    private renderFooter(profile: WeaponStatsProfile | undefined) {
        const footer = $("<div/>", { class: "loadout-editor-footer" });
        if (!this.editable) {
            footer.append($("<span/>", { class: "loadout-editor-readonly", text: "Only the lobby leader can change weapon stats." }));
        } else if (profile) {
            const armed = this.deleteArmedUntil > Date.now();
            footer.append($("<a/>", {
                class: `loadout-editor-clear${armed ? " armed" : ""}`,
                text: armed ? "Click again to delete" : "Delete profile",
            }).on("click", () => {
                if (this.deleteArmedUntil > Date.now()) {
                    const list = this.saved();
                    const [removed] = list.splice(this.selected, 1);
                    this.save(list);
                    this.selected = Math.max(0, Math.min(this.selected, list.length - 1));
                    this.deleteArmedUntil = 0;
                    // a deleted profile is gone for the lobby too
                    if (this.isActive(removed)) this.host.setActive(undefined);
                    this.render();
                    return;
                }
                this.deleteArmedUntil = Date.now() + 3000;
                this.render();
                setTimeout(() => {
                    if (this.deleteArmedUntil && this.deleteArmedUntil <= Date.now()) {
                        this.deleteArmedUntil = 0;
                        this.render();
                    }
                }, 3100);
            }));
            const changed = Object.keys(profile.stats).length;
            if (changed) {
                footer.append($("<a/>", { class: "loadout-editor-chip", text: `Reset all (${changed})` }).on("click", () =>
                    this.mutate((s) => {
                        for (const k of Object.keys(s)) delete s[k];
                    })));
            }
            footer.append($("<a/>", { class: "loadout-editor-chip", text: "Duplicate" }).on("click", () => this.createProfile(profile)));
            const inUse = this.isActive(profile);
            const use = $("<a/>", {
                class: `btn-green btn-darken menu-option loadout-editor-done${inUse ? " btn-disabled" : ""}`,
                text: inUse ? "In use" : "Use in lobby",
            });
            if (!inUse) {
                use.on("click", () => {
                    this.host.setActive(validateWeaponStatsProfile(profile));
                    this.render();
                });
            }
            footer.append(use);
        }
        footer.append($("<a/>", { class: "btn-darken menu-option loadout-editor-done custom-map-done", text: "Done" }).on("click", () => this.close()));
        return footer;
    }
}

function changedText(stats: WeaponStats) {
    const n = Object.keys(stats).length;
    return n ? `${n} weapon${n === 1 ? "" : "s"} changed` : "no changes";
}
