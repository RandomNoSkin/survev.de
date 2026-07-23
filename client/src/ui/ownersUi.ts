import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import { getItemCategory, getItemRarity } from "../../../shared/defs/shopConfig";
import type { ItemOwner, ItemOwnersResponse } from "../../../shared/types/user";
import type { Account } from "../account";
import { helpers } from "../helpers";
import type { Localization } from "./localization";

/** Rarity index → colour (matches the loadout/shop palette). */
const RARITY_COLORS = ["#c5c5c5", "#c5c5c5", "#12ff00", "#00deff", "#f600ff", "#d96100"];
const RARITY_NAMES = ["stock", "common", "uncommon", "rare", "epic", "mythic"];

/**
 * The Shop's "Owners" tab: pick a cosmetic and see which players own it (admins excluded).
 * Reached either by searching for an item here, or by clicking an item's rarity in the
 * loadout (which opens the shop straight onto this tab with the item preselected). Purely a
 * viewer — gifting lives in the Social panel.
 */
export class OwnersUi {
    itemSearch = $("#owners-item-search");
    itemSuggestions = $("#owners-item-suggestions");
    userSearch = $("#owners-user-search");
    selectedEl = $("#owners-selected");
    body = $("#owners-list");
    loadMoreEl = $("#owners-loadmore");

    /** Currently selected cosmetic type ("" = none picked yet). */
    type = "";
    page = 0;
    userFilter = "";
    loading = false;
    hasMore = false;

    /** Opens a single seller's storefront (wired by main.ts to switch to the Market tab). */
    onOpenStorefront: ((slug: string) => void) | null = null;

    private catalog: Array<{ type: string; name: string }> | null = null;
    private itemDebounce: ReturnType<typeof setTimeout> | null = null;
    private userDebounce: ReturnType<typeof setTimeout> | null = null;

    constructor(
        public account: Account,
        public localization: Localization,
    ) {
        this.itemSearch.on("input", () => {
            if (this.itemDebounce !== null) clearTimeout(this.itemDebounce);
            this.itemDebounce = setTimeout(() => this.renderSuggestions(), 150);
        });
        this.itemSearch.on("focus", () => this.renderSuggestions());
        this.userSearch.on("input", () => {
            if (this.userDebounce !== null) clearTimeout(this.userDebounce);
            this.userDebounce = setTimeout(() => {
                this.userFilter = String(this.userSearch.val() ?? "").trim();
                this.reload();
            }, 250);
        });
        this.loadMoreEl.on("click", () => this.loadMore());
    }

    /** Called by ShopUi when the Owners tab becomes visible. */
    activate() {
        if (this.type) {
            this.reload();
        } else {
            this.renderPrompt();
        }
    }

    /** Called by ShopUi when leaving the Owners tab / closing the shop. */
    deactivate() {
        if (this.itemDebounce !== null) clearTimeout(this.itemDebounce);
        if (this.userDebounce !== null) clearTimeout(this.userDebounce);
        this.itemDebounce = null;
        this.userDebounce = null;
        this.itemSuggestions.css("display", "none").empty();
    }

    /** Preselect a cosmetic (used by the loadout rarity click) and load its owners. */
    selectType(type: string) {
        this.type = type;
        this.userFilter = "";
        this.userSearch.val("");
        this.itemSearch.val(this.itemName(type));
        this.itemSuggestions.css("display", "none").empty();
        this.renderSelected();
        this.reload();
    }

    private itemName(type: string): string {
        const def = GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined;
        return this.localization.translate(`game-${type}`) || def?.name || type;
    }

    private buildCatalog() {
        if (this.catalog) return;
        this.catalog = [];
        for (const type of GameObjectDefs.getAllTypes()) {
            if (!getItemCategory(type)) continue;
            this.catalog.push({ type, name: this.itemName(type).toLowerCase() });
        }
        this.catalog.sort((a, b) => a.name.localeCompare(b.name));
    }

