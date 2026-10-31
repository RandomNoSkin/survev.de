import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import {
    BUY_ORDER_TTL_MS,
    getItemCategory,
    getItemPrice,
    getItemRarity,
    getMarketTotal,
    type ShopCategory,
} from "../../../shared/defs/shopConfig";
import type { BuyOrder, TradeEvent, TradePriceStats } from "../../../shared/types/user";
import type { Account } from "../account";
import { helpers } from "../helpers";
import type { AuctionUi } from "./auctionUi";
import type { Localization } from "./localization";
import type { MarketUi } from "./marketUi";
import { MenuModal } from "./menuModal";

/** Rarity index → colour (matches the loadout/shop palette). */
const RARITY_COLORS = ["#c5c5c5", "#c5c5c5", "#12ff00", "#00deff", "#f600ff", "#d96100"];

/** How often the menu asks for new trade events (sold / outbid / offers ...). */
const EVENTS_POLL_MS = 30_000;
/** localStorage: ids of the buy orders for the player's items they already looked at */
const SEEN_ORDERS_KEY = "survev_seen_buy_orders";
const TOAST_MS = 7000;

/** "3m", "2h", "4d" */
function ago(ms: number): string {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
}

function inTime(ms: number): string {
    const s = Math.max(0, (ms - Date.now()) / 1000);
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
}

const fries = (n: number) => `<span class="trade-fries">${n.toLocaleString("en-US")}<span class="shop-fries-icon"></span></span>`;

/**
 * The trading side of the shop that isn't a plain listing or auction:
 *  - Market: the "Recently sold" strip, "Make offer" (buy orders) and "Wanted"
 *  - Sell: the player's own items, with price info and every way to sell them
 *  - My Trades: buy orders for their items ("Requests") and their own orders
 *  - live trade notifications (toasts) + the counts behind the My Trades badge
 */
export class TradeUi {
    offerModal: MenuModal;
    /** Set by main.ts: is a match running (no toasts over the game). */
    isInGame: () => boolean = () => false;
    /** Called when the pending counts change (My Trades badge). */
    onPending: ((offers: number, orders: number) => void) | null = null;
    /** Opens the shop on a tab (toast clicks). */
    onOpenShop: ((where: "market" | "trades" | "requests" | "orders" | "auctions") => void) | null = null;

    pending = { offers: 0, orders: 0 };
    /** best open order per type, refreshed with the Wanted / Sell views */
    private topOrders: BuyOrder[] = [];
    private catalog: Array<{ type: string; name: string }> | null = null;
    private offerType = "";
    private offerBusy = false;
    private sellSelected = "";
    private sellSearch = "";
    private sellCategory: ShopCategory | "" = "";
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    /** the first poll after login stays quiet for what the login popups already show */
    private firstPoll = true;

    constructor(
        public account: Account,
        public localization: Localization,
        public marketUi: MarketUi,
        public auctionUi: AuctionUi,
    ) {
        this.offerModal = new MenuModal($("#modal-make-offer"));
        $("#trade-make-offer-btn").on("click", () => this.openMakeOffer());
        $("#offer-item-search").on("input", () => this.renderOfferSuggestions());
        $("#offer-amount").on("input", () => this.renderOfferTotal());
        $("#offer-confirm").on("click", () => this.confirmOffer());

        $("#sell-search").on("input", () => {
            this.sellSearch = String($("#sell-search").val() ?? "").trim().toLowerCase();
            this.renderSellGrid();
        });
        $("#sell-category-filter").on("change", () => {
            this.sellCategory = (String($("#sell-category-filter").val() ?? "") as ShopCategory | "") || "";
            this.renderSellGrid();
        });

        this.account.addEventListener("login", () => this.startPolling());
        // a sale / purchase changes what's sellable
        this.account.addEventListener("items", () => {
            if ($("#shop-sell").css("display") !== "none") this.renderSell();
        });
    }

    //
    // helpers
    //

    itemName(type: string): string {
        const def = GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined;
        return this.localization.translate(`game-${type}`) || def?.name || type;
    }

    private rarityColor(type: string) {
        return RARITY_COLORS[getItemRarity(type)] ?? "#c5c5c5";
    }

