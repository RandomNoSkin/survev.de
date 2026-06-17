import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/gameObjectDefs";
import {
    getItemCategory,
    getItemPrice,
    getMarketPriceBounds,
    getMarketTotal,
    MARKET_LISTING_TTL_MS,
    type ShopCategory,
} from "../../../shared/defs/shopConfig";
import type { MarketListing, MarketListResponse, MyListing } from "../../../shared/types/user";
import type { Account } from "../account";
import { helpers } from "../helpers";
import type { Localization } from "./localization";
import { MenuModal } from "./menuModal";

/** Rarity index → colour (matches the loadout/shop palette). */
const RARITY_COLORS = ["#c5c5c5", "#c5c5c5", "#12ff00", "#00deff", "#f600ff", "#d96100"];
/** Rarity index → l10n key suffix (loadout-<name>). */
const RARITY_NAMES = ["stock", "common", "uncommon", "rare", "epic", "mythic"];

type MarketTab = "browse" | "private" | "mine";

/**
 * Player-to-player marketplace UI. Browse tab lists all active listings (filterable by
 * category, or by a single seller = storefront); My Listings tab shows the caller's own
 * actives with a Cancel action. Also owns the "Sell" dialog opened from the loadout menu.
 */
export class MarketUi {
    sellModal: MenuModal;
    body = $("#market-listings");
    balanceEl = $("#shop-balance-amount");
    loadMoreEl = $("#market-loadmore");
    storefrontBanner = $("#market-storefront-banner");
    categoryFilter = $("#market-category-filter");
    rarityFilter = $("#market-rarity-filter");
    searchInput = $("#market-search");

    tab: MarketTab = "browse";
    category: ShopCategory | "" = "";
    /** Selected rarity index to filter by, or "" for all. */
    rarity: number | "" = "";
    /** Free-text search (cosmetic name / source / owner) on the Browse tab. */
    search = "";
    /** Non-empty → showing a single seller's storefront. */
    sellerSlug = "";
    page = 0;
    loading = false;
    busy = false;

    sellItemId = 0;
    sellType = "";

    /** Ticks the per-listing auto-expiry countdowns while the market is visible. */
    private expiryInterval: ReturnType<typeof setInterval> | null = null;
    /** Debounce handle for the search box. */
    private searchDebounce: ReturnType<typeof setTimeout> | null = null;
    /** Cached [type, lowercased display name] for resolving name-search matches. */
    private cosmeticCatalog: Array<{ type: string; name: string }> | null = null;
    /** Watches cards so only on-screen ones load their image + tick their countdown. */
    private cardObserver: IntersectionObserver | null = null;
    /** Cards currently in (or near) the viewport — the only ones we keep ticking. */
    private visibleCards = new Set<HTMLElement>();

    constructor(
        public account: Account,
        public localization: Localization,
    ) {
        this.sellModal = new MenuModal($("#modal-market-sell"));

        $("#market-tab-browse").on("click", () => this.selectTab("browse"));
        $("#market-tab-private").on("click", () => this.selectTab("private"));
        $("#market-tab-mine").on("click", () => this.selectTab("mine"));
        this.categoryFilter.on("change", () => {
            this.category = (this.categoryFilter.val() as ShopCategory | "") || "";
            this.reload();
        });
        this.rarityFilter.on("change", () => {
            const v = String(this.rarityFilter.val() ?? "");
            this.rarity = v === "" ? "" : parseInt(v, 10);
            this.reload();
        });
        this.searchInput.on("input", () => {
            if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
            this.searchDebounce = setTimeout(() => {
                this.search = String(this.searchInput.val() ?? "").trim();
                this.reload();
            }, 250);
        });
        this.loadMoreEl.on("click", () => this.loadMore());

        $("#market-sell-price").on("input", () => this.updateSellPreview());
        $("#market-sell-confirm").on("click", () => this.confirmSell());
    }

