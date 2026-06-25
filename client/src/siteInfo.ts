import $ from "jquery";
import { type MapDef, MapDefs } from "../../shared/defs/mapDefs";
import { TeamModeToString } from "../../shared/defs/types/misc";
import type { SiteInfoRes } from "../../shared/types/api";
import { api } from "./api";
import type { ConfigManager } from "./config";
import { device } from "./device";
import type { Localization } from "./ui/localization";

export class SiteInfo {
    info = {} as SiteInfoRes;
    loaded = false;
    onModesUpdated?: () => void;

    constructor(
        public config: ConfigManager,
        public localization: Localization,
    ) {
        this.config = config;
        this.localization = localization;
    }

    /** Geographic group + playlist category a region belongs to, with defaults applied. */
    regionMeta(region: string): { group: string; category: string } {
        const data = GAME_REGIONS[region];
        return {
            group: data?.group || region,
            category: data?.category || "default",
        };
    }

    /** Unique geographic groups in config order, each with the label of its first region. */
    getGroups(): Array<{ group: string; l10n: string }> {
        const seen = new Set<string>();
        const groups: Array<{ group: string; l10n: string }> = [];
        for (const region in GAME_REGIONS) {
            const group = GAME_REGIONS[region].group || region;
            if (seen.has(group)) continue;
            seen.add(group);
            groups.push({ group, l10n: GAME_REGIONS[region].l10n });
        }
        return groups;
    }

    /** Playlist categories available within a group, ordered by `categories[].order`. */
    getCategoriesForGroup(group: string): Array<{ category: string }> {
        const seen = new Set<string>();
        const cats: Array<{ category: string; order: number }> = [];
        let appearance = 0;
        for (const region in GAME_REGIONS) {
            const meta = this.regionMeta(region);
            if (meta.group !== group || seen.has(meta.category)) continue;
            seen.add(meta.category);
            cats.push({
                category: meta.category,
                order: GAME_CATEGORIES[meta.category]?.order ?? appearance,
            });
            appearance++;
        }
        cats.sort((a, b) => a.order - b.order);
        return cats.map(({ category }) => ({ category }));
    }

    /** Resolves a (group, category) selection back to a concrete region key. */
    resolveRegion(group: string, category: string): string {
        for (const region in GAME_REGIONS) {
            const meta = this.regionMeta(region);
            if (meta.group === group && meta.category === category) return region;
        }
        // Fall back to any region in the group, then to the first region overall.
        for (const region in GAME_REGIONS) {
            if (this.regionMeta(region).group === group) return region;
        }
        return Object.keys(GAME_REGIONS)[0];
    }

    /** Display label for a category tab; title-cased id when no translation exists. */
    categoryLabel(category: string): string {
        const key = GAME_CATEGORIES[category]?.l10n;
        const translated = key ? this.localization.translate(key) : "";
        if (translated) return translated;
        return category.charAt(0).toUpperCase() + category.slice(1);
    }

    /**
     * Selects the right group in the geo dropdown and (re)builds the category tab row
     * for the currently selected group. Hides the tabs when a group has a single
     * category. Driven entirely off `config.regionGroup` / `config.playlist`.
     */
    renderRegionSelection() {
        const groups = this.getGroups();
        const group = this.config.get("regionGroup") || groups[0]?.group || "";

        $("#server-select-main option").each((_i, ele) => {
            (ele as HTMLOptionElement).selected =
                (ele as HTMLOptionElement).value === group;
        });

        const tabs = $("#category-tabs");
        tabs.empty();
        const cats = this.getCategoriesForGroup(group);
        if (cats.length <= 1) {
            // Single (or no) category for this group — nothing to choose, hide the row.
            tabs.css("display", "none");
            return;
        }
        tabs.css("display", "flex");
        const selected = this.config.get("playlist");
        for (const { category } of cats) {
            const isSelected = category === selected;
            tabs.append(
                `<a class="btn-hollow menu-option btn-cat-tab${
                    isSelected ? " btn-hollow-selected" : ""
                }" data-category="${category}">${this.categoryLabel(category)}</a>`,
            );
        }
    }

