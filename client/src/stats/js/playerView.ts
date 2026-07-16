import $ from "jquery";
import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import { EmotesDefs } from "../../../../shared/defs/gameObjects/emoteDefs";
import { getItemPrice, getItemRarity } from "../../../../shared/defs/shopConfig";
import { MapId, TeamModeToString } from "../../../../shared/defs/types/misc";
import type { TeamMode } from "../../../../shared/gameConfig";
import {
    ALL_MAPS,
    ALL_TEAM_MODES,
    type LeaderboardRequest,
    type MatchData,
    type MatchDataRequest,
    type MatchDataResponse,
    type MatchHistory,
    type MatchHistoryParams,
    type MatchHistoryResponse,
    type UserStatsRequest,
    type UserStatsResponse,
} from "../../../../shared/types/stats";
import { api } from "../../api";
import { device } from "../../device";
import { helpers } from "../../helpers";
import type { App } from "./app";
import {
    DEFAULT_UNLOCKED,
    imgHtml,
    LOADOUT_MODAL_CSS,
    upgradeSkinImages,
} from "./loadoutModal";
import loading from "./templates/loading.ejs";
import matchData from "./templates/matchData.ejs";
import matchHistory from "./templates/matchHistory.ejs";
import player from "./templates/player.ejs";
import playerCards from "./templates/playerCards.ejs";

const templates = {
    loading,
    matchData,
    matchHistory,
    player,
    playerCards,
};

/** One owned cosmetic (deduped per type) as returned by /api/user_loadout. */
interface OwnedItem {
    type: string;
    count: number;
    /** A representative owned instance id (for making a buy-offer). */
    itemId: number;
    onMarket: boolean;
    price: number | null;
}

/** Same "1h 2m 3s" formatting the in-game end-of-match stats download uses. */
function humanizeTime(time: number): string {
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor(time / 60) % 60;
    const seconds = Math.floor(time) % 60;
    let out = "";
    if (hours > 0) out += `${hours}h `;
    if (hours > 0 || minutes > 0) out += `${minutes}m `;
    return out + `${seconds}s`;
}

/**
 * Downloads a CSV of a match's player stats — identical format to the "Download
 * Stats" button shown at the end of a game (see client/src/ui/ui.ts).
 */
function downloadMatchStatsCsv(data: MatchDataResponse): void {
    const headers = "Name,Rank,Kills,Damage Dealt,Damage Taken,Time Alive,Elo Gained\n";
    const csv =
        headers +
        data
            .map(
                (d) =>
                    `${d.username},${d.rank},${d.kills},${d.damage_dealt},${d.damage_taken},${humanizeTime(d.time_alive)}`,
            )
            .join("\n");
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const fileName = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}_stats.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    window.URL.revokeObjectURL(url);
}

export interface TeamModes {
    teamMode: TeamMode;
    games: number;
    name: string;
    botStats: { name: string; val: string }[];
    midStats: { name: string; val: string }[];
}

// Leaderboard map filter is limited to the competitive / special modes only.
const PLAYER_MAP_IDS: number[] = [
    MapId.Comp,
    MapId.CompSolo,
    MapId.CompDuo,
    MapId.Scrims,
    MapId.TwoVsTwo,
    MapId.FourVsFour,
    MapId.Local,
];
const DEFAULT_MAP_ID = String(PLAYER_MAP_IDS[0]);

