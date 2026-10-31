import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import {
    CLAN_CREATE_COST,
    CLAN_NAME_MAX,
    CLAN_TAG_MAX,
    type ClanActionResponse,
    type ClanDetails,
    CLAN_GOAL_TIERS,
    CLAN_MIN_LOBBY_PLAYERS,
    CLAN_RATING_PRIOR_GAMES,
    CLAN_BANNERS,
    CLAN_TAG_COLORS,
    CLAN_TEAM_BONUS,
    clanLevel,
    clanTagColor,
    CLAN_REWARD_MIN_ACTIVE,
    CLAN_REWARD_MIN_GAMES_EACH,
    CLAN_WEEK_REWARDS,
    type ClanLeagueEntry,
    type ClanLeagueMetric,
    type ClanLeagueResponse,
    type ClanLinkInfoResponse,
    type ClanModeStats,
    type ClanStatsResponse,
    type ClanViewResponse,
    type ClanWeek,
    type ClanWeekSummary,
    perGame,
    type ClanListEntry,
    type ClanListResponse,
    type ClanListSort,
    type ClanSummary,
    type MyClanResponse,
    normalizeClanName,
    normalizeClanTag,
    validateClan,
} from "../../../shared/utils/clan";
import { getKeyTypes } from "../../../shared/defs/crateConfig";
import { loadout } from "../../../shared/utils/loadout";
import type { Account } from "../account";
import { helpers } from "../helpers";

const ERRORS: Record<string, string> = {
    name_length: "The name needs 3 to 20 characters.",
    name_chars: "Names may only use letters, digits, spaces and _ . -",
    tag_length: "The tag needs 2 to 5 characters.",
    tag_chars: "Tags may only use letters and digits.",
    tag_reserved: "That tag is reserved.",
    bad_color: "Pick a tag colour.",
    color_locked: "That colour isn't unlocked yet.",
    bad_banner: "Pick a banner.",
    banner_locked: "That banner isn't unlocked yet.",
    name_taken: "A clan with that name already exists.",
    tag_taken: "That tag is already taken.",
    bad_words: "That name or tag isn't allowed.",
    bad_icon: "You can only pick an emote you own.",
    already_in_clan: "You're already in a clan.",
    not_owner: "Only the clan owner can do that.",
    insufficient_funds: `You need ${CLAN_CREATE_COST} Golden Fries to found a clan.`,
    not_found: "That doesn't exist (anymore).",
    already_member: "They're already in your clan.",
    already_invited: "They're already invited.",
    clan_full: "The clan is full.",
    too_many_pending: "Too many open invites and requests - clear some first.",
    self: "That's you.",
    owner_cannot_leave: "The owner can't leave - disband the clan instead.",
    not_member: "They're not in the clan.",
    blocked: "The clan owner has blocked this player.",
    no_permission: "Only the clan owner can do that.",
};

/**
 * The Social panel's Clans tab: your clan (members; the owner edits name / tag / icon,
 * invites players directly or with a link, accepts link requests, kicks, disbands), or -
 * without one - your invites and requests, founding a clan for Golden Fries and a list
 * of existing clans.
 */
export class ClanUi {
    private root = $("#clan-view");
    private clan: ClanDetails | null = null;
    private mine: MyClanResponse | null = null;
    /** Code of an invite link the player opened (?clan=CODE), shown until handled. */
    private linkCode: string | null = null;
    /** Sub-tab of your clan's page (kept across the reloads after an action). */
    private clanTab: "overview" | "stats" | "management" = "overview";
    private leagueMetric: ClanLeagueMetric = "rated";
    /** Sort of the member stats table (Stats tab and clan popup). */
    private statsSort: { key: "games" | "wins" | "winrate" | "damage"; desc: boolean } = { key: "wins", desc: true };
    /** Count for the tab badge: invites to me, or join requests to my clan. */
    onBadge: (count: number) => void = () => {};
    /** null = not editing; "create" / "edit" = the form is open. */
    private form: "create" | "edit" | null = null;
    private searchDebounce: ReturnType<typeof setTimeout> | null = null;
    /** Discover tab: search text and order, kept while the menu stays open. */
    private discover: { search: string; sort: ClanListSort } = { search: "", sort: "members" };
    private discoverSeq = 0;
    private loadSeq = 0;

    constructor(private account: Account) {}

    /** Called when the Clans tab opens. */
    show() {
        this.form = null;
        this.clanTab = "overview";
        this.load();
    }

    private post<T>(url: string, data: Record<string, unknown>, cb: (res: T | null) => void) {
        this.account.ajaxRequest(url, data, (err, res: T) => cb(err ? null : res));
    }

    private load() {
        if (!this.account.loggedIn) {
            this.root.html('<div class="shop-status">Log in to found or join a clan.</div>');
            return;
        }
        const seq = ++this.loadSeq;
        this.root.html('<div class="shop-status">Loading…</div>');
        this.post<MyClanResponse>("/api/user/clan/mine", {}, (res) => {
            if (seq !== this.loadSeq) return;
            if (!res) {
                this.root.html('<div class="shop-status">Couldn\'t load clans.</div>');
                return;
            }
            this.setMine(res);
            this.render();
        });
    }

    private setMine(res: MyClanResponse) {
        this.mine = res;
        this.clan = res.clan;
        const c = res.clan;
        const poolKeys = c?.myRole === "owner" ? Object.values(c.pool).reduce((a, b) => a + b, 0) : 0;
        this.onBadge(c ? (c.manage?.requests.length ?? 0) + (poolKeys > 0 ? 1 : 0) : res.invites.length);
    }

    /** True when the player may invite (owner or lieutenant) - for "Invite to clan" in
     *  the player menus. */
    canInvite(): boolean {
        return !!this.clan?.manage;
    }

    /** Re-reads the clan state just for the badge (on login, when Social opens/closes). */
    refreshBadge() {
        if (!this.account.loggedIn) return;
        this.post<MyClanResponse>("/api/user/clan/mine", {}, (res) => {
            if (res) this.setMine(res);
        });
    }

    /** Invite a player from elsewhere (the Social player menus). */
    invitePlayer(slug: string, cb: (msg: string) => void) {
        this.post<ClanActionResponse>("/api/user/clan/invite", { slug }, (res) => {
            if (res?.success) cb(res.joined ? "They had asked to join - they're in your clan now." : "Invite sent.");
            else cb(ERRORS[res?.error ?? ""] ?? "Couldn't invite them.");
            this.refreshBadge();
        });
    }

    /** An invite link was opened: show it on the Clans tab. */
    openLink(code: string) {
        this.linkCode = code;
    }

    private render() {
        this.root.empty();
        if (this.flashMsg) {
            this.root.append($("<div/>", { class: `clan-flash${this.flashMsg.error ? " clan-flash-error" : ""}`, text: this.flashMsg.text }));
            this.flashMsg = null;
        }
        if (this.form) {
            this.root.append(this.renderForm());
        } else if (this.clan) {
            if (this.linkCode) this.root.append(this.renderLinkCard(this.linkCode));
            this.root.append(this.renderMyClan(this.clan));
        } else {
            if (this.linkCode) this.root.append(this.renderLinkCard(this.linkCode));
            if (this.mine) this.root.append(this.renderPending(this.mine));
            this.root.append(this.renderFoundCard());
            this.root.append(this.renderBrowser());
        }
    }

    /** Puts the clan's banner pattern (in its tag colour) behind an element. `strip` is
     *  the subtle variant used behind list rows. */
    private static banner(el: JQuery<HTMLElement>, banner: number, tagColor: number, strip = false) {
        const key = CLAN_BANNERS[banner]?.key ?? "none";
        // only the pattern classes - the element may carry other clan-banner-* classes
        el.removeClass(["clan-banner", "clan-banner-strip", ...CLAN_BANNERS.map((b) => `clan-banner-${b.key}`)].join(" "));
        if (key === "none") return el;
        return el
            .addClass(`clan-banner clan-banner-${key}${strip ? " clan-banner-strip" : ""}`)
            .css("--clan-color", clanTagColor(tagColor));
    }