    load() {
        const locale = this.localization.getLocale();
        const siteInfoUrl = api.resolveUrl(`/api/site_info?language=${locale}`);

        const mainSelector = $("#server-opts");
        const teamSelector = $("#team-server-opts");
        const spectatorSelector = $("#spectate-server-opts");
        const privateLobbySelector = $("#private-lobby-server-opts");

        // Main menu: one entry per geographic group (eu/asia/...), deduplicated.
        // The concrete region (eu-arena, ...) is then resolved via the category tabs.
        mainSelector.empty();
        for (const { group, l10n } of this.getGroups()) {
            const name = this.localization.translate(l10n);
            mainSelector.append(
                `<option value='${group}' data-l10n='${l10n}' data-label='${name}'>${name}</option>`,
            );
        }

        // Team / spectate / private-lobby menus keep the flat per-region list. Since
        // regions in the same group share an l10n ("Europe"), suffix the category so the
        // entries stay distinct (e.g. "Europe Arena", "Europe Scrims").
        for (const region in GAME_REGIONS) {
            const data = GAME_REGIONS[region];
            const base = this.localization.translate(data.l10n);
            const category = this.regionMeta(region).category;
            const name =
                category !== "default" ? `${base} ${this.categoryLabel(category)}` : base;
            const elm = `<option value='${region}' data-l10n='${data.l10n}' data-label='${name}'>${name}</option>`;
            teamSelector.append(elm);
            spectatorSelector.append(elm);
            privateLobbySelector.append(elm);
        }

        $.ajax(siteInfoUrl).done((data: SiteInfoRes) => {
            this.info = data || {};
            this.loaded = true;
            this.updatePageFromInfo();
        });
    }

    getModesForSelectedRegion() {
        const region = this.config.get("region")!;
        return this.info.modesByRegion?.[region] || this.info.modes || [];
    }

    getGameModeStyles(region?: string) {
        const availableModes = [];
        const modes = region
            ? this.info.modesByRegion?.[region] || this.info.modes || []
            : this.getModesForSelectedRegion();
        console.log("Available modes for region", this.config.get("region"), modes);
        for (let i = 0; i < modes.length; i++) {
            const mode = modes[i];
            const mapDef = (MapDefs[mode.mapName as keyof typeof MapDefs] || MapDefs.main).desc;

            const l10nKey = mapDef.buttonText
            ? null
            : `index-play-${TeamModeToString[mode.teamMode]}`;
            const buttonText = mapDef.buttonText
                ? mapDef.buttonText +"-"+ TeamModeToString[mode.teamMode]
                : TeamModeToString[mode.teamMode];

            availableModes.push({
                icon: mapDef.icon,
                buttonCss: mapDef.buttonCss,
                buttonText,
                l10nKey,
                enabled: mode.enabled,
            });
        }
        return availableModes;
    }