    /** Rarity-bordered tile; the image inside carries the type's rotation (melee). */
    private itemImg(type: string, cls = "trade-img"): JQuery<HTMLElement> {
        const box = $(`<div class="${cls}" style="border-color:${this.rarityColor(type)}"></div>`);
        box.append(
            $('<div class="trade-img-inner"></div>').css({
                "background-image": `url(${helpers.getSvgFromGameType(type)})`,
                transform: helpers.getCssTransformFromGameType(type),
            }),
        );
        return box;
    }

    private balance(): number {
        return this.account.profile.goldenFries ?? 0;
    }

    /** Owned, sellable copies of `type` (not listed, not in an auction). */
    private freeCopies(type: string) {
        const listed = new Set(this.account.myListings.map((l) => l.itemId));
        return this.account.items.filter(
            (i) => i.type === type && i.id !== undefined && !listed.has(i.id) && i.id !== this.account.activeAuctionItemId,
        );
    }

    private statsLine(stats: TradePriceStats | null, type: string): string {
        const shop = getItemPrice(type);
        if (!stats) return `Never traded yet${shop > 0 ? ` · shop value ${fries(shop)}` : ""}`;
        return (
            `Last sold ${fries(stats.last)} · Ø ${fries(stats.avg)}` +
            (stats.count ? ` <span class="trade-muted">(${stats.count} sale${stats.count === 1 ? "" : "s"} in 30 days, ${stats.min}–${stats.max})</span>` : "")
        );
    }

    /** A sensible price for a new listing / offer: recent average, else shop value. */
    suggestedPrice(stats: TradePriceStats | null, type: string): number {
        return stats?.avg || stats?.last || getItemPrice(type) || 1;
    }

    //
    // Market: Recently sold + Wanted
    //

    loadRecent() {
        const list = $("#trade-recent-list");
        this.account.getTradeHistory(undefined, (err, res) => {
            list.empty();
            if (err || !res?.success || !res.recent.length) {
                list.html('<span class="trade-muted">No sales yet - be the first!</span>');
                return;
            }
            for (const s of res.recent.slice(0, 12)) {
                const chip = $('<div class="trade-recent-chip"></div>');
                chip.append(this.itemImg(s.type, "trade-img trade-img-sm"));
                chip.append(
                    `<span class="trade-recent-name">${helpers.htmlEscape(this.itemName(s.type))}</span>${fries(s.price)}<span class="trade-muted">${ago(s.at)}</span>`,
                );
                chip.attr("title", `${s.kind === "auction" ? "Auction" : s.kind === "order" ? "Sold to an offer" : s.kind === "offer" ? "Offer" : "Bought"} · ${ago(s.at)} ago`);
                list.append(chip);
            }
        });
    }

    renderWanted() {
        const wrap = $("#shop-wanted").html('<div class="shop-status">…</div>');
        this.account.getTopBuyOrders((err, res) => {
            wrap.empty();
            if (err || !res?.success) {
                wrap.html('<div class="shop-status">Failed to load</div>');
                return;
            }
            this.topOrders = res.orders;
            if (!res.orders.length) {
                wrap.append(this.emptyState("Nobody is looking for anything right now.", "＋ Make the first offer", () => this.openMakeOffer()));
                return;
            }
            for (const o of res.orders) wrap.append(this.renderOrderCard(o, "wanted"));
        });
    }

    private emptyState(text: string, cta?: string, onCta?: () => void): JQuery<HTMLElement> {
        const el = $(`<div class="trade-empty"><div>${text}</div></div>`);
        if (cta && onCta) {
            el.append($(`<div class="shop-buy-btn menu-option btn-darken trade-empty-btn">${cta}</div>`).on("click", onCta));
        }
        return el;
    }

