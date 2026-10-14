import $ from "jquery";
import { MapDefs } from "../../../shared/defs/mapDefs";
import type { PublicLobby, PublicLobbyDetails } from "../../../shared/types/privateLobby";
import { api } from "../api";
import type { ConfigManager } from "../config";
import type { GameInfo, SpectateGame, SpectateGameDetails } from "../gameInfo";
import { helpers } from "../helpers";
import type { PingTest } from "../pingTest";
import type { SiteInfo } from "../siteInfo";
import type { Localization } from "./localization";
import { MenuModal } from "./menuModal";

export interface MatchData {
    zone: string;
    /** UUID - was previously (incorrectly) typed as number; only ever used for URL interpolation/display. */
    gameId: string;
    useHttps: boolean;
    hosts: string[];
    addrs: string[];
    data: string;
}

const DETAILS_MS = 3000;

type View = "matches" | "lobbies";

function teamModeName(n: number) {
    return n === 4 ? "Squad" : n === 2 ? "Duo" : "Solo";
}

function mapDisplayName(mapName: string) {
    return (MapDefs as Record<string, { desc?: { name?: string } }>)[mapName]?.desc?.name || mapName;
}

function runtimeText(g: SpectateGame) {
    if (!g.startedAt) return "Waiting";
    const sec = Math.max(0, Math.floor((Date.now() - g.startedAt) / 1000));
    return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, "0")}`;
}

function lobbyTitle(l: PublicLobby) {
    return `${helpers.formatUsername(l.leaderName, l.leaderRoleTag)}'s Lobby`;
}

export class SpectatorMenu {
    spectatorMenu = $("#spectator-menu");
    startMenu = $("#start-menu");
    rightColumn = $("#right-column");
    btnLeaveSpectator = $("#btn-leave-spectator");
    spectateBtn = $("#btn-start-spectate");
    lobbyMatchBtn = $("#btn-spectate-lobby-match");
    gameLobbyBtn = $("#btn-join-game-lobby");
    lobbyJoinBtn = $("#btn-join-lobby-spectator");
    regionTabs = $("#spectator-region-tabs");
    viewTabs = $("#spectator-view-tabs");
    gameList = $("#spectator-game-list");
    errorDisplay = $("#spectator-error");

    refreshModal = new MenuModal($("#modal-refresh"));

    spectatorMenuOpen = false;
    region = "";
    view: View = "matches";
    /** Live game lists pushed by the server, per region (absent = not received yet). */
    gamesByRegion: Record<string, SpectateGame[]> = {};
    /** Live lobby lists (Public Spectating on), per region. */
    lobbiesByRegion: Record<string, PublicLobby[]> = {};
    lobbiesLoaded = false;
    selectedId: string | null = null;
    selectedLobbyId: string | null = null;
    details: SpectateGameDetails | null = null;
    lobbyDetails: PublicLobbyDetails | null = null;
    joining = false;

    private detailsTimer: ReturnType<typeof setInterval> | null = null;
    private tickAccum = 0;

    get games(): SpectateGame[] {
        return this.gamesByRegion[this.region] ?? [];
    }

    get gamesLoaded() {
        return this.region in this.gamesByRegion;
    }

    get lobbies(): PublicLobby[] {
        return this.lobbiesByRegion[this.region] ?? [];
    }

    get selectedLobby() {
        return this.lobbies.find((l) => l.publicId === this.selectedLobbyId);
    }

    /** The publicly listed lobby running this match, if any. */
    lobbyForGame(gameId: string) {
        return this.lobbies.find((l) => l.gameId === gameId);
    }

