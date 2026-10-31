import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import { getItemCategory, getItemRarity } from "../../../shared/defs/shopConfig";
import type {
    BlockedUser,
    Friend,
    FriendEntry,
    FriendsResponse,
    RecentPlayer,
    RoleTag,
    TeamInvite,
    UserSearchResult,
} from "../../../shared/types/user";
import type { Account } from "../account";
import { ClanUi } from "./clanUi";
import { api } from "../api";
import { helpers } from "../helpers";
import type { Localization } from "./localization";
import { MenuModal } from "./menuModal";
import type { OwnersUi } from "./ownersUi";

/** Rarity index → colour (matches the loadout/shop palette). */
const RARITY_COLORS = ["#c5c5c5", "#c5c5c5", "#12ff00", "#00deff", "#f600ff", "#d96100"];

/** Shown whenever a block (in either direction) stops an interaction. */
const BLOCKED_MSG = "You can't interact with this player.";

/** How often an open menu tells the server "still here" (online status + invites). */
const PRESENCE_MS = 20_000;

type SocialTab = "friends" | "players" | "clans" | "discover" | "league" | "owners";
/** The gift sub-views, shown in place of a tab (Back returns to it). */
type GiftView = "fries" | "cosmetics";

/** A giftable owned instance — only the fields the gift flow needs. */
type GiftableItem = { id?: number; type: string };

/** Anyone a row can be about: friend, request, search hit, recent or blocked player. */
type Person = { slug: string; username: string; roleTag?: RoleTag; icon?: string };

/** What a row shows besides the name. */
type RowInfo = {
    /** status dot on the avatar */
    presence?: "game" | "online";
    /** the grey line under the name */
    sub?: string;
    subClass?: string;
    /** the one button that's always visible (Spectate / Accept / Add ...) */
    primary?: JQuery<HTMLElement>[];
    /** nothing but the primary buttons (requests, blocked) */
    noMenu?: boolean;
    /** extra ⋯ entries before the common ones */
    menu?: Array<{ label: string; action: () => void; danger?: boolean }>;
};

/**
 * The "Social" panel (opened from the button next to the username).
 *  - Friends: requests, who's playing / online, all friends, recently played, blocked
 *  - Players: search anyone (suggestions when empty)
 *  - Clans (coming), Owners (who owns a cosmetic, see OwnersUi)
 * Every person is one row: avatar with presence dot, name (→ stats page), a status line,
 * one primary button and a ⋯ menu for the rest (gift fries / cosmetic, invite, stats,
 * add / remove friend, block). Gifting opens a sub-view with a Back button.
 * Also runs the presence heartbeat (online status, team / lobby invites).
 */
export class SocialUi {
    modal: MenuModal;
    /** Set by main.ts: spectates a friend's current live game (region + gameId). */
    onSpectate: ((region: string, gameId: string) => void) | null = null;
    /** Set by main.ts: the team / private lobby the player could invite a friend to. */
    getInviteTarget: () => { kind: "team" | "lobby"; code: string } | null = () => null;
    /** Set by main.ts: join a friend's team / lobby from an invite. */
    onJoinInvite: ((invite: TeamInvite) => void) | null = null;
    /** Set by main.ts: shows a toast (click → `onClick`). */
    toast: (html: string, onClick?: () => void) => void = () => {};
    /** The "Owners" tab (who owns a cosmetic); set by main.ts. */
    ownersUi: OwnersUi | null = null;
    /** The Clans tab. */
    clanUi: ClanUi;
    /** Opened on the Owners tab (from the loadout's rarity click), maybe on one item. */
    private openOnOwners: { type?: string } | null = null;
    private tab: SocialTab = "friends";
    /** The gift sub-view showing, if any. */
    private view: GiftView | null = null;
    /** The player the current gift sub-view is targeting. */
    private target: Person | null = null;
    /** Item id the loadout asked to gift (highlighted in the cosmetics view). */
    private pendingItemId: number | null = null;
    private searchDebounce: ReturnType<typeof setTimeout> | null = null;
    private itemsDebounce: ReturnType<typeof setTimeout> | null = null;
    /** Auto-refresh timer for the Friends tab (live / online status), while it's open. */
    private friendsPoll: ReturnType<typeof setInterval> | null = null;
    private presenceTimer: ReturnType<typeof setInterval> | null = null;
    /** Callback fired when the in-app confirm dialog is accepted. */
    private confirmOk: (() => void) | null = null;
    /** The last friends response (Players-tab suggestions, button states). */
    private last: FriendsResponse | null = null;
    /** Accepted-friend slugs, for the button state. */
    private friendSlugs = new Set<string>();
    /** Slugs I've sent a (pending) request to. */
    private outgoingSlugs = new Set<string>();
    /** Slugs that have sent ME a (pending) request. */
    private incomingSlugs = new Set<string>();
    /** Slugs I've blocked (they can't offer/friend/gift me). */
    private blockedSlugs = new Set<string>();
    /** localStorage key for the client-only recent-gift-targets list. */
    private static readonly RECENT_KEY = "survev_social_recent";
    /** localStorage key: slugs of friend requests already viewed (drives the "new" badge). */
    private static readonly SEEN_REQ_KEY = "survev_seen_requests";