    /** A buy order card: in Wanted (sell to it if you own one), Requests, or My orders. */
    private renderOrderCard(o: BuyOrder, where: "wanted" | "requests" | "mine"): JQuery<HTMLElement> {
        const color = this.rarityColor(o.type);
        const card = $(`<div class="shop-offer market-listing trade-order" style="border-color:${color}"></div>`);
        card.append($('<div class="trade-order-img"></div>').append(this.itemImg(o.type, "trade-img trade-img-lg")));
        card.append(`<div class="shop-offer-title" style="color:${color}">${helpers.htmlEscape(this.itemName(o.type))}</div>`);
        if (where === "mine") {
            const status =
                o.status === "open"
                    ? `Open · ends in ${inTime(o.expiresAt)}`
                    : o.status === "filled"
                      ? `✅ Bought from ${helpers.htmlEscape(o.sellerSlug ?? "")}`
                      : o.status === "expired"
                        ? "⌛ Ran out - refunded"
                        : "Cancelled - refunded";
            card.append(`<div class="market-meta">${status}</div>`);
        } else {
            card.append(`<div class="market-seller">wanted by ${helpers.formatUsername(o.buyerUsername || o.buyerSlug, o.buyerRoleTag)}</div>`);
            card.append(`<div class="market-meta">ends in ${inTime(o.expiresAt)}</div>`);
        }
        card.append(`<div class="market-price"><div class="shop-fries-icon"></div><span>${o.amount}</span><span class="market-fee">${where === "mine" ? `paid ${o.total} incl. fee` : "you get it all"}</span></div>`);

        const mine = o.buyerSlug === (this.account.profile.slug ?? "");
        if (where === "mine") {
            if (o.status === "open") {
                const btn = $('<div class="shop-buy-btn market-cancel-btn menu-option btn-darken">Cancel & refund</div>');
                btn.on("click", () => this.cancelOrder(o, btn));
                card.append(btn);
            }
        } else if (mine) {
            card.append('<div class="shop-buy-btn shop-buy-disabled">Your offer</div>');
        } else {
            const copies = this.freeCopies(o.type);
            const btn = $('<div class="shop-buy-btn market-buy-btn menu-option btn-darken"></div>');
            if (!copies.length) {
                btn.addClass("shop-buy-disabled").text(this.account.items.some((i) => i.type === o.type) ? "Yours is listed" : "You don't own it");
            } else {
                btn.text(`Sell for ${o.amount}`);
                this.twoStep(btn, `Sell for ${o.amount}`, () => this.fillOrder(o, copies[0].id!, btn));
            }
            card.append(btn);
        }
        return card;
    }

    /** First click arms the button ("Sure? …"), the second one runs `action`. */
    private twoStep(btn: JQuery<HTMLElement>, label: string, action: () => void) {
        let armed = false;
        btn.on("click", () => {
            if (btn.hasClass("shop-buy-disabled")) return;
            if (!armed) {
                armed = true;
                btn.addClass("trade-armed").text("Sure? Click again");
                setTimeout(() => {
                    if (armed && btn.hasClass("trade-armed")) {
                        armed = false;
                        btn.removeClass("trade-armed").text(label);
                    }
                }, 3500);
                return;
            }
            armed = false;
            btn.removeClass("trade-armed");
            action();
        });
    }

    private fillOrder(o: BuyOrder, itemId: number, btn: JQuery<HTMLElement>, after?: () => void) {
        btn.addClass("shop-buy-disabled").text("…");
        this.account.fillBuyOrder(o.orderId, itemId, (err, res) => {
            if (err || !res?.success) {
                btn.text(
                    res?.error === "gone" ? "Already taken" : res?.error === "blocked" ? "Blocked" : res?.error === "auctioned" ? "In an auction" : "Error",
                );
                return;
            }
            btn.text(`Sold ✓ +${o.amount}`);
            $("#shop-balance-amount").text(res.balance ?? this.balance());
            this.refreshPending();
            after?.();
        });
    }

    private cancelOrder(o: BuyOrder, btn: JQuery<HTMLElement>) {
        btn.addClass("shop-buy-disabled").text("…");
        this.account.cancelBuyOrder(o.orderId, (err, res) => {
            if (err || !res?.success) {
                btn.text("Error");
                return;
            }
            $("#shop-balance-amount").text(res.balance ?? this.balance());
            this.renderMyOrders();
        });
    }

    //
    // Make offer (buy order) dialog
    //

    private ensureCatalog() {
        if (this.catalog) return this.catalog;
        this.catalog = [];
        for (const type of GameObjectDefs.getAllTypes()) {
            if (!getItemCategory(type)) continue;
            this.catalog.push({ type, name: this.itemName(type) });
        }
        this.catalog.sort((a, b) => a.name.localeCompare(b.name));
        return this.catalog;
    }

