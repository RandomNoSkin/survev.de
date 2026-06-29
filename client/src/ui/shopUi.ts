import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/gameObjectDefs";
import { getItemRarity } from "../../../shared/defs/shopConfig";
import type { ShopOffer } from "../../../shared/types/user";
import { cosmeticStats, formatOwnerPercent } from "../../../shared/utils/cosmeticStats";
import type { Account } from "../account";
import { helpers } from "../helpers";
import type { Localization } from "./localization";
import type { MarketUi } from "./marketUi";
import { MenuModal } from "./menuModal";

/** Rarity index → colour (matches the loadout menu palette). */
const RARITY_COLORS = ["#c5c5c5", "#c5c5c5", "#12ff00", "#00deff", "#f600ff", "#d96100"];

export class ShopUi {
    modal: MenuModal;
    body = $("#shop-daily-offers");
    balanceEl = $("#shop-balance-amount");
    resetTimerEl = $("#shop-reset-timer-value");
    buying = false;
    /** The marketplace panel (the "Market" tab); set by main.ts. */
    marketUi: MarketUi | null = null;
    tab: "daily" | "market" = "daily";
    private resetInterval: ReturnType<typeof setInterval> | null = null;
    /** Epoch ms of the next shop reset, as reported by the API server. */
    private resetTime = 0;

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
        });

        $("#modal-shop [data-shop-tab]").on("click", (e) => {
            this.selectTab($(e.currentTarget).data("shop-tab") as "daily" | "market");
        });
    }

    /** Switch between the Daily shop and the player Market within the shop modal. */
    selectTab(tab: "daily" | "market") {
        this.tab = tab;
        $("#modal-shop [data-shop-tab]").removeClass("shop-tab-active");
        $(`#modal-shop [data-shop-tab='${tab}']`).addClass("shop-tab-active");
        const daily = tab === "daily";
        $("#shop-daily-offers").css("display", daily ? "" : "none");
        $("#shop-market").css("display", daily ? "none" : "block");
        $("#shop-reset-timer").css("display", daily ? "" : "none");
        if (daily) {
            this.marketUi?.deactivate();
            this.refresh();
        } else {
            this.marketUi?.activate();
        }
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

    private updateResetTimer() {
        if (!this.resetTime) {
            this.resetTimerEl.text("--:--:--");
            return;
        }
        // resetTime and Date.now() are both epoch ms, so this is timezone-agnostic.
        const remaining = Math.floor((this.resetTime - Date.now()) / 1000);
        if (remaining <= 0) {
            // Reset reached while the modal was open → pull the new offers (and the
            // next resetTime). Clear it first so we only refresh once.
            this.resetTime = 0;
            this.refresh();
            return;
        }
        const pad = (n: number) => String(n).padStart(2, "0");
        const h = Math.floor(remaining / 3600);
        const m = Math.floor((remaining % 3600) / 60);
        const s = remaining % 60;
        this.resetTimerEl.text(`${pad(h)}:${pad(m)}:${pad(s)}`);
    }

    open() {
        this.modal.show();
    }

    refresh() {
        this.body.html('<div class="shop-status">…</div>');
        this.account.getShop((err, res) => {
            if (err || !res || !res.success) {
                this.body.html('<div class="shop-status">Failed to load shop</div>');
                return;
            }
            this.resetTime = res.resetTime;
            this.updateResetTimer();
            this.balanceEl.text(res.balance);
            this.renderOffers(res.balance, res.offers);
        });
    }

    private renderOffers(balance: number, offers: ShopOffer[]) {
        this.body.empty();
        if (offers.length === 0) {
            this.body.html('<div class="shop-status">No offers today</div>');
            return;
        }
        for (const offer of offers) {
            this.body.append(this.renderOffer(balance, offer));
        }
    }

    private renderOffer(balance: number, offer: ShopOffer): JQuery<HTMLElement> {
        const card = $('<div class="shop-offer"></div>');
        const title = offer.slot === 0 ? "Daily Item" : "Daily Bundle";
        card.append(`<div class="shop-offer-title">${title}</div>`);

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
        const def = GameObjectDefs[type] as
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