    /** Called by ShopUi when the Market tab is selected; starts on the Browse view. */
    activate() {
        this.selectTab("browse");
        this.startExpiryTimer();
    }

    /** Called by ShopUi when leaving the Market tab / closing the shop. */
    deactivate() {
        this.stopExpiryTimer();
        this.resetCardTracking();
        if (this.searchDebounce !== null) {
            clearTimeout(this.searchDebounce);
            this.searchDebounce = null;
        }
    }

    /** Lazily creates the viewport observer (root = the scrolling shop body). */
    private ensureObserver() {
        if (this.cardObserver || typeof IntersectionObserver === "undefined") return;
        const root = document.querySelector(".shop-body");
        this.cardObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const card = entry.target as HTMLElement;
                    if (entry.isIntersecting) {
                        this.visibleCards.add(card);
                        this.hydrateCard(card);
                    } else {
                        this.visibleCards.delete(card);
                    }
                }
            },
            // Pre-load a screenful above/below the fold so scrolling stays smooth.
            { root, rootMargin: "300px 0px" },
        );
    }

    /** Appends a card and starts observing it (or loads it eagerly if no IO support). */
    private appendCard(card: JQuery<HTMLElement>) {
        this.ensureObserver();
        this.body.append(card);
        const el = card[0];
        if (this.cardObserver) this.cardObserver.observe(el);
        else this.hydrateCard(el);
    }

    /** First time a card is visible: load its deferred image + sync its countdown. */
    private hydrateCard(card: HTMLElement) {
        const img = card.querySelector<HTMLElement>(".market-item-img[data-svg]");
        if (img) {
            img.style.backgroundImage = `url(${img.dataset.svg})`;
            img.style.transform = img.dataset.transform ?? "";
            img.removeAttribute("data-svg");
        }
        const exp = card.querySelector<HTMLElement>("[data-expire-at]");
        if (exp) this.updateExpiryEl($(exp), Number(exp.getAttribute("data-expire-at")));
    }

    /** Stops observing the current cards (called before replacing the list). */
    private resetCardTracking() {
        this.cardObserver?.disconnect();
        this.visibleCards.clear();
    }

    private startExpiryTimer() {
        this.stopExpiryTimer();
        this.expiryInterval = setInterval(() => this.tickExpiries(), 1000);
    }

    private stopExpiryTimer() {
        if (this.expiryInterval !== null) {
            clearInterval(this.expiryInterval);
            this.expiryInterval = null;
        }
    }

    /** Refresh the countdowns of on-screen cards only (off-screen ones are left frozen). */
    private tickExpiries() {
        for (const card of this.visibleCards) {
            const exp = card.querySelector<HTMLElement>("[data-expire-at]");
            if (exp) {
                this.updateExpiryEl($(exp), Number(exp.getAttribute("data-expire-at")));
            }
        }
    }

    /** A live auto-expiry countdown element for a listing created at `createdAt` (ms). */
    private renderExpiry(createdAt: number): JQuery<HTMLElement> {
        const expireAt = createdAt + MARKET_LISTING_TTL_MS;
        const el = $(`<div class="market-expiry" data-expire-at="${expireAt}"></div>`);
        this.updateExpiryEl(el, expireAt);
        return el;
    }

    private updateExpiryEl(el: JQuery<HTMLElement>, expireAt: number) {
        const remaining = expireAt - Date.now();
        if (!Number.isFinite(expireAt) || remaining <= 0) {
            el.text("⌛ Expired");
            return;
        }
        const totalSec = Math.floor(remaining / 1000);
        const pad = (n: number) => String(n).padStart(2, "0");
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        el.text(`⌛ ${pad(h)}:${pad(m)}:${pad(s)}`);
    }

    private balance(): number {
        return this.account.profile.goldenFries ?? 0;
    }

    private selectTab(tab: MarketTab) {
        this.tab = tab;
        this.sellerSlug = "";
        $(".market-subtab").removeClass("market-subtab-active");
        $(`#market-tab-${tab}`).addClass("market-subtab-active");
        // Filters + search only make sense on the public Browse view.
        const filterDisplay = tab === "browse" ? "" : "none";
        this.categoryFilter.css("display", filterDisplay);
        this.rarityFilter.css("display", filterDisplay);
        this.searchInput.css("display", filterDisplay);
        this.storefrontBanner.css("display", "none");
        this.reload();
    }

    private openBrowse() {
        this.selectTab("browse");
    }

    /** Show a single player's storefront (their active listings). */
    openStorefront(slug: string) {
        this.tab = "browse";
        this.sellerSlug = slug;
        $(".market-subtab").removeClass("market-subtab-active");
        $("#market-tab-browse").addClass("market-subtab-active");
        this.categoryFilter.css("display", "none");
        this.rarityFilter.css("display", "none");
        this.searchInput.css("display", "none");
        this.storefrontBanner
            .css("display", "block")
            .html(
                `Listings by <b>${helpers.htmlEscape(slug)}</b> · ` +
                    `<span id="market-storefront-back" class="market-link">back to all</span>`,
            );
        $("#market-storefront-back").on("click", () => this.openBrowse());
        this.reload();
    }

    private reload() {
        this.page = 0;
        this.balanceEl.text(this.balance());
        this.loadMoreEl.css("display", "none");
        this.resetCardTracking();
        this.body.html('<div class="shop-status">…</div>');
        this.fetch(true);
    }

    private loadMore() {
        this.page += 1;
        this.fetch(false);
    }

    private fetch(replace: boolean) {
        if (this.tab === "mine") {
            this.renderMine();
            return;
        }
        if (this.loading) return;
        this.loading = true;

        const empty =
            this.tab === "private"
                ? "No private offers for you"
                : "No listings";
        const done = (err: unknown, res?: MarketListResponse) => {
            this.loading = false;
            if (replace) this.body.empty();
            if (err || !res || !res.success) {
                if (replace) {
                    this.body.html('<div class="shop-status">Failed to load market</div>');
                }
                return;
            }
            if (replace && res.listings.length === 0) {
                this.body.html(`<div class="shop-status">${empty}</div>`);
            }
            for (const l of res.listings) this.appendCard(this.renderListing(l));
            this.loadMoreEl.css("display", res.hasMore ? "block" : "none");
        };

        // Private offers (targeted at me): their own endpoint, no filters/pagination.
        if (this.tab === "private") {
            this.account.getPrivateOffers(done);
            return;
        }

        // A seller filter (storefront) is just the global market scoped to one seller,
        // routed through the paginated endpoint so "load more" works in both modes.
        const scoped = this.sellerSlug;
        this.account.getMarket(
            {
                category: scoped ? undefined : this.category || undefined,
                rarity: scoped || this.rarity === "" ? undefined : this.rarity,
                sellerSlug: scoped || undefined,
                page: this.page,
                search: scoped || !this.search ? undefined : this.search,
                searchTypes:
                    scoped || !this.search
                        ? undefined
                        : this.resolveNameTypes(this.search),
            },
            done,
        );
    }

    /**
     * Resolves which cosmetic types match `query` by display name (the server can only
     * match the raw type id / source / owner, not the localized name). Returns up to 300
     * matches so the server can OR them into the search.
     */
    private resolveNameTypes(query: string): string[] | undefined {
        const q = query.toLowerCase();
        if (!q) return undefined;
        if (!this.cosmeticCatalog) {
            this.cosmeticCatalog = [];
            for (const type in GameObjectDefs) {
                if (!getItemCategory(type)) continue;
                this.cosmeticCatalog.push({
                    type,
                    name: this.itemName(type).toLowerCase(),
                });
            }
        }
        const types: string[] = [];
        for (const c of this.cosmeticCatalog) {
            if (c.name.includes(q)) types.push(c.type);
            if (types.length >= 300) break;
        }
        return types.length ? types : undefined;
    }

    private renderMine() {
        this.loadMoreEl.css("display", "none");
        this.balanceEl.text(this.balance());
        this.resetCardTracking();
        this.body.empty();
        const listings = this.account.myListings;
        if (listings.length === 0) {
            this.body.html('<div class="shop-status">You have no active listings</div>');
            return;
        }
        for (const l of listings) this.appendCard(this.renderMineCard(l));
    }

    /** Item image tile (rarity-bordered), shared by browse/mine/sell cards. */
    private renderItemImage(type: string): JQuery<HTMLElement> {
        const def = GameObjectDefs[type] as { rarity?: number } | undefined;
        const rarity = def?.rarity ?? 1;
        const el = $(
            `<div class="shop-item-img market-item-img" style="border-color:${
                RARITY_COLORS[rarity] ?? "#c5c5c5"
            }"></div>`,
        );
        // Deferred: the IntersectionObserver paints these once the card scrolls into
        // view, so off-screen listings never fetch/decode their SVG (saves the client).
        el.attr("data-svg", helpers.getSvgFromGameType(type));
        el.attr("data-transform", helpers.getCssTransformFromGameType(type));
        return el;
    }

    private itemName(type: string): string {
        const def = GameObjectDefs[type] as { name?: string } | undefined;
        return this.localization.translate(`game-${type}`) || def?.name || type;
    }

    /** Rarity index, colour and localized name for a cosmetic type. */
    private rarityInfo(type: string): { color: string; name: string } {
        const rarity = (GameObjectDefs[type] as { rarity?: number } | undefined)?.rarity ?? 1;
        const key = RARITY_NAMES[rarity] ?? "common";
        return {
            color: RARITY_COLORS[rarity] ?? "#c5c5c5",
            name: this.localization.translate(`loadout-${key}`) || key,
        };
    }

    /**
     * Applies the item's rarity to a market card: colours the card frame + title and
     * inserts a rarity-name label right under the title.
     */
    private applyRarity(card: JQuery<HTMLElement>, type: string) {
        const { color, name } = this.rarityInfo(type);
        card.css({ "border-color": color, "box-shadow": `inset 0 0 0 1px ${color}55` });
        card.find(".shop-offer-title")
            .css("color", color)
            .after(
                `<div class="market-rarity" style="color:${color}">${helpers.htmlEscape(
                    name,
                )}</div>`,
            );
    }

    /** Human-readable provenance of a listed instance (localized when possible). */
    private sourceName(source: string): string {
        if (!source) return "Unknown";
        if (source === "market") return "Marketplace";
        if (source.startsWith("shop:")) return `Shop · ${source.slice(5)}`;
        const def = GameObjectDefs[source] as { name?: string } | undefined;
        return (
            this.localization.translate(`loadout-${source}`) ||
            this.localization.translate(source) ||
            def?.name ||
            source
        );
    }

    /** Stats + ownership history block shown on each listing (skin provenance). */
    private renderProvenance(listing: MarketListing): JQuery<HTMLElement> {
        const wrap = $('<div class="market-provenance"></div>');
        wrap.append(
            `<div class="market-stats">` +
                `<span title="Games">🎮 ${listing.games}</span>` +
                `<span title="Wins">🏆 ${listing.wins}</span>` +
                `<span title="Kills">💀 ${listing.kills}</span>` +
                `<span title="Damage">🩸 ${listing.damage}</span>` +
                `</div>`,
        );
        wrap.append(
            `<div class="market-meta">Source: ${helpers.htmlEscape(
                this.sourceName(listing.source),
            )}</div>`,
        );
        if (listing.previousOwners.length) {
            const joined = listing.previousOwners.join("  →  ");
            const toggle = $(
                `<div class="market-meta market-owners-toggle" title="${helpers.htmlEscape(
                    joined,
                )}">Prev. owners: ${listing.previousOwners.length} ▾</div>`,
            );
            const list = $(
                `<div class="market-owners-list" style="display:none">${helpers.htmlEscape(
                    joined,
                )}</div>`,
            );
            // Click to reveal the names inline (the title also shows them on hover).
            toggle.on("click", () => {
                const open = list.css("display") !== "none";
                list.css("display", open ? "none" : "block");
                toggle.html(
                    `Prev. owners: ${listing.previousOwners.length} ${open ? "▾" : "▴"}`,
                );
            });
            wrap.append(toggle);
            wrap.append(list);
        }
        return wrap;
    }

    private renderListing(listing: MarketListing): JQuery<HTMLElement> {
        const card = $('<div class="shop-offer market-listing"></div>');
        card.append(this.renderItemImage(listing.type));
        card.append(
            `<div class="shop-offer-title">${helpers.htmlEscape(
                this.itemName(listing.type),
            )}</div>`,
        );
        this.applyRarity(card, listing.type);

        const seller = $(
            `<div class="market-seller market-link">${helpers.htmlEscape(
                listing.sellerUsername || listing.sellerSlug,
            )}</div>`,
        );
        seller.on("click", () => this.openStorefront(listing.sellerSlug));
        card.append(seller);

        card.append(this.renderProvenance(listing));
        card.append(this.renderExpiry(listing.createdAt));

        card.append(
            `<div class="market-price"><div class="shop-fries-icon"></div>` +
                `<span>${listing.price}</span> <span class="market-fee">+${listing.fee} fee = ${listing.total}</span></div>`,
        );

        const mine = listing.sellerSlug === (this.account.profile.slug ?? "");
        const btn = $('<div class="shop-buy-btn market-buy-btn menu-option btn-darken"></div>');
        if (mine) {
            btn.addClass("shop-buy-disabled").text("Yours");
        } else if (this.balance() < listing.total) {
            btn.addClass("shop-buy-disabled").text(`Buy (${listing.total})`);
        } else {
            btn.text(`Buy (${listing.total})`).on("click", () => this.buy(listing, btn));
        }
        card.append(btn);
        return card;
    }

    private renderMineCard(listing: MyListing): JQuery<HTMLElement> {
        const card = $('<div class="shop-offer market-listing"></div>');
        card.append(this.renderItemImage(listing.type));
        card.append(
            `<div class="shop-offer-title">${helpers.htmlEscape(
                this.itemName(listing.type),
            )}</div>`,
        );
        this.applyRarity(card, listing.type);
        if (listing.buyerSlug) {
            card.append(
                `<div class="market-private-tag" title="Only this player can buy it">🔒 Private → ${helpers.htmlEscape(
                    listing.buyerSlug,
                )}</div>`,
            );
        }
        card.append(this.renderExpiry(listing.createdAt));
        card.append(
            `<div class="market-price"><div class="shop-fries-icon"></div><span>${listing.price}</span></div>`,
        );
        const btn = $(
            '<div class="shop-buy-btn market-cancel-btn menu-option btn-darken">Cancel</div>',
        );
        btn.on("click", () => this.cancel(listing.listingId, btn));
        card.append(btn);
        return card;
    }

    private buy(listing: MarketListing, btn: JQuery<HTMLElement>) {
        if (this.busy) return;
        this.busy = true;
        btn.addClass("shop-buy-disabled").text("…");
        this.account.buyListing(listing.listingId, (err, res) => {
            this.busy = false;
            if (err || !res || !res.success) {
                btn.text(res?.error === "insufficient_funds" ? "Too poor" : "Unavailable");
                setTimeout(() => this.reload(), 900);
                return;
            }
            this.reload();
            this.balanceEl.text(res.balance);
        });
    }

    private cancel(listingId: number, btn: JQuery<HTMLElement>) {
        if (this.busy) return;
        this.busy = true;
        btn.addClass("shop-buy-disabled").text("…");
        this.account.cancelListing(listingId, (err, res) => {
            this.busy = false;
            if (err || !res || !res.success) {
                btn.text("Error");
                return;
            }
            // Optimistically drop it; loadProfile() will reconcile myListings shortly.
            this.account.myListings = this.account.myListings.filter(
                (l) => l.listingId !== listingId,
            );
            this.renderMine();
        });
    }

    //
    // Sell dialog (opened from the loadout menu)
    //

    openSellDialog(itemId: number, type: string) {
        this.sellItemId = itemId;
        this.sellType = type;
        $("#market-sell-name").text(this.itemName(type));
        $("#market-sell-buyer").val("");
        const bounds = getMarketPriceBounds(type);
        const input = $("#market-sell-price");
        $("#market-sell-error").text("");
        if (bounds) {
            const suggested = Math.min(Math.max(getItemPrice(type), bounds.min), bounds.max);
            input
                .attr("min", bounds.min)
                .attr("max", bounds.max)
                .val(suggested)
                .prop("disabled", false);
            $("#market-sell-bounds").text(`Allowed: ${bounds.min} – ${bounds.max} fries`);
            $("#market-sell-confirm").removeClass("shop-buy-disabled");
        } else {
            input.val("").prop("disabled", true);
            $("#market-sell-bounds").text("This item can't be listed.");
            $("#market-sell-confirm").addClass("shop-buy-disabled");
        }
        this.updateSellPreview();
        this.sellModal.show();
    }

    private updateSellPreview() {
        const price = parseInt(String($("#market-sell-price").val()), 10);
        if (!Number.isFinite(price) || price <= 0) {
            $("#market-sell-total").text("");
            return;
        }
        $("#market-sell-total").text(
            `Buyer pays ${getMarketTotal(price)} — you receive ${price}`,
        );
    }

    private confirmSell() {
        if (this.busy) return;
        const bounds = getMarketPriceBounds(this.sellType);
        if (!bounds) return;
        const price = parseInt(String($("#market-sell-price").val()), 10);
        if (!Number.isFinite(price) || price < bounds.min || price > bounds.max) {
            $("#market-sell-error").text(`Price must be ${bounds.min}–${bounds.max} fries.`);
            return;
        }
        const buyerSlug =
            String($("#market-sell-buyer").val() ?? "").trim() || undefined;
        this.busy = true;
        $("#market-sell-confirm").addClass("shop-buy-disabled").text("…");
        this.account.listItem(this.sellItemId, price, buyerSlug, (err, res) => {
            this.busy = false;
            $("#market-sell-confirm").removeClass("shop-buy-disabled").text("List for sale");
            if (err || !res || !res.success) {
                $("#market-sell-error").text(
                    this.listErrorText(res?.error, res?.retryAfter),
                );
                return;
            }
            this.sellModal.hide();
        });
    }

    private listErrorText(code?: string, retryAfter?: number): string {
        switch (code) {
            case "bad_price":
                return "Price is out of the allowed range.";
            case "not_listable":
                return "This item can't be listed.";
            case "too_many_listings":
                return "You have too many active listings.";
            case "already_listed":
                return "This item is already listed.";
            case "not_owned":
                return "You no longer own this item.";
            case "buyer_not_found":
                return "No player with that slug was found.";
            case "self_buyer":
                return "You can't make a private listing to yourself.";
            case "rate_limited": {
                if (retryAfter && retryAfter > Date.now()) {
                    const mins = Math.max(
                        1,
                        Math.ceil((retryAfter - Date.now()) / 60000),
                    );
                    return `You can only list one item per hour. Try again in ${mins} min.`;
                }
                return "You can only list one item per hour.";
            }
            default:
                return "Could not list the item.";
        }
    }
}