    constructor(
        public config: ConfigManager,
        public pingTest: PingTest,
        public siteInfo: SiteInfo,
        public gameInfo: GameInfo,
        public localization: Localization,
        public account: any,
        public joinGameCb: (data: MatchData) => void,
        public joinLobbyCb: (publicId: string) => void,
    ) {
        this.btnLeaveSpectator.on("click", () => this.leaveSpectatorMode());

        this.regionTabs.on("click", ".spectator-region-tab", (e) => {
            const region = $(e.currentTarget).attr("data-region");
            if (!region || region === this.region) return;
            this.region = region;
            this.selectedId = this.games[0]?.id ?? null;
            this.selectedLobbyId = this.lobbies[0]?.publicId ?? null;
            this.details = null;
            this.lobbyDetails = null;
            this.renderAll();
            this.refreshDetails();
        });

        this.viewTabs.on("click", ".spectator-view-tab", (e) => {
            const view = $(e.currentTarget).attr("data-view") as View;
            if (!view || view === this.view) return;
            this.view = view;
            this.renderAll();
            this.refreshDetails();
        });

        this.gameList.on("click", ".spectator-game-card", (e) => {
            const id = $(e.currentTarget).attr("data-id");
            if (!id) return;
            if (this.view === "lobbies") {
                if (id === this.selectedLobbyId) return;
                this.selectedLobbyId = id;
                this.lobbyDetails = null;
            } else {
                if (id === this.selectedId) return;
                this.selectedId = id;
                this.details = null;
            }
            this.renderList();
            this.renderDetails();
            this.refreshDetails();
        });

        this.spectateBtn.on("click", () => this.spectateSelected());
        this.lobbyMatchBtn.on("click", () => {
            const lobby = this.selectedLobby;
            if (lobby?.gameId) this.spectateWithLobby(lobby, lobby.gameId);
        });
        this.gameLobbyBtn.on("click", () => {
            const lobby = this.selectedId ? this.lobbyForGame(this.selectedId) : undefined;
            if (lobby && this.selectedId) this.spectateWithLobby(lobby, this.selectedId);
        });
        this.lobbyJoinBtn.on("click", () => {
            const lobby = this.selectedLobby;
            if (!lobby) return;
            this.leaveSpectatorMode();
            this.joinLobbyCb(lobby.publicId);
        });
    }

    loadSpectatorMenu() {
        this.spectatorMenuOpen = true;
        this.spectatorMenu.css("display", "block");
        this.startMenu.css("display", "none");
        this.rightColumn.css("display", "none");
        // same full-stage layout as the private lobby: header + side columns make room
        $("#left-column, #start-row-header, #social-share-block").css("display", "none");

        const regions = this.getRegions();
        if (!regions.some((r) => r.id === this.region)) {
            const configRegion = this.config.get("region");
            this.region = regions.some((r) => r.id === configRegion)
                ? configRegion!
                : (regions[0]?.id ?? "");
        }

        this.renderAll();
        this.syncStream();
        if (!this.detailsTimer) {
            // Also notices when the menu got hidden by joining a game (and comes back
            // after it), so the stream only stays open while the menu is on screen.
            this.detailsTimer = setInterval(() => this.syncStream(), DETAILS_MS);
        }
    }

    leaveSpectatorMode() {
        this.spectatorMenuOpen = false;
        if (this.detailsTimer) {
            clearInterval(this.detailsTimer);
            this.detailsTimer = null;
        }
        this.gameInfo.closeStream();
        this.spectatorMenu.css("display", "none");
        this.startMenu.css("display", "block");
        this.rightColumn.css("display", "block");
        $("#left-column, #start-row-header, #social-share-block").css("display", "block");
    }

    private syncStream() {
        if (!this.spectatorMenu.is(":visible")) {
            this.gameInfo.closeStream();
            return;
        }
        if (!this.gameInfo.streamOpen) {
            this.gamesByRegion = {};
            this.lobbiesByRegion = {};
            this.lobbiesLoaded = false;
            this.renderAll();
            this.gameInfo.openStream(
                (region, games) => this.onGames(region, games),
                (ok) => this.showError(ok ? "" : "Live updates interrupted - reconnecting..."),
                (lobbies) => this.onLobbies(lobbies),
            );
        }
        this.refreshDetails();
    }

    private onGames(region: string, games: SpectateGame[]) {
        this.gamesByRegion[region] = games.sort((a, b) => b.playerCount - a.playerCount);
        if (region !== this.region) {
            this.renderTabs();
            return;
        }
        if (!this.games.some((g) => g.id === this.selectedId)) {
            this.selectedId = this.games[0]?.id ?? null;
            this.details = null;
            if (this.view === "matches") this.refreshDetails();
        }
        this.renderAll();
    }