function getPlayerCardData(
    userData: UserStatsResponse,
    error: boolean,
    teamModeFilter: number,
) {
    // get_user_stats currently returns data rows for all teamModes;
    // transform the data a bit for the player card.
    if (error || !userData) {
        return {
            profile: {},
            teamModes: [],
            error: error,
        };
    }

    const emoteDef = EmotesDefs[userData.player_icon];
    const texture = emoteDef
        ? helpers.emoteImgToSvg(emoteDef.texture)
        : "/img/gui/player-gui.svg";

    let tmpSlug = userData.slug.toLowerCase();
    tmpSlug = tmpSlug.replace(userData.username.toLowerCase(), "");

    const tmpslugToShow =
        tmpSlug != "" ? `${userData.username}#${tmpSlug}` : userData.username;

    const profile = {
        username: userData.username,
        slugToShow: tmpslugToShow,
        banned: userData.banned,
        avatarTexture: texture,
        wins: userData.wins,
        kills: userData.kills,
        games: userData.games,
        kpg: userData.kpg,
    };

    // Gather card data
    const addStat = function addStat(
        arr: { name: string; val: number | string }[],
        name: string,
        val: number | string,
    ) {
        arr.push({
            name: name,
            val: val,
        });
    };
    const teamModes: Partial<TeamModes>[] = [];
    for (let i = 0; i < userData.modes.length; i++) {
        const mode = userData.modes[i];

        // Overall rank / rating not available yet
        const mid: { name: string; val: string }[] = [];
        addStat(mid, "Rating", "-");
        addStat(mid, "Rank", "-");

        const bot: { name: string; val: string }[] = [];
        addStat(bot, "Wins", mode.wins);
        addStat(bot, "Win %", mode.winPct);
        addStat(bot, "Kills", mode.kills);
        addStat(bot, "Avg Survived", helpers.formatTime(mode.avgTimeAlive));
        addStat(bot, "Most kills", mode.mostKills);
        addStat(bot, "K/G", mode.kpg);
        addStat(bot, "Most damage", mode.mostDamage);
        addStat(bot, "Avg Damage", mode.avgDamage);

        teamModes.push({
            teamMode: mode.teamMode,
            games: mode.games,
            midStats: mid,
            botStats: bot,
        });
    }

    // Insert blank cards for all teammodes
    const keys = Object.keys(TeamModeToString) as unknown as TeamMode[];

    for (let i = 0; i < keys.length; i++) {
        const teamMode = keys[i];
        if (!teamModes.find((x) => x.teamMode == teamMode)) {
            teamModes.push({
                teamMode,
                games: 0,
            });
        }
    }
    teamModes.sort((a, b) => a.teamMode! - b.teamMode!);
    for (let i = 0; i < teamModes.length; i++) {
        const teamMode = teamModes[i].teamMode!;
        teamModes[i].name = TeamModeToString[teamMode];
    }

    const gameModes = helpers.getGameModes();

    return {
        profile: profile,
        error: error,
        teamModes: teamModes,
        teamModeFilter: teamModeFilter,
        gameModes: helpers.getGameModes().filter((m) => PLAYER_MAP_IDS.includes(m.mapId)),
    };
}

//
// Query
//

class Query<T> {
    inProgress = false;
    dataValid = false;
    error = false;
    args = {};
    data: T | null = null;

    query(
        url: string,
        args: Record<string, unknown>,
        debugTimeout: number,
        onComplete: (err: any, res: any) => void,
    ) {
        if (this.inProgress) {
            return;
        }

        this.inProgress = true;
        this.error = false;

        $.ajax({
            url: api.resolveUrl(url),
            type: "POST",
            data: JSON.stringify(args),
            contentType: "application/json; charset=utf-8",
            timeout: 10 * 1000,
            success: (data, _status, _xhr) => {
                this.data = data;
                this.dataValid = !!data;
            },
            error: () => {
                this.error = true;
                this.dataValid = false;
            },
            complete: () => {
                setTimeout(() => {
                    this.inProgress = false;
                    onComplete(this.error, this.data);
                }, debugTimeout);
            },
        });
    }
}

