import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import { getItemCategory, getItemRarity } from "../../../shared/defs/shopConfig";
import type {
    BlockedUser,
    Friend,
    FriendEntry,
    FriendsResponse,
    RecentPlayer,
    UserSearchResult,
} from "../../../shared/types/user";
import type { Account } from "../account";
import { helpers } from "../helpers";
import type { Localization } from "./localization";
import { MenuModal } from "./menuModal";

/** Rarity index → colour (matches the loadout/shop palette). */
const RARITY_COLORS = ["#c5c5c5", "#c5c5c5", "#12ff00", "#00deff", "#f600ff", "#d96100"];

/** Shown whenever a block (in either direction) stops an interaction. */
const BLOCKED_MSG = "You can't interact with this player.";

type SocialTab = "gift" | "friends" | "clans";
/** Sub-views inside the Gift tab. */
type GiftView = "search" | "fries" | "cosmetics";

/** A giftable owned instance — only the fields the gift flow needs. */
type GiftableItem = { id?: number; type: string };

/**
 * The "Social" panel (opened from the button next to the username). The Gift tab is a
 * player search: search a player, then pick "Gift Golden Fries" or "Gift Cosmetics" next
 * to them, which opens a small sub-view (amount / skin picker) with a Back button. The tab
 * layout leaves room for Friends/Clans later.
 */
export class SocialUi {
    modal: MenuModal;
    /** Set by main.ts: spectates a friend's current live game (region + gameId). */
    onSpectate: ((region: string, gameId: string) => void) | null = null;
    private tab: SocialTab = "gift";
    private view: GiftView = "search";
    /** The player the current gift sub-view is targeting. */
    private target: UserSearchResult | null = null;
    /** Item id the loadout asked to gift (highlighted in the cosmetics view). */
    private pendingItemId: number | null = null;
    private searchDebounce: ReturnType<typeof setTimeout> | null = null;
    private itemsDebounce: ReturnType<typeof setTimeout> | null = null;
    /** Auto-refresh timer for the Friends tab (live in-game status), while it's open. */
    private friendsPoll: ReturnType<typeof setInterval> | null = null;
    /** Callback fired when the in-app confirm dialog is accepted. */
    private confirmOk: (() => void) | null = null;
    /** Accepted-friend slugs, for the button state. */
    private friendSlugs = new Set<string>();
    /** Slugs I've sent a (pending) request to. */
    private outgoingSlugs = new Set<string>();
    /** Slugs that have sent ME a (pending) request. */
    private incomingSlugs = new Set<string>();
    /** Slugs I've blocked (they can't offer/friend/gift me). */
    private blockedSlugs = new Set<string>();
    /** localStorage key for the client-only recent-players list. */
    private static readonly RECENT_KEY = "survev_social_recent";
    /** localStorage key: slugs of friend requests already viewed (drives the "new" badge). */
    private static readonly SEEN_REQ_KEY = "survev_seen_requests";

    constructor(
        public account: Account,
        public localization: Localization,
    ) {
        this.modal = new MenuModal($("#modal-social"));
        this.modal.onShow(() => this.onShow());
        this.modal.onHide(() => this.onHide());

        $("#modal-social [data-social-tab]").on("click", (e) => {
            this.selectTab($(e.currentTarget).data("social-tab") as SocialTab);
        });

        $("#social-user-search").on("input", () => {
            if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
            this.searchDebounce = setTimeout(() => this.searchPlayers(), 250);
        });
        $("#social-fries-back").on("click", () => this.showView("search"));
        $("#social-cosmetics-back").on("click", () => this.showView("search"));
        $("#social-fries-send").on("click", () => this.sendFries());

        // Cosmetics view: search + type filter + sort (all re-render the giftable list).
        $("#social-cosmetics-search").on("input", () => {
            if (this.itemsDebounce !== null) clearTimeout(this.itemsDebounce);
            this.itemsDebounce = setTimeout(() => this.renderItems(), 150);
        });
        $("#social-cosmetics-category").on("change", () => this.renderItems());
        $("#social-cosmetics-sort").on("change", () => this.renderItems());

        // In-app confirm dialog (replaces the browser's window.confirm).
        $("#social-confirm-cancel").on("click", () => this.hideConfirm());
        $("#social-confirm-ok").on("click", () => {
            const cb = this.confirmOk;
            this.hideConfirm();
            cb?.();
        });

        // Keep the giftable-items list fresh while the cosmetics view is open (a gift
        // refreshes the profile, which re-emits "items").
        this.account.addEventListener("items", () => {
            if (this.modal.isVisible() && this.view === "cosmetics") this.renderItems();
        });
        // On login, check for pending friend requests to light up the Social button badge.
        this.account.addEventListener("login", () => this.refreshFriends());
    }