    private onLobbies(byRegion: Record<string, PublicLobby[]>) {
        for (const region in byRegion) {
            byRegion[region].sort(
                (a, b) => Number(b.inGame) - Number(a.inGame) || b.playerCount - a.playerCount,
            );
        }
        this.lobbiesByRegion = byRegion;
        this.lobbiesLoaded = true;
        if (!this.selectedLobby) {
            this.selectedLobbyId = this.lobbies[0]?.publicId ?? null;
            this.lobbyDetails = null;
            if (this.view === "lobbies") this.refreshDetails();
        }
        this.renderAll();
    }

    /** Regions from the (hidden) spectate select, which SiteInfo fills with labels. */
    getRegions() {
        return $("#spectate-server-opts option")
            .toArray()
            .map((el) => ({
                id: (el as HTMLOptionElement).value,
                label: $(el).attr("data-label") || (el as HTMLOptionElement).value,
            }));
    }

    async refreshDetails() {
        if (this.view === "lobbies") {
            const publicId = this.selectedLobbyId;
            if (!publicId) return;
            const details = await this.gameInfo.fetchLobbyDetails(publicId);
            if (publicId !== this.selectedLobbyId) return;
            this.lobbyDetails = details;
            this.renderDetails();
            return;
        }
        const gameId = this.selectedId;
        if (!gameId) return;
        const details = await this.gameInfo.fetchDetails(this.region, gameId);
        if (gameId !== this.selectedId) return;
        this.details = details;
        this.renderDetails();
    }

    renderAll() {
        this.renderTabs();
        this.renderList();
        this.renderDetails();
    }

    renderTabs() {
        const pops = this.siteInfo.info?.pops ?? {};
        this.regionTabs.html(
            this.getRegions()
                .map(({ id, label }) => {
                    const active = id === this.region;
                    const live = this.gamesByRegion[id];
                    const players = live
                        ? live.reduce((n, g) => n + g.playerCount, 0)
                        : (pops[id]?.playerCount ?? 0);
                    return `<a class="btn-hollow btn-darken spectator-region-tab${active ? " btn-hollow-selected" : ""}" data-region="${helpers.htmlEscape(id)}">${helpers.htmlEscape(label)}<span class="spectator-region-tab-count">${players}</span></a>`;
                })
                .join(""),
        );
        this.viewTabs.find(".spectator-view-tab").each((_i, el) => {
            $(el).toggleClass("btn-hollow-selected", $(el).attr("data-view") === this.view);
        });
        $("#spectator-count-matches").text(this.games.length);
        $("#spectator-count-lobbies").text(this.lobbies.length);
    }

    renderList() {
        if (this.view === "lobbies") {
            this.renderLobbyList();
            return;
        }
        if (!this.gamesLoaded) {
            this.gameList.html('<div class="spectator-empty"><div class="ui-spinner"></div></div>');
            return;
        }
        if (!this.games.length) {
            this.gameList.html('<div class="spectator-empty">No running games in this region right now.</div>');
            return;
        }
        this.gameList.html(
            this.games
                .map((g, i) => {
                    const selected = g.id === this.selectedId ? " selected" : "";
                    const lobby = g.isPrivate ? '<span class="spectator-lobby-badge">Lobby</span>' : "";
                    return `<div class="spectator-game-card${selected}" data-id="${helpers.htmlEscape(g.id)}">
                        <div class="spectator-card-row">
                            <span class="spectator-mode-badge mode-${g.teamMode}">${teamModeName(g.teamMode)}</span>
                            <span class="spectator-card-map">${helpers.htmlEscape(mapDisplayName(g.mapName))}</span>
                            ${lobby}
                            <span class="spectator-card-alive">${g.playerCount}</span>
                        </div>
                        <div class="spectator-card-sub">Game #${i + 1} &middot; <span class="spectator-card-runtime" data-id="${helpers.htmlEscape(g.id)}">${runtimeText(g)}</span></div>
                    </div>`;
                })
                .join(""),
        );
    }

