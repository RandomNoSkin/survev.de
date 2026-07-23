import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import {
    AUCTION_MIN_INCREMENT,
    getItemCategory,
    getItemPrice,
    getItemRarity,
    getMarketFee,
    type ShopCategory,
} from "../../../shared/defs/shopConfig";
import type { Auction } from "../../../shared/types/user";
import type { Account } from "../account";
import { helpers } from "../helpers";
import type { Localization } from "./localization";
import { MenuModal } from "./menuModal";

const RARITY_COLORS = ["#c5c5c5", "#c5c5c5", "#12ff00", "#00deff", "#f600ff", "#d96100"];
const RARITY_NAMES = ["stock", "common", "uncommon", "rare", "epic", "mythic"];

/**
 * The Auction house tab: browse active auctions (soonest-ending first) and place escrowed
 * bids, plus a "New auction" flow to put one of your own items up for 24h. Auctions cannot
 * be cancelled once started, so creating one takes an explicit confirm.
 */
export class AuctionUi {
    createModal: MenuModal;
    body = $("#auction-listings");
    balanceEl = $("#shop-balance-amount");
    categoryFilter = $("#auction-category-filter");
    rarityFilter = $("#auction-rarity-filter");

    category: ShopCategory | "" = "";
    rarity: number | "" = "";
    page = 0;
    loading = false;
    busy = false;

    /** Item chosen in the create dialog. */
    private createItemId = 0;
    private createType = "";
    private pendingCreate = false;

    private tickInterval: ReturnType<typeof setInterval> | null = null;

    constructor(
        public account: Account,
        public localization: Localization,
    ) {
        this.createModal = new MenuModal($("#modal-auction-create"));

        this.categoryFilter.on("change", () => {
            this.category = (this.categoryFilter.val() as ShopCategory) || "";
            this.reload();
        });
        this.rarityFilter.on("change", () => {
            const v = this.rarityFilter.val() as string;
            this.rarity = v === "" ? "" : Number(v);
            this.reload();
        });

        $("#auction-create-btn").on("click", () => this.openCreate());
        $("#auction-loadmore").on("click", () => this.loadMore());

        $("#auction-min-bid").on("input", () => this.resetCreateConfirm());
        $("#auction-create-confirm").on("click", () => this.confirmCreate());
    }

    activate() {
        this.reload();
        this.stopTicker();
        this.tickInterval = setInterval(() => this.tickCountdowns(), 1000);
    }

    deactivate() {
        this.stopTicker();
    }