//
// PlayerView
//
export class PlayerView {
    games: {
        expanded: boolean;
        dataError: boolean;
        data: MatchData[] | null;
        summary: MatchHistory;
    }[] = [];
    moreGamesAvailable = true;
    teamModeFilter = ALL_TEAM_MODES;
    userStats = new Query<UserStatsResponse>();
    userStatsCache = {} as Record<string, { error: boolean; data: UserStatsResponse }>;
    matchHistory = new Query<MatchHistoryResponse>();
    matchHistoryCache = {} as Record<number, typeof this.games>;
    matchData = new Query<MatchDataResponse>();
    el = $(
        templates.player({
            phoneDetected: device.mobile && !device.tablet,
        }),
    );
    constructor(readonly app: App) {}
    getUrlParams() {
        const params = new URLSearchParams(window.location.search);
        const slug = params.get("slug") || "";
        const interval = params.get("time") || "alltime";
        let mapId = params.get("mapId") || ALL_MAPS;
        if (!PLAYER_MAP_IDS.includes(Number(mapId))) mapId = ALL_MAPS;
        const gameId = params.get("gameId") || "";

        return {
            slug,
            interval,
            mapId,
            gameId,
        };
    }
    getGameByGameId(gameId: string) {
        return this.games.find((x) => x.summary.guid == gameId);
    }
    load() {
        const getUrlParams = this.getUrlParams();
        const slug = getUrlParams.slug;
        const interval = getUrlParams.interval as UserStatsRequest["interval"];
        const mapId = getUrlParams.mapId;

        this.loadUserStats(slug, interval, mapId);
        this.loadMatchHistory(slug, 0, 7);

        this.render();
    }
    loadUserStats(
        slug: string,
        interval: UserStatsRequest["interval"],
        mapIdFilter: string,
    ) {
        const args: UserStatsRequest = {
            slug: slug,
            interval: interval,
            mapIdFilter: mapIdFilter,
        };

        const cacheKey = `${interval}${mapIdFilter}`;
        if (this.userStatsCache[cacheKey]) {
            const { error, data } = this.userStatsCache[cacheKey];
            this.userStats.data = data;
            this.userStats.error = error;
            this.render();
            return;
        }
        this.userStats.query("/api/user_stats", args, 0, (error, data) => {
            this.userStatsCache[cacheKey] = {
                error,
                data,
            };
            this.render();
        });
    }
    loadMatchHistory(slug: string, offset: number, teamModeFilter: number) {
        const count = 10;
        const args: MatchHistoryParams = {
            slug: slug,
            offset: offset,
            count: count,
            teamModeFilter: teamModeFilter,
        };
        if (offset === 0 && this.matchHistoryCache[teamModeFilter]) {
            this.games = this.matchHistoryCache[teamModeFilter];

            this.moreGamesAvailable = this.games.length >= count;
            this.render();
            return;
        }
        this.matchHistory.query(
            "/api/match_history",
            args,
            0,
            (_err, data: (MatchHistoryResponse[number] & { icon: string })[]) => {
                const gameModes = helpers.getGameModes();

                const games = data || [];

                for (let i = 0; i < games.length; i++) {
                    // @ts-expect-error string or number, IT STILL WORKS
                    games[i].team_mode =
                        TeamModeToString[games[i].team_mode as unknown as TeamMode];

                    const gameMode = gameModes.find((x) => x.mapId == games[i].map_id);
                    games[i].icon = gameMode ? gameMode.desc.icon : "";

                    this.games.push({
                        expanded: false,
                        summary: games[i],
                        data: null,
                        dataError: false,
                    });
                }
                if (offset === 0 && !this.matchHistoryCache[teamModeFilter]) {
                    this.matchHistoryCache[teamModeFilter] = this.games;
                }
                this.moreGamesAvailable = games.length >= count;

                const gameId = this.getUrlParams().gameId;
                if (gameId) {
                    for (const game of this.games) {
                        if (!game.expanded && game.summary.guid === gameId) {
                            game.expanded = true;
                            this.loadMatchData(gameId);
                            break;
                        }
                    }
                }

                this.render();
            },
        );
    }
    loadMatchData(gameId: string) {
        const args: MatchDataRequest = {
            gameId: gameId,
        };
        this.matchData.query(
            "/api/match_data",
            args,
            0,
            (err, data: MatchDataResponse) => {
                const game = this.getGameByGameId(gameId);
                if (game) {
                    game.data = data;
                    game.dataError = err || !data;
                }
                this.render();
            },
        );
    }
    toggleMatchData(gameId: string) {
        const game = this.getGameByGameId(gameId);
        if (!game) {
            return;
        }

        const wasExpanded = game.expanded;
        for (let i = 0; i < this.games.length; i++) {
            this.games[i].expanded = false;
        }
        game.expanded = !wasExpanded;

        if (!game.data && !game.dataError) {
            this.loadMatchData(gameId);
        }

        this.render();
        this.updateSearchParams();
    }