    constructor(
        public account: Account,
        public localization: Localization,
    ) {
        this.clanUi = new ClanUi(account);
        this.clanUi.onBadge = (n) => {
            $("#social-clans-tab-badge")
                .text(n > 0 ? String(n) : "")
                .css("display", n > 0 ? "inline-block" : "none");
            this.clanAlert = n > 0;
            this.applyAlert();
        };
        this.modal = new MenuModal($("#modal-social"));
        this.modal.onShow(() => this.onShow());
        this.modal.onHide(() => this.onHide());

        $("#modal-social [data-social-tab]").on("click", (e) => {
            this.selectTab($(e.currentTarget).data("social-tab") as SocialTab);
        });

        // the Friends tab's search box hands over to the Players tab
        $("#social-friend-search").on("input", () => {
            const q = String($("#social-friend-search").val() ?? "");
            $("#social-friend-search").val("");
            this.selectTab("players");
            $("#social-user-search").val(q).trigger("focus");
            this.searchPlayers();
        });
        $("#social-user-search").on("input", () => {
            if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
            this.searchDebounce = setTimeout(() => this.searchPlayers(), 250);
        });
        $("#social-fries-back, #social-cosmetics-back").on("click", () => this.closeGiftView());
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

        // ⋯ menus close on any click outside them
        $(document).on("mousedown", (e) => {
            if (!$(e.target).closest(".social-menu, .social-menu-btn").length) this.closeMenu();
        });

        // Keep the giftable-items list fresh while the cosmetics view is open (a gift
        // refreshes the profile, which re-emits "items").
        this.account.addEventListener("items", () => {
            if (this.modal.isVisible() && this.view === "cosmetics") this.renderItems();
        });
        // On login: friend-request badge, and start telling friends we're online.
        this.account.addEventListener("login", () => {
            this.refreshFriends();
            this.clanUi.refreshBadge();
            this.startPresence();
        });
    }

    open() {
        this.modal.show();
    }

    /** Opens the panel on the Owners tab, optionally with a cosmetic preselected. */
    openOwners(type?: string) {
        this.openOnOwners = { type };
        if (this.modal.isVisible()) this.onShow();
        else this.modal.show();
    }

    /** Opens the panel to gift a specific skin (from the loadout gift button): pick a
     *  player, then "Gift cosmetic" - this item is pre-highlighted there. */
    openWithItem(item: GiftableItem) {
        this.pendingItemId = item?.id ?? null;
        this.modal.show();
        this.selectTab("players");
    }

    private onShow() {
        const owners = this.openOnOwners;
        this.openOnOwners = null;
        this.selectTab(owners ? "owners" : "friends");
        if (owners?.type) this.ownersUi?.selectType(owners.type);
    }

    private onHide() {
        if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
        if (this.itemsDebounce !== null) clearTimeout(this.itemsDebounce);
        this.searchDebounce = null;
        this.itemsDebounce = null;
        this.pendingItemId = null;
        this.target = null;
        this.view = null;
        this.hideConfirm();
        this.closeMenu();
        this.stopFriendsPolling();
        $(".clan-popup-backdrop").remove();
        this.ownersUi?.deactivate();
        // Requests may have been accepted/declined while open — refresh the button badge.
        this.refreshFriends();
        this.clanUi.refreshBadge();
    }