    open() {
        this.modal.show();
    }

    /** Opens the panel to gift a specific skin (from the loadout gift button): the user
     *  searches a player and picks "Gift Cosmetics", where this item is pre-highlighted. */
    openWithItem(item: GiftableItem) {
        this.pendingItemId = item?.id ?? null;
        this.tab = "gift";
        this.modal.show();
    }

    private onShow() {
        this.selectTab("gift");
        // Load friend slugs so the search rows can show "✓ Friend" vs "+ Add friend".
        this.refreshFriends(() => {
            const searching = String($("#social-user-search").val() ?? "").trim();
            if (this.tab === "gift" && this.view === "search" && !searching) {
                this.renderSearchEmpty();
            }
        });
        window.setTimeout(() => $("#social-user-search").trigger("focus"), 50);
    }

    private refreshFriends(cb?: () => void) {
        if (!this.account.loggedIn) {
            this.updateFriendBadge([]);
            cb?.();
            return;
        }
        this.account.getFriends((err, res) => {
            if (!err && res?.success) {
                this.friendSlugs = new Set(res.friends.map((f) => f.slug));
                this.outgoingSlugs = new Set(res.outgoing.map((f) => f.slug));
                this.incomingSlugs = new Set(res.incoming.map((f) => f.slug));
                this.blockedSlugs = new Set((res.blocked ?? []).map((b) => b.slug));
                this.updateFriendBadge(res.incoming.map((f) => f.slug));
            }
            cb?.();
        });
    }

    /** Shows the pulsing alert on the Social button + a count on the Friends tab for
     *  UNSEEN friend requests (mirrors the loadout button's "new item" alert). Requests
     *  already viewed on the Friends tab don't count until new ones arrive. */
    private updateFriendBadge(incomingSlugs: string[]) {
        const seen = this.loadSeenRequests();
        const unseen = incomingSlugs.filter((s) => !seen.has(s)).length;
        $("#social-alert-main").css("display", unseen > 0 ? "block" : "none");
        $("#social-friends-tab-badge")
            .text(unseen > 0 ? String(unseen) : "")
            .css("display", unseen > 0 ? "inline-block" : "none");
    }