    renderLobbyList() {
        if (!this.lobbiesLoaded) {
            this.gameList.html('<div class="spectator-empty"><div class="ui-spinner"></div></div>');
            return;
        }
        if (!this.lobbies.length) {
            this.gameList.html('<div class="spectator-empty">No lobbies with public spectating in this region right now.</div>');
            return;
        }
        this.gameList.html(
            this.lobbies
                .map((l) => {
                    const selected = l.publicId === this.selectedLobbyId ? " selected" : "";
                    const status = l.inGame
                        ? '<span class="spectator-lobby-status in-match">In match</span>'
                        : '<span class="spectator-lobby-status waiting">Waiting</span>';
                    const specs = l.spectatorCount
                        ? ` &middot; ${l.spectatorCount} ${l.spectatorCount === 1 ? "spectator" : "spectators"}`
                        : "";
                    return `<div class="spectator-game-card${selected}" data-id="${helpers.htmlEscape(l.publicId)}">
                        <div class="spectator-card-row">
                            <span class="spectator-mode-badge mode-${l.teamMode}">${teamModeName(l.teamMode)}</span>
                            <span class="spectator-card-map">${helpers.htmlEscape(mapDisplayName(l.mapName))}</span>
                            ${status}
                        </div>
                        <div class="spectator-card-sub">${lobbyTitle(l)} &middot; ${l.playerCount}/${l.maxPlayers} players${specs}</div>
                    </div>`;
                })
                .join(""),
        );
    }

    renderDetails() {
        const empty = $("#spectator-detail-empty");
        const body = $("#spectator-detail-body");
        const lobbyBody = $("#spectator-lobby-body");
        if (this.view === "lobbies") {
            body.css("display", "none");
            const lobby = this.selectedLobby;
            if (!lobby) {
                lobbyBody.css("display", "none");
                empty.css("display", "block").text(
                    this.lobbiesLoaded && !this.lobbies.length
                        ? "Lobbies only show up here while their host has Public Spectating on."
                        : "Select a lobby to see who is in it.",
                );
                return;
            }
            empty.css("display", "none");
            lobbyBody.css("display", "flex");
            this.renderLobbyDetails(lobby);
            return;
        }

        lobbyBody.css("display", "none");
        const game = this.games.find((g) => g.id === this.selectedId);
        if (!game) {
            body.css("display", "none");
            empty.css("display", "block").text(
                this.gamesLoaded && !this.games.length
                    ? "Nothing to spectate yet - check back in a moment."
                    : "Select a game to see who is playing.",
            );
            return;
        }
        empty.css("display", "none");
        body.css("display", "flex");

        const d = this.details?.game.id === game.id ? this.details : null;
        // header + stats come from the pushed list, the same source as the card, so the
        // two can never disagree; the details request only adds players and kills
        const g = game;
        $("#spectator-detail-mode")
            .attr("class", `spectator-mode-badge mode-${g.teamMode}`)
            .text(teamModeName(g.teamMode));
        $("#spectator-detail-map").text(mapDisplayName(g.mapName));
        $("#spectator-detail-private").css("display", g.isPrivate ? "" : "none");
        $("#spectator-detail-alive").text(g.playerCount);
        $("#spectator-detail-runtime").text(runtimeText(g));

        const players = $("#spectator-detail-players");
        if (!d) {
            $("#spectator-detail-kills").text("-");
            players.html('<div class="spectator-empty"><div class="ui-spinner"></div></div>');
            $("#spectator-detail-feed, #spectator-detail-feed-title").css("display", "none");
        } else {
            type P = SpectateGameDetails["players"][number];
            const byStanding = (a: P, b: P) =>
                Number(b.alive) - Number(a.alive) || b.kills - a.kills;
            const playerRow = (p: P) => `<div class="spectator-player${p.alive ? "" : " dead"}">
                                <span class="spectator-player-dot"></span>
                                <span class="spectator-player-name">${helpers.formatUsername(p.name, p.roleTag)}</span>
                                <span class="spectator-player-kills">${p.kills} ${p.kills === 1 ? "kill" : "kills"}</span>
                            </div>`;

            const teams = new Map<number, P[]>();
            for (const p of d.players) {
                const team = teams.get(p.teamId);
                if (team) team.push(p);
                else teams.set(p.teamId, [p]);
            }
            const grouped = [...teams.values()].some((t) => t.length > 1);

            $("#spectator-detail-kills").text(d.players.reduce((n, p) => n + p.kills, 0));
            if (!d.players.length) {
                players.html('<div class="spectator-empty">No players.</div>');
            } else if (!grouped) {
                players.html([...d.players].sort(byStanding).map(playerRow).join(""));
            } else {
                const kills = (t: P[]) => t.reduce((n, p) => n + p.kills, 0);
                const aliveCount = (t: P[]) => t.filter((p) => p.alive).length;
                const ordered = [...teams.values()].sort(
                    (a, b) =>
                        Number(aliveCount(b) > 0) - Number(aliveCount(a) > 0)
                        || kills(b) - kills(a)
                        || aliveCount(b) - aliveCount(a),
                );
                players.html(
                    ordered
                        .map((t, i) => {
                            const alive = aliveCount(t);
                            return `<div class="spectator-team${alive ? "" : " eliminated"}">
                                <div class="spectator-team-head">
                                    <span>Team ${i + 1}</span>
                                    <span class="spectator-team-meta">${alive ? `${alive}/${t.length} alive` : "eliminated"} &middot; ${kills(t)} ${kills(t) === 1 ? "kill" : "kills"}</span>
                                </div>
                                ${[...t].sort(byStanding).map(playerRow).join("")}
                            </div>`;
                        })
                        .join(""),
                );
            }

            const feed = [...d.feed].reverse();
            $("#spectator-detail-feed, #spectator-detail-feed-title").css(
                "display",
                feed.length ? "" : "none",
            );
            $("#spectator-detail-feed").html(
                feed
                    .map((k) => {
                        const weapon = this.localization.translate(`game-${k.weapon}`) || k.weapon;
                        return `<div><b>${helpers.htmlEscape(k.killer)}</b> killed <b>${helpers.htmlEscape(k.victim)}</b> <span class="spectator-feed-weapon">${helpers.htmlEscape(weapon)}</span></div>`;
                    })
                    .join(""),
            );
        }

        this.spectateBtn
            .toggleClass("btn-disabled", this.joining)
            .html(this.joining ? '<div class="ui-spinner"></div>' : "Spectate");
        this.gameLobbyBtn
            .css("display", this.lobbyForGame(game.id) ? "" : "none")
            .toggleClass("btn-disabled", this.joining);
    }