    updateSearchParams() {
        const slug = this.getUrlParams().slug;
        const time = $("#player-time").val();
        const mapId = $("#player-map-id").val();

        let searchP = new URLSearchParams();
        searchP.set("slug", slug);
        searchP.set("time", time as string);
        searchP.set("mapId", mapId as string);

        const selectedGame = this.games.find((g) => g.expanded);
        if (selectedGame) {
            searchP.set("gameId", selectedGame.summary.guid);
        }

        window.history.pushState("", "", `?${searchP.toString()}`);
    }

    onChangedParams() {
        this.updateSearchParams();

        const params = this.getUrlParams();
        this.loadUserStats(
            params.slug,
            params.interval as LeaderboardRequest["interval"],
            params.mapId,
        );
    }

    /** Fetch and display a read-only viewer of the given player's equipped loadout. */
    showLoadoutModal(slug: string) {
        $.ajax({
            url: api.resolveUrl("/api/user_loadout"),
            type: "POST",
            data: JSON.stringify({ slug }),
            contentType: "application/json; charset=utf-8",
            timeout: 10 * 1000,
            success: (data: {
                found?: boolean;
                private?: boolean;
                username?: string;
                slug?: string;
                loadout?: Record<string, string | string[]>;
                items?: OwnedItem[];
            }) => {
                if (data?.private) {
                    this.showLoadoutPrivate(data.username || "");
                    return;
                }
                if (data?.found) {
                    this.renderLoadoutModal(
                        data.username || "",
                        data.slug || slug,
                        data.loadout || {},
                        data.items || [],
                    );
                }
            },
        });
    }

    /** Shown instead of the collection when the player marked their loadout private. */
    showLoadoutPrivate(username: string) {
        $(".loadout-modal-overlay").remove();
        const $modal = $(
            `<div class="loadout-modal-overlay">` +
                `<style>${LOADOUT_MODAL_CSS}</style>` +
                `<div class="loadout-modal">` +
                `<div class="ld-header"><span>Collection — ${helpers.htmlEscape(username)}</span><span class="ld-close">✕</span></div>` +
                `<div class="ld-body"><div class="ld-empty">This player's loadout is private.</div></div>` +
                `</div></div>`,
        );
        $modal.on("click", (e) => {
            if (
                $(e.target).is(".loadout-modal-overlay") ||
                $(e.target).closest(".ld-close").length
            ) {
                $modal.remove();
            }
        });
        $("body").append($modal);
    }