    private loadSeenRequests(): Set<string> {
        try {
            const raw = localStorage.getItem(SocialUi.SEEN_REQ_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return new Set(Array.isArray(arr) ? (arr as string[]) : []);
        } catch {
            return new Set();
        }
    }

    /** Marks all current incoming requests as seen (pruned to the current set so it never
     *  grows unbounded and a re-sent request counts as new again) and clears the badge. */
    private markRequestsSeen(incomingSlugs: string[]) {
        try {
            localStorage.setItem(SocialUi.SEEN_REQ_KEY, JSON.stringify(incomingSlugs));
        } catch {
            /* ignore quota errors */
        }
        this.updateFriendBadge(incomingSlugs);
    }

    private onHide() {
        if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
        if (this.itemsDebounce !== null) clearTimeout(this.itemsDebounce);
        this.searchDebounce = null;
        this.itemsDebounce = null;
        this.pendingItemId = null;
        this.target = null;
        this.hideConfirm();
        this.stopFriendsPolling();
        // Requests may have been accepted/declined while open — refresh the button badge.
        this.refreshFriends();
    }

    private selectTab(tab: SocialTab) {
        this.tab = tab;
        $("#modal-social [data-social-tab]").removeClass("shop-tab-active");
        $(`#modal-social [data-social-tab='${tab}']`).addClass("shop-tab-active");
        $("#social-gift").css("display", tab === "gift" ? "block" : "none");
        $("#social-friends").css("display", tab === "friends" ? "block" : "none");
        $("#social-clans").css("display", tab === "clans" ? "block" : "none");
        if (tab === "gift") {
            this.showView("search");
            $("#social-user-search").val("");
            this.renderSearchEmpty();
            this.stopFriendsPolling();
        } else if (tab === "friends") {
            this.loadFriends();
            this.startFriendsPolling();
        } else {
            this.stopFriendsPolling();
        }
    }

    private showView(view: GiftView) {
        this.view = view;
        $("#social-search-view").css("display", view === "search" ? "block" : "none");
        $("#social-fries-view").css("display", view === "fries" ? "block" : "none");
        $("#social-cosmetics-view").css(
            "display",
            view === "cosmetics" ? "block" : "none",
        );
    }

    /** Switches to the Social Hub tab without resetting its search (used when a gift is
     *  triggered from the Friends tab). */
    private showGiftTab() {
        this.tab = "gift";
        this.stopFriendsPolling();
        $("#modal-social [data-social-tab]").removeClass("shop-tab-active");
        $("#modal-social [data-social-tab='gift']").addClass("shop-tab-active");
        $("#social-gift").css("display", "block");
        $("#social-friends, #social-clans").css("display", "none");
    }

    private itemName(type: string): string {
        const def = GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined;
        return this.localization.translate(`game-${type}`) || def?.name || type;
    }

    private playerName(u: UserSearchResult): string {
        return u.username || u.slug;
    }

    //
    // Player search
    //

    private searchPlayers() {
        const q = String($("#social-user-search").val() ?? "").trim();
        const box = $("#social-search-results");
        if (!q) {
            this.renderSearchEmpty();
            return;
        }
        this.account.searchUsers(q, (err, res) => {
            box.empty();
            if (err || !res || !res.success) return;
            if (res.users.length === 0) {
                box.html('<div class="shop-status">No players found</div>');
                return;
            }
            for (const u of res.users) box.append(this.renderPlayerRow(u));
        });
    }

    /** Opens a player's public stats page in a new tab. */
    private openStats(slug: string) {
        window.open(`/stats/?slug=${encodeURIComponent(slug)}`, "_blank");
    }

    /** A player name that links to their stats page on click. */
    private nameLink(u: { slug: string; username: string }): JQuery<HTMLElement> {
        const el = $(
            `<span class="social-player-name social-name-link">${helpers.htmlEscape(
                u.username || u.slug,
            )}</span>`,
        );
        el.on("click", () => this.openStats(u.slug));
        return el;
    }

    /** 🍟 Gift Fries button that opens the gift-fries flow for `u`. */
    private friesBtn(u: UserSearchResult): JQuery<HTMLElement> {
        const btn = $(
            '<div class="shop-buy-btn social-action-fries menu-option btn-darken">🍟 Gift Fries</div>',
        );
        btn.on("click", () => this.openFries(u));
        return btn;
    }

    /** 🎁 Gift Cosmetic button that opens the gift-cosmetics flow for `u`. */
    private cosmeticsBtn(u: UserSearchResult): JQuery<HTMLElement> {
        const btn = $(
            '<div class="shop-buy-btn social-action-cosmetics menu-option btn-darken">🎁 Gift Cosmetic</div>',
        );
        btn.on("click", () => this.openCosmetics(u));
        return btn;
    }

    /** Friend button whose state reflects the relationship: accepted → "✓ Friend",
     *  incoming request → "Accept", outgoing request → "Requested" (click to cancel),
     *  otherwise "+ Add" (sends a request). Transitions swap the button in place. */
    private friendBtn(u: { slug: string; username: string }): JQuery<HTMLElement> {
        const slug = u.slug;

        if (this.friendSlugs.has(slug)) {
            return $(
                '<div class="shop-buy-btn social-friend-added shop-buy-disabled">✓ Friend</div>',
            );
        }

        // Runs an action, showing a spinner, then swaps in the fresh button on success.
        const action = (
            btn: JQuery<HTMLElement>,
            label: string,
            fn: (
                cb: (err: unknown, res?: { success: boolean; error?: string }) => void,
            ) => void,
            onOk: () => void,
        ) => {
            btn.on("click", () => {
                btn.addClass("shop-buy-disabled").text("…");
                fn((err, res) => {
                    if (!err && res?.success) {
                        onOk();
                        btn.replaceWith(this.friendBtn(u));
                        return;
                    }
                    btn.removeClass("shop-buy-disabled").text(label);
                    // A block (either direction) is the one failure worth explaining.
                    if (res?.error === "blocked") {
                        this.showInfo(BLOCKED_MSG);
                    }
                });
            });
        };

        if (this.incomingSlugs.has(slug)) {
            const btn = $(
                '<div class="shop-buy-btn social-action-accept menu-option btn-darken">Accept</div>',
            );
            action(
                btn,
                "Accept",
                (cb) => this.account.acceptFriend(slug, cb),
                () => {
                    this.incomingSlugs.delete(slug);
                    this.friendSlugs.add(slug);
                },
            );
            return btn;
        }

        if (this.outgoingSlugs.has(slug)) {
            const btn = $(
                '<div class="shop-buy-btn social-friend-pending menu-option btn-darken" title="Cancel request">Requested</div>',
            );
            action(
                btn,
                "Requested",
                (cb) => this.account.removeFriend(slug, cb),
                () => this.outgoingSlugs.delete(slug),
            );
            return btn;
        }

        const btn = $(
            '<div class="shop-buy-btn social-action-add menu-option btn-darken">+ Add</div>',
        );
        action(
            btn,
            "+ Add",
            (cb) => this.account.requestFriend(slug, cb),
            () => this.outgoingSlugs.add(slug),
        );
        return btn;
    }

    /**
     * Block / Unblock. Blocking cuts interaction both ways (no offers, friend requests or
     * gifts) and the server also drops any friendship + pending requests, so it needs an
     * explicit confirm. Unblocking is immediate and restores nothing.
     */
    private blockBtn(u: UserSearchResult): JQuery<HTMLElement> {
        const slug = u.slug;
        const blocked = this.blockedSlugs.has(slug);
        const label = blocked ? "Unblock" : "Block";
        const btn = $(
            `<div class="shop-buy-btn ${
                blocked ? "social-action-unblock" : "social-action-block"
            } menu-option btn-darken">${label}</div>`,
        );

        const run = () => {
            btn.addClass("shop-buy-disabled").text("…");
            this.account.blockAction(blocked ? "unblock" : "block", slug, (err, res) => {
                if (err || !res?.success) {
                    btn.removeClass("shop-buy-disabled").text(label);
                    return;
                }
                if (blocked) {
                    this.blockedSlugs.delete(slug);
                } else {
                    this.blockedSlugs.add(slug);
                    // The server tears these down as part of the block.
                    this.friendSlugs.delete(slug);
                    this.incomingSlugs.delete(slug);
                    this.outgoingSlugs.delete(slug);
                }
                // Friends tab: reload so the Blocked/Friends sections stay truthful.
                if (this.tab === "friends") {
                    this.loadFriends(true);
                    return;
                }
                const row = btn.closest(".social-player-row");
                if (row.length) row.replaceWith(this.renderPlayerRow(u));
                else btn.replaceWith(this.blockBtn(u));
            });
        };

        if (blocked) {
            btn.on("click", run);
        } else {
            btn.on("click", () =>
                this.askConfirm(
                    `Block <b>${helpers.htmlEscape(u.username)}</b>?<br/>` +
                        "They won't be able to send you offers, friend requests or gifts. " +
                        "Any friendship or pending request is removed.",
                    run,
                ),
            );
        }
        return btn;
    }

    private renderPlayerRow(u: UserSearchResult): JQuery<HTMLElement> {
        const row = $('<div class="social-player-row"></div>');
        row.append(this.nameLink(u));
        const actions = $('<div class="social-player-actions"></div>');
        if (this.blockedSlugs.has(u.slug)) {
            // Blocked → no interaction is possible; only lifting the block.
            actions.append(
                '<div class="social-blocked-tag">Blocked</div>',
                this.blockBtn(u),
            );
        } else {
            actions.append(
                this.friesBtn(u),
                this.cosmeticsBtn(u),
                this.friendBtn(u),
                this.blockBtn(u),
            );
        }
        row.append(actions);
        return row;
    }

    //
    // Golden Fries sub-view
    //

    private openFries(u: UserSearchResult) {
        this.target = u;
        this.pushRecent(u);
        this.showGiftTab();
        $("#social-fries-target").text(this.playerName(u));
        $("#social-fries-balance").text(`🍟 ${this.account.profile?.goldenFries ?? 0}`);
        $("#social-fries-amount").val("");
        this.setStatus("#social-fries-status", "");
        this.showView("fries");
        window.setTimeout(() => $("#social-fries-amount").trigger("focus"), 50);
    }

    private sendFries() {
        if (!this.target) return;
        const amount = parseInt(String($("#social-fries-amount").val() ?? ""), 10);
        if (!Number.isFinite(amount) || amount <= 0) {
            this.setStatus("#social-fries-status", "Enter a valid amount.", true);
            return;
        }
        if (amount > (this.account.profile?.goldenFries ?? 0)) {
            this.setStatus("#social-fries-status", "Not enough Golden Fries.", true);
            return;
        }
        const target = this.target;
        const name = this.playerName(target);
        this.askConfirm(
            `Give <b>${amount}</b> 🍟 to <b>${helpers.htmlEscape(name)}</b>?`,
            () => {
                this.setStatus("#social-fries-status", "Sending…");
                this.account.giftFries(target.slug, amount, (err, res) => {
                    if (err || !res || !res.success) {
                        this.setStatus(
                            "#social-fries-status",
                            this.giftFriesError(res?.error),
                            true,
                        );
                        return;
                    }
                    $("#social-fries-amount").val("");
                    $("#social-fries-balance").text(
                        `🍟 ${this.account.profile?.goldenFries ?? 0}`,
                    );
                    this.setStatus(
                        "#social-fries-status",
                        `Sent ${amount} 🍟 to ${name}.`,
                    );
                });
            },
        );
    }

    //
    // Cosmetics sub-view
    //

    private openCosmetics(u: UserSearchResult) {
        this.target = u;
        this.pushRecent(u);
        this.showGiftTab();
        $("#social-cosmetics-target").text(this.playerName(u));
        $("#social-cosmetics-search").val("");
        this.setStatus("#social-cosmetics-status", "");
        this.renderItems();
        this.showView("cosmetics");
    }

    private giftableItems(): GiftableItem[] {
        return (this.account.items ?? []).filter(
            (it) => it.id != null && !!getItemCategory(it.type),
        );
    }

    /** Sorts giftable items by the chosen key (rarity | type | name). */
    private sortGiftItems(items: GiftableItem[], sort: string): GiftableItem[] {
        const byName = (a: GiftableItem, b: GiftableItem) =>
            this.itemName(a.type).localeCompare(this.itemName(b.type));
        const arr = [...items];
        if (sort === "type") {
            arr.sort(
                (a, b) =>
                    (getItemCategory(a.type) ?? "").localeCompare(
                        getItemCategory(b.type) ?? "",
                    ) ||
                    getItemRarity(b.type) - getItemRarity(a.type) ||
                    byName(a, b),
            );
        } else if (sort === "name") {
            arr.sort(byName);
        } else {
            // rarity (default): rarest first, then by name
            arr.sort(
                (a, b) => getItemRarity(b.type) - getItemRarity(a.type) || byName(a, b),
            );
        }
        return arr;
    }

    private renderItems() {
        const cont = $("#social-gift-items");
        cont.empty();
        const base = this.giftableItems();
        if (base.length === 0) {
            cont.html('<div class="shop-status">You have no giftable skins.</div>');
            return;
        }

        let items = base;
        const cat = String($("#social-cosmetics-category").val() ?? "");
        if (cat) items = items.filter((it) => getItemCategory(it.type) === cat);
        const q = String($("#social-cosmetics-search").val() ?? "")
            .trim()
            .toLowerCase();
        if (q) {
            items = items.filter(
                (it) =>
                    this.itemName(it.type).toLowerCase().includes(q) ||
                    it.type.toLowerCase().includes(q),
            );
        }
        items = this.sortGiftItems(
            items,
            String($("#social-cosmetics-sort").val() ?? "rarity"),
        );

        if (items.length === 0) {
            cont.html('<div class="shop-status">No matching cosmetics.</div>');
            return;
        }

        for (const it of items) {
            const rarity = getItemRarity(it.type);
            const row = $(
                `<div class="social-gift-item"${
                    it.id === this.pendingItemId ? ' data-pending="1"' : ""
                }>` +
                    `<div class="social-gift-img" style="border-color:${
                        RARITY_COLORS[rarity] ?? "#c5c5c5"
                    }"></div>` +
                    `<span class="social-gift-name">${helpers.htmlEscape(
                        this.itemName(it.type),
                    )}</span>` +
                    '<div class="shop-buy-btn social-gift-btn menu-option btn-darken">🎁 Gift</div>' +
                    "</div>",
            );
            row.find(".social-gift-img").css({
                "background-image": `url(${helpers.getSvgFromGameType(it.type)})`,
                transform: helpers.getCssTransformFromGameType(it.type),
            });
            row.find(".social-gift-btn").on("click", () => this.giftItem(it));
            cont.append(row);
        }
        if (this.pendingItemId != null) {
            cont.find('[data-pending="1"]').get(0)?.scrollIntoView({ block: "nearest" });
        }
    }

    private giftItem(item: GiftableItem) {
        if (!this.target || item.id == null) return;
        const target = this.target;
        const itemId = item.id;
        const name = this.playerName(target);
        this.askConfirm(
            `Give <b>${helpers.htmlEscape(
                this.itemName(item.type),
            )}</b> to <b>${helpers.htmlEscape(name)}</b>?<br>This can't be undone.`,
            () => {
                this.setStatus("#social-cosmetics-status", "Sending…");
                this.account.giftItem(itemId, target.slug, (err, res) => {
                    if (err || !res || !res.success) {
                        this.setStatus(
                            "#social-cosmetics-status",
                            this.giftItemError(res?.error),
                            true,
                        );
                        return;
                    }
                    this.pendingItemId = null;
                    this.setStatus(
                        "#social-cosmetics-status",
                        `Sent ${this.itemName(item.type)} to ${name}. 🎁`,
                    );
                });
            },
        );
    }

    //
    // Confirm dialog (in-app, replaces window.confirm)
    //

    private askConfirm(html: string, onOk: () => void) {
        this.confirmOk = onOk;
        $("#social-confirm-msg").html(html);
        $("#social-confirm-cancel").css("display", "");
        $("#social-confirm-ok").text("Confirm");
        $("#social-confirm").css("display", "flex");
    }

    /** Info popup — the same overlay with a single OK and no action attached. */
    private showInfo(html: string) {
        this.confirmOk = null;
        $("#social-confirm-msg").html(html);
        $("#social-confirm-cancel").css("display", "none");
        $("#social-confirm-ok").text("OK");
        $("#social-confirm").css("display", "flex");
    }

    private hideConfirm() {
        this.confirmOk = null;
        $("#social-confirm").css("display", "none");
    }

    //
    // Recent-players history (client-only, localStorage — no DB)
    //

    private loadRecent(): UserSearchResult[] {
        try {
            const raw = localStorage.getItem(SocialUi.RECENT_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    private pushRecent(u: UserSearchResult) {
        const list = this.loadRecent().filter((r) => r.slug !== u.slug);
        list.unshift({ slug: u.slug, username: u.username });
        try {
            localStorage.setItem(SocialUi.RECENT_KEY, JSON.stringify(list.slice(0, 8)));
        } catch {
            /* ignore quota errors */
        }
    }

    /** Renders the recent-players list (or nothing) when the search box is empty. */
    private renderSearchEmpty() {
        const box = $("#social-search-results");
        box.empty();
        const recent = this.loadRecent();
        if (!recent.length) return;
        const head = $('<div class="social-recent-head">Recent</div>');
        const clear = $('<span class="social-recent-clear">clear</span>');
        clear.on("click", () => {
            try {
                localStorage.removeItem(SocialUi.RECENT_KEY);
            } catch {
                /* ignore */
            }
            this.renderSearchEmpty();
        });
        head.append(clear);
        box.append(head);
        for (const u of recent) box.append(this.renderPlayerRow(u));
    }

    //
    // Friends tab (friends list + recently-played players)
    //

    /** Loads (or, when `silent`, live-refreshes without the loading flash) the Friends tab. */
    private loadFriends(silent = false) {
        if (!silent) {
            // Opening the Friends tab clears the "new requests" badge immediately.
            $("#social-friends-tab-badge, #social-alert-main").css("display", "none");
            $("#social-requests-list").empty();
            $("#social-friends-list").html('<div class="shop-status">Loading…</div>');
            $("#social-recent-list").empty();
        }
        this.account.getFriends((err, res) => {
            if (err || !res || !res.success) {
                if (!silent) {
                    $("#social-friends-list").html(
                        '<div class="shop-status">Failed to load friends.</div>',
                    );
                }
                return;
            }
            this.friendSlugs = new Set(res.friends.map((f) => f.slug));
            this.outgoingSlugs = new Set(res.outgoing.map((f) => f.slug));
            this.incomingSlugs = new Set(res.incoming.map((f) => f.slug));
            this.blockedSlugs = new Set((res.blocked ?? []).map((b) => b.slug));
            // Mark these requests as seen so the badge stays gone until new ones arrive.
            this.markRequestsSeen(res.incoming.map((f) => f.slug));
            this.renderFriends(res);
        });
    }

    /** While the Friends tab is open, live-refresh it every 8 s (in-game status, last game,
     *  incoming requests) — the same idea as the moderation dashboard's periodic push. */
    private startFriendsPolling() {
        this.stopFriendsPolling();
        this.friendsPoll = setInterval(() => {
            if (this.modal.isVisible() && this.tab === "friends") {
                this.loadFriends(true);
            } else {
                this.stopFriendsPolling();
            }
        }, 8000);
    }

    private stopFriendsPolling() {
        if (this.friendsPoll !== null) {
            clearInterval(this.friendsPoll);
            this.friendsPoll = null;
        }
    }

    private renderFriends(res: FriendsResponse) {
        // Incoming friend requests (Accept / Decline).
        const rq = $("#social-requests-list").empty();
        $("#social-requests-head").css("display", res.incoming.length ? "" : "none");
        for (const f of res.incoming) rq.append(this.renderRequestRow(f));

        // Outgoing requests you've sent (Cancel to withdraw).
        const sl = $("#social-sent-list").empty();
        $("#social-sent-head").css("display", res.outgoing.length ? "" : "none");
        for (const f of res.outgoing) sl.append(this.renderSentRow(f));

        // Accepted friends.
        const fl = $("#social-friends-list").empty();
        if (res.friends.length === 0) {
            fl.html('<div class="shop-status">No friends yet — add players below.</div>');
        } else {
            for (const f of res.friends) fl.append(this.renderFriendRow(f));
        }

        // Recently-played players.
        const rl = $("#social-recent-list").empty();
        if (res.recent.length === 0) {
            rl.html('<div class="shop-status">No recent players.</div>');
        } else {
            for (const p of res.recent) rl.append(this.renderRecentRow(p));
        }

        // Blocked accounts (Unblock to lift); hidden when nothing is blocked.
        const blocked = res.blocked ?? [];
        const bl = $("#social-blocked-list").empty();
        $("#social-blocked-head").css("display", blocked.length ? "" : "none");
        for (const b of blocked) bl.append(this.renderBlockedRow(b));
    }

    private renderBlockedRow(b: BlockedUser): JQuery<HTMLElement> {
        const row = $('<div class="social-player-row"></div>');
        row.append(this.nameLink(b));
        row.append(
            $('<div class="social-player-actions"></div>').append(this.blockBtn(b)),
        );
        return row;
    }

    private renderSentRow(f: Friend): JQuery<HTMLElement> {
        const cancel = $(
            '<div class="shop-buy-btn social-friend-remove menu-option btn-darken">Cancel</div>',
        );
        cancel.on("click", () =>
            this.account.removeFriend(f.slug, () => this.loadFriends()),
        );
        const row = $('<div class="social-friend-row"></div>');
        row.append(this.nameLink(f));
        row.append('<span class="social-friend-meta">Pending…</span>');
        row.append($('<div class="social-player-actions"></div>').append(cancel));
        return row;
    }

    private renderRequestRow(f: Friend): JQuery<HTMLElement> {
        const accept = $(
            '<div class="shop-buy-btn social-action-accept menu-option btn-darken">Accept</div>',
        );
        accept.on("click", () =>
            this.account.acceptFriend(f.slug, () => this.loadFriends()),
        );
        const decline = $(
            '<div class="shop-buy-btn social-friend-remove menu-option btn-darken">Decline</div>',
        );
        decline.on("click", () =>
            this.account.removeFriend(f.slug, () => this.loadFriends()),
        );
        const row = $('<div class="social-friend-row"></div>');
        row.append(this.nameLink(f));
        row.append(
            $('<div class="social-player-actions"></div>').append(accept, decline),
        );
        return row;
    }

    private renderFriendRow(f: FriendEntry): JQuery<HTMLElement> {
        const remove = $(
            '<div class="shop-buy-btn social-friend-remove menu-option btn-darken">Remove</div>',
        );
        remove.on("click", () =>
            this.account.removeFriend(f.slug, () => this.loadFriends()),
        );

        const actions = $('<div class="social-player-actions"></div>');
        if (f.live) {
            const live = f.live;
            const spec = $(
                '<div class="shop-buy-btn social-action-spectate menu-option btn-darken">▶ Spectate</div>',
            );
            spec.on("click", () => {
                this.modal.hide();
                this.onSpectate?.(live.region, live.gameId);
            });
            actions.append(spec);
        }
        actions.append(this.friesBtn(f), this.cosmeticsBtn(f), remove);

        const row = $('<div class="social-friend-row"></div>');
        row.append(this.nameLink(f));
        // In-game friends show a live tag (+ Spectate button); others show last-played time.
        row.append(
            f.live
                ? '<span class="social-friend-meta social-live-meta">🟢 In game</span>'
                : `<span class="social-friend-meta">${helpers.htmlEscape(
                      this.lastGameText(f.lastGame),
                  )}</span>`,
        );
        row.append(actions);
        return row;
    }

    private lastGameText(ms: number | null): string {
        if (!ms) return "No games yet";
        const m = Math.floor((Date.now() - ms) / 60000);
        if (m < 1) return "Last played just now";
        if (m < 60) return `Last played ${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `Last played ${h}h ago`;
        return `Last played ${Math.floor(h / 24)}d ago`;
    }

    private renderRecentRow(p: RecentPlayer): JQuery<HTMLElement> {
        const row = $('<div class="social-friend-row"></div>');
        row.append(
            p.relation === "with"
                ? '<span class="social-relation social-relation-with">with</span>'
                : '<span class="social-relation social-relation-against">vs</span>',
        );
        row.append(this.nameLink(p));
        const actions = $('<div class="social-player-actions"></div>');
        if (this.blockedSlugs.has(p.slug)) {
            actions.append(
                '<div class="social-blocked-tag">Blocked</div>',
                this.blockBtn(p),
            );
        } else {
            actions.append(
                this.friesBtn(p),
                this.cosmeticsBtn(p),
                this.friendBtn(p),
                this.blockBtn(p),
            );
        }
        row.append(actions);
        return row;
    }

    //
    // Helpers
    //

    private setStatus(selector: string, msg: string, isError = false) {
        $(selector)
            .text(msg)
            .css("color", isError ? "#ff6a6a" : "#c5c5c5");
    }

    private giftItemError(code?: string): string {
        switch (code) {
            case "recipient_not_found":
                return "That player no longer exists.";
            case "self_gift":
                return "You can't gift to yourself.";
            case "not_owned":
                return "You no longer own that item.";
            case "not_giftable":
                return "That item can't be gifted.";
            case "listed":
                return "Item is listed on the market — cancel the listing first.";
            case "auctioned":
                return "Item is up for auction — it can't be gifted.";
            case "blocked":
                return BLOCKED_MSG;
            default:
                return "Could not send the gift.";
        }
    }

    private giftFriesError(code?: string): string {
        switch (code) {
            case "insufficient_funds":
                return "Not enough Golden Fries.";
            case "recipient_not_found":
                return "That player no longer exists.";
            case "self_gift":
                return "You can't gift to yourself.";
            case "blocked":
                return BLOCKED_MSG;
            default:
                return "Could not send the fries.";
        }
    }
}