    /** A clan's icon, or its tag on a coloured badge when it has none. */
    private badge(icon: string, tag: string, big = false): JQuery<HTMLElement> {
        const cls = `clan-badge${big ? " clan-badge-big" : ""}`;
        const svg = icon ? helpers.getSvgFromGameType(icon) : "";
        if (svg) return $("<div/>", { class: `${cls} clan-badge-icon` }).css("background-image", `url(${svg})`);
        return $("<div/>", { class: cls, text: tag });
    }

    // ── without a clan ──────────────────────────────────────────────────────

    private renderFoundCard() {
        const card = $('<div class="clan-card clan-found"></div>');
        card.append(
            $('<div class="clan-found-text"></div>').append(
                $('<div class="clan-card-title">Found your own clan</div>'),
                $('<div class="clan-muted">Pick a name, a tag and an icon. You can change them any time.</div>'),
            ),
        );
        const btn = $("<div/>", {
            class: "shop-buy-btn menu-option btn-darken clan-found-btn",
            text: `Found a clan · ${CLAN_CREATE_COST} 🍟`,
        });
        btn.on("click", () => {
            this.form = "create";
            this.render();
        });
        card.append(btn);
        return card;
    }

    private renderBrowser() {
        const wrap = $('<div class="clan-browser"></div>');
        const search = $("<input/>", {
            class: "market-search social-search",
            type: "text",
            placeholder: "🔍 Search clans by name or tag…",
            autocomplete: "off",
        });
        const list = $('<div class="social-list clan-list"></div>');
        const load = () => {
            const q = String(search.val() ?? "").trim();
            this.post<ClanListResponse>("/api/user/clan/list", q ? { search: q } : {}, (res) => {
                list.empty();
                if (!res) {
                    list.append('<div class="shop-status">Couldn\'t load clans.</div>');
                    return;
                }
                if (!res.clans.length) {
                    list.append(`<div class="shop-status">${q ? "No clan matches that." : "No clans yet - be the first!"}</div>`);
                    return;
                }
                for (const c of res.clans) list.append(this.renderClanRow(c));
            });
        };
        search.on("input", () => {
            if (this.searchDebounce) clearTimeout(this.searchDebounce);
            this.searchDebounce = setTimeout(load, 250);
        });
        wrap.append($('<div class="social-section-head">Clans</div>'), search, list);
        wrap.append($('<div class="clan-muted clan-discover-hint">Find more clans - by tag, name or member - in the <b>Discover Clans</b> tab.</div>'));
        load();
        return wrap;
    }

    private renderClanRow(c: ClanSummary | ClanListEntry) {
        const row = $('<div class="social-row clan-row"></div>');
        ClanUi.banner(row, c.banner, c.tagColor, true);
        row.append(this.badge(c.icon, c.tag));
        const main = $('<div class="social-row-main"></div>');
        main.append(
            $('<div class="social-row-name clan-row-name"></div>').append(
                $("<span/>", { class: "clan-tag", text: `[${c.tag}]`, css: { color: clanTagColor(c.tagColor) } }),
                $("<span/>", { text: ` ${c.name}` }),
            ),
            $("<div/>", {
                class: "social-row-sub",
                text: `${c.members} ${c.members === 1 ? "member" : "members"} · owner ${c.ownerName || c.ownerSlug}`,
            }),
        );
        if ("matched" in c && c.matched?.length) {
            main.append($("<div/>", { class: "social-row-sub clan-row-matched", text: `👤 ${c.matched.join(", ")}` }));
        }
        row.append(main);
        if ("weekGames" in c) {
            row.append(
                $('<div class="clan-discover-stats"></div>').append(
                    $("<div/>", { class: "clan-discover-level", text: `Lv ${clanLevel(c.xp).level}` }),
                    $("<div/>", {
                        class: `clan-discover-week${c.weekGames ? "" : " clan-discover-idle"}`,
                        text: c.weekGames ? `${c.weekGames} games this week` : "no games this week",
                    }),
                    c.titles ? $("<div/>", { class: "clan-discover-week", text: `🏆 ${c.titles}× #1` }) : "",
                ),
            );
        }
        row.addClass("clan-row-clickable").attr("title", "View clan");
        row.on("click", (e) => {
            if ($(e.target).closest(".shop-buy-btn").length) return;
            this.openClanPopup(c.id);
        });
        return row;
    }

    // ── Discover: every clan, searchable by tag, name or member ─────────────

    private static readonly DISCOVER_SORTS: Array<[ClanListSort, string]> = [
        ["members", "Biggest"],
        ["active", "Most active"],
        ["level", "Highest level"],
        ["titles", "Most #1"],
        ["newest", "Newest"],
    ];

    /** The Discover tab (Social): search + order + a paged clan list. */
    showDiscover(root: JQuery<HTMLElement>) {
        root.empty();
        const search = $("<input/>", {
            class: "market-search social-search",
            type: "text",
            placeholder: "🔍 Search clans by tag, name or member…",
            autocomplete: "off",
            maxlength: 32,
        }).val(this.discover.search);
        const seg = $('<div class="clan-seg clan-discover-sorts"></div>');
        for (const [value, label] of ClanUi.DISCOVER_SORTS) {
            const b = $("<div/>", { class: `clan-seg-btn${value === this.discover.sort ? " clan-seg-active" : ""}`, text: label });
            b.on("click", () => {
                if (this.discover.sort === value) return;
                this.discover.sort = value;
                seg.children().removeClass("clan-seg-active");
                b.addClass("clan-seg-active");
                load(0);
            });
            seg.append(b);
        }
        const info = $('<div class="clan-muted clan-week"></div>');
        const list = $('<div class="social-list clan-list clan-discover-list"></div>');
        const more = $("<div/>", { class: "shop-buy-btn menu-option btn-darken clan-discover-more", text: "Show more" }).hide();
        const myId = this.clan?.id;

        const load = (offset: number) => {
            const seq = ++this.discoverSeq;
            const q = this.discover.search;
            if (!offset) list.html('<div class="shop-status">Loading…</div>');
            more.hide();
            this.post<ClanListResponse>(
                "/api/user/clan/list",
                { ...(q ? { search: q } : {}), sort: this.discover.sort, offset },
                (res) => {
                    if (seq !== this.discoverSeq) return;
                    if (!offset) list.empty();
                    if (!res) {
                        list.append('<div class="shop-status">Couldn\'t load clans.</div>');
                        return;
                    }
                    if (!offset && !res.clans.length) {
                        list.append(`<div class="shop-status">${q ? "No clan or member matches that." : "No clans yet - be the first!"}</div>`);
                    }
                    for (const c of res.clans) {
                        const row = this.renderClanRow(c);
                        if (c.id === myId) row.addClass("clan-league-mine");
                        list.append(row);
                    }
                    const shown = offset + res.clans.length;
                    info.text(q && shown ? `${shown}${res.hasMore ? "+" : ""} ${shown === 1 ? "clan" : "clans"} for "${q}"` : "");
                    more.toggle(res.hasMore).off("click").on("click", () => {
                        more.text("Loading…");
                        load(shown);
                    });
                    more.text("Show more");
                },
            );
        };
        search.on("input", () => {
            this.discover.search = String(search.val() ?? "").trim();
            if (this.searchDebounce) clearTimeout(this.searchDebounce);
            this.searchDebounce = setTimeout(() => load(0), 250);
        });
        root.append(search, $('<div class="clan-league-filters"></div>').append(seg), info, list, more);
        load(0);
        window.setTimeout(() => search.trigger("focus"), 50);
    }

    // ── your clan ───────────────────────────────────────────────────────────