    private renderSuggestions() {
        this.buildCatalog();
        const q = String(this.itemSearch.val() ?? "")
            .trim()
            .toLowerCase();
        const matches = (this.catalog ?? [])
            .filter((c) => !q || c.name.includes(q) || c.type.toLowerCase().includes(q))
            .slice(0, 20);
        if (matches.length === 0) {
            this.itemSuggestions.css("display", "none").empty();
            return;
        }
        this.itemSuggestions.empty();
        for (const m of matches) {
            const rarity = getItemRarity(m.type);
            const row = $(
                `<div class="owners-suggestion">` +
                    `<div class="owners-suggestion-img" style="border-color:${
                        RARITY_COLORS[rarity] ?? "#c5c5c5"
                    }"></div>` +
                    `<span>${helpers.htmlEscape(this.itemName(m.type))}</span>` +
                    `</div>`,
            );
            row.find(".owners-suggestion-img").css({
                "background-image": `url(${helpers.getSvgFromGameType(m.type)})`,
                transform: helpers.getCssTransformFromGameType(m.type),
            });
            row.on("click", () => this.selectType(m.type));
            this.itemSuggestions.append(row);
        }
        this.itemSuggestions.css("display", "block");
    }

    private renderSelected() {
        if (!this.type) {
            this.selectedEl.css("display", "none").empty();
            return;
        }
        const rarity = getItemRarity(this.type);
        const key = RARITY_NAMES[rarity] ?? "common";
        const rarityLabel = this.localization.translate(`loadout-${key}`) || key;
        this.selectedEl
            .css("display", "flex")
            .html(
                `<div class="owners-selected-img" style="border-color:${
                    RARITY_COLORS[rarity] ?? "#c5c5c5"
                }"></div>` +
                    `<div class="owners-selected-info">` +
                    `<div class="owners-selected-name">${helpers.htmlEscape(
                        this.itemName(this.type),
                    )}</div>` +
                    `<div class="owners-selected-rarity" style="color:${
                        RARITY_COLORS[rarity] ?? "#c5c5c5"
                    }">${helpers.htmlEscape(rarityLabel)}</div>` +
                    `</div>`,
            );
        this.selectedEl.find(".owners-selected-img").css({
            "background-image": `url(${helpers.getSvgFromGameType(this.type)})`,
            transform: helpers.getCssTransformFromGameType(this.type),
        });
    }

    private renderPrompt() {
        this.selectedEl.css("display", "none").empty();
        this.body.html(
            '<div class="shop-status">Pick an item above to see who owns it.</div>',
        );
        this.loadMoreEl.css("display", "none");
    }

    private reload() {
        if (!this.type) {
            this.renderPrompt();
            return;
        }
        this.page = 0;
        this.renderSelected();
        this.body.html('<div class="shop-status">…</div>');
        this.loadMoreEl.css("display", "none");
        this.fetch(true);
    }

    private loadMore() {
        this.page += 1;
        this.fetch(false);
    }

    private fetch(replace: boolean) {
        if (this.loading || !this.type) return;
        this.loading = true;
        const type = this.type;
        this.account.getItemOwners(
            type,
            this.page,
            this.userFilter || undefined,
            (err, res?: ItemOwnersResponse) => {
                this.loading = false;
                // A newer selection superseded this request.
                if (type !== this.type) return;
                if (replace) this.body.empty();
                if (err || !res || !res.success) {
                    if (replace) {
                        this.body.html(
                            '<div class="shop-status">Failed to load owners</div>',
                        );
                    }
                    return;
                }
                if (replace) {
                    const count = res.total;
                    this.selectedEl
                        .find(".owners-selected-count")
                        .remove();
                    this.selectedEl.append(
                        `<div class="owners-selected-count">${count} owner${
                            count === 1 ? "" : "s"
                        }</div>`,
                    );
                    if (res.owners.length === 0) {
                        this.body.html(
                            '<div class="shop-status">No players own this item.</div>',
                        );
                    }
                }
                for (const o of res.owners) this.body.append(this.renderOwner(o));
                this.hasMore = res.hasMore;
                this.loadMoreEl.css("display", res.hasMore ? "block" : "none");
            },
        );
    }

    private renderOwner(o: ItemOwner): JQuery<HTMLElement> {
        const name = o.username || o.slug;
        const row = $(
            `<div class="owners-row">` +
                `<span class="owners-name market-link">${helpers.htmlEscape(
                    name,
                )}</span>` +
                (o.copies > 1
                    ? `<span class="owners-copies">×${o.copies}</span>`
                    : "") +
                `</div>`,
        );
        row.find(".owners-name").on("click", () => this.onOpenStorefront?.(o.slug));
        return row;
    }
}