    renderLoadoutModal(
        username: string,
        slug: string,
        loadout: Record<string, string | string[]>,
        items: OwnedItem[],
    ) {
        $(".loadout-modal-overlay").remove();

        const rarityColors = [
            "#c5c5c5",
            "#c5c5c5",
            "#12ff00",
            "#00deff",
            "#f600ff",
            "#d96100",
        ];
        const rarityNames = ["Stock", "Common", "Uncommon", "Rare", "Epic", "Mythic"];

        // Types currently equipped by the player — flagged with an "Equipped" badge.
        const equipped = new Set<string>();
        for (const key of [
            "outfit",
            "melee",
            "heal",
            "boost",
            "death_effect",
            "player_icon",
            "crosshair",
        ]) {
            const v = loadout[key];
            if (typeof v === "string" && v) equipped.add(v);
        }
        if (Array.isArray(loadout.emotes)) {
            for (const e of loadout.emotes) if (e) equipped.add(e);
        }

        const nameFor = (type: string) =>
            (GameObjectDefs[type] as { name?: string } | undefined)?.name || type;
        const catOf = (type: string) => {
            const t = (GameObjectDefs[type] as { type?: string } | undefined)?.type;
            switch (t) {
                case "outfit":
                case "melee":
                case "emote":
                case "heal_effect":
                case "boost_effect":
                case "death_effect":
                case "crosshair":
                    return t;
                default:
                    return "other";
            }
        };

        const tile = (item: OwnedItem) => {
            const { type, count, onMarket, price } = item;
            const r = getItemRarity(type);
            const name = helpers.htmlEscape(nameFor(type));
            const badges =
                (equipped.has(type)
                    ? `<div class="ld-badge ld-badge-eq">Equipped</div>`
                    : "") +
                (count > 1 ? `<div class="ld-badge ld-badge-count">x${count}</div>` : "");
            const market = onMarket
                ? `<div class="ld-market">On market${price != null ? ` · ${price}` : ""} ›</div>`
                : "";
            return `<div class="ld-tile${onMarket ? " ld-tile-market" : ""}">
                <div class="ld-badges">${badges}</div>
                ${imgHtml(type)}
                <div class="ld-name" title="${name}">${name}</div>
                <div class="ld-rarity" style="color:${rarityColors[r] ?? "#c5c5c5"}">${rarityNames[r] ?? "Common"}</div>
                ${market}
                <div class="ld-offer-btn" data-item-id="${item.itemId}" data-type="${type}">Make offer</div>
            </div>`;
        };

        // Owned, non-default, known cosmetics grouped by category.
        const shown = items.filter(
            (it) => !DEFAULT_UNLOCKED.has(it.type) && !!GameObjectDefs[it.type],
        );

        // Total inventory worth in Golden Fries (shop value × copies).
        const totalValue = shown.reduce(
            (sum, it) => sum + getItemPrice(it.type) * it.count,
            0,
        );
        const groups = new Map<string, OwnedItem[]>();
        for (const it of shown) {
            const cat = catOf(it.type);
            const arr = groups.get(cat);
            if (arr) arr.push(it);
            else groups.set(cat, [it]);
        }
        const sortItems = (arr: OwnedItem[]) =>
            arr.sort((a, b) => {
                if (a.onMarket !== b.onMarket) return a.onMarket ? -1 : 1;
                const rd = getItemRarity(b.type) - getItemRarity(a.type);
                if (rd) return rd;
                return nameFor(a.type).localeCompare(nameFor(b.type));
            });

        const groupOrder: { key: string; label: string }[] = [
            { key: "outfit", label: "Outfits" },
            { key: "melee", label: "Melee" },
            { key: "emote", label: "Emotes" },
            { key: "heal_effect", label: "Heal Effects" },
            { key: "boost_effect", label: "Boost Effects" },
            { key: "death_effect", label: "Death Effects" },
            { key: "crosshair", label: "Crosshairs" },
            { key: "other", label: "Other" },
        ];

        let body = "";
        for (const g of groupOrder) {
            const arr = groups.get(g.key);
            if (!arr || !arr.length) continue;
            sortItems(arr);
            body +=
                `<div class="ld-section">${g.label} <span class="ld-count">${arr.length}</span></div>` +
                `<div class="ld-grid">${arr.map(tile).join("")}</div>`;
        }
        if (!body) {
            body = `<div class="ld-empty">This player only owns default cosmetics.</div>`;
        }

        const html =
            `<div class="loadout-modal-overlay">` +
            `<style>${LOADOUT_MODAL_CSS}</style>` +
            `<div class="loadout-modal">` +
            `<div class="ld-header"><span>Collection — ${helpers.htmlEscape(username)}</span><span class="ld-close">✕</span></div>` +
            (shown.length
                ? `<div class="ld-valuebar">Inventory value <span class="ld-value-num">${totalValue.toLocaleString("en-US")}</span><span class="ld-fries"></span></div>`
                : "") +
            `<div class="ld-body">${body}</div>` +
            `</div></div>`;

        const $modal = $(html);
        $modal.on("click", (e) => {
            const $target = $(e.target);
            if (
                $target.is(".loadout-modal-overlay") ||
                $target.closest(".ld-close").length
            ) {
                $modal.remove();
                return;
            }
            // "Make offer" — takes precedence over the market redirect on the same tile.
            const $offer = $target.closest(".ld-offer-btn");
            if ($offer.length) {
                e.stopPropagation();
                this.makeStatsOffer(
                    Number($offer.attr("data-item-id")),
                    String($offer.attr("data-type")),
                );
                return;
            }
            // Clicking an on-market item jumps to the seller's storefront in the main menu.
            if ($target.closest(".ld-tile-market").length) {
                window.location.href = `/?storefront=${encodeURIComponent(slug)}`;
            }
        });
        $("body").append($modal);
        upgradeSkinImages($modal);
    }