    renderLobbyDetails(lobby: PublicLobby) {
        $("#spectator-lobby-mode")
            .attr("class", `spectator-mode-badge mode-${lobby.teamMode}`)
            .text(teamModeName(lobby.teamMode));
        $("#spectator-lobby-title").html(
            `${helpers.htmlEscape(mapDisplayName(lobby.mapName))} &middot; ${lobbyTitle(lobby)}`,
        );
        $("#spectator-lobby-players").text(`${lobby.playerCount}/${lobby.maxPlayers}`);
        $("#spectator-lobby-spectators").text(lobby.spectatorCount);
        $("#spectator-lobby-status").text(lobby.inGame ? "In match" : "Waiting");

        const members = $("#spectator-lobby-members");
        const d = this.lobbyDetails?.lobby.publicId === lobby.publicId ? this.lobbyDetails : null;
        if (!d) {
            members.html('<div class="spectator-empty"><div class="ui-spinner"></div></div>');
        } else {
            type M = PublicLobbyDetails["members"][number];
            const memberRow = (m: M) => {
                const state = m.afk ? "AFK" : m.inGame ? "in match" : "";
                return `<div class="spectator-player">
                    <span class="spectator-player-dot"></span>
                    <span class="spectator-player-name">${helpers.formatUsername(m.name, m.roleTag)}</span>
                    <span class="spectator-player-kills">${state}</span>
                </div>`;
            };
            const teams = new Map<number, M[]>();
            const spectators: M[] = [];
            for (const m of d.members) {
                if (m.spectator || m.teamId < 0) {
                    spectators.push(m);
                    continue;
                }
                const team = teams.get(m.teamId);
                if (team) team.push(m);
                else teams.set(m.teamId, [m]);
            }
            const teamHtml = [...teams.entries()]
                .sort(([a], [b]) => a - b)
                .map(([teamId, list]) => {
                    const wins = d.teamScores[teamId];
                    const score = wins
                        ? `<span class="spectator-team-score">${wins} ${wins === 1 ? "win" : "wins"}</span>`
                        : "";
                    return `<div class="spectator-team">
                        <div class="spectator-team-head">
                            <span>Team ${teamId + 1}${score}</span>
                            <span class="spectator-team-meta">${list.length} ${list.length === 1 ? "player" : "players"}</span>
                        </div>
                        ${list.map(memberRow).join("")}
                    </div>`;
                })
                .join("");
            const specHtml = spectators.length
                ? `<div class="spectator-team eliminated">
                        <div class="spectator-team-head"><span>Spectators</span><span class="spectator-team-meta">${spectators.length}</span></div>
                        ${spectators.map(memberRow).join("")}
                    </div>`
                : "";
            members.html(teamHtml + specHtml || '<div class="spectator-empty">No members.</div>');
        }

        this.lobbyMatchBtn
            .css("display", lobby.inGame && lobby.gameId ? "" : "none")
            .toggleClass("btn-disabled", this.joining)
            .html(this.joining ? '<div class="ui-spinner"></div>' : "Spectate Match");
    }