    openMakeOffer(type?: string) {
        this.offerType = "";
        $("#offer-item-search").val("");
        $("#offer-amount").val("");
        $("#offer-error").text("");
        $("#offer-item-selected, #offer-item-stats, #offer-total").empty();
        $("#offer-item-suggestions").css("display", "none").empty();
        this.offerModal.show();
        if (type) this.selectOfferType(type);
        else setTimeout(() => $("#offer-item-search").trigger("focus"), 50);
    }

    private renderOfferSuggestions() {
        const q = String($("#offer-item-search").val() ?? "").trim().toLowerCase();
        const box = $("#offer-item-suggestions").empty();
        if (!q) {
            box.css("display", "none");
            return;
        }
        const hits = this.ensureCatalog().filter((c) => c.name.toLowerCase().includes(q)).slice(0, 12);
        if (!hits.length) {
            box.css("display", "block").html('<div class="shop-status">No such item</div>');
            return;
        }
        for (const h of hits) {
            const row = $('<div class="owners-suggestion"></div>');
            row.append(this.itemImg(h.type, "trade-img trade-img-sm"));
            row.append(`<span style="color:${this.rarityColor(h.type)}">${helpers.htmlEscape(h.name)}</span>`);
            row.on("click", () => this.selectOfferType(h.type));
            box.append(row);
        }
        box.css("display", "block");
    }

    private selectOfferType(type: string) {
        this.offerType = type;
        $("#offer-item-suggestions").css("display", "none");
        $("#offer-item-search").val(this.itemName(type));
        const sel = $("#offer-item-selected").empty();
        sel.append(this.itemImg(type));
        sel.append(`<div><div style="color:${this.rarityColor(type)};font-weight:700">${helpers.htmlEscape(this.itemName(type))}</div></div>`);
        $("#offer-item-stats").html('<span class="trade-muted">…</span>');
        this.account.getTradeHistory(type, (err, res) => {
            if (this.offerType !== type) return;
            const stats = !err && res?.success ? res.stats : null;
            $("#offer-item-stats").html(this.statsLine(stats, type));
            if (!$("#offer-amount").val()) $("#offer-amount").val(this.suggestedPrice(stats, type));
            this.renderOfferTotal();
        });
        $("#offer-amount").trigger("focus");
    }

    private renderOfferTotal() {
        const amount = parseInt(String($("#offer-amount").val()), 10);
        $("#offer-error").text("");
        if (!Number.isInteger(amount) || amount < 1) {
            $("#offer-total").text("");
            return;
        }
        const total = getMarketTotal(amount);
        const days = Math.round(BUY_ORDER_TTL_MS / 86400000);
        $("#offer-total").html(
            `You pay ${fries(total)} now (incl. ${total - amount} fee). The seller gets ${fries(amount)}. Runs ${days} days.` +
                (total > this.balance() ? ` <span class="market-sell-error">You have ${this.balance()}.</span>` : ""),
        );
    }

    private confirmOffer() {
        if (this.offerBusy) return;
        const amount = parseInt(String($("#offer-amount").val()), 10);
        if (!this.offerType) {
            $("#offer-error").text("Pick an item first.");
            return;
        }
        if (!Number.isInteger(amount) || amount < 1) {
            $("#offer-error").text("Enter a price of at least 1.");
            return;
        }
        this.offerBusy = true;
        $("#offer-confirm").addClass("shop-buy-disabled").text("…");
        this.account.createBuyOrder(this.offerType, amount, (err, res) => {
            this.offerBusy = false;
            $("#offer-confirm").removeClass("shop-buy-disabled").text("Place offer");
            if (err || !res?.success) {
                $("#offer-error").text(
                    res?.error === "insufficient_funds"
                        ? "Not enough Golden Fries."
                        : res?.error === "duplicate"
                          ? "You already have an open offer for this item - see My Trades → My orders."
                          : res?.error === "too_many"
                            ? "Too many open offers - cancel one first."
                            : res?.error === "not_tradeable"
                              ? "This item can't be traded."
                              : "Could not place the offer.",
                );
                return;
            }
            $("#shop-balance-amount").text(res.balance ?? this.balance());
            this.offerModal.hide();
            this.toast(`✅ Offer placed: ${this.itemName(this.offerType)} for ${amount}. You'll get a notification when someone sells.`);
            if ($("#shop-wanted").css("display") !== "none") this.renderWanted();
            if ($("#shop-myorders").css("display") !== "none") this.renderMyOrders();
        });
    }