    private renderMyClan(c: ClanDetails) {
        const wrap = $("<div/>");
        const card = ClanUi.banner($('<div class="clan-card clan-mine"></div>'), c.banner, c.tagColor);
        card.append(this.badge(c.icon, c.tag, true));
        card.append(
            $('<div class="clan-mine-text"></div>').append(
                $('<div class="clan-card-title"></div>').append(
                    $("<span/>", { class: "clan-tag", text: `[${c.tag}]`, css: { color: clanTagColor(c.tagColor) } }),
                    $("<span/>", { text: ` ${c.name}` }),
                ),
                $("<div/>", {
                    class: "clan-muted",
                    text: `Founded ${new Date(c.createdAt).toLocaleDateString()} · ${c.members} ${c.members === 1 ? "member" : "members"}`,
                }),
                ClanUi.headStats(c.weekStats, c.titles),
                ClanUi.levelBar(c.xp),
            ),
        );
        const actions = $('<div class="clan-actions"></div>');
        if (c.myRole === "owner") {
            const edit = $('<div class="shop-buy-btn menu-option btn-darken">Edit</div>');
            edit.on("click", () => {
                this.form = "edit";
                this.render();
            });
            actions.append(
                edit,
                this.armedButton("Disband", "Really disband? Click again", "clan-danger-btn", () =>
                    this.post<ClanActionResponse>("/api/user/clan/disband", {}, () => this.load()),
                ),
            );
        } else {
            actions.append(
                this.armedButton("Leave", "Really leave? Click again", "clan-danger-btn", () =>
                    this.post<ClanActionResponse>("/api/user/clan/leave", {}, () => this.load()),
                ),
            );
        }
        card.append(actions);
        wrap.append(card);

        // Overview (members) | Stats (this week) | Management (owner + lieutenants:
        // requests, invites, link)
        const manage = c.manage;
        if (!manage && this.clanTab === "management") this.clanTab = "overview";
        {
            const tabs = $('<div class="clan-tabs"></div>');
            const requests = manage?.requests.length ?? 0;
            const tabList: Array<["overview" | "stats" | "management", string]> = [
                ["overview", "Overview"],
                ["stats", "Stats"],
            ];
            if (manage) tabList.push(["management", "Management"]);
            for (const [id, label] of tabList) {
                const tab = $("<div/>", { class: `clan-tab${this.clanTab === id ? " clan-tab-active" : ""}`, text: label });
                if (id === "management" && requests > 0) {
                    tab.append($("<span/>", { class: "tab-badge clan-tab-badge", text: String(requests) }));
                }
                tab.on("click", () => {
                    if (this.clanTab === id) return;
                    this.clanTab = id;
                    this.render();
                });
                tabs.append(tab);
            }
            wrap.append(tabs);
            if (this.clanTab === "management" && manage) {
                wrap.append(this.renderOwnerPanel(manage, c.myRole === "owner"));
                return wrap;
            }
            if (this.clanTab === "stats") {
                wrap.append(this.renderStats(c));
                return wrap;
            }
        }

        if (Object.values(c.pool).some((n) => n > 0)) wrap.append(this.renderPool(c));

        wrap.append($(`<div class="social-section-head">Members <span class="social-count">${c.members}</span></div>`));
        const list = $('<div class="social-list"></div>');
        for (const m of c.memberList) {
            const roleName = m.role === "owner" ? "Owner" : m.role === "lieutenant" ? "Lieutenant" : "Member";
            const row = this.personRow(m, `${roleName} · joined ${new Date(m.joinedAt).toLocaleDateString()}`);
            const right = $('<div class="clan-row-buttons"></div>');
            if (m.role !== "member") {
                right.append($("<div/>", { class: `clan-role-badge clan-role-${m.role}`, text: roleName }));
            }
            if (c.myRole === "owner" && m.role !== "owner") {
                right.append(
                    m.role === "lieutenant"
                        ? this.smallButton("Demote", "clan-grey-btn", () =>
                              this.act("/api/user/clan/role", { slug: m.slug, role: "member" }),
                          )
                        : this.smallButton("Make lieutenant", "", () =>
                              this.act("/api/user/clan/role", { slug: m.slug, role: "lieutenant" }, (r) => {
                                  if (r?.success) this.flash(`${m.username || m.slug} is now a lieutenant.`);
                              }),
                          ),
                );
            }
            // the owner kicks anyone, lieutenants only regular members
            const canKick = m.role !== "owner" && (c.myRole === "owner" || (c.myRole === "lieutenant" && m.role === "member"));
            if (canKick) {
                right.append(
                    this.armedButton("Kick", "Kick?", "clan-small-btn clan-danger-btn", () =>
                        this.act("/api/user/clan/kick", { slug: m.slug }),
                    ),
                );
            }
            if (right.children().length) row.append(right);
            list.append(row);
        }
        wrap.append(list);
        return wrap;
    }

    /** League keys the clan won, waiting for the owner to share them out. */
    private renderPool(c: ClanDetails) {
        const box = $('<div class="clan-card clan-pool"></div>');
        box.append(
            $('<div class="clan-pool-head"></div>').append(
                $('<div class="clan-box-title">🏆 Reward pool</div>'),
                ClanUi.keyList(c.pool),
            ),
        );
        if (c.myRole !== "owner") {
            box.append($('<div class="clan-muted">Keys your clan won in the weekly league. The owner shares them out.</div>'));
            return box;
        }
        box.append($('<div class="clan-muted">Keys your clan won in the weekly league - share them out however you think is fair.</div>'));
        const form = $('<div class="clan-pool-form"></div>');
        const member = $('<select class="market-select clan-pool-select"></select>');
        for (const m of c.memberList) member.append($("<option/>", { value: m.slug, text: m.username || m.slug }));
        const key = $('<select class="market-select clan-pool-select"></select>');
        for (const type of getKeyTypes().slice().reverse()) {
            const n = c.pool[type] ?? 0;
            if (n > 0) key.append($("<option/>", { value: type, text: `${this.keyName(type)} (${n} left)` }));
        }
        const amount = $('<input type="number" min="1" value="1" class="market-search clan-pool-amount">');
        const give = this.smallButton("Give", "", () => {
            const slug = String(member.val() ?? "");
            const keyType = String(key.val() ?? "");
            const n = Math.max(1, Math.floor(Number(amount.val()) || 1));
            this.act("/api/user/clan/pool/give", { slug, keyType, amount: n }, (r) => {
                if (r?.success) {
                    const who = c.memberList.find((m) => m.slug === slug);
                    this.flash(`Gave ${n}× ${this.keyName(keyType)} to ${who?.username || slug}.`);
                    if (slug === this.account.profile.slug) this.account.loadProfile();
                }
            });
        });
        form.append(member, key, amount, give);
        box.append(form);
        return box;
    }

    private keyName(type: string): string {
        return (GameObjectDefs.typeToDefSafe(type) as { name?: string })?.name ?? type;
    }

    /** A player row: their icon (or initial), name and a status line. */
    private personRow(p: { slug: string; username: string; icon: string }, sub: string) {
        const row = $('<div class="social-row"></div>');
        const svg = p.icon ? helpers.getSvgFromGameType(p.icon) : "";
        row.append(
            svg
                ? $('<div class="social-avatar social-avatar-icon"></div>').css("background-image", `url(${svg})`)
                : $('<div class="social-avatar clan-member-initial"></div>').text(
                      (p.username || p.slug).trim()[0]?.toUpperCase() ?? "?",
                  ),
        );
        row.append(
            $('<div class="social-row-main"></div>').append(
                $("<div/>", { class: "social-row-name", text: p.username || p.slug }),
                $("<div/>", { class: "social-row-sub", text: sub }),
            ),
        );
        return row;
    }

    private smallButton(label: string, cls: string, onClick: () => void) {
        const btn = $("<div/>", { class: `shop-buy-btn menu-option btn-darken clan-small-btn ${cls}`, text: label });
        btn.on("click", () => {
            if (btn.hasClass("shop-buy-disabled")) return;
            btn.addClass("shop-buy-disabled");
            onClick();
        });
        return btn;
    }