    showError(msg: string) {
        this.errorDisplay.text(msg).css("display", msg ? "block" : "none");
    }

    spectateSelected() {
        if (this.selectedId) this.spectateGame(this.selectedId);
    }

    spectateGame(gameId: string) {
        if (this.joining) return;
        this.joining = true;
        this.renderDetails();
        this.findGameWithId(gameId, this.region, (err, matchData) => {
            this.joining = false;
            this.renderDetails();
            if (err || !matchData) {
                this.onJoinGameError(err ?? "join_game_spectator_failed");
                return;
            }
            this.showError("");
            this.joinGameCb(matchData);
        });
    }

    /** Joins the lobby as a spectator AND drops straight into its running match; after
     *  the match the lobby client takes over, so the viewer lands back in the lobby.
     *  The match is resolved first so a match that just ended doesn't strand them. */
    spectateWithLobby(lobby: PublicLobby, gameId: string) {
        if (this.joining) return;
        this.joining = true;
        this.renderDetails();
        this.findGameWithId(gameId, this.region, (err, matchData) => {
            this.joining = false;
            this.renderDetails();
            if (err || !matchData) {
                this.onJoinGameError(err ?? "join_game_spectator_failed");
                return;
            }
            this.showError("");
            this.leaveSpectatorMode();
            this.joinLobbyCb(lobby.publicId);
            this.joinGameCb(matchData);
        });
    }

    onJoinGameError(err: string) {
        const errMap: Record<string, string> = {
            full: this.localization.translate("index-failed-finding-game"),
            invalid_protocol: this.localization.translate("index-invalid-protocol"),
            join_game_failed: this.localization.translate("index-failed-joining-game"),
            join_game_spectator_failed: this.localization.translate(
                "index-failed-joining-spectator-game",
            ),
        };
        if (err === "invalid_protocol") {
            this.refreshModal.show(true);
        }
        this.showError(errMap[err] || errMap.join_game_spectator_failed || "Could not join this game.");
        this.refreshDetails();
    }

    update(dt: number) {
        this.tickAccum += dt;
        if (this.tickAccum < 0.25) return;
        this.tickAccum = 0;
        for (const g of this.games) {
            $(`.spectator-card-runtime[data-id="${g.id}"]`).text(runtimeText(g));
        }
        const game = this.games.find((g) => g.id === this.selectedId);
        if (game) $("#spectator-detail-runtime").text(runtimeText(game));
    }

    findGameWithId(
        selectedGameId: string,
        region: string,
        cb: (err?: string | null, matchData?: MatchData) => void,
    ) {
        (function findGameImpl(iter, maxAttempts) {
            if (iter >= maxAttempts) {
                cb("full");
                return;
            }
            const retry = function () {
                setTimeout(() => {
                    findGameImpl(iter + 1, maxAttempts);
                }, 500);
            };
            $.ajax({
                type: "POST",
                url: api.resolveUrl("/api/find_game_by_id"),
                data: JSON.stringify({ gameId: selectedGameId, region: region }),
                contentType: "application/json; charset=utf-8",
                timeout: 10 * 1000,
                success: function (data: { err?: string; res: [MatchData] }) {
                    if (data?.err && data.err != "full") {
                        cb(data.err);
                        return;
                    }
                    const matchData = data?.res ? data.res[0] : null;
                    if (matchData?.hosts && matchData.addrs) {
                        cb(null, matchData);
                    } else {
                        retry();
                    }
                },
                error: function (_e) {
                    retry();
                },
            });
        })(0, 2);
    }
}