    //
    // Sell tab
    //

    renderSell() {
        // fresh "Wanted" prices for the detail panel
        this.account.getTopBuyOrders((err, res) => {
            if (!err && res?.success) this.topOrders = res.orders;
            // the green "wanted" dots need the orders
            this.renderSellGrid();
            this.renderSellDetail();
        });
        this.renderSellGrid();
        this.renderSellDetail();
    }

    private renderSellGrid() {
        const grid = $("#sell-grid").empty();
        const byType = new Map<string, number>();
        for (const i of this.account.items) {
            if (i.id === undefined || !getItemCategory(i.type)) continue;
            byType.set(i.type, (byType.get(i.type) ?? 0) + 1);
        }
        let types = [...byType.keys()].filter((t) => {
            if (this.sellCategory && getItemCategory(t) !== this.sellCategory) return false;
            return !this.sellSearch || this.itemName(t).toLowerCase().includes(this.sellSearch);
        });
        types.sort((a, b) => getItemRarity(b) - getItemRarity(a) || this.itemName(a).localeCompare(this.itemName(b)));
        // types with a copy up for sale: a listing, or the one auction
        const selling = new Set(this.account.myListings.map((l) => l.type));
        const auctioned = this.account.items.find((i) => i.id === this.account.activeAuctionItemId);
        if (auctioned) selling.add(auctioned.type);
        if (!byType.size) {
            grid.append(this.emptyState("You don't own anything you could sell yet. Items come from the battle pass, the Store and other players."));
            return;
        }
        if (!types.length) {
            grid.append('<div class="shop-status">No match</div>');
            return;
        }
        if (!this.sellSelected || !types.includes(this.sellSelected)) this.sellSelected = this.sellSelected && byType.has(this.sellSelected) ? this.sellSelected : types[0];
        for (const t of types) {
            const tile = $(`<div class="sell-tile${t === this.sellSelected ? " sell-tile-active" : ""}" title="${helpers.htmlEscape(this.itemName(t))}"></div>`);
            tile.append(this.itemImg(t, "trade-img"));
            const n = byType.get(t)!;
            if (n > 1) tile.append(`<span class="sell-count">×${n}</span>`);
            const dots = $('<span class="sell-dots"></span>');
            if (this.topOrders.some((o) => o.type === t && o.buyerSlug !== this.account.profile.slug)) {
                dots.append('<span class="sell-dot sell-dot-wanted" title="Someone wants to buy this"></span>');
            }
            if (selling.has(t)) dots.append('<span class="sell-dot sell-dot-selling" title="You are selling this (listed or in an auction)"></span>');
            if (dots.children().length) tile.append(dots);
            tile.on("click", () => {
                this.sellSelected = t;
                grid.find(".sell-tile").removeClass("sell-tile-active");
                tile.addClass("sell-tile-active");
                this.renderSellDetail();
            });
            grid.append(tile);
        }
    }