    /** Opens an in-app dialog to enter a Golden Fries amount and send a buy-offer. */
    makeStatsOffer(itemId: number, type: string) {
        if (!Number.isFinite(itemId)) return;
        const name = helpers.htmlEscape(
            (GameObjectDefs[type] as { name?: string } | undefined)?.name || type,
        );
        const est = getItemPrice(type);
        $(".ld-offer-overlay").remove();
        const $ov = $(
            `<div class="ld-offer-overlay">
                <div class="ld-offer-dialog">
                    <div class="ld-offer-title">Make an offer for ${name}</div>
                    <div class="ld-offer-est">Estimated value: ${est > 0 ? `${est.toLocaleString("en-US")} 🍟` : "—"}</div>
                    <input type="number" class="ld-offer-input" min="1" placeholder="Golden Fries amount" />
                    <div class="ld-offer-msg"></div>
                    <div class="ld-offer-actions">
                        <div class="ld-offer-cancel">Cancel</div>
                        <div class="ld-offer-send">Send offer</div>
                    </div>
                </div>
            </div>`,
        );
        const $input = $ov.find(".ld-offer-input");
        const $msg = $ov.find(".ld-offer-msg");
        const $send = $ov.find(".ld-offer-send");
        const close = () => $ov.remove();

        $ov.on("click", (e) => {
            if (
                $(e.target).is(".ld-offer-overlay") ||
                $(e.target).is(".ld-offer-cancel")
            ) {
                close();
            }
        });

        const submit = () => {
            const amount = parseInt(String($input.val()), 10);
            if (!Number.isInteger(amount) || amount < 1) {
                $msg.css("color", "#ff8a8a").text("Enter a whole number of at least 1.");
                return;
            }
            $send.addClass("ld-offer-disabled").text("…");
            $.ajax({
                url: api.resolveUrl("/api/user/offer/make"),
                type: "POST",
                data: JSON.stringify({ itemId, amount }),
                contentType: "application/json; charset=utf-8",
                timeout: 10 * 1000,
                success: (res: { success?: boolean; error?: string }) => {
                    if (res?.success) {
                        $msg.css("color", "#8fce6a").text(
                            "Offer sent! The owner can accept, decline, or counter it.",
                        );
                        setTimeout(close, 1400);
                        return;
                    }
                    $send.removeClass("ld-offer-disabled").text("Send offer");
                    const msg =
                        res?.error === "self_offer"
                            ? "You can't make an offer on your own item."
                            : res?.error === "duplicate"
                              ? "You already have an active offer on this item."
                              : res?.error === "auctioned"
                                ? "This item is currently being auctioned."
                                : res?.error === "offers_disabled"
                                  ? "This player isn't accepting offers."
                                  : res?.error === "blocked"
                                    ? "You can't interact with this player."
                                    : "Could not send the offer.";
                    $msg.css("color", "#ff8a8a").text(msg);
                },
                error: (xhr) => {
                    $send.removeClass("ld-offer-disabled").text("Send offer");
                    $msg.css("color", "#ff8a8a").text(
                        xhr.status === 401 || xhr.status === 403
                            ? "Log in on the main page first to make offers."
                            : "Could not send the offer.",
                    );
                },
            });
        };

        $send.on("click", submit);
        $input.on("keydown", (e) => {
            if (e.key === "Enter") submit();
        });
        $("body").append($ov);
        $input.trigger("focus");
    }