    private stopTicker() {
        if (this.tickInterval !== null) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }
    }

    private balance(): number {
        return this.account.profile.goldenFries ?? 0;
    }

    private itemName(type: string): string {
        const def = GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined;
        return this.localization.translate(`game-${type}`) || def?.name || type;
    }

    private reload() {
        this.page = 0;
        this.balanceEl.text(this.balance());
        this.body.html('<div class="shop-status">…</div>');
        this.fetch(true);
    }

    private loadMore() {
        this.page += 1;
        this.fetch(false);
    }

    private fetch(replace: boolean) {
        if (this.loading) return;
        this.loading = true;
        this.account.getAuctions(
            {
                category: this.category || undefined,
                rarity: this.rarity === "" ? undefined : this.rarity,
                page: this.page,
            },
            (err, res) => {
                this.loading = false;
                if (replace) this.body.empty();
                if (err || !res || !res.success) {
                    if (replace) {
                        this.body.html(
                            '<div class="shop-status">Failed to load auctions</div>',
                        );
                    }
                    return;
                }
                if (replace && res.auctions.length === 0) {
                    this.body.html('<div class="shop-status">No live auctions</div>');
                }
                for (const a of res.auctions) this.body.append(this.renderAuction(a));
                $("#auction-loadmore").css("display", res.hasMore ? "block" : "none");
            },
        );
    }

    private renderAuction(a: Auction): JQuery<HTMLElement> {
        const rarity = getItemRarity(a.type);
        const color = RARITY_COLORS[rarity] ?? "#c5c5c5";
        const card = $('<div class="shop-offer market-listing"></div>');
        card.css({ "border-color": color, "box-shadow": `inset 0 0 0 1px ${color}55` });

        const img = $('<div class="shop-item-img market-item-img"></div>').css({
            "border-color": color,
            "background-image": `url(${helpers.getSvgFromGameType(a.type)})`,
            transform: helpers.getCssTransformFromGameType(a.type),
        });
        card.append(img);
        card.append(
            `<div class="shop-offer-title" style="color:${color}">${helpers.htmlEscape(
                this.itemName(a.type),
            )}</div>`,
        );
        card.append(
            `<div class="market-rarity" style="color:${color}">${
                this.localization.translate(`loadout-${RARITY_NAMES[rarity]}`) ||
                RARITY_NAMES[rarity]
            }</div>`,
        );
        card.append(
            `<div class="market-seller">by ${helpers.htmlEscape(
                a.sellerUsername || a.sellerSlug,
            )}</div>`,
        );

        const bidLabel =
            a.currentBid != null
                ? `Current bid <b>${a.currentBid}</b>${
                      a.currentBidderSlug
                          ? ` · ${helpers.htmlEscape(a.currentBidderSlug)}`
                          : ""
                  }`
                : `Min bid <b>${a.minBid}</b> · no bids yet`;
        card.append(`<div class="auction-bid-info">${bidLabel}</div>`);
        card.append(
            `<div class="auction-countdown" data-ends-at="${a.endsAt}">${this.formatCountdown(
                a.endsAt,
            )}</div>`,
        );

        card.append(this.renderBidAction(a));
        return card;
    }

    private minNextBid(a: Auction): number {
        return a.currentBid == null ? a.minBid : a.currentBid + AUCTION_MIN_INCREMENT;
    }

    private renderBidAction(a: Auction): JQuery<HTMLElement> {
        const wrap = $('<div class="auction-action"></div>');
        if (a.youAreSeller) {
            // The seller may end early — the current top bidder (if any) wins now.
            wrap.append('<div class="auction-your">Your auction</div>');
            const label =
                a.currentBid != null
                    ? `End now → sell for ${a.currentBid}`
                    : "End now (no bids)";
            const btn = $(
                `<div class="shop-buy-btn menu-option btn-darken market-offer-danger">${label}</div>`,
            );
            btn.on("click", () => {
                btn.addClass("shop-buy-disabled").text("…");
                this.account.endAuction(a.auctionId, () => this.reload());
            });
            wrap.append(btn);
            return wrap;
        }
        if (a.youAreHighBidder) {
            wrap.append('<div class="shop-buy-btn shop-buy-disabled">✓ You lead</div>');
            return wrap;
        }

        const minBid = this.minNextBid(a);
        const btn = $(
            `<div class="shop-buy-btn menu-option btn-darken">Bid (≥ ${minBid})</div>`,
        );
        btn.on("click", () => {
            // Reveal an inline bid input the first time; confirm places the bid.
            if (wrap.find(".auction-bid-input").length) return;
            const row = $('<div class="auction-bid-row"></div>');
            const input = $(
                `<input type="number" class="auction-bid-input market-sell-price" min="${minBid}" value="${minBid}" />`,
            );
            const send = $(
                '<div class="shop-buy-btn menu-option btn-darken auction-bid-send">Place bid</div>',
            );
            const err = $('<div class="market-sell-error auction-bid-err"></div>');
            send.on("click", () => this.placeBid(a, input, send, err));
            row.append(input).append(send);
            wrap.empty().append(row).append(err);
            input.trigger("focus");
        });
        wrap.append(btn);
        return wrap;
    }

    private placeBid(
        a: Auction,
        input: JQuery<HTMLElement>,
        send: JQuery<HTMLElement>,
        err: JQuery<HTMLElement>,
    ) {
        if (this.busy) return;
        const amount = parseInt(String(input.val()), 10);
        const min = this.minNextBid(a);
        if (!Number.isInteger(amount) || amount < min) {
            err.text(`Bid at least ${min}.`);
            return;
        }
        if (amount > this.balance()) {
            err.text(`Not enough fries (balance ${this.balance()}).`);
            return;
        }
        this.busy = true;
        send.addClass("shop-buy-disabled").text("…");
        this.account.placeBid(a.auctionId, amount, (e, res) => {
            this.busy = false;
            send.removeClass("shop-buy-disabled").text("Place bid");
            if (e || !res || !res.success) {
                if (res?.error === "bid_too_low" && res.minRequired) {
                    err.text(`Bid at least ${res.minRequired}.`);
                } else if (res?.error === "insufficient_funds") {
                    err.text("Not enough fries.");
                } else if (res?.error === "ended") {
                    err.text("This auction just ended.");
                } else if (res?.error === "already_highest") {
                    err.text("You're already the top bidder.");
                } else {
                    err.text("Bid failed.");
                }
                return;
            }
            this.reload();
        });
    }

    private formatCountdown(endsAt: number): string {
        const remaining = endsAt - Date.now();
        if (remaining <= 0) return "⏱ ending…";
        const totalSec = Math.floor(remaining / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const pad = (n: number) => String(n).padStart(2, "0");
        return `⏱ ${h}h ${pad(m)}m ${pad(s)}s`;
    }

    private tickCountdowns() {
        this.body.find(".auction-countdown").each((_i, el) => {
            const endsAt = Number(el.getAttribute("data-ends-at"));
            el.textContent = this.formatCountdown(endsAt);
        });
    }

    //
    // Create-auction flow
    //

    /** Opens the create dialog; with an item preselected (from the loadout) or a picker. */
    openCreate(itemId?: number, type?: string) {
        this.pendingCreate = false;
        $("#auction-create-error").text("");
        $("#auction-create-confirm")
            .removeClass("shop-buy-disabled market-sell-confirming")
            .text("Start auction");

        if (itemId != null && type) {
            this.createItemId = itemId;
            this.createType = type;
            $("#auction-create-picker").css("display", "none").empty();
            $("#auction-create-name").text(this.itemName(type));
            const rec = getItemPrice(type);
            $("#auction-min-bid").val(rec > 0 ? rec : 1);
        } else {
            this.createItemId = 0;
            this.createType = "";
            $("#auction-create-name").text("Pick an item to auction");
            $("#auction-min-bid").val(1);
            this.renderPicker();
        }
        this.createModal.show();
    }

    /** Lists the caller's tradeable owned instances to choose one to auction. */
    private renderPicker() {
        const picker = $("#auction-create-picker").css("display", "block").empty();
        const items = this.account.items.filter(
            (it) => it.id != null && !!getItemCategory(it.type),
        );
        if (!items.length) {
            picker.html('<div class="shop-status">No tradeable items</div>');
            return;
        }
        for (const it of items) {
            const rarity = getItemRarity(it.type);
            const row = $('<div class="auction-pick-row"></div>');
            row.append(
                $('<div class="auction-pick-img"></div>').css({
                    "background-image": `url(${helpers.getSvgFromGameType(it.type)})`,
                    transform: helpers.getCssTransformFromGameType(it.type),
                    "border-color": RARITY_COLORS[rarity] ?? "#c5c5c5",
                }),
            );
            row.append(
                `<div class="auction-pick-name">${helpers.htmlEscape(
                    this.itemName(it.type),
                )}</div>`,
            );
            row.on("click", () => {
                this.createItemId = it.id!;
                this.createType = it.type;
                $("#auction-create-picker .auction-pick-row").removeClass(
                    "auction-pick-selected",
                );
                row.addClass("auction-pick-selected");
                $("#auction-create-name").text(this.itemName(it.type));
                const rec = getItemPrice(it.type);
                $("#auction-min-bid").val(rec > 0 ? rec : 1);
                this.resetCreateConfirm();
            });
            picker.append(row);
        }
    }

    private resetCreateConfirm() {
        if (this.busy || !this.pendingCreate) return;
        this.pendingCreate = false;
        $("#auction-create-confirm")
            .removeClass("market-sell-confirming")
            .text("Start auction");
    }

    private confirmCreate() {
        if (this.busy) return;
        if (!this.createItemId) {
            $("#auction-create-error").text("Pick an item first.");
            return;
        }
        const minBid = parseInt(String($("#auction-min-bid").val()), 10);
        if (!Number.isInteger(minBid) || minBid < 1) {
            $("#auction-create-error").text("Enter a minimum bid of at least 1.");
            return;
        }

        // Auctions can't be cancelled → require a confirming second click.
        if (!this.pendingCreate) {
            this.pendingCreate = true;
            $("#auction-create-error").text("");
            $("#auction-create-confirm")
                .addClass("market-sell-confirming")
                .text("Confirm — start 24h auction (click again)");
            return;
        }

        this.busy = true;
        this.pendingCreate = false;
        $("#auction-create-confirm")
            .removeClass("market-sell-confirming")
            .addClass("shop-buy-disabled")
            .text("…");
        this.account.createAuction(this.createItemId, minBid, (err, res) => {
            this.busy = false;
            $("#auction-create-confirm")
                .removeClass("shop-buy-disabled")
                .text("Start auction");
            if (err || !res || !res.success) {
                $("#auction-create-error").text(this.createErrorText(res?.error));
                return;
            }
            this.createModal.hide();
            this.reload();
        });
    }

    private createErrorText(code?: string): string {
        switch (code) {
            case "not_owned":
                return "You don't own this item.";
            case "not_listable":
                return "This item can't be auctioned.";
            case "bad_price":
                return "Enter a valid minimum bid.";
            case "listed":
                return "Cancel its market listing first.";
            case "already_auctioned":
                return "It's already up for auction.";
            case "already_have_auction":
                return "You can only run one auction at a time.";
            default:
                return "Could not start the auction.";
        }
    }

    /** The market fee the seller pays out of the final bid (shown as a hint). */
    feeOn(amount: number): number {
        return getMarketFee(amount);
    }
}