    private renderSellDetail() {
        const box = $("#sell-detail").empty();
        const type = this.sellSelected;
        if (!type) return;
        const color = this.rarityColor(type);
        const owned = this.account.items.filter((i) => i.type === type && i.id !== undefined);
        const free = this.freeCopies(type);
        box.append(this.itemImg(type, "trade-img trade-img-lg"));
        box.append(`<div class="sell-detail-name" style="color:${color}">${helpers.htmlEscape(this.itemName(type))}</div>`);
        box.append(`<div class="trade-muted">You own ${owned.length}${owned.length !== free.length ? ` · ${owned.length - free.length} listed / in an auction` : ""}</div>`);
        const stats = $('<div class="trade-stats">…</div>');
        box.append(stats);

        const best = this.topOrders.find((o) => o.type === type && o.buyerSlug !== this.account.profile.slug);
        if (best) {
            const quick = $('<div class="sell-quick"></div>');
            quick.append(`<div>💰 <b>${helpers.htmlEscape(best.buyerUsername || best.buyerSlug)}</b> wants it for ${fries(best.amount)}</div>`);
            const btn = $('<div class="shop-buy-btn menu-option btn-darken"></div>').text(`Sell now for ${best.amount}`);
            if (!free.length) btn.addClass("shop-buy-disabled").text("All copies listed");
            else this.twoStep(btn, `Sell now for ${best.amount}`, () => this.fillOrder(best, free[0].id!, btn, () => this.renderSell()));
            quick.append(btn);
            box.append(quick);
        }

        const actions = $('<div class="sell-actions"></div>');
        const list = $('<div class="shop-buy-btn menu-option btn-darken" title="Sell at a fixed price">💰 List</div>');
        const auction = $('<div class="shop-buy-btn menu-option btn-darken" title="24 h, highest bid wins">🔨 Auction</div>');
        if (!free.length) {
            list.addClass("shop-buy-disabled");
            auction.addClass("shop-buy-disabled");
        } else {
            list.on("click", () => {
                this.marketUi.openSellDialog(free[0].id!, type);
                const price = this.lastStats?.type === type ? this.suggestedPrice(this.lastStats.stats, type) : 0;
                if (price) $("#market-sell-price").val(price).trigger("input");
            });
            if (this.account.activeAuctionItemId != null) auction.addClass("shop-buy-disabled").attr("title", "You already have an item in an auction");
            else auction.on("click", () => this.auctionUi.openCreate(free[0].id!, type));
        }
        actions.append(list, auction);
        box.append(actions);
        box.append('<div class="trade-muted sell-hint">Listing: buyers pay your price + 10% fee, you get your full price. Auction: runs 24 h, highest bid wins (10% fee).</div>');

        this.account.getTradeHistory(type, (err, res) => {
            if (this.sellSelected !== type) return;
            const s = !err && res?.success ? res.stats : null;
            this.lastStats = { type, stats: s };
            stats.html(this.statsLine(s, type));
        });
    }

    private lastStats: { type: string; stats: TradePriceStats | null } | null = null;

    //
    // My Trades: Requests + My orders
    //

    renderRequests() {
        const wrap = $("#shop-requests").html('<div class="shop-status">…</div>');
        this.account.getBuyOrders((err, res) => {
            wrap.empty();
            if (err || !res?.success) {
                wrap.html('<div class="shop-status">Failed to load</div>');
                return;
            }
            // looking at them clears the Requests badge until a new one comes in
            this.markOrdersSeen(res.forMyItems.map((o) => o.orderId));
            this.setPending(this.pending.offers, 0);
            if (!res.forMyItems.length) {
                wrap.append(this.emptyState("Nobody wants your items right now. When someone makes an offer for an item you own, it shows up here."));
                return;
            }
            wrap.append('<div class="market-offers-head">Players want to buy these from you</div>');
            const grid = $('<div class="shop-offers market-listings"></div>');
            for (const o of res.forMyItems) grid.append(this.renderOrderCard(o, "requests"));
            wrap.append(grid);
        });
    }

    renderMyOrders() {
        const wrap = $("#shop-myorders").html('<div class="shop-status">…</div>');
        this.account.getBuyOrders((err, res) => {
            wrap.empty();
            if (err || !res?.success) {
                wrap.html('<div class="shop-status">Failed to load</div>');
                return;
            }
            const head = $('<div class="trade-orders-head"><div class="market-offers-head">Your offers for items</div></div>');
            head.append($('<div class="shop-buy-btn menu-option btn-darken">＋ Make offer</div>').on("click", () => this.openMakeOffer()));
            wrap.append(head);
            if (!res.mine.length) {
                wrap.append(this.emptyState("You haven't made any offers yet. Want an item nobody sells? Name your price and every owner can sell it to you."));
                return;
            }
            const grid = $('<div class="shop-offers market-listings"></div>');
            for (const o of res.mine) grid.append(this.renderOrderCard(o, "mine"));
            wrap.append(grid);
        });
    }

    //
    // Notifications
    //

