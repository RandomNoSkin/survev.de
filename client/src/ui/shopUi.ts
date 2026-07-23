import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import { getItemRarity } from "../../../shared/defs/shopConfig";
import type { ShopOffer } from "../../../shared/types/user";
import { cosmeticStats, formatOwnerPercent } from "../../../shared/utils/cosmeticStats";
import type { Account } from "../account";
import { helpers } from "../helpers";
import type { AuctionUi } from "./auctionUi";
import type { Localization } from "./localization";
import type { MarketUi } from "./marketUi";
import { MenuModal } from "./menuModal";
import type { OwnersUi } from "./ownersUi";

/** Rarity index → colour (matches the loadout menu palette). */
const RARITY_COLORS = ["#c5c5c5", "#c5c5c5", "#12ff00", "#00deff", "#f600ff", "#d96100"];

/** Slot ids are fixed server-side (see ShopOffer.slot). The Daily/Weekly section heading
 *  supplies the period, so the card only names what it is. */
const SLOT_TITLES: Record<number, string> = {
    0: "Item",
    1: "Bundle",
    2: "Item",
    3: "Bundle",
};

/** Slots 2 and 3 are the weekly rotation — mirrors `isWeeklySlot` on the server. */
function isWeeklySlot(slot: number): boolean {
    return slot === 2 || slot === 3;
}