    private selectTab(tab: SocialTab) {
        this.tab = tab;
        this.view = null;
        this.closeMenu();
        $("#modal-social [data-social-tab]").removeClass("shop-tab-active");
        $(`#modal-social [data-social-tab='${tab}']`).addClass("shop-tab-active");
        $("#social-gift").css("display", "none");
        $("#social-friends").css("display", tab === "friends" ? "block" : "none");
        $("#social-players").css("display", tab === "players" ? "block" : "none");
        $("#social-clans").css("display", tab === "clans" ? "block" : "none");
        $("#social-discover").css("display", tab === "discover" ? "block" : "none");
        $("#social-league").css("display", tab === "league" ? "block" : "none");
        $("#shop-owners").css("display", tab === "owners" ? "block" : "none");
        if (tab === "clans") this.clanUi.show();
        if (tab === "discover") this.clanUi.showDiscover($("#social-discover"));
        if (tab === "league") this.clanUi.showLeague($("#social-league"));
        if (tab === "owners") this.ownersUi?.activate();
        else this.ownersUi?.deactivate();
        if (tab === "friends") {
            this.loadFriends();
            this.startFriendsPolling();
        } else {
            this.stopFriendsPolling();
        }
        if (tab === "players") {
            const q = String($("#social-user-search").val() ?? "").trim();
            if (q) this.searchPlayers();
            else this.renderSuggestions();
            window.setTimeout(() => $("#social-user-search").trigger("focus"), 50);
        }
    }

    /** Shows a gift sub-view in place of the current tab. */
    private showGiftView(view: GiftView) {
        this.view = view;
        this.closeMenu();
        this.stopFriendsPolling();
        $("#social-friends, #social-players, #social-clans, #social-discover, #social-league, #shop-owners").css("display", "none");
        $("#social-gift").css("display", "block");
        $("#social-fries-view").css("display", view === "fries" ? "block" : "none");
        $("#social-cosmetics-view").css("display", view === "cosmetics" ? "block" : "none");
    }

    private closeGiftView() {
        this.selectTab(this.tab);
    }

    private itemName(type: string): string {
        const def = GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined;
        return this.localization.translate(`game-${type}`) || def?.name || type;
    }

    private playerName(u: Person): string {
        return u.username || u.slug;
    }

    //
    // Friends data + request badge
    //

    private refreshFriends(cb?: () => void) {
        if (!this.account.loggedIn) {
            this.updateFriendBadge([]);
            cb?.();
            return;
        }
        this.account.getFriends((err, res) => {
            if (!err && res?.success) {
                this.storeFriends(res);
                this.updateFriendBadge(res.incoming.map((f) => f.slug));
            }
            cb?.();
        });
    }

    private storeFriends(res: FriendsResponse) {
        this.last = res;
        this.friendSlugs = new Set(res.friends.map((f) => f.slug));
        this.outgoingSlugs = new Set(res.outgoing.map((f) => f.slug));
        this.incomingSlugs = new Set(res.incoming.map((f) => f.slug));
        this.blockedSlugs = new Set((res.blocked ?? []).map((b) => b.slug));
    }

    /** Shows the pulsing alert on the Social button + a count on the Friends tab for
     *  UNSEEN friend requests (mirrors the loadout button's "new item" alert). Requests
     *  already viewed on the Friends tab don't count until new ones arrive. */
    private friendAlert = false;
    private clanAlert = false;

    /** The pulsing alert on the Social button: new friend requests or clan invites /
     *  join requests. */
    private applyAlert() {
        $("#social-alert-main").css("display", this.friendAlert || this.clanAlert ? "block" : "none");
    }

    /** Opens the Clans tab for an invite link (?clan=CODE). */
    openClanLink(code: string) {
        this.clanUi.openLink(code);
        if (!this.modal.isVisible()) this.modal.show();
        this.selectTab("clans");
    }