    /** Two clicks: the first arms it, the second (within a few seconds) runs `onConfirm`. */
    private armedButton(label: string, armedLabel: string, cls: string, onConfirm: () => void) {
        const btn = $("<div/>", { class: `shop-buy-btn menu-option btn-darken ${cls}`, text: label });
        let timer: ReturnType<typeof setTimeout> | null = null;
        btn.on("click", () => {
            if (btn.hasClass("shop-buy-disabled")) return;
            if (!btn.hasClass("clan-armed")) {
                btn.addClass("clan-armed").text(armedLabel);
                timer = setTimeout(() => btn.removeClass("clan-armed").text(label), 4000);
                return;
            }
            if (timer) clearTimeout(timer);
            btn.addClass("shop-buy-disabled").text("…");
            onConfirm();
        });
        return btn;
    }

    /** Runs a clan action and reloads; a failure shows up in the status line on top. */
    private act(url: string, data: Record<string, unknown>, onDone?: (res: ClanActionResponse | null) => void) {
        this.post<ClanActionResponse>(url, data, (res) => {
            if (onDone) onDone(res);
            if (res && !res.success) this.flash(ERRORS[res.error ?? ""] ?? "Something went wrong.", true);
            this.load();
        });
    }

    private flashMsg: { text: string; error: boolean } | null = null;

    /** A message shown once on top of the tab (survives the reload after an action). */
    private flash(text: string, error = false) {
        this.flashMsg = { text, error };
    }

    // ── owner: invite players, invite link, pending joins ──────────────────