    private startPolling() {
        this.stopPolling();
        this.firstPoll = true;
        this.poll();
        this.pollTimer = setInterval(() => this.poll(), EVENTS_POLL_MS);
    }

    private stopPolling() {
        if (this.pollTimer !== null) clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.setPending(0, 0);
    }

    refreshPending() {
        this.poll(false);
    }

    private poll(showToasts = true) {
        if (!this.account.loggedIn) return;
        this.account.getTradeEvents((err, res) => {
            if (err || !res?.success) return;
            this.setPending(res.pending.offers, this.unseenOrders(res.pending.orderIds));
            if (!showToasts || !res.events.length) return;
            // on login the "sold" / auction popups already cover those
            const quiet = this.firstPoll ? new Set(["sold", "auction_sold", "auction_won"]) : new Set<string>();
            this.firstPoll = false;
            if (this.isInGame()) return; // keep them for the menu
            for (const e of res.events.slice(-5)) if (!quiet.has(e.kind)) this.toastEvent(e);
            this.account.markTradeEventsSeen(res.events.map((e) => e.id));
            // fries / items moved
            if (res.events.some((e) => e.kind !== "offer_received" && e.kind !== "offer_countered" && e.kind !== "offer_declined")) {
                this.account.loadProfile();
            }
        });
    }

    private seenOrderIds(): Set<number> {
        try {
            return new Set(JSON.parse(localStorage.getItem(SEEN_ORDERS_KEY) || "[]") as number[]);
        } catch {
            return new Set();
        }
    }

    /** Remembers `ids` as seen (only the still-open ones are kept). */
    private markOrdersSeen(ids: number[]) {
        try {
            localStorage.setItem(SEEN_ORDERS_KEY, JSON.stringify(ids.slice(0, 200)));
        } catch {
            /* ignore */
        }
    }

    /** Open orders for my items that I haven't looked at yet. */
    private unseenOrders(ids: number[]): number {
        const seen = this.seenOrderIds();
        return ids.filter((id) => !seen.has(id)).length;
    }

    private setPending(offers: number, orders: number) {
        if (offers === this.pending.offers && orders === this.pending.orders) return;
        this.pending = { offers, orders };
        this.onPending?.(offers, orders);
    }

    private toastEvent(e: TradeEvent) {
        const item = `<b>${helpers.htmlEscape(this.itemName(e.type))}</b>`;
        const who = e.otherSlug ? `<b>${helpers.htmlEscape(e.otherSlug)}</b>` : "someone";
        const amt = e.amount != null ? fries(e.amount) : "";
        const map: Record<TradeEvent["kind"], [string, "market" | "trades" | "requests" | "orders" | "auctions"]> = {
            sold: [`💰 Your ${item} sold for ${amt} to ${who}`, "trades"],
            auction_sold: [`🔨 Your auction of ${item} ended: ${amt} from ${who}`, "trades"],
            auction_won: [`🏆 You won ${item} for ${amt}`, "auctions"],
            outbid: [`⚠ You were outbid on ${item} (${amt})`, "auctions"],
            offer_received: [`📩 ${who} offers ${amt} for your ${item}`, "trades"],
            offer_accepted: [`✅ ${who} accepted: ${item} for ${amt}`, "trades"],
            offer_declined: [`✖ ${who} declined the offer on ${item}`, "trades"],
            offer_countered: [`↩ ${who} countered: ${item} for ${amt}`, "trades"],
            order_filled: [`✅ ${who} sold you ${item} for ${amt}`, "orders"],
            order_expired: [`⌛ Nobody sold you ${item} - ${amt} refunded`, "orders"],
        };
        const [html, where] = map[e.kind] ?? [`${item}`, "trades"];
        this.toast(html, () => this.onOpenShop?.(where));
    }

    toast(html: string, onClick?: () => void) {
        const el = $(`<div class="trade-toast">${html}</div>`);
        if (onClick) el.addClass("trade-toast-link").on("click", () => {
            onClick();
            el.remove();
        });
        $("#trade-toasts").append(el);
        requestAnimationFrame(() => el.addClass("trade-toast-in"));
        setTimeout(() => {
            el.removeClass("trade-toast-in");
            setTimeout(() => el.remove(), 400);
        }, TOAST_MS);
    }
}
