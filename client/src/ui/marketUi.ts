import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/gameObjectDefs";
import {
    getItemCategory,
    getItemPrice,
    getItemRarity,
    getMarketTotal,
    MARKET_LIST_COOLDOWN_MS,
    MARKET_LISTING_TTL_MS,
    type ShopCategory,
} from "../../../shared/defs/shopConfig";
import type {
    MarketListing,
    MarketListResponse,
    MyListing,
    Offer,
} from "../../../shared/types/user";
import { cosmeticStats, formatOwnerPercent } from "../../../shared/utils/cosmeticStats";
import type { Account } from "../account";
import { helpers } from "../helpers";
import type { Localization } from "./localization";
import { MenuModal } from "./menuModal";

/** Rarity index → colour (matches the loadout/shop palette). */
const RARITY_COLORS = ["#c5c5c5", "#c5c5c5", "#12ff00", "#00deff", "#f600ff", "#d96100"];
/** Rarity index → l10n key suffix (loadout-<name>). */
const RARITY_NAMES = ["stock", "common", "uncommon", "rare", "epic", "mythic"];

type MarketTab = "browse" | "private" | "mine" | "offers";

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
    /** True after the first "List for sale" click, requiring a second click to confirm. */
    private pendingSell = false;

    /** Ticks the per-listing auto-expiry countdowns while the market is visible. */
    private expiryInterval: ReturnType<typeof setInterval> | null = null;
    /** Polls the offers list while the Offers sub-tab is open, so an offer withdrawn or
     *  declined by the other party disappears here without a manual reload. */
    private offersPoll: ReturnType<typeof setInterval> | null = null;
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
        $("#market-tab-offers").on("click", () => this.selectTab("offers"));

        // Keep the Offers sub-tab in sync whenever the profile reloads (e.g. after an
        // accept/decline/counter/withdraw): refresh the badge and, if the Offers view is
        // open, re-render it so a resolved offer disappears immediately.
        this.account.addEventListener("offers", () => {
            this.updateOffersBadge();
            if (this.tab === "offers") this.renderOffers();
        });
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

        $("#market-sell-price").on("input", () => {
            this.resetSellConfirm();
            this.updateSellPreview();
        });
        $("#market-sell-buyer").on("input", () => this.resetSellConfirm());
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
        this.stopOffersPolling();
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
        // The Offers view has its own container; the listing grid backs every other tab.
        const offersTab = tab === "offers";
        $("#market-offers").css("display", offersTab ? "block" : "none");
        this.body.css("display", offersTab ? "none" : "");
        this.loadMoreEl.css("display", "none");
        // Only the Offers view polls for the other party's withdraw/decline.
        if (offersTab) this.startOffersPolling();
        else this.stopOffersPolling();
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
        if (this.tab === "offers") {
            this.renderOffers();
            return;
        }
        if (this.loading) return;
        this.loading = true;

        const empty =
            this.tab === "private" ? "No private offers for you" : "No listings";
        const done = (err: unknown, res?: MarketListResponse) => {
            this.loading = false;
            if (replace) this.body.empty();
            if (err || !res || !res.success) {
                if (replace) {
                    this.body.html(
                        '<div class="shop-status">Failed to load market</div>',
                    );
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

    /** Offers sub-tab badge: incoming offers awaiting a reply + my offers that got countered. */
    private updateOffersBadge() {
        const incoming = this.account.offersIncoming.filter(
            (o) => o.status === "pending",
        ).length;
        const counters = this.account.offersOutgoing.filter(
            (o) => o.status === "countered",
        ).length;
        const n = incoming + counters;
        $("#market-offers-badge")
            .text(n > 0 ? String(n) : "")
            .css("display", n > 0 ? "inline-block" : "none");
    }

    /** Refetches offers every few seconds while the Offers view is open, so an offer the
     *  other party withdrew/declined vanishes here promptly (there's no server push). */
    private startOffersPolling() {
        this.stopOffersPolling();
        this.offersPoll = setInterval(() => {
            if (this.tab !== "offers") {
                this.stopOffersPolling();
                return;
            }
            // Don't refresh mid-counter — it would wipe the input the user is typing.
            if ($("#market-offers .market-counter-input").length) return;
            this.account.getOffers((err, res) => {
                if (err || !res || !res.success) return;
                this.account.offersIncoming = res.incoming;
                this.account.offersOutgoing = res.outgoing;
                // Re-render + refresh every offer badge (sub-tab, Market tab, shop button).
                this.account.emit("offers", {
                    incoming: res.incoming,
                    outgoing: res.outgoing,
                });
            });
        }, 6000);
    }

    private stopOffersPolling() {
        if (this.offersPoll !== null) {
            clearInterval(this.offersPoll);
            this.offersPoll = null;
        }
    }

    /** Renders the caller's incoming (on their items) and outgoing (made) offers. */
    private renderOffers() {
        this.balanceEl.text(this.balance());
        const wrap = $("#market-offers").empty();
        const incoming = this.account.offersIncoming;
        const outgoing = this.account.offersOutgoing;

        wrap.append('<div class="market-offers-head">Offers on your items</div>');
        if (!incoming.length) {
            wrap.append('<div class="shop-status">No incoming offers</div>');
        } else {
            for (const o of incoming) wrap.append(this.renderOfferRow(o, "incoming"));
        }
        wrap.append('<div class="market-offers-head">Offers you made</div>');
        if (!outgoing.length) {
            wrap.append('<div class="shop-status">No outgoing offers</div>');
        } else {
            for (const o of outgoing) wrap.append(this.renderOfferRow(o, "outgoing"));
        }
        this.updateOffersBadge();
    }

    private renderOfferRow(o: Offer, side: "incoming" | "outgoing"): JQuery<HTMLElement> {
        const rarity = getItemRarity(o.type);
        const row = $('<div class="market-offer-row"></div>');
        row.append(
            $('<div class="market-offer-img"></div>').css({
                "background-image": `url(${helpers.getSvgFromGameType(o.type)})`,
                transform: helpers.getCssTransformFromGameType(o.type),
                "border-color": RARITY_COLORS[rarity] ?? "#c5c5c5",
            }),
        );

        const other = side === "incoming" ? o.fromUsername || o.fromSlug : o.toSlug;
        const price = o.counterAmount ?? o.amount;
        const priceLabel =
            o.status === "countered"
                ? `counter <b>${o.counterAmount}</b> (was ${o.amount})`
                : `<b>${o.amount}</b>`;
        row.append(
            `<div class="market-offer-main">` +
                `<div class="market-offer-name">${helpers.htmlEscape(this.itemName(o.type))}</div>` +
                `<div class="market-offer-meta">${side === "incoming" ? "from" : "to"} ${helpers.htmlEscape(other)} · ${priceLabel} 🍟</div>` +
                `</div>`,
        );

        const actions = $('<div class="market-offer-actions"></div>');
        if (side === "incoming") {
            if (o.status === "pending") {
                // Owner: accept / counter / decline.
                this.addOfferBtn(actions, `Accept ${o.amount}`, () =>
                    this.account.acceptOffer(o.offerId, () => {}),
                );
                this.addOfferBtn(actions, "Counter", () => this.startCounter(o, row));
                this.addOfferBtn(
                    actions,
                    "Decline",
                    () => this.account.offerAction("decline", o.offerId, () => {}),
                    true,
                );
            } else {
                // Countered by me — waiting on the bidder; I can still retract/decline it.
                actions.append('<div class="market-offer-status">Countered</div>');
                this.addOfferBtn(
                    actions,
                    "Decline",
                    () => this.account.offerAction("decline", o.offerId, () => {}),
                    true,
                );
            }
        } else {
            if (o.status === "countered") {
                // Bidder: accept the owner's counter (if affordable) or walk away.
                const total = getMarketTotal(price);
                if (this.balance() < total) {
                    actions.append(
                        `<div class="market-offer-status market-offer-broke">Need ${total} 🍟 (you have ${this.balance()})</div>`,
                    );
                } else {
                    this.addOfferBtn(actions, `Accept ${price} (${total})`, () =>
                        this.account.acceptOffer(o.offerId, () => {}),
                    );
                }
            }
            this.addOfferBtn(
                actions,
                "Withdraw",
                () => this.account.offerAction("withdraw", o.offerId, () => {}),
                true,
            );
        }
        row.append(actions);
        return row;
    }

    private addOfferBtn(
        parent: JQuery<HTMLElement>,
        label: string,
        onClick: () => void,
        danger = false,
    ) {
        const btn = $(
            `<div class="shop-buy-btn menu-option btn-darken market-offer-btn${
                danger ? " market-offer-danger" : ""
            }">${label}</div>`,
        );
        btn.on("click", () => {
            btn.addClass("shop-buy-disabled").text("…");
            onClick();
        });
        parent.append(btn);
    }

    /** Inline counter-offer input on an incoming offer row. */
    private startCounter(o: Offer, row: JQuery<HTMLElement>) {
        if (row.find(".market-counter-input").length) return;
        const box = $('<div class="market-counter-box"></div>');
        const input = $(
            `<input type="number" class="market-counter-input market-sell-price" min="1" value="${o.amount}" />`,
        );
        const send = $(
            '<div class="shop-buy-btn menu-option btn-darken">Send counter</div>',
        );
        send.on("click", () => {
            const amount = parseInt(String(input.val()), 10);
            if (!Number.isInteger(amount) || amount < 1) return;
            send.addClass("shop-buy-disabled").text("…");
            this.account.counterOffer(o.offerId, amount, () => {});
        });
        box.append(input).append(send);
        row.append(box);
    }

    /** Item image tile (rarity-bordered), shared by browse/mine/sell cards. */
    private renderItemImage(type: string): JQuery<HTMLElement> {
        const rarity = getItemRarity(type);
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
        const rarity = getItemRarity(type);
        const key = RARITY_NAMES[rarity] ?? "common";
        const label = this.localization.translate(`loadout-${key}`) || key;
        const owners = cosmeticStats.hasData()
            ? ` · ${cosmeticStats.getCount(type)} (${formatOwnerPercent(
                  cosmeticStats.getPercent(type),
              )})`
            : "";
        return {
            color: RARITY_COLORS[rarity] ?? "#c5c5c5",
            name: label + owners,
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
        const btn = $(
            '<div class="shop-buy-btn market-buy-btn menu-option btn-darken"></div>',
        );
        if (mine) {
            btn.addClass("shop-buy-disabled").text("Yours");
        } else if (this.balance() < listing.total) {
            btn.addClass("shop-buy-disabled").text(`Buy (${listing.total})`);
        } else {
            btn.text(`Buy (${listing.total})`).on("click", () => this.buy(listing, btn));
        }
        card.append(btn);

        // Buyers can also propose a lower/different price via an offer (charge-on-accept).
        if (!mine) {
            const offerBtn = $(
                '<div class="shop-buy-btn market-offer-open menu-option btn-darken">Make offer</div>',
            );
            offerBtn.on("click", () =>
                this.startMakeOffer(card, listing.itemId, listing.type, offerBtn),
            );
            card.append(offerBtn);
        }
        return card;
    }

    /** Inline "make an offer" input on a listing card. */
    private startMakeOffer(
        card: JQuery<HTMLElement>,
        itemId: number,
        type: string,
        opener: JQuery<HTMLElement>,
    ) {
        if (card.find(".market-makeoffer-box").length) return;
        opener.css("display", "none");
        const box = $('<div class="market-makeoffer-box"></div>');
        const suggested = getItemPrice(type) || 1;
        const est = getItemPrice(type);
        const hint = $(
            `<div class="market-offer-est">Est. value: ${
                est > 0 ? `${est} 🍟` : "—"
            }</div>`,
        );
        const input = $(
            `<input type="number" class="market-makeoffer-input market-sell-price" min="1" value="${suggested}" />`,
        );
        const send = $(
            '<div class="shop-buy-btn menu-option btn-darken">Send offer</div>',
        );
        const err = $('<div class="market-sell-error"></div>');
        send.on("click", () => {
            const amount = parseInt(String(input.val()), 10);
            if (!Number.isInteger(amount) || amount < 1) {
                err.text("Enter a whole number of at least 1.");
                return;
            }
            send.addClass("shop-buy-disabled").text("…");
            this.account.makeOffer(itemId, amount, (e, res) => {
                if (e || !res || !res.success) {
                    send.removeClass("shop-buy-disabled").text("Send offer");
                    err.text(
                        res?.error === "duplicate"
                            ? "You already have an offer on this item."
                            : res?.error === "auctioned"
                              ? "This item is being auctioned."
                              : res?.error === "offers_disabled"
                                ? "This player isn't accepting offers."
                                : res?.error === "blocked"
                                  ? "You can't interact with this player."
                                  : res?.error === "too_many"
                                    ? "Too many open offers."
                                    : "Could not send the offer.",
                    );
                    return;
                }
                box.html('<div class="market-offer-status">Offer sent ✓</div>');
            });
        });
        box.append(hint).append(input).append(send).append(err);
        card.append(box);
        input.trigger("focus");
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
                btn.text(
                    res?.error === "insufficient_funds" ? "Too poor" : "Unavailable",
                );
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
        this.pendingSell = false;
        $("#market-sell-name").text(this.itemName(type));
        $("#market-sell-buyer").val("");
        $("#market-sell-error").text("");
        // Any price is allowed (incl. 0/free). We only suggest the rarity-based value.
        const recommended = getItemPrice(type);
        $("#market-sell-price")
            .attr("min", 0)
            .removeAttr("max")
            .val(recommended > 0 ? recommended : 0)
            .prop("disabled", false);
        $("#market-sell-bounds").text(
            recommended > 0
                ? `Recommended price: ${recommended} fries (based on rarity). You can set any price, even 0 (free).`
                : "You can set any price, even 0 (free).",
        );
        $("#market-sell-confirm")
            .removeClass("shop-buy-disabled market-sell-confirming")
            .text("List for sale");
        this.updateSellPreview();
        this.sellModal.show();
    }

    private updateSellPreview() {
        const price = parseInt(String($("#market-sell-price").val()), 10);
        if (!Number.isFinite(price) || price < 0) {
            $("#market-sell-total").text("");
            return;
        }
        $("#market-sell-total").text(
            price === 0
                ? "Free — buyer pays 0"
                : `Buyer pays ${getMarketTotal(price)} — you receive ${price}`,
        );
    }

    /** Drops the "click again to confirm" state (called when the price/buyer is edited). */
    private resetSellConfirm() {
        if (this.busy || !this.pendingSell) return;
        this.pendingSell = false;
        $("#market-sell-confirm")
            .removeClass("market-sell-confirming")
            .text("List for sale");
    }

    private confirmSell() {
        if (this.busy) return;
        const price = parseInt(String($("#market-sell-price").val()), 10);
        if (!Number.isInteger(price) || price < 0) {
            $("#market-sell-error").text("Enter a whole number of 0 or more.");
            return;
        }

        // Require an explicit second click before the item is actually listed.
        if (!this.pendingSell) {
            this.pendingSell = true;
            $("#market-sell-error").text("");
            const priceLabel = price === 0 ? "for free" : `for ${price} fries`;
            $("#market-sell-confirm")
                .addClass("market-sell-confirming")
                .text(`Confirm — list ${priceLabel} (click again)`);
            return;
        }

        const buyerSlug = String($("#market-sell-buyer").val() ?? "").trim() || undefined;
        this.busy = true;
        this.pendingSell = false;
        $("#market-sell-confirm")
            .removeClass("market-sell-confirming")
            .addClass("shop-buy-disabled")
            .text("…");
        this.account.listItem(this.sellItemId, price, buyerSlug, (err, res) => {
            this.busy = false;
            $("#market-sell-confirm")
                .removeClass("shop-buy-disabled market-sell-confirming")
                .text("List for sale");
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
                return "Enter a whole number of 0 or more.";
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
                const every = this.formatDuration(MARKET_LIST_COOLDOWN_MS);
                if (retryAfter && retryAfter > Date.now()) {
                    const left = this.formatDuration(retryAfter - Date.now());
                    return `You can only list one item every ${every}. Try again in ${left}.`;
                }
                return `You can only list one item every ${every}.`;
            }
            default:
                return "Could not list the item.";
        }
    }

    /** Compact human duration: "10s", "5 min", "2 h" — rounds up to whole units. */
    private formatDuration(ms: number): string {
        const s = Math.max(1, Math.ceil(ms / 1000));
        if (s < 60) return `${s}s`;
        const m = Math.ceil(s / 60);
        if (m < 60) return `${m} min`;
        return `${Math.ceil(m / 60)} h`;
    }
}