    render() {
        const params = this.getUrlParams();

        // User stats
        let content = "";
        if (this.userStats.inProgress) {
            content = templates.loading({
                type: "player",
            });
        } else {
            const cardData = getPlayerCardData(
                this.userStats.data!,
                this.userStats.error,
                this.teamModeFilter,
            );
            content = templates.playerCards(cardData);
        }
        this.el.find(".content").html(content);

        const loadoutBtn = this.el.find(".view-loadout-btn");
        loadoutBtn.on("click", () => {
            this.showLoadoutModal(params.slug);
        });
        // Match the main-menu button's hover feedback (.btn-darken:hover).
        loadoutBtn.on("mouseenter", function () {
            $(this).css("filter", "brightness(85%)");
        });
        loadoutBtn.on("mouseleave", function () {
            $(this).css("filter", "");
        });

        const timeSelector = this.el.find("#player-time");
        if (timeSelector) {
            timeSelector.val(params.interval);
            timeSelector.on("change", () => {
                this.onChangedParams();
            });
        }

        const mapIdSelector = this.el.find("#player-map-id");
        if (mapIdSelector) {
            mapIdSelector.val(params.mapId);
            mapIdSelector.on("change", () => {
                this.onChangedParams();
            });
        }

        // Match history
        let historyContent = "";
        if (this.games.length == 0 && this.matchHistory.inProgress) {
            historyContent = templates.loading({
                type: "match_history",
            });
        } else {
            historyContent = templates.matchHistory({
                games: this.games,
                moreGamesAvailable: this.moreGamesAvailable,
                loading: this.matchHistory.inProgress,
                error: this.matchHistory.error,
                formatTime: helpers.formatTime,
            });
        }

        const historySelector = this.el.find("#match-history");
        if (historySelector) {
            historySelector.html(historyContent);

            $(".js-match-data").on("click", (e) => {
                if (!$(e.target).is("a")) {
                    this.toggleMatchData($(e.currentTarget).data("game-id"));
                }
            });

            $(".js-match-load-more").on("click", (_e) => {
                const params = this.getUrlParams();
                this.loadMatchHistory(
                    params.slug,
                    this.games.length,
                    this.teamModeFilter,
                );
                this.render();
            });

            $(".extra-team-mode-filter").on("click", (e) => {
                if (!this.matchHistory.inProgress) {
                    const _params = this.getUrlParams();
                    this.games = [];
                    this.teamModeFilter = $(e.currentTarget).data("filter");
                    this.loadMatchHistory(_params.slug, 0, this.teamModeFilter);
                    this.render();
                }
            });

            const params = this.getUrlParams();

            // Match data
            let matchDataContent = "";
            const expandedGame = this.games.find((x) => x.expanded);
            if (expandedGame) {
                let localId = 0;
                // Get this player's player_id in this match
                if (expandedGame.data) {
                    for (let i = 0; i < expandedGame.data.length; i++) {
                        const d = expandedGame.data[i];
                        if (params.slug == d.slug) {
                            localId = d.player_id || 0;
                            break;
                        }
                    }
                }

                matchDataContent = templates.matchData({
                    data: expandedGame.data,
                    error: expandedGame.dataError,
                    loading: this.matchData.inProgress,
                    localId: localId,
                    formatTime: helpers.formatTime,
                });
            }

            $("#match-data").html(matchDataContent);

            // "Download Stats" — same CSV export as the end-of-game button.
            this.el.find(".match-download-btn").on("click", () => {
                const game = this.games.find((x) => x.expanded);
                if (game?.data?.length) downloadMatchStatsCsv(game.data);
            });

            if (expandedGame && expandedGame.summary.guid === params.gameId) {
                const elm = document.querySelector(
                    `div[data-game-id="${params.gameId}"]`,
                );
                if (elm) {
                    elm.scrollIntoView();
                }
            }
        }

        this.app.localization.localizeIndex();
    }
}