    private updateFriendBadge(incomingSlugs: string[]) {
        const seen = this.loadSeenRequests();
        const unseen = incomingSlugs.filter((s) => !seen.has(s)).length;
        this.friendAlert = unseen > 0;
        this.applyAlert();
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

    //
    // Presence: online status + team / lobby invites
    //

    private startPresence() {
        if (this.presenceTimer !== null) return;
        const beat = () => {
            // a hidden tab doesn't count as online
            if (!this.account.loggedIn || document.visibilityState !== "visible") return;
            this.account.sendPresence((err, res) => {
                if (err || !res?.success) return;
                for (const inv of res.invites) this.showInvite(inv);
            });
        };
        beat();
        this.presenceTimer = setInterval(beat, PRESENCE_MS);
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") beat();
        });
        // closing / leaving the page: tell the server now instead of letting the status run
        // out (a beacon still goes out while the page unloads, a normal request may not)
        window.addEventListener("pagehide", () => {
            if (!this.account.loggedIn) return;
            const body = new Blob([JSON.stringify({ offline: true })], { type: "application/json" });
            navigator.sendBeacon?.(api.resolveUrl("/api/user/presence"), body);
        });
    }

    private showInvite(inv: TeamInvite) {
        const who = helpers.formatUsername(inv.fromUsername || inv.fromSlug, inv.fromRoleTag);
        this.toast(
            `🎮 ${who} invites you to their ${inv.kind === "team" ? "team" : "lobby"} - <b>click to join</b>`,
            () => {
                this.modal.hide();
                this.onJoinInvite?.(inv);
            },
        );
    }

    private invite(f: Person) {
        const target = this.getInviteTarget();
        if (!target) {
            this.showInfo("Create or join a team (or a private lobby) first, then invite your friends to it.");
            return;
        }
        this.account.inviteFriend(f.slug, target.kind, target.code, (err, res) => {
            if (err || !res?.success) {
                this.showInfo(
                    res?.error === "offline"
                        ? `<b>${helpers.htmlEscape(this.playerName(f))}</b> isn't online right now.`
                        : "Could not send the invite.",
                );
                return;
            }
            this.toast(`✅ Invited <b>${helpers.htmlEscape(this.playerName(f))}</b> to your ${target.kind}.`);
        });
    }

    //
    // Rows + ⋯ menu
    //

    /** Stable colour per player for the avatar circle. */
    private avatarColor(slug: string): string {
        // FNV-1a, so similar names still land on clearly different hues
        let h = 2166136261;
        for (let i = 0; i < slug.length; i++) h = Math.imul(h ^ slug.charCodeAt(i), 16777619) >>> 0;
        return `hsl(${h % 360}, 45%, 38%)`;
    }

    /** Opens a player's public stats page in a new tab. */
    private openStats(slug: string) {
        window.open(`/stats/?slug=${encodeURIComponent(slug)}`, "_blank");
    }

    private row(p: Person, info: RowInfo): JQuery<HTMLElement> {
        const row = $('<div class="social-row"></div>');
        // the player icon they picked in their loadout, else their initial on a colour
        const iconSvg = p.icon ? helpers.getSvgFromGameType(p.icon) : "";
        const avatar = iconSvg
            ? $('<div class="social-avatar social-avatar-icon"></div>').css("background-image", `url(${iconSvg})`)
            : $(`<div class="social-avatar" style="background:${this.avatarColor(p.slug)}">${helpers.htmlEscape((this.playerName(p).trim()[0] ?? "?").toUpperCase())}</div>`);
        if (info.presence) {
            avatar.append(
                `<span class="social-presence social-presence-${info.presence}" title="${info.presence === "game" ? "In a game" : "Online"}"></span>`,
            );
        }
        row.append(avatar);

        const main = $('<div class="social-row-main"></div>');
        const name = $(
            `<span class="social-row-name" title="Open stats">${helpers.formatUsername(this.playerName(p), p.roleTag ?? null)}</span>`,
        );
        name.on("click", () => this.openStats(p.slug));
        main.append(name);
        if (info.sub) main.append(`<div class="social-row-sub ${info.subClass ?? ""}">${info.sub}</div>`);
        row.append(main);

        const actions = $('<div class="social-row-actions"></div>');
        for (const b of info.primary ?? []) actions.append(b);
        if (!info.noMenu) {
            const more = $('<div class="social-menu-btn" title="More">⋯</div>');
            more.on("click", () => this.openMenu(more, p, info));
            actions.append(more);
        }
        row.append(actions);
        return row;
    }

    private button(label: string, cls: string, onClick: (btn: JQuery<HTMLElement>) => void): JQuery<HTMLElement> {
        const btn = $(`<div class="social-btn ${cls}">${label}</div>`);
        btn.on("click", () => onClick(btn));
        return btn;
    }

    private closeMenu() {
        $(".social-menu").remove();
    }

    private openMenu(anchor: JQuery<HTMLElement>, p: Person, info: RowInfo) {
        const wasOpen = anchor.hasClass("social-menu-open");
        this.closeMenu();
        $(".social-menu-open").removeClass("social-menu-open");
        if (wasOpen) return;
        anchor.addClass("social-menu-open");

        const friend = this.friendSlugs.has(p.slug);
        const blocked = this.blockedSlugs.has(p.slug);
        const items: Array<{ label: string; action: () => void; danger?: boolean }> = [...(info.menu ?? [])];
        if (!blocked) {
            items.push({ label: "🍟 Gift Golden Fries", action: () => this.openFries(p) });
            items.push({ label: "🎁 Gift a cosmetic", action: () => this.openCosmetics(p) });
        }
        items.push({ label: "📊 View stats", action: () => this.openStats(p.slug) });
        if (this.clanUi.canInvite() && p.slug !== this.account.profile.slug) {
            items.push({
                label: "🛡 Invite to clan",
                action: () => this.clanUi.invitePlayer(p.slug, (msg) => this.showInfo(helpers.htmlEscape(msg))),
            });
        }
        if (friend) {
            items.push({
                label: "👤 Remove friend",
                danger: true,
                action: () =>
                    this.askConfirm(`Remove <b>${helpers.htmlEscape(this.playerName(p))}</b> from your friends?`, () =>
                        this.account.removeFriend(p.slug, () => this.reloadCurrent()),
                    ),
            });
        } else if (!blocked && !this.incomingSlugs.has(p.slug) && !this.outgoingSlugs.has(p.slug)) {
            items.push({ label: "＋ Add friend", action: () => this.addFriend(p) });
        }
        items.push(blocked ? { label: "Unblock", action: () => this.unblock(p) } : { label: "⛔ Block", danger: true, action: () => this.block(p) });

        const menu = $('<div class="social-menu"></div>');
        for (const it of items) {
            const el = $(`<div class="social-menu-item${it.danger ? " social-menu-danger" : ""}">${it.label}</div>`);
            el.on("click", () => {
                this.closeMenu();
                anchor.removeClass("social-menu-open");
                it.action();
            });
            menu.append(el);
        }
        $("body").append(menu);
        // fixed, so a scrolling list can't clip it; flips up near the screen bottom
        const r = anchor[0].getBoundingClientRect();
        const h = menu.outerHeight() ?? 0;
        const w = menu.outerWidth() ?? 0;
        const top = r.bottom + 4 + h > window.innerHeight ? r.top - 4 - h : r.bottom + 4;
        menu.css({ left: Math.max(8, r.right - w), top: Math.max(8, top) });
    }

    /** Re-renders whatever list is showing after a friend / block change. */
    private reloadCurrent() {
        if (this.tab === "friends") this.loadFriends(true);
        else
            this.refreshFriends(() => {
                if (this.tab === "players") {
                    const q = String($("#social-user-search").val() ?? "").trim();
                    if (q) this.searchPlayers();
                    else this.renderSuggestions();
                }
            });
    }

    private addFriend(p: Person, btn?: JQuery<HTMLElement>) {
        btn?.addClass("social-btn-busy").text("…");
        this.account.requestFriend(p.slug, (err, res) => {
            if (err || !res?.success) {
                btn?.removeClass("social-btn-busy").text("＋ Add");
                if (res?.error === "blocked") this.showInfo(BLOCKED_MSG);
                return;
            }
            this.outgoingSlugs.add(p.slug);
            this.reloadCurrent();
        });
    }

    /**
     * Blocking cuts interaction both ways (no offers, friend requests or gifts) and the
     * server also drops any friendship + pending requests, so it needs a confirm.
     */
    private block(p: Person) {
        this.askConfirm(
            `Block <b>${helpers.htmlEscape(this.playerName(p))}</b>?<br/>` +
                "They won't be able to send you offers, friend requests or gifts. " +
                "Any friendship or pending request is removed.",
            () =>
                this.account.blockAction("block", p.slug, (err, res) => {
                    if (err || !res?.success) return;
                    this.blockedSlugs.add(p.slug);
                    this.friendSlugs.delete(p.slug);
                    this.incomingSlugs.delete(p.slug);
                    this.outgoingSlugs.delete(p.slug);
                    this.reloadCurrent();
                }),
        );
    }

    private unblock(p: Person) {
        this.account.blockAction("unblock", p.slug, (err, res) => {
            if (err || !res?.success) return;
            this.blockedSlugs.delete(p.slug);
            this.reloadCurrent();
        });
    }

    /** The "relationship" button for someone who isn't a friend (yet). */
    private relationButton(p: Person): JQuery<HTMLElement> | null {
        if (this.blockedSlugs.has(p.slug)) return this.button("Unblock", "social-btn-ghost", () => this.unblock(p));
        if (this.friendSlugs.has(p.slug)) return $('<div class="social-tag">✓ Friend</div>');
        if (this.incomingSlugs.has(p.slug)) {
            return this.button("Accept", "social-btn-green", (b) => {
                b.addClass("social-btn-busy").text("…");
                this.account.acceptFriend(p.slug, () => this.reloadCurrent());
            });
        }
        if (this.outgoingSlugs.has(p.slug)) {
            return this.button("Requested", "social-btn-ghost", (b) => {
                b.addClass("social-btn-busy").text("…");
                this.account.removeFriend(p.slug, () => {
                    this.outgoingSlugs.delete(p.slug);
                    this.reloadCurrent();
                });
            }).attr("title", "Cancel the request");
        }
        return this.button("＋ Add", "social-btn-green", (b) => this.addFriend(p, b));
    }

    private lastGameText(ms: number | null): string {
        if (!ms) return "No games yet";
        const m = Math.floor((Date.now() - ms) / 60000);
        if (m < 1) return "Played just now";
        if (m < 60) return `Played ${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `Played ${h}h ago`;
        return `Played ${Math.floor(h / 24)}d ago`;
    }

    //
    // Friends tab
    //

    /** Loads (or, when `silent`, live-refreshes without the loading flash) the Friends tab. */
    private loadFriends(silent = false) {
        const box = $("#social-friends-sections");
        if (!silent) {
            // Opening the Friends tab clears the "new requests" badge immediately.
            $("#social-friends-tab-badge").css("display", "none");
            this.friendAlert = false;
            this.applyAlert();
            if (!this.last) box.html('<div class="shop-status">Loading…</div>');
            else this.renderFriends(this.last);
        }
        this.account.getFriends((err, res) => {
            if (err || !res || !res.success) {
                if (!silent) box.html('<div class="shop-status">Failed to load friends.</div>');
                return;
            }
            this.storeFriends(res);
            // Mark these requests as seen so the badge stays gone until new ones arrive.
            this.markRequestsSeen(res.incoming.map((f) => f.slug));
            // don't rebuild under an open ⋯ menu
            if (!$(".social-menu").length) this.renderFriends(res);
        });
    }

    /** While the Friends tab is open, live-refresh it every 8 s (in-game / online status,
     *  incoming requests). */
    private startFriendsPolling() {
        this.stopFriendsPolling();
        this.friendsPoll = setInterval(() => {
            if (this.modal.isVisible() && this.tab === "friends" && !this.view) {
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

    private section(title: string, count?: number, cls = ""): JQuery<HTMLElement> {
        return $(`<div class="social-section-head ${cls}">${title}${count !== undefined ? ` <span class="social-count">${count}</span>` : ""}</div>`);
    }

    private renderFriends(res: FriendsResponse) {
        const box = $("#social-friends-sections").empty();

        // Requests: someone wants to be friends (Accept / ✕), and the ones I sent.
        if (res.incoming.length || res.outgoing.length) {
            box.append(this.section("Friend requests", res.incoming.length || undefined, "social-section-hot"));
            for (const f of res.incoming) box.append(this.renderRequestRow(f));
            for (const f of res.outgoing) box.append(this.renderSentRow(f));
        }

        // Friends: playing now, then online, then everyone else by last game.
        const playing = res.friends.filter((f) => f.live);
        const online = res.friends.filter((f) => !f.live && f.online);
        const rest = res.friends
            .filter((f) => !f.live && !f.online)
            .sort((a, b) => (b.lastGame ?? 0) - (a.lastGame ?? 0));
        if (playing.length) {
            box.append(this.section("Playing now", playing.length));
            for (const f of playing) box.append(this.renderFriendRow(f));
        }
        if (online.length) {
            box.append(this.section("Online", online.length));
            for (const f of online) box.append(this.renderFriendRow(f));
        }
        box.append(this.section(playing.length || online.length ? "Offline" : "Friends", rest.length));
        if (!res.friends.length) {
            box.append('<div class="social-empty">No friends yet. Search a player above, or add someone you just played with below.</div>');
        } else if (!rest.length) {
            box.append('<div class="social-empty">Everyone is online 🎉</div>');
        }
        for (const f of rest) box.append(this.renderFriendRow(f));

        // Recently played (not already friends).
        const recent = res.recent.filter((p) => !this.friendSlugs.has(p.slug));
        if (recent.length) {
            box.append(this.section("Recently played"));
            for (const p of recent) box.append(this.renderRecentRow(p));
        }

        // Blocked accounts (collapsed - rarely needed).
        const blocked = res.blocked ?? [];
        if (blocked.length) {
            const details = $(`<details class="social-blocked"><summary class="social-section-head">Blocked <span class="social-count">${blocked.length}</span></summary></details>`);
            for (const b of blocked) details.append(this.renderBlockedRow(b));
            box.append(details);
        }
    }

    private renderFriendRow(f: FriendEntry): JQuery<HTMLElement> {
        const primary: JQuery<HTMLElement>[] = [];
        const menu: RowInfo["menu"] = [];
        if (f.live) {
            const live = f.live;
            primary.push(
                this.button("▶ Spectate", "social-btn-blue", () => {
                    this.modal.hide();
                    this.onSpectate?.(live.region, live.gameId);
                }),
            );
        } else if (f.online) {
            const target = this.getInviteTarget();
            primary.push(
                this.button("Invite", "social-btn-green", () => this.invite(f)).attr(
                    "title",
                    target ? `Invite to your ${target.kind}` : "Create or join a team first",
                ),
            );
        }
        if (f.online && f.live) menu.push({ label: "🎮 Invite to my team", action: () => this.invite(f) });
        return this.row(f, {
            presence: f.live ? "game" : f.online ? "online" : undefined,
            sub: f.live ? "In a game" : f.online ? "Online" : this.lastGameText(f.lastGame),
            subClass: f.live ? "social-sub-game" : f.online ? "social-sub-online" : "",
            primary,
            menu,
        });
    }

    private renderRequestRow(f: Friend): JQuery<HTMLElement> {
        return this.row(f, {
            sub: "wants to be your friend",
            subClass: "social-sub-hot",
            noMenu: false,
            primary: [
                this.button("Accept", "social-btn-green", (b) => {
                    b.addClass("social-btn-busy").text("…");
                    this.account.acceptFriend(f.slug, () => this.loadFriends(true));
                }),
                this.button("✕", "social-btn-ghost", (b) => {
                    b.addClass("social-btn-busy");
                    this.account.removeFriend(f.slug, () => this.loadFriends(true));
                }).attr("title", "Decline"),
            ],
        });
    }

    private renderSentRow(f: Friend): JQuery<HTMLElement> {
        return this.row(f, {
            sub: "request sent",
            primary: [
                this.button("Cancel", "social-btn-ghost", (b) => {
                    b.addClass("social-btn-busy").text("…");
                    this.account.removeFriend(f.slug, () => this.loadFriends(true));
                }),
            ],
        });
    }

    private renderRecentRow(p: RecentPlayer): JQuery<HTMLElement> {
        const btn = this.relationButton(p);
        return this.row(p, {
            sub: p.relation === "with" ? "played with you" : "played against you",
            subClass: p.relation === "with" ? "social-sub-with" : "social-sub-vs",
            primary: btn ? [btn] : [],
        });
    }

    private renderBlockedRow(b: BlockedUser): JQuery<HTMLElement> {
        return this.row(b, {
            sub: "blocked",
            noMenu: true,
            primary: [this.button("Unblock", "social-btn-ghost", () => this.unblock(b))],
        });
    }

    //
    // Players tab
    //

    private searchPlayers() {
        const q = String($("#social-user-search").val() ?? "").trim();
        const box = $("#social-search-results");
        if (!q) {
            this.renderSuggestions();
            return;
        }
        this.account.searchUsers(q, (err, res) => {
            if (String($("#social-user-search").val() ?? "").trim() !== q) return;
            box.empty();
            if (err || !res || !res.success) return;
            if (res.users.length === 0) {
                box.html('<div class="social-empty">No players found.</div>');
                return;
            }
            for (const u of res.users) box.append(this.renderPlayerRow(u));
        });
    }

    private renderPlayerRow(u: UserSearchResult): JQuery<HTMLElement> {
        const btn = this.relationButton(u);
        const blocked = this.blockedSlugs.has(u.slug);
        return this.row(u, {
            sub: blocked ? "blocked" : undefined,
            noMenu: blocked,
            primary: btn ? [btn] : [],
        });
    }

    /** Empty search: people you might mean - recently played, and recent gift targets. */
    private renderSuggestions() {
        const box = $("#social-search-results").empty();
        const recent = (this.last?.recent ?? []).filter((p) => !this.friendSlugs.has(p.slug));
        const gifted = this.loadRecent().filter((u) => !recent.some((r) => r.slug === u.slug));
        if (!recent.length && !gifted.length) {
            box.append('<div class="social-empty">Type a name to find a player.</div>');
            return;
        }
        if (recent.length) {
            box.append(this.section("Recently played"));
            for (const p of recent) box.append(this.renderRecentRow(p));
        }
        if (gifted.length) {
            const head = this.section("Recently gifted");
            const clear = $('<span class="social-recent-clear">clear</span>');
            clear.on("click", () => {
                try {
                    localStorage.removeItem(SocialUi.RECENT_KEY);
                } catch {
                    /* ignore */
                }
                this.renderSuggestions();
            });
            head.append(clear);
            box.append(head);
            for (const u of gifted) box.append(this.renderPlayerRow(u as UserSearchResult));
        }
    }

    //
    // Golden Fries sub-view
    //

    private openFries(u: Person) {
        this.target = u;
        this.pushRecent(u);
        $("#social-fries-target").text(this.playerName(u));
        $("#social-fries-balance").text(`🍟 ${this.account.profile?.goldenFries ?? 0}`);
        $("#social-fries-amount").val("");
        this.setStatus("#social-fries-status", "");
        this.showGiftView("fries");
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
        this.askConfirm(`Give <b>${amount}</b> 🍟 to <b>${helpers.htmlEscape(name)}</b>?`, () => {
            this.setStatus("#social-fries-status", "Sending…");
            this.account.giftFries(target.slug, amount, (err, res) => {
                if (err || !res || !res.success) {
                    this.setStatus("#social-fries-status", this.giftFriesError(res?.error), true);
                    return;
                }
                $("#social-fries-amount").val("");
                $("#social-fries-balance").text(`🍟 ${this.account.profile?.goldenFries ?? 0}`);
                this.setStatus("#social-fries-status", `Sent ${amount} 🍟 to ${name}.`);
            });
        });
    }

    //
    // Cosmetics sub-view
    //

    private openCosmetics(u: Person) {
        this.target = u;
        this.pushRecent(u);
        $("#social-cosmetics-target").text(this.playerName(u));
        $("#social-cosmetics-search").val("");
        this.setStatus("#social-cosmetics-status", "");
        this.renderItems();
        this.showGiftView("cosmetics");
    }

    private giftableItems(): GiftableItem[] {
        return (this.account.items ?? []).filter((it) => it.id != null && !!getItemCategory(it.type));
    }

    /** Sorts giftable items by the chosen key (rarity | type | name). */
    private sortGiftItems(items: GiftableItem[], sort: string): GiftableItem[] {
        const byName = (a: GiftableItem, b: GiftableItem) => this.itemName(a.type).localeCompare(this.itemName(b.type));
        const arr = [...items];
        if (sort === "type") {
            arr.sort(
                (a, b) =>
                    (getItemCategory(a.type) ?? "").localeCompare(getItemCategory(b.type) ?? "") ||
                    getItemRarity(b.type) - getItemRarity(a.type) ||
                    byName(a, b),
            );
        } else if (sort === "name") {
            arr.sort(byName);
        } else {
            // rarity (default): rarest first, then by name
            arr.sort((a, b) => getItemRarity(b.type) - getItemRarity(a.type) || byName(a, b));
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
            items = items.filter((it) => this.itemName(it.type).toLowerCase().includes(q) || it.type.toLowerCase().includes(q));
        }
        items = this.sortGiftItems(items, String($("#social-cosmetics-sort").val() ?? "rarity"));

        if (items.length === 0) {
            cont.html('<div class="shop-status">No matching cosmetics.</div>');
            return;
        }

        for (const it of items) {
            const rarity = getItemRarity(it.type);
            const row = $(
                `<div class="social-gift-item"${it.id === this.pendingItemId ? ' data-pending="1"' : ""}>` +
                    `<div class="social-gift-img" style="border-color:${RARITY_COLORS[rarity] ?? "#c5c5c5"}"></div>` +
                    `<span class="social-gift-name">${helpers.htmlEscape(this.itemName(it.type))}</span>` +
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
            `Give <b>${helpers.htmlEscape(this.itemName(item.type))}</b> to <b>${helpers.htmlEscape(name)}</b>?<br>This can't be undone.`,
            () => {
                this.setStatus("#social-cosmetics-status", "Sending…");
                this.account.giftItem(itemId, target.slug, (err, res) => {
                    if (err || !res || !res.success) {
                        this.setStatus("#social-cosmetics-status", this.giftItemError(res?.error), true);
                        return;
                    }
                    this.pendingItemId = null;
                    this.setStatus("#social-cosmetics-status", `Sent ${this.itemName(item.type)} to ${name}. 🎁`);
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
    // Recent gift targets (client-only, localStorage — no DB)
    //

    private loadRecent(): Person[] {
        try {
            const raw = localStorage.getItem(SocialUi.RECENT_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    private pushRecent(u: Person) {
        const list = this.loadRecent().filter((r) => r.slug !== u.slug);
        list.unshift({ slug: u.slug, username: u.username, roleTag: u.roleTag, icon: u.icon });
        try {
            localStorage.setItem(SocialUi.RECENT_KEY, JSON.stringify(list.slice(0, 8)));
        } catch {
            /* ignore quota errors */
        }
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