    updatePageFromInfo() {
        // Group dropdown + category tabs are driven by build-time config (GAME_REGIONS),
        // so refresh them regardless of whether the async site_info has loaded yet.
        this.renderRegionSelection();
        if (this.loaded) {
            for (let i = 0; i < 3; i++) {
                const btn = $(`#btn-start-mode-${i}`);
                btn.removeClass("btn-custom-mode-no-indent btn-custom-mode-main");
                btn.css("background-image", "");
                btn.removeData("l10n");
                btn.html("");
                btn.hide();

                const l = $(`#btn-team-queue-mode-${i}`);
                l.removeClass("btn-custom-mode-select");
                l.css("background-image", "");
                l.removeData("l10n");
                l.html("");
                l.hide();
            }
            const getGameModeStyles = this.getGameModeStyles();
            for (let i = 0; i < getGameModeStyles.length; i++) {
                const style = getGameModeStyles[i];
                const selector = `index-play-${style.buttonText}`;
                const btn = $(`#btn-start-mode-${i}`);
                btn.data("l10n", selector);
                btn.html(this.localization.translate(selector));
                if (style.icon || style.buttonCss) {
                    if (i == 0) {
                        btn.addClass("btn-custom-mode-no-indent");
                    } else {
                        btn.addClass("btn-custom-mode-main");
                    }
                    btn.addClass(style.buttonCss);
                    btn.css({
                        "background-image": `url(${style.icon})`,
                    });
                }
                const l = $(`#btn-team-queue-mode-${i}`);
                if (l.length) {
                    const c = `index-play-${style.buttonText}`;
                    l.data("l10n", c);
                    l.html(this.localization.translate(c));
                    if (style.icon) {
                        l.addClass("btn-custom-mode-select");
                        l.css({
                            "background-image": `url(${style.icon})`,
                        });
                    }
                }

                btn.toggle(style.enabled);
                l.toggle(style.enabled);
            }
            const selectedModes = this.getModesForSelectedRegion();
            const supportsTeam = selectedModes.some((s) => s.enabled && s.teamMode > 1);
            $("#btn-join-team, #btn-create-team").toggle(supportsTeam);

            const supportsPrivateLobby = selectedModes.some((s) => s.enabled);
            $("#btn-join-private-lobby, #btn-create-private-lobby").toggle(supportsPrivateLobby);

            // Region pops — the geo dropdown is grouped, so sum player counts per group.
            const pops = this.info.pops;
            if (pops) {
                const players = this.localization.translate("index-players");
                const groupCounts: Record<string, number> = {};
                for (const region in pops) {
                    const group = this.regionMeta(region).group;
                    groupCounts[group] = (groupCounts[group] ?? 0) + pops[region].playerCount;
                }
                for (const group in groupCounts) {
                    const sel = $("#server-opts").children(`option[value="${group}"]`);
                    sel.text(`${sel.data("label")} [${groupCounts[group]} ${players}]`);
                }
            }
            let hasTwitchStreamers = false;
            const featuredStreamersElem = $("#featured-streamers");
            const streamerList = $(".streamer-list");
            if (!device.mobile && this.info.twitch) {
                streamerList.empty();
                for (let i = 0; i < this.info.twitch.length; i++) {
                    const streamer = this.info.twitch[i];
                    const template = $("#featured-streamer-template").clone();
                    template
                        .attr("class", "featured-streamer streamer-tooltip")
                        .attr("id", "");
                    const link = template.find("a");
                    const text = this.localization.translate(
                        streamer.viewers == 1 ? "index-viewer" : "index-viewers",
                    );
                    link.html(
                        `${streamer.name} <span>${streamer.viewers} ${text}</span>`,
                    );
                    link.css("background-image", `url(${streamer.img})`);
                    link.attr("href", streamer.url);
                    streamerList.append(template);
                    hasTwitchStreamers = true;
                }
            }
            featuredStreamersElem.css(
                "visibility",
                hasTwitchStreamers ? "visible" : "hidden",
            );

            const featuredYoutuberElem = $("#featured-youtuber");
            const displayYoutuber = this.info.youtube;
            if (displayYoutuber) {
                $(".btn-youtuber")
                    .attr("href", this.info.youtube.link)
                    .html(this.info.youtube.name);
            }
            featuredYoutuberElem.css("display", displayYoutuber ? "block" : "none");

            const mapDef = MapDefs[this.info.clientTheme] as MapDef;
            if (mapDef) {
                this.config.set("cachedBgImg", mapDef.desc.backgroundImg);
                const bg = document.getElementById("background");
                if (bg) {
                    bg.style.backgroundImage = `url(${mapDef.desc.backgroundImg})`;
                }
            }
        }
        this.onModesUpdated?.();
    }
}