/** "3d 04:11:22" / "04:11:22" — the weekly countdown spans days, unlike the daily one. */
function formatRemaining(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const pad = (n: number) => String(n).padStart(2, "0");
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${d > 0 ? `${d}d ` : ""}${pad(h)}:${pad(m)}:${pad(s)}`;
}

export class ShopUi {
    modal: MenuModal;
    body = $("#shop-daily-offers");
    balanceEl = $("#shop-balance-amount");
    buying = false;
    /** The marketplace panel (the "Market" tab); set by main.ts. */
    marketUi: MarketUi | null = null;
    /** The "Owners" tab (who owns a cosmetic); set by main.ts. */
    ownersUi: OwnersUi | null = null;
    /** The "Auction" tab; set by main.ts. */
    auctionUi: AuctionUi | null = null;
    tab: "daily" | "market" | "auction" | "owners" = "daily";
    private resetInterval: ReturnType<typeof setInterval> | null = null;
    /** Epoch ms of the next daily shop reset, as reported by the API server. */
    private resetTime = 0;
    /** Epoch ms of the next weekly reset (Sunday 23:59:59), as reported by the server. */
    private weeklyResetTime = 0;
    /** Number of private offers waiting (drives the Private sub-tab count). */
    private privateBadgeCount = 0;
    /** New public listings from other players (part of the Market tab badge). */
    private marketNewCount = 0;
    /** Epoch ms of the newest public market listing seen at the last badge refresh. */
    private marketNewestTs = 0;
    /** localStorage key: the shop day ("YYYY-MM-DD") the player last viewed. */
    private static readonly SEEN_DAY_KEY = "survev_shop_day_seen";
    /** localStorage key: epoch ms of the newest market listing the player has seen. */
    private static readonly MARKET_SEEN_KEY = "survev_market_seen_ts";
    /** localStorage key: bid-carrying auction count the player has already seen. */
    private static readonly AUCTION_SEEN_KEY = "survev_auction_bids_seen";

    constructor(
        public account: Account,
        public localization: Localization,
    ) {
        this.modal = new MenuModal($("#modal-shop"));
        this.modal.onShow(() => {
            this.startResetTimer();
            this.selectTab("daily");
        });
        this.modal.onHide(() => {
            this.stopResetTimer();
            this.marketUi?.deactivate();
            this.auctionUi?.deactivate();
            this.ownersUi?.deactivate();
            // A purchase/claim while open may have changed what's waiting — recheck badges.
            this.refreshShopBadges();
        });

        $("#modal-shop [data-shop-tab]").on("click", (e) => {
            this.selectTab(
                $(e.currentTarget).data("shop-tab") as
                    | "daily"
                    | "market"
                    | "auction"
                    | "owners",
            );
        });

        // On login, light up the shop button/tabs if there's a new daily rotation or
        // private offers waiting (mirrors the loadout/social "new" alerts).
        this.account.addEventListener("login", () => this.refreshShopBadges());
        // Incoming buy-offers + counters on my offers surface on the Market tab (Offers
        // sub-tab); a bid on my auction surfaces on the Auction tab. Recompute both badges
        // whenever the profile reloads (offers/auctions events fire together on load).
        const refreshTradeBadges = () => {
            this.renderMarketBadge();
            this.renderAuctionBadge();
            this.updateShopBtnAlert();
        };
        this.account.addEventListener("offers", refreshTradeBadges);
        this.account.addEventListener("auctions", refreshTradeBadges);
    }

    /** Switch between the Daily shop, the player Market, the Auction house, and Owners. */
    selectTab(tab: "daily" | "market" | "auction" | "owners") {
        this.tab = tab;
        $("#modal-shop [data-shop-tab]").removeClass("shop-tab-active");
        $(`#modal-shop [data-shop-tab='${tab}']`).addClass("shop-tab-active");
        $("#shop-daily-offers").css("display", tab === "daily" ? "" : "none");
        $("#shop-market").css("display", tab === "market" ? "block" : "none");
        $("#shop-auction").css("display", tab === "auction" ? "block" : "none");
        $("#shop-owners").css("display", tab === "owners" ? "block" : "none");

        if (tab !== "market") this.marketUi?.deactivate();
        if (tab !== "auction") this.auctionUi?.deactivate();
        if (tab !== "owners") this.ownersUi?.deactivate();

        if (tab === "daily") {
            this.refresh();
        } else if (tab === "market") {
            this.marketUi?.activate();
            // Viewing the market clears the "new item" dot.
            this.markMarketSeen();
        } else if (tab === "auction") {
            this.auctionUi?.activate();
            // Viewing the auctions clears the "new bid" badge.
            this.markAuctionSeen();
        } else {
            this.ownersUi?.activate();
        }
    }

    /** Opens the shop directly on the Owners tab, optionally with a cosmetic preselected. */
    openOwners(type?: string) {
        this.open();
        this.selectTab("owners");
        if (type) this.ownersUi?.selectType(type);
    }

    /** Runs a 1s countdown to the server-provided reset time (server-local midnight). */
    private startResetTimer() {
        this.stopResetTimer();
        this.updateResetTimer();
        this.resetInterval = setInterval(() => this.updateResetTimer(), 1000);
    }

    private stopResetTimer() {
        if (this.resetInterval !== null) {
            clearInterval(this.resetInterval);
            this.resetInterval = null;
        }
    }

    /** Time left on a rotation, for the countdown in its section heading. */
    private remainingFor(weekly: boolean): string {
        const until = weekly ? this.weeklyResetTime : this.resetTime;
        if (!until) return "--:--:--";
        // `until` and Date.now() are both epoch ms, so this is timezone-agnostic.
        return formatRemaining(until - Date.now());
    }

    private updateResetTimer() {
        this.body.find(".shop-daily-timer").text(this.remainingFor(false));
        this.body.find(".shop-weekly-timer").text(this.remainingFor(true));

        // The weekly rolls at a Monday midnight, which is always a daily reset too — so
        // this one check pulls in a new week as well as a new day.
        if (this.resetTime && this.resetTime - Date.now() <= 0) {
            // Reset reached while the modal was open → pull the new offers (and the
            // next resetTime). Clear it first so we only refresh once.
            this.resetTime = 0;
            this.refresh();
        }
    }

    open() {
        this.modal.show();
    }

    /**
     * Refreshes the shop button + tab badges: a dot when a new daily rotation is available
     * (vs the last one the player viewed) and a count when private market offers are
     * waiting. Called on login and whenever the shop closes.
     */
    refreshShopBadges() {
        if (!this.account.loggedIn) {
            this.applyShopBadges(false, 0, 0);
            return;
        }
        this.account.getShop((err, res) => {
            const dailyNew = !!(
                !err &&
                res?.success &&
                res.day &&
                res.day !== this.seenShopDay()
            );
            this.account.getPrivateOffers((e2, r2) => {
                const priv = !e2 && r2?.success ? r2.listings.length : 0;
                // Count new public listings from OTHER players (own listings never count).
                this.account.getMarket({ page: 0 }, (e3, r3) => {
                    const listings = !e3 && r3?.success ? r3.listings : [];
                    const ownSlug = this.account.profile?.slug ?? "";
                    const seen = this.seenMarketTs();
                    this.marketNewestTs = listings.length ? listings[0].createdAt : 0;
                    const marketNewCount = listings.filter(
                        (l) => l.sellerSlug !== ownSlug && l.createdAt > seen,
                    ).length;
                    this.applyShopBadges(dailyNew, priv, marketNewCount);
                });
            });
        });
    }

    private seenShopDay(): string {
        try {
            return localStorage.getItem(ShopUi.SEEN_DAY_KEY) || "";
        } catch {
            return "";
        }
    }

    private seenMarketTs(): number {
        try {
            return Number(localStorage.getItem(ShopUi.MARKET_SEEN_KEY)) || 0;
        } catch {
            return 0;
        }
    }

    /**
     * Buy-offers needing the player's attention: incoming offers awaiting a reply, plus
     * their own offers the owner has countered. Drives the Offers sub-tab + Market badge.
     */
    private actionableOffersCount(): number {
        const incoming = this.account.offersIncoming.filter(
            (o) => o.status === "pending",
        ).length;
        const counters = this.account.offersOutgoing.filter(
            (o) => o.status === "countered",
        ).length;
        return incoming + counters;
    }

    /** Market tab badge = new public listings + offers needing attention (both live there). */
    private renderMarketBadge() {
        const total = this.marketNewCount + this.actionableOffersCount();
        $("#shop-market-badge")
            .text(total > 0 ? String(total) : "")
            .css("display", total > 0 ? "inline-block" : "none");
    }

    private seenAuctionBids(): number {
        try {
            return Number(localStorage.getItem(ShopUi.AUCTION_SEEN_KEY)) || 0;
        } catch {
            return 0;
        }
    }

    private setSeenAuctionBids(n: number) {
        try {
            localStorage.setItem(ShopUi.AUCTION_SEEN_KEY, String(n));
        } catch {
            /* ignore */
        }
    }

    /** Auction tab badge lights when a new bid lands on one of the player's auctions. */
    private renderAuctionBadge() {
        const bids = this.account.auctionBids;
        // If bid-carrying auctions dropped (e.g. one settled), forget the old baseline.
        if (bids < this.seenAuctionBids()) this.setSeenAuctionBids(bids);
        const show = bids > this.seenAuctionBids();
        $("#shop-auction-badge")
            .text(show ? String(bids) : "")
            .css("display", show ? "inline-block" : "none");
    }

    /** Marks the current bid situation as seen (clears the Auction tab badge). */
    private markAuctionSeen() {
        this.setSeenAuctionBids(this.account.auctionBids);
        $("#shop-auction-badge").text("").css("display", "none");
        this.updateShopBtnAlert();
    }

    private applyShopBadges(
        dailyNew: boolean,
        privateCount: number,
        marketNewCount: number,
    ) {
        this.privateBadgeCount = privateCount;
        this.marketNewCount = marketNewCount;
        $("#shop-daily-dot").css("display", dailyNew ? "inline-block" : "none");
        this.renderMarketBadge();
        this.renderAuctionBadge();
        // Private sub-tab keeps the exact private-offer count.
        $("#market-private-badge")
            .text(privateCount > 0 ? String(privateCount) : "")
            .css("display", privateCount > 0 ? "inline-block" : "none");
        this.updateShopBtnAlert();
    }

    /** Lights the shop button when any tab has an active badge/dot. */
    private updateShopBtnAlert() {
        const lit =
            $("#shop-daily-dot").css("display") !== "none" ||
            $("#shop-market-badge").css("display") !== "none" ||
            $("#shop-auction-badge").css("display") !== "none" ||
            $("#market-private-badge").css("display") !== "none" ||
            $("#market-offers-badge").css("display") !== "none";
        $("#shop-btn-alert").css("display", lit ? "block" : "none");
    }

    /** Marks the current public market as seen (clears the "new listings" count). */
    private markMarketSeen() {
        this.account.getMarket({ page: 0 }, (err, res) => {
            const newest =
                !err && res?.success && res.listings.length
                    ? res.listings[0].createdAt
                    : this.marketNewestTs;
            try {
                localStorage.setItem(ShopUi.MARKET_SEEN_KEY, String(newest));
            } catch {
                /* ignore */
            }
            this.marketNewestTs = newest;
            // Only the "new listings" part is now seen; incoming offers still show.
            this.marketNewCount = 0;
            this.renderMarketBadge();
            this.updateShopBtnAlert();
        });
    }

    refresh() {
        this.body.html('<div class="shop-status">…</div>');
        this.account.getShop((err, res) => {
            if (err || !res || !res.success) {
                this.body.html('<div class="shop-status">Failed to load shop</div>');
                return;
            }
            this.resetTime = res.resetTime;
            // Set before rendering: the weekly cards stamp their countdown on creation.
            this.weeklyResetTime = res.weeklyResetTime;
            this.updateResetTimer();
            this.balanceEl.text(res.balance);
            this.renderOffers(res.balance, res.offers);
            // Viewing the daily shop marks its current rotation as seen.
            try {
                localStorage.setItem(ShopUi.SEEN_DAY_KEY, res.day);
            } catch {
                /* ignore */
            }
            $("#shop-daily-dot").css("display", "none");
            // Daily is no longer "new"; the button stays lit only if another tab has a dot.
            this.updateShopBtnAlert();
        });
    }

    private renderOffers(balance: number, offers: ShopOffer[]) {
        this.body.empty();
        if (offers.length === 0) {
            this.body.html('<div class="shop-status">No offers today</div>');
            return;
        }
        // One row per rotation, daily above weekly, each heading carrying its countdown.
        for (const section of [
            { label: "Daily", weekly: false },
            { label: "Weekly", weekly: true },
        ]) {
            const group = offers.filter((o) => isWeeklySlot(o.slot) === section.weekly);
            if (group.length === 0) continue;
            const timerClass = section.weekly ? "shop-weekly-timer" : "shop-daily-timer";
            const el = $('<div class="shop-section"></div>');
            el.append(
                `<div class="shop-section-head">` +
                    `<span class="shop-section-label">${section.label}</span>` +
                    `<span class="shop-section-reset">Resets in <span class="${timerClass}">${this.remainingFor(section.weekly)}</span></span>` +
                    `</div>`,
            );
            const row = $('<div class="shop-offers-row"></div>');
            for (const offer of group) row.append(this.renderOffer(balance, offer));
            el.append(row);
            this.body.append(el);
        }
    }

    private renderOffer(balance: number, offer: ShopOffer): JQuery<HTMLElement> {
        const card = $('<div class="shop-offer"></div>');
        card.append(`<div class="shop-offer-title">${SLOT_TITLES[offer.slot]}</div>`);

        const itemsWrap = $('<div class="shop-offer-items"></div>');
        for (const it of offer.items) {
            itemsWrap.append(this.renderItem(it.type));
        }
        card.append(itemsWrap);

        const footer = $('<div class="shop-offer-footer"></div>');
        /*footer.append(
            `<div class="shop-offer-price"><div class="shop-fries-icon"></div><span>${offer.price}</span></div>`,
        );*/

        const btn = $('<div class="shop-buy-btn menu-option btn-darken"></div>');
        if (offer.purchased) {
            btn.addClass("shop-buy-disabled").text("Owned");
        } else if (balance < offer.price) {
            btn.addClass("shop-buy-disabled").html(
                `<div class="shop-fries-icon"></div><div class="shop-offer-price">${offer.price}</div>`,
            );
        } else {
            btn.html(
                `<div class="shop-fries-icon"></div><div class="shop-offer-price">${offer.price}</div>`,
            ).on("click", () => this.buy(offer.slot, btn));
        }
        footer.append(btn);
        card.append(footer);
        return card;
    }

    private renderItem(type: string): JQuery<HTMLElement> {
        const def = GameObjectDefs.typeToDef(type) as
            | { rarity?: number; name?: string }
            | undefined;
        const rarity = getItemRarity(type);
        const svg = helpers.getSvgFromGameType(type);
        const transform = helpers.getCssTransformFromGameType(type);
        const name = this.localization.translate(`game-${type}`) || def?.name || type;
        const ownersHtml = cosmeticStats.hasData()
            ? `<div class="shop-item-owners" style="font-size:11px;color:#c5c5c5;">${cosmeticStats.getCount(
                  type,
              )} (${formatOwnerPercent(cosmeticStats.getPercent(type))})</div>`
            : "";

        const el = $(
            `<div class="shop-item" style="border-color:${RARITY_COLORS[rarity] ?? "#c5c5c5"}">` +
                '<div class="shop-item-img"></div>' +
                `<div class="shop-item-name">${helpers.htmlEscape(name)}</div>` +
                ownersHtml +
                "</div>",
        );
        el.find(".shop-item-img").css({
            "background-image": `url(${svg})`,
            transform,
        });
        return el;
    }

    private buy(slot: number, btn: JQuery<HTMLElement>) {
        if (this.buying) return;
        this.buying = true;
        btn.addClass("shop-buy-disabled").text("…");
        this.account.buyShopOffer(slot, (err, res) => {
            this.buying = false;
            if (err || !res || !res.success) {
                btn.text(res?.error === "insufficient_funds" ? "Too poor" : "Error");
                setTimeout(() => this.refresh(), 900);
                return;
            }
            this.refresh();
        });
    }
}