    private renderOwnerPanel(owner: NonNullable<ClanDetails["manage"]>, isOwner: boolean) {
        const wrap = $("<div/>");

        if (owner.requests.length) {
            wrap.append($(`<div class="social-section-head social-section-hot">Join requests <span class="social-count">${owner.requests.length}</span></div>`));
            const list = $('<div class="social-list"></div>');
            for (const p of owner.requests) {
                const row = this.personRow(p, `Asked via your invite link · ${new Date(p.at).toLocaleDateString()}`);
                row.append(
                    $('<div class="clan-row-buttons"></div>').append(
                        this.smallButton("Accept", "", () => this.act("/api/user/clan/request/respond", { slug: p.slug, accept: true })),
                        this.smallButton("Decline", "clan-grey-btn", () =>
                            this.act("/api/user/clan/request/respond", { slug: p.slug, accept: false }),
                        ),
                    ),
                );
                list.append(row);
            }
            wrap.append(list);
        } else {
            wrap.append($('<div class="social-section-head">Join requests</div>'));
            wrap.append($('<div class="clan-muted clan-empty">No open requests. People who use your invite link show up here.</div>'));
        }

        const box = $('<div class="clan-card clan-invite-box"></div>');
        box.append($('<div class="clan-box-title">Invite players</div>'));
        const search = $("<input/>", {
            class: "market-search social-search clan-invite-search",
            type: "text",
            placeholder: "🔍 Search a player to invite…",
            autocomplete: "off",
        });
        const results = $('<div class="social-list clan-invite-results"></div>');
        let debounce: ReturnType<typeof setTimeout> | null = null;
        search.on("input", () => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => {
                const q = String(search.val() ?? "").trim();
                if (!q) {
                    results.empty();
                    return;
                }
                this.account.searchUsers(q, (err, res) => {
                    if (String(search.val() ?? "").trim() !== q) return;
                    results.empty();
                    if (err || !res?.success) return;
                    const invited = new Set(owner.invites.map((p) => p.slug));
                    const inClan = new Set(this.clan?.memberList.map((m) => m.slug));
                    const users = res.users.filter((u) => !inClan.has(u.slug)).slice(0, 6);
                    if (!users.length) results.append('<div class="social-empty">No players found.</div>');
                    for (const u of users) {
                        const row = this.personRow({ slug: u.slug, username: u.username, icon: u.icon ?? "" }, `@${u.slug}`);
                        row.append(
                            invited.has(u.slug)
                                ? $('<div class="clan-muted">Invited</div>')
                                : this.smallButton("Invite", "", () =>
                                      this.act("/api/user/clan/invite", { slug: u.slug }, (r) => {
                                          if (r?.success) this.flash(r.joined ? `${u.username || u.slug} joined the clan.` : `Invited ${u.username || u.slug}.`);
                                      }),
                                  ),
                        );
                        results.append(row);
                    }
                });
            }, 250);
        });
        box.append(search, results);

        // the shareable link: anyone opening it can ask to join, the owner accepts
        box.append($('<div class="clan-box-title clan-box-title-spaced">Invite link</div>'));
        box.append(
            $(
                `<div class="clan-muted">Anyone with the link can ask to join - you${isOwner ? " (and your lieutenants)" : " and the owner"} accept or decline each request here.</div>`,
            ),
        );
        const linkRow = $('<div class="clan-link-row"></div>');
        const url = (code: string) => `${window.location.origin}/?clan=${code}`;
        if (owner.inviteCode) {
            const input = $("<input/>", { class: "market-search clan-link-input", type: "text", readonly: true, value: url(owner.inviteCode) });
            input.on("focus", () => input.trigger("select"));
            const copy = $('<div class="shop-buy-btn menu-option btn-darken clan-small-btn">Copy</div>');
            copy.on("click", () => {
                const text = url(owner.inviteCode!);
                const done = () => {
                    copy.text("Copied ✓");
                    setTimeout(() => copy.text("Copy"), 1500);
                };
                navigator.clipboard?.writeText(text).then(done, () => {
                    input.trigger("select");
                    document.execCommand("copy");
                    done();
                });
            });
            linkRow.append(input, copy);
            if (isOwner) {
                linkRow.append(
                    this.armedButton("New link", "Old link stops working - sure?", "clan-small-btn clan-grey-btn", () =>
                        this.post("/api/user/clan/link", { regenerate: true }, () => this.load()),
                    ),
                );
            }
        } else {
            linkRow.append(
                this.smallButton("Create invite link", "", () => this.post("/api/user/clan/link", {}, () => this.load())),
            );
        }
        box.append(linkRow);
        wrap.append(box);

        if (owner.invites.length) {
            wrap.append($(`<div class="social-section-head">Invited <span class="social-count">${owner.invites.length}</span></div>`));
            const list = $('<div class="social-list"></div>');
            for (const p of owner.invites) {
                const row = this.personRow(p, `Invited ${new Date(p.at).toLocaleDateString()} · waiting for them to accept`);
                row.append(this.smallButton("Cancel", "clan-grey-btn", () => this.act("/api/user/clan/invite/cancel", { slug: p.slug })));
                list.append(row);
            }
            wrap.append(list);
        }
        return wrap;
    }

    // ── without a clan: invites to me, my requests, an opened invite link ───

    private renderPending(mine: MyClanResponse) {
        const wrap = $("<div/>");
        if (mine.invites.length) {
            wrap.append($(`<div class="social-section-head social-section-hot">Clan invites <span class="social-count">${mine.invites.length}</span></div>`));
            const list = $('<div class="social-list"></div>');
            for (const c of mine.invites) {
                const row = this.renderClanRow(c);
                row.append(
                    $('<div class="clan-row-buttons"></div>').append(
                        this.smallButton("Join", "", () =>
                            this.act("/api/user/clan/invite/respond", { clanId: c.id, accept: true }, (r) => {
                                if (r?.success) this.flash(`You joined [${c.tag}] ${c.name}!`);
                            }),
                        ),
                        this.smallButton("Decline", "clan-grey-btn", () =>
                            this.act("/api/user/clan/invite/respond", { clanId: c.id, accept: false }),
                        ),
                    ),
                );
                list.append(row);
            }
            wrap.append(list);
        }
        if (mine.requests.length) {
            wrap.append($('<div class="social-section-head">Your join requests</div>'));
            const list = $('<div class="social-list"></div>');
            for (const c of mine.requests) {
                const row = this.renderClanRow(c);
                row.find(".social-row-sub").text("Waiting for the owner to accept");
                row.append(
                    this.smallButton("Withdraw", "clan-grey-btn", () => this.act("/api/user/clan/request/withdraw", { clanId: c.id })),
                );
                list.append(row);
            }
            wrap.append(list);
        }
        return wrap;
    }

    /** The card for an opened invite link (?clan=CODE). */
    private renderLinkCard(code: string) {
        const card = $('<div class="clan-card clan-link-card"><div class="clan-muted">Loading invite…</div></div>');
        this.post<ClanLinkInfoResponse>("/api/user/clan/link/info", { code }, (res) => {
            card.empty();
            if (!res?.clan) {
                card.append($('<div class="clan-muted">This invite link is no longer valid.</div>'));
                card.append(this.smallButton("OK", "clan-grey-btn", () => this.dropLink()));
                return;
            }
            const c = res.clan;
            card.append(this.badge(c.icon, c.tag, true));
            const text = $('<div class="clan-mine-text"></div>').append(
                $('<div class="clan-muted">You\'ve been invited to join</div>'),
                $('<div class="clan-card-title"></div>').append(
                    $("<span/>", { class: "clan-tag", text: `[${c.tag}]`, css: { color: clanTagColor(c.tagColor) } }),
                    $("<span/>", { text: ` ${c.name}` }),
                ),
                $("<div/>", { class: "clan-muted", text: `${c.members} ${c.members === 1 ? "member" : "members"} · owner ${c.ownerName || c.ownerSlug}` }),
            );
            card.append(text);
            const actions = $('<div class="clan-actions"></div>');
            const note: Record<string, string> = {
                member: "You're already in this clan.",
                requested: "Request sent - the owner has to accept it.",
                in_clan: "Leave your current clan first to join this one.",
                full: "This clan is full.",
                blocked: "You can't join this clan.",
            };
            if (res.state === "request" || res.state === "invited") {
                actions.append(
                    this.smallButton(res.state === "invited" ? "Join" : "Ask to join", "", () =>
                        this.act("/api/user/clan/link/request", { code }, (r) => {
                            if (!r?.success) return;
                            this.dropLink();
                            this.flash(r.joined ? `You joined [${c.tag}] ${c.name}!` : "Request sent - the owner has to accept it.");
                        }),
                    ),
                );
            } else {
                text.append($("<div/>", { class: "clan-link-note", text: note[res.state] ?? "" }));
            }
            actions.append(this.smallButton("Dismiss", "clan-grey-btn", () => this.dropLink()));
            card.append(actions);
        });
        return card;
    }

    private dropLink() {
        this.linkCode = null;
        this.render();
    }

    // ── weekly stats (public Comp games) ───────────────────────────────────

    /** "Mon 26 Oct – Sun 1 Nov · resets in 1d 4h" */
    private weekLabel(w: ClanWeek): string {
        const fmt = (t: number) =>
            new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
        const left = Math.max(0, w.end - Date.now());
        const d = Math.floor(left / 86_400_000);
        const h = Math.floor((left % 86_400_000) / 3_600_000);
        return `${fmt(w.start)} – ${fmt(w.end - 1)} · resets in ${d > 0 ? `${d}d ` : ""}${h}h`;
    }

    private static fmtDmg(s: ClanModeStats) {
        return s.games ? Math.round(perGame(s.damage, s.games)).toLocaleString("en-US") : "–";
    }

    private static fmtWins(s: ClanModeStats) {
        return s.games ? perGame(s.wins, s.games).toFixed(2) : "–";
    }

    /** This week's numbers as a compact strip next to the clan name: the rated win rate
     *  first (it decides the weekly rewards), then the just-for-fun numbers. */
    private static headStats(s: ClanWeekSummary, titles: number) {
        const tile = (value: string, label: string, cls = "") =>
            $(`<div class="clan-head-stat ${cls}"></div>`).append(
                $("<span/>", { class: "clan-head-stat-value", text: value }),
                $("<span/>", { class: "clan-head-stat-label", text: label }),
            );
        const strip = $('<div class="clan-head-stats" title="This week, full public Comp lobbies"></div>').append(
            tile(`${(s.rating * 100).toFixed(1)}%`, "rated win rate", "clan-head-stat-main").attr(
                "title",
                `Decides the weekly rewards: your win rate, smoothed with ${CLAN_RATING_PRIOR_GAMES} average games so a few lucky games can't decide the league.`,
            ),
            tile(String(s.wins), s.wins === 1 ? "win" : "wins"),
            tile(String(s.games), "games"),
            tile(ClanUi.fmtWins(s), "wins/game"),
            tile(ClanUi.fmtDmg(s), "dmg/game"),
        );
        if (titles > 0) {
            strip.append($("<span/>", { class: "clan-titles", text: `🏆 ${titles}× #1`, title: `Won the weekly league ${titles}×` }));
        }
        const wrap = $("<div/>").append(strip);
        if (!s.eligible) {
            wrap.append(
                $("<div/>", {
                    class: "clan-eligibility",
                    text: `Needs ${CLAN_REWARD_MIN_ACTIVE} players with ${CLAN_REWARD_MIN_GAMES_EACH}+ games for league rewards (${s.qualified}/${CLAN_REWARD_MIN_ACTIVE})`,
                }),
            );
        }
        return wrap;
    }

    /** The team-bonus hint (stats tab + league). */
    private static teamBonusNote() {
        const parts = Object.entries(CLAN_TEAM_BONUS).map(([n, m]) => `${n} in a team ×${m}`);
        return $("<div/>", {
            class: "clan-bonus-note",
            text: `🤝 Team bonus: wins count more for the rated win rate when clan mates play in the same team - ${parts.join(", ")}.`,
        });
    }

    /** "Lv 3" with a progress bar to the next level. */
    private static levelBar(xp: number) {
        const { level, levelXp, nextXp } = clanLevel(xp);
        const pct = nextXp ? Math.min(100, ((xp - levelXp) / (nextXp - levelXp)) * 100) : 100;
        const next = CLAN_TAG_COLORS.find((c) => c.level === level + 1);
        return $('<div class="clan-level"></div>').append(
            $("<span/>", { class: "clan-level-chip", text: `Lv ${level}` }),
            $('<div class="clan-level-bar"></div>').append($("<i/>").css("width", `${pct}%`)),
            $("<span/>", {
                class: "clan-level-text",
                text: nextXp
                    ? `${Math.floor(xp).toLocaleString("en-US")} / ${nextXp.toLocaleString("en-US")} XP${next ? ` · next: ${next.name} tag` : ""}`
                    : `${Math.floor(xp).toLocaleString("en-US")} XP · max level`,
            }),
        ).attr("title", "Clan XP: every match's XP of the members (the same XP as for the battle pass) adds up here. Levels unlock tag colours.");
    }

    /** Weekly activity goal: average games of the players with 5+ games, the three tiers
     *  and their keys (paid straight to each of those players on Sunday night). */
    private static goalBox(s: ClanWeekSummary) {
        const max = CLAN_GOAL_TIERS[CLAN_GOAL_TIERS.length - 1].avgGames;
        const box = $('<div class="clan-card clan-goal"></div>');
        box.append(
            $('<div class="clan-box-title">Weekly goal</div>'),
            $("<div/>", {
                class: "clan-muted",
                text: `Average games of your ${s.qualified} ${s.qualified === 1 ? "player" : "players"} with ${CLAN_REWARD_MIN_GAMES_EACH}+ games: ${s.avgGames.toFixed(1)}. Every tier reached on Sunday night gives a key to each of those players${s.eligible ? "" : ` - needs ${CLAN_REWARD_MIN_ACTIVE} of them (${s.qualified}/${CLAN_REWARD_MIN_ACTIVE})`}.`,
            }),
        );
        const bar = $('<div class="clan-goal-bar"></div>').append($("<i/>").css("width", `${Math.min(100, (s.avgGames / max) * 100)}%`));
        for (const t of CLAN_GOAL_TIERS) {
            const reached = s.eligible && s.avgGames >= t.avgGames;
            bar.append(
                $(`<div class="clan-goal-mark${reached ? " clan-goal-reached" : ""}"></div>`)
                    .css("left", `${(t.avgGames / max) * 100}%`)
                    .append(
                        $("<span/>", { class: "clan-key-icon" }).css("background-image", `url(${helpers.getSvgFromGameType(t.key)})`),
                        $("<span/>", { class: "clan-goal-num", text: String(t.avgGames) }),
                    ),
            );
        }
        box.append(bar);
        return box;
    }

    /** Each member's numbers this week; the column headers sort it (a
     *  second click flips the direction, players without games always go last). */
    private memberStatsTable(res: ClanStatsResponse) {
        const table = $('<table class="clan-stats-table"></table>');
        const headRow = $("<tr></tr>").append($("<th/>", { text: "Player" }));
        const columns: Array<[typeof this.statsSort.key, string]> = [
            ["games", "Games"],
            ["wins", "Wins"],
            ["winrate", "Wins/G"],
            ["damage", "Dmg/G"],
        ];
        const body = $("<tbody></tbody>");
        const value = (s: ClanModeStats, key: typeof this.statsSort.key) =>
            key === "games"
                ? s.games
                : key === "wins"
                  ? s.wins
                  : key === "winrate"
                    ? perGame(s.wins, s.games)
                    : perGame(s.damage, s.games);
        const fill = () => {
            const { key, desc } = this.statsSort;
            const sorted = [...res.members].sort((a, b) => {
                if (!a.stats.games !== !b.stats.games) return a.stats.games ? -1 : 1;
                const d = value(a.stats, key) - value(b.stats, key);
                return (desc ? -d : d) || b.stats.games - a.stats.games;
            });
            headRow.find("th[data-key]").each((_, th) => {
                const k = th.dataset.key;
                const label = columns.find((c) => c[0] === k)![1];
                $(th)
                    .toggleClass("clan-th-sorted", k === key)
                    .text(k === key ? `${label} ${desc ? "▼" : "▲"}` : label);
            });
            body.empty();
            for (const m of sorted) {
                const tr = $("<tr></tr>");
                const role = m.role === "owner" ? "Owner" : m.role === "lieutenant" ? "Lieutenant" : "Member";
                const who = this.personRow(m, role);
                tr.append($("<td/>").append(who.addClass("clan-stats-person")));
                for (const v of [String(m.stats.games), String(m.stats.wins), ClanUi.fmtWins(m.stats), ClanUi.fmtDmg(m.stats)]) {
                    tr.append($("<td/>", { text: v }));
                }
                body.append(tr);
            }
        };
        for (const [key, label] of columns) {
            headRow.append(
                $("<th/>", { class: "clan-th-sort", "data-key": key, text: label, title: `Sort by ${label}` }).on("click", () => {
                    this.statsSort = { key, desc: this.statsSort.key === key ? !this.statsSort.desc : true };
                    fill();
                }),
            );
        }
        table.append($("<thead></thead>").append(headRow), body);
        fill();
        return $('<div class="clan-stats-table-wrap"></div>').append(table);
    }

    private renderStats(c: ClanDetails) {
        const wrap = $('<div class="clan-stats"><div class="shop-status">Loading…</div></div>');
        this.post<ClanStatsResponse>("/api/user/clan/stats", { clanId: c.id }, (res) => {
            wrap.empty();
            if (!res) {
                wrap.append('<div class="shop-status">Couldn\'t load the stats.</div>');
                return;
            }
            wrap.append($("<div/>", { class: "clan-muted clan-week", text: `This week: ${this.weekLabel(res.week)}` }));
            wrap.append(ClanUi.goalBox(res.totals));
            wrap.append(this.memberStatsTable(res));
            wrap.append(
                $(`<div class="clan-muted clan-stats-note">Only full public Comp lobbies count (${CLAN_MIN_LOBBY_PLAYERS} players), played while in the clan. Games where the clan is on more than one team don't count for it. Games from before joining count too, if the player was in no clan this week - after switching clans, only games from the join on count for the new one. Everything resets every Monday at 00:00.</div>`),
                ClanUi.teamBonusNote(),
            );
        });
        return wrap;
    }

    // ── clan info popup (from the league or the clan list) ──────────────────

    /** A look at any clan: header with this week's numbers, Overview and Stats tabs. */
    openClanPopup(clanId: number) {
        $(".clan-popup-backdrop").remove();
        const backdrop = $('<div class="clan-popup-backdrop"></div>');
        const popup = $('<div class="clan-popup"><div class="shop-status">Loading…</div></div>');
        backdrop.append(popup);
        backdrop.on("click", (e) => {
            if (e.target === backdrop[0]) backdrop.remove();
        });
        $("#modal-social .modal-content").append(backdrop);
        this.post<ClanViewResponse>("/api/user/clan/view", { clanId }, (res) => {
            popup.empty();
            const close = $('<div class="clan-popup-close" title="Close">×</div>').on("click", () => backdrop.remove());
            popup.append(close);
            if (!res?.clan || !res.stats) {
                popup.append('<div class="shop-status">This clan doesn\'t exist anymore.</div>');
                return;
            }
            const c = res.clan;
            const stats = res.stats;
            popup.append(
                ClanUi.banner($('<div class="clan-popup-head"></div>'), c.banner, c.tagColor).append(
                    this.badge(c.icon, c.tag, true),
                    $('<div class="clan-mine-text"></div>').append(
                        $('<div class="clan-card-title"></div>').append(
                            $("<span/>", { class: "clan-tag", text: `[${c.tag}]`, css: { color: clanTagColor(c.tagColor) } }),
                            $("<span/>", { text: ` ${c.name}` }),
                        ),
                        $("<div/>", {
                            class: "clan-muted",
                            text: `Founded ${new Date(c.createdAt).toLocaleDateString()} · ${c.members} ${c.members === 1 ? "member" : "members"} · owner ${c.ownerName || c.ownerSlug}`,
                        }),
                        ClanUi.headStats(stats.totals, c.titles),
                    ),
                ),
            );
            const tabs = $('<div class="clan-tabs"></div>');
            const body = $('<div class="clan-popup-body"></div>');
            const show = (tab: "overview" | "stats") => {
                tabs.children().removeClass("clan-tab-active");
                tabs.children(`[data-tab="${tab}"]`).addClass("clan-tab-active");
                body.empty();
                if (tab === "overview") {
                    const list = $('<div class="social-list"></div>');
                    for (const m of c.memberList) {
                        const roleName = m.role === "owner" ? "Owner" : m.role === "lieutenant" ? "Lieutenant" : "Member";
                        const row = this.personRow(m, `${roleName} · joined ${new Date(m.joinedAt).toLocaleDateString()}`);
                        if (m.role !== "member") {
                            row.append($("<div/>", { class: `clan-role-badge clan-role-${m.role}`, text: roleName }));
                        }
                        list.append(row);
                    }
                    body.append(list);
                } else {
                    body.append($("<div/>", { class: "clan-muted clan-week", text: `This week: ${this.weekLabel(stats.week)}` }));
                    body.append(this.memberStatsTable(stats));
                }
            };
            for (const [id, label] of [
                ["overview", "Overview"],
                ["stats", "Stats"],
            ] as const) {
                tabs.append($("<div/>", { class: "clan-tab", "data-tab": id, text: label }).on("click", () => show(id)));
            }
            popup.append(tabs, body);
            show("overview");
        });
    }

    // ── clan league (its own tab in the Social panel) ──────────────────────

    private static readonly LEAGUE_VIEWS: Array<[ClanLeagueMetric, string, string]> = [
        ["rated", "Rated win rate", "rated win rate"],
        ["wins", "Total wins", "wins"],
        ["winrate", "Wins / game", "wins / game"],
        ["damage", "Damage / game", "damage / game"],
    ];

    /** Little key icons + counts, e.g. for a league reward. */
    private static keyList(keys: Record<string, number>) {
        const box = $('<div class="clan-keys"></div>');
        for (const type of getKeyTypes().slice().reverse()) {
            const n = keys[type] ?? 0;
            if (!n) continue;
            box.append(
                $('<span class="clan-key"></span>').append(
                    $("<span/>", { class: "clan-key-icon" }).css("background-image", `url(${helpers.getSvgFromGameType(type)})`),
                    $("<span/>", { text: `×${n}` }),
                ),
            );
        }
        return box;
    }

    /** Renders the league into `root` (the Social panel's Clan League tab). */
    showLeague(root: JQuery<HTMLElement>) {
        root.empty();
        const seg = $('<div class="clan-seg"></div>');
        for (const [value, label] of ClanUi.LEAGUE_VIEWS) {
            const b = $("<div/>", { class: `clan-seg-btn${value === this.leagueMetric ? " clan-seg-active" : ""}`, text: label });
            if (value === "rated") b.prepend("🏆 ");
            b.on("click", () => {
                this.leagueMetric = value;
                this.showLeague(root);
            });
            seg.append(b);
        }
        const metric = this.leagueMetric;
        const unit = ClanUi.LEAGUE_VIEWS.find((v) => v[0] === metric)![2];
        const info = $('<div class="clan-muted clan-week"></div>');
        const list = $('<div class="social-list clan-league-list"><div class="shop-status">Loading…</div></div>');
        root.append($('<div class="clan-league-filters"></div>').append(seg), info);
        if (metric === "rated") {
            // compact: the prizes always show, the explanation folds open on demand
            const rewards = $('<div class="clan-card clan-league-rewards"></div>');
            const places = $('<div class="clan-reward-places"></div>');
            for (const rank of [1, 2, 3]) {
                places.append(
                    $(`<div class="clan-reward-place clan-league-top-${rank}"></div>`).append(
                        $("<div/>", { class: "clan-league-rank", text: `#${rank}` }),
                        ClanUi.keyList(CLAN_WEEK_REWARDS[rank]),
                    ),
                );
            }
            const details = $('<div class="clan-rewards-details"></div>').append(
                $("<div/>", {
                    class: "clan-muted",
                    text: `Every Sunday night the top 3 clans by rated win rate get a key pool, which the owner shares out among the members. The rated win rate is your win rate with ${CLAN_RATING_PRIOR_GAMES} average games added, so a few lucky games can't win it - consistent good play does, whatever the clan size. Only full public Comp lobbies count - not games where your clan is on more than one team - and a clan needs ${CLAN_REWARD_MIN_ACTIVE} players with ${CLAN_REWARD_MIN_GAMES_EACH}+ games to be ranked.`,
                }),
                ClanUi.teamBonusNote(),
                $("<div/>", {
                    class: "clan-muted clan-goal-hint",
                    text: `Plus weekly goals for every clan: when your players with ${CLAN_REWARD_MIN_GAMES_EACH}+ games average ${CLAN_GOAL_TIERS.map((t) => t.avgGames).join(" / ")} games, each of them gets a Wooden / Soviet / Airdrop key.`,
                }),
            );
            let open = false;
            try {
                open = localStorage.getItem("clanRewardsInfoOpen") === "1";
            } catch {}
            const toggle = $('<div class="clan-rewards-toggle"></div>');
            const apply = () => {
                details.toggle(open);
                toggle.text(open ? "How it works ▴" : "How it works ▾");
            };
            toggle.on("click", () => {
                open = !open;
                try {
                    localStorage.setItem("clanRewardsInfoOpen", open ? "1" : "0");
                } catch {}
                apply();
            });
            rewards.append(
                $('<div class="clan-rewards-head"></div>').append($('<div class="clan-box-title">Weekly rewards</div>'), toggle),
                places,
                details,
            );
            apply();
            root.append(rewards);
        }
        root.append(list);
        this.post<ClanLeagueResponse>("/api/user/clan/league", { metric }, (res) => {
            if (metric !== this.leagueMetric) return;
            list.empty();
            if (!res) {
                list.append('<div class="shop-status">Couldn\'t load the league.</div>');
                return;
            }
            const needs = metric === "winrate" || metric === "damage" ? ` · clans need ${res.minGames} games to be ranked` : "";
            const avg = metric === "rated" ? ` · league average ${(res.leagueAverage * 100).toFixed(1)}%` : "";
            info.text(`This week (Comp): ${this.weekLabel(res.week)}${needs}${avg}`);
            const myId = this.clan?.id;
            const fmt = (e: ClanLeagueEntry) =>
                metric === "damage"
                    ? Math.round(e.value).toLocaleString("en-US")
                    : metric === "wins"
                      ? String(e.wins)
                      : metric === "rated"
                        ? `${(e.value * 100).toFixed(1)}%`
                        : e.value.toFixed(2);
            const row = (e: ClanLeagueEntry, rank: number | null) => {
                const r = $(`<div class="social-row clan-league-row clan-row-clickable${e.id === myId ? " clan-league-mine" : ""}${rank && rank <= 3 ? ` clan-league-top clan-league-top-${rank}` : ""}${rank ? "" : " clan-league-unranked"}"></div>`);
                r.attr("title", "View clan").on("click", () => this.openClanPopup(e.id));
                ClanUi.banner(r, e.banner, e.tagColor, true);
                r.append($("<div/>", { class: "clan-league-rank", text: rank ? `#${rank}` : "–" }), this.badge(e.icon, e.tag));
                const sub =
                    metric === "rated"
                        ? `${e.wins}/${e.games} won (${(perGame(e.wins, e.games) * 100).toFixed(1)}% real) · ${e.qualified}/${CLAN_REWARD_MIN_ACTIVE} players with ${CLAN_REWARD_MIN_GAMES_EACH}+ games`
                        : `${e.games} games · ${e.players} ${e.players === 1 ? "player" : "players"}`;
                r.append(
                    $('<div class="social-row-main"></div>').append(
                        $('<div class="social-row-name clan-row-name"></div>').append(
                            $("<span/>", { class: "clan-tag", text: `[${e.tag}]`, css: { color: clanTagColor(e.tagColor) } }),
                            $("<span/>", { text: ` ${e.name}` }),
                            e.titles ? $("<span/>", { class: "clan-titles", text: ` 🏆${e.titles}` }) : "",
                        ),
                        $("<div/>", { class: "social-row-sub", text: sub }),
                    ),
                );
                r.append(
                    $('<div class="clan-league-value"></div>').append(
                        $("<div/>", { class: "clan-stat-value", text: fmt(e) }),
                        $("<div/>", { class: "clan-stat-label", text: unit }),
                    ),
                );
                return r;
            };
            if (!res.entries.length) {
                list.append(
                    `<div class="shop-status">${
                        metric === "rated"
                            ? "No clan qualifies yet this week."
                            : metric === "wins"
                              ? "No clan has played yet this week."
                              : `No clan has ${res.minGames} games yet this week.`
                    }</div>`,
                );
            }
            res.entries.forEach((e, i) => list.append(row(e, i + 1)));
            if (res.unranked.length) {
                list.append(
                    $(`<div class="social-section-head">Not ranked yet <span class="social-count">${res.unranked.length}</span></div>`),
                    $("<div/>", {
                        class: "clan-muted clan-empty",
                        text: `These clans need ${CLAN_REWARD_MIN_ACTIVE} players with ${CLAN_REWARD_MIN_GAMES_EACH}+ games this week.`,
                    }),
                );
                for (const e of res.unranked) list.append(row(e, null));
            }
        });
    }

    // ── create / edit form ──────────────────────────────────────────────────

    /** Emotes the player owns (defaults included), sorted by name. */
    private ownedEmotes(): string[] {
        const types = new Set<string>();
        for (const it of loadout.getUserAvailableItems(this.account.items ?? [])) {
            if (GameObjectDefs.typeToDefSafe(it.type)?.type === "emote") types.add(it.type);
        }
        const name = (t: string) => (GameObjectDefs.typeToDefSafe(t) as { name?: string })?.name ?? t;
        return [...types].sort((a, b) => name(a).localeCompare(name(b)));
    }

    private renderForm() {
        const editing = this.form === "edit" && this.clan;
        let icon = editing ? this.clan!.icon : "";
        let tagColor = editing ? this.clan!.tagColor : 0;
        let banner = editing ? this.clan!.banner : 0;
        const level = editing ? clanLevel(this.clan!.xp).level : 1;
        const card = $('<div class="clan-card clan-form"></div>');
        card.append(
            $('<div class="clan-card-title"></div>').text(editing ? "Edit your clan" : "Found a clan"),
        );

        const preview = $('<div class="clan-preview"></div>');
        const nameInput = $("<input/>", {
            class: "market-search clan-input",
            type: "text",
            maxlength: CLAN_NAME_MAX,
            placeholder: "Clan name",
            autocomplete: "off",
            value: editing ? this.clan!.name : "",
        });
        const tagInput = $("<input/>", {
            class: "market-search clan-input clan-input-tag",
            type: "text",
            maxlength: CLAN_TAG_MAX,
            placeholder: "TAG",
            autocomplete: "off",
            value: editing ? this.clan!.tag : "",
        });
        const status = $('<div class="clan-form-status"></div>');

        const updatePreview = () => {
            const name = normalizeClanName(String(nameInput.val() ?? ""));
            const tag = normalizeClanTag(String(tagInput.val() ?? ""));
            ClanUi.banner(preview, banner, tagColor);
            preview.empty().append(
                this.badge(icon, tag || "?", true),
                $('<div class="clan-card-title"></div>').append(
                    $("<span/>", { class: "clan-tag", text: `[${tag || "TAG"}]`, css: { color: clanTagColor(tagColor) } }),
                    $("<span/>", { text: ` ${name || "Clan name"}` }),
                ),
            );
        };
        tagInput.on("input", () => {
            const v = String(tagInput.val() ?? "");
            const up = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
            if (up !== v) tagInput.val(up);
            updatePreview();
        });
        nameInput.on("input", updatePreview);

        card.append(
            preview,
            $('<div class="clan-fields"></div>').append(
                $('<label class="clan-field"><span>Name</span></label>').append(nameInput),
                $('<label class="clan-field clan-field-tag"><span>Tag</span></label>').append(tagInput),
            ),
        );

        // icon picker: no icon, or one of the player's emotes
        const picker = $('<div class="clan-icon-picker"></div>');
        const pick = (type: string) => {
            icon = type;
            picker.find(".clan-icon-option").removeClass("clan-icon-selected");
            picker.find(`[data-icon="${type}"]`).addClass("clan-icon-selected");
            updatePreview();
        };
        picker.append(
            $("<div/>", { class: "clan-icon-option clan-icon-none", "data-icon": "", title: "No icon (shows the tag)", text: "TAG" }).on(
                "click",
                () => pick(""),
            ),
        );
        for (const type of this.ownedEmotes()) {
            const name = (GameObjectDefs.typeToDefSafe(type) as { name?: string })?.name ?? type;
            picker.append(
                $("<div/>", { class: "clan-icon-option", "data-icon": type, title: name })
                    .css("background-image", `url(${helpers.getSvgFromGameType(type)})`)
                    .on("click", () => pick(type)),
            );
        }
        card.append($('<div class="clan-field-label">Icon</div>'), picker);
        pick(icon);

        // tag colour: unlocked by the clan level (clan XP = the members' match XP)
        const colors = $('<div class="clan-color-picker"></div>');
        CLAN_TAG_COLORS.forEach((c, i) => {
            const locked = c.level > level;
            const opt = $("<div/>", {
                class: `clan-color-option${i === tagColor ? " clan-color-selected" : ""}${locked ? " clan-color-locked" : ""}`,
                title: locked ? `${c.name} - unlocks at clan level ${c.level}` : c.name,
            }).css("background", c.color);
            if (locked) opt.append($("<span/>", { class: "clan-color-lock", text: `Lv${c.level}` }));
            else
                opt.on("click", () => {
                    tagColor = i;
                    colors.children().removeClass("clan-color-selected");
                    opt.addClass("clan-color-selected");
                    updatePreview();
                });
            colors.append(opt);
        });
        const banners = $('<div class="clan-banner-picker"></div>');
        CLAN_BANNERS.forEach((b, i) => {
            const locked = b.level > level;
            const opt = $("<div/>", {
                class: `clan-banner-option${i === banner ? " clan-banner-selected" : ""}${locked ? " clan-banner-locked" : ""}`,
                title: locked ? `${b.name} - unlocks at clan level ${b.level}` : b.name,
            }).append($("<span/>", { class: "clan-banner-name", text: locked ? `Lv${b.level}` : b.name }));
            ClanUi.banner(opt, i, tagColor);
            if (!locked) {
                opt.on("click", () => {
                    banner = i;
                    banners.children().removeClass("clan-banner-selected");
                    opt.addClass("clan-banner-selected");
                    updatePreview();
                });
            }
            banners.append(opt);
        });
        // the banner swatches follow the picked tag colour
        colors.on("click", () => banners.children().each((i, el) => void ClanUi.banner($(el), i, tagColor)));
        card.append(
            $('<div class="clan-field-label">Tag colour</div>'),
            colors,
            $('<div class="clan-field-label">Banner</div>'),
            banners,
            $("<div/>", {
                class: "clan-muted clan-color-note",
                text: editing
                    ? `Your clan is level ${level}. More colours and banners unlock as your members play - every match's XP also counts for the clan.`
                    : "More colours and banners unlock as your clan levels up - every match's XP of your members also counts for the clan.",
            }),
        );

        const buttons = $('<div class="clan-form-buttons"></div>');
        const cancel = $('<div class="shop-buy-btn menu-option btn-darken clan-cancel-btn">Cancel</div>');
        cancel.on("click", () => {
            this.form = null;
            this.render();
        });
        const balance = this.account.profile.goldenFries ?? 0;
        const submit = $("<div/>", {
            class: "shop-buy-btn menu-option btn-darken",
            text: editing ? "Save" : `Found clan · ${CLAN_CREATE_COST} 🍟`,
        });
        if (!editing) {
            card.append(
                $("<div/>", {
                    class: `clan-muted clan-balance${balance < CLAN_CREATE_COST ? " clan-balance-low" : ""}`,
                    text: `You have ${balance.toLocaleString("en-US")} 🍟`,
                }),
            );
        }
        submit.on("click", () => {
            if (submit.hasClass("shop-buy-disabled")) return;
            const name = normalizeClanName(String(nameInput.val() ?? ""));
            const tag = normalizeClanTag(String(tagInput.val() ?? ""));
            const invalid = validateClan(name, tag);
            if (invalid) {
                status.text(ERRORS[invalid]).addClass("clan-form-error");
                return;
            }
            submit.addClass("shop-buy-disabled");
            status.removeClass("clan-form-error").text(editing ? "Saving…" : "Founding…");
            this.post<ClanActionResponse>(
                editing ? "/api/user/clan/update" : "/api/user/clan/create",
                { name, tag, icon, tagColor, banner },
                (res) => {
                    if (!res?.success) {
                        submit.removeClass("shop-buy-disabled");
                        status.text(ERRORS[res?.error ?? ""] ?? "Something went wrong.").addClass("clan-form-error");
                        return;
                    }
                    // founding cost fries: refresh the balance
                    if (!editing) this.account.loadProfile();
                    this.form = null;
                    this.load();
                },
            );
        });
        buttons.append(cancel, submit);
        card.append(status, buttons);
        setTimeout(() => nameInput.trigger("focus"), 30);
        return card;
    }
}
