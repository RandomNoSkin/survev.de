import $ from "jquery";
import {
    CUSTOM_LOADOUT_AMMOS,
    CUSTOM_LOADOUT_BACKPACKS,
    CUSTOM_LOADOUT_CHESTS,
    CUSTOM_LOADOUT_GRENADES,
    CUSTOM_LOADOUT_GUNS,
    CUSTOM_LOADOUT_HEALS,
    CUSTOM_LOADOUT_HELMETS,
    CUSTOM_LOADOUT_MELEES,
    CUSTOM_LOADOUT_NAME_MAX_LEN,
    CUSTOM_LOADOUT_PERKS,
    CUSTOM_LOADOUT_SCOPES,
    type CustomLoadoutConfig,
    DEFAULT_CUSTOM_LOADOUT,
    MAX_EXTRA_CUSTOM_LOADOUTS,
    validateCustomLoadout,
} from "../../../shared/defs/customLoadout";
import { GameObjectDefs } from "../../../shared/defs/register.ts";
import { type GunDef, GunDefs } from "../../../shared/defs/gameObjects/gunDefs";
import { type RoleDef, RoleDefs } from "../../../shared/defs/gameObjects/roleDefs";
import { type MapDef, MapDefs } from "../../../shared/defs/mapDefs";
import { GameConfig, type InventoryItem } from "../../../shared/gameConfig";
import * as net from "../../../shared/net/net";
import type { FindGameMatchData } from "../../../shared/types/api";
import type {
    PrivateLobbyErrorType,
    PrivateLobbyMenuPlayer,
    PrivateLobbyPlayGameMsg,
    PrivateLobbyStateMsg,
    RoomData,
    SavedPrivateLobbySettings,
    ServerToClientPrivateLobbyMsg,
} from "../../../shared/types/privateLobby";
import { api } from "../api";
import type { AudioManager } from "../audioManager";
import type { ConfigManager } from "../config";
import { device } from "../device";
import { helpers } from "../helpers";
import type { PingTest } from "../pingTest";
import { SDK } from "../sdk/sdk";
import type { SiteInfo } from "../siteInfo";
import type { Localization } from "./localization";

function errorTypeToString(type: string, localization: Localization) {
    const typeMap = {
        join_full: localization.translate("index-private-lobby-is-full"),
        join_not_found: localization.translate("index-failed-joining-private-lobby"),
        create_failed: localization.translate("index-failed-creating-private-lobby"),
        join_failed: localization.translate("index-failed-joining-private-lobby"),
        join_game_failed: localization.translate("index-failed-joining-game"),
        lost_conn: localization.translate("index-lost-connection-private-lobby"),
        find_game_error: localization.translate("index-failed-finding-game"),
        find_game_full: localization.translate("index-failed-finding-game"),
        find_game_invalid_protocol: localization.translate("index-invalid-protocol"),
        kicked: localization.translate("index-private-lobby-kicked"),
        banned: localization.translate("index-ip-banned"),
        behind_proxy: "behind_proxy", // this will get passed to the main app to show a modal
        login_required: localization.translate("index-private-lobby-login-required"),
        mode_disabled: localization.translate("index-private-lobby-mode-disabled"),
        team_full: localization.translate("index-private-lobby-team-full"),
        host_left: localization.translate("index-private-lobby-host-left"),
    } as Record<PrivateLobbyErrorType, string>;
    return typeMap[type as keyof typeof typeMap] || typeMap.lost_conn;
}

export class PrivateLobbyMenu {
    // Jquery elems
    playBtn = $("#btn-start-private-lobby");
    stopGameBtn = $("#btn-stop-private-lobby-game");
    afkBtn = $("#btn-private-lobby-afk");
    afkConfirmContainer = $("#private-lobby-afk-confirm");
    startAnywayBtn = $("#btn-private-lobby-start-anyway");
    cancelStartBtn = $("#btn-private-lobby-cancel-start");
    serverWarning = $("#server-warning");
    serverSelect = $("#private-lobby-server-select");
    categoryTabs = $("#private-lobby-category-tabs");
    modesContainer = $("#private-lobby-menu-modes");
    teamGrid = $("#private-lobby-menu-team-grid");
    createTeamBtn = $("#btn-private-lobby-create-team");
    settingsContainer = $("#private-lobby-menu-settings");
    settingsTabs = $("#private-lobby-settings-tabs");
    settingsContent = $("#private-lobby-settings-content");

    active = false;
    joined = false;
    create = false;
    joiningGame = false;
    afkConfirmPending = false;
    ws: WebSocket | null = null;

    // Ui state
    playerData = {};
    roomData = {} as RoomData;
    players: PrivateLobbyMenuPlayer[] = [];
    teamScores: Record<number, number> = {};

    prevPlayerCount = 0;
    localPlayerId = 0;
    isLeader = true;
    editingName = false;
    displayedInvalidProtocolModal = false;

    /** Lobby-local id of the player currently selected for team reassignment (leader only). */
    selectedPlayerId = -1;
    /** Team slots revealed via "Create Team" that are still empty; cleared once a player joins them. */
    extraEmptyTeamIds = new Set<number>();
    /** When true, "Create Team" is limited to one empty slot at a time. When false, unlimited. Default true. */
    limitEmptyTeams = true;
    /** Set when joining as part of a "Create Team" handoff so the lobby groups us with our teammates. */
    importGroupId: string | undefined;
    /** Set when joining via a team-specific invite link/code (e.g. "ABC123-2") so the lobby places us directly into that team slot. */
    teamId: number | undefined;
    /** Id of the currently selected settings tab (e.g. "arenaRoles"); reset to the first available tab whenever it stops applying. */
    activeSettingsTab: string | null = null;
    /** Indices (0 = base "Custom Loadout", 1+ = `extraCustomLoadouts[index - 1]`) whose builder is collapsed while "Custom Loadout" remains enabled. Local UI state only. */
    collapsedLoadouts = new Set<number>();
    /** Index of the loadout whose name label is currently being edited inline (leader only), or null. Local UI state only. */
    editingLoadoutName: number | null = null;
    /** Uncommitted text of the inline rename input, kept so a refreshUi() (e.g. triggered by a member's action) doesn't reset what the leader is typing. */
    editingLoadoutValue: string | null = null;
    /** True when the local client joined via a spectator invite link (`#CODE-s`). */
    spectator = false;

    hideUrl!: boolean;

    constructor(
        public config: ConfigManager,
        public pingTest: PingTest,
        public siteInfo: SiteInfo,
        public localization: Localization,
        public audioManager: AudioManager,
        public joinGameCb: (data: FindGameMatchData) => void,
        public leaveCb: (err: string) => void,
        public forceQuitCb: () => void,
        public joinGameAsSpectatorCb: (data: FindGameMatchData) => void,
    ) {
        // Listen for ui modifications
        // The server dropdown holds geographic groups (eu/asia/...); the playlist
        // within the group is chosen via the category tabs. Both resolve to a
        // concrete region, which is the value actually synced to the room.
        this.serverSelect.on("change", () => {
            const group = this.serverSelect.find(":selected").val() as string;
            this.applyRegion(this.regionForGroup(group));
        });
        this.categoryTabs.on("click", ".btn-cat-tab", (e) => {
            if (!this.isLeader) return;
            const category = $(e.currentTarget).data("category") as string;
            const group = this.siteInfo.regionMeta(this.roomData.region).group;
            this.applyRegion(this.siteInfo.resolveRegion(group, category));
        });
        this.playBtn.on("click", () => {
            SDK.requestMidGameAd(() => {
                this.tryStartGame();
            });
        });
        this.stopGameBtn.on("click", () => {
            this.tryEndGame();
        });
        this.startAnywayBtn.on("click", () => {
            this.tryStartGame();
        });
        this.cancelStartBtn.on("click", () => {
            this.afkConfirmPending = false;
            this.refreshUi();
        });
        this.afkBtn.on("click", () => {
            const localPlayer = this.getPlayerById(this.localPlayerId);
            if (localPlayer) {
                this.sendMessage("setAfk", { afk: !localPlayer.afk });
            }
        });
        $("#private-lobby-copy-url, #private-lobby-desc-text").on("click", (e) => {
            const t = $("<div/>", {
                class: "copy-toast",
                html: "Copied!",
            });
            $("#start-menu-wrapper").append(t);
            t.css({
                left: e.pageX - parseInt(t.css("width")) / 2,
                top: $("#private-lobby-copy-url").offset()!.top,
            });
            t.animate(
                {
                    top: "-=20",
                    opacity: 1,
                },
                {
                    queue: false,
                    duration: 300,
                    complete: function () {
                        $(this).fadeOut(250, function () {
                            $(this).remove();
                        });
                    },
                },
            );
            let codeToCopy = $("#private-lobby-url").text();
            // if running on an iframe
            if (window !== window.top) {
                codeToCopy = this.roomData.roomUrl.substring(1);
            }
            helpers.copyTextToClipboard(codeToCopy);
        });

        if (window !== window.top) {
            $("#private-lobby-desc-text").hide();
        }

        if (!device.mobile) {
            // Hide invite link
            this.hideUrl = false;
            $("#private-lobby-hide-url").on("click", (e) => {
                const el = e.currentTarget;
                this.hideUrl = !this.hideUrl;
                $("#private-lobby-desc-text, #private-lobby-code-text").css({
                    opacity: this.hideUrl ? 0 : 1,
                });
                $(el).css({
                    "background-image": this.hideUrl
                        ? "url(../img/gui/hide.svg)"
                        : "url(../img/gui/eye.svg)",
                });
            });
        }

        // Clicking anywhere inside a team's area either:
        //   a) moves the currently selected player there (leader only, when a player is selected)
        //   b) joins that team yourself (leader always; members when allowMembersJoinTeams is on)
        this.teamGrid.on("click", ".private-lobby-team", (e) => {
            const teamIdAttr = $(e.currentTarget).attr("data-teamid");
            if (teamIdAttr === undefined) return;
            const teamId = Number(teamIdAttr);

            if (this.isLeader && this.selectedPlayerId >= 0) {
                // Move the selected player into this team
                this.sendMessage("assignTeam", {
                    playerId: this.selectedPlayerId,
                    teamId,
                });
                this.selectedPlayerId = -1;
                this.refreshUi();
            } else if (this.selectedPlayerId < 0) {
                // No player selected — join this team yourself (spectators can join too)
                const canJoin = this.isLeader || this.roomData.allowMembersJoinTeams;
                if (!canJoin) return;
                const localPlayer = this.getPlayerById(this.localPlayerId);
                if (!localPlayer || localPlayer.teamId === teamId) return;
                this.sendMessage("assignTeam", {
                    playerId: this.localPlayerId,
                    teamId,
                });
            }
        });

        // Reveals the next empty team slot in the grid (leader only).
        // When limitEmptyTeams is true only one empty slot may be shown at a time;
        // when false any number can be revealed.
        this.createTeamBtn.on("click", () => {
            if (!this.isLeader) return;
            if (this.limitEmptyTeams && this.extraEmptyTeamIds.size > 0) return;
            const maxPlayers = Math.max(1, this.roomData.maxPlayers);
            const occupied = new Set([
                ...this.players
                    .filter((p) => p.teamId >= 0 && p.teamId < maxPlayers)
                    .map((p) => p.teamId),
                ...this.extraEmptyTeamIds,
            ]);
            if (occupied.size >= maxPlayers) return;
            for (let t = 0; t < maxPlayers; t++) {
                if (!occupied.has(t)) {
                    this.extraEmptyTeamIds.add(t);
                    break;
                }
            }
            this.refreshUi();
        });

        setInterval(() => {
            if (this.joined) {
                this.sendMessage("keepAlive", {});
            }
        }, 10 * 1000);
    }

    getPlayerById(playerId: number) {
        return this.players.find((x) => {
            return x.playerId == playerId;
        });
    }

    connect(
        create: boolean,
        roomUrl: string,
        importGroupId?: string,
        teamId?: number,
        spectator = false,
    ) {
        if (!this.active || roomUrl !== this.roomData.roomUrl) {
            const roomHost = api.resolveRoomHost();
            const url = `w${
                window.location.protocol === "https:" ? "ss" : "s"
            }://${roomHost}/private_lobby_v2`;
            this.active = true;
            this.joined = false;
            this.create = create;
            this.joiningGame = false;
            this.editingName = false;
            this.selectedPlayerId = -1;
            this.extraEmptyTeamIds.clear();
            this.importGroupId = importGroupId;
            this.teamId = teamId;
            this.spectator = spectator;

            // Load properties from config
            this.playerData = {
                name: this.config.get("playerName"),
            };
            // When creating a new lobby, restore the leader's last-used settings,
            // but never carry over "Advanced Settings". The saved loadouts are
            // re-validated first so a config corrupted by an older build (e.g. a
            // perks array with holes that serialize to null) can't keep failing
            // the server's schema and permanently lock the player out of creating.
            const savedSettings = create
                ? this.sanitizeSavedSettings(this.config.get("privateLobbySettings"))
                : undefined;
            this.roomData = {
                roomUrl,
                region: this.config.get("region")!,
                gameModeIdx: this.config.get("gameModeIdx")!,
                findingGame: false,
                lastError: "",
                ...savedSettings,
                ...(create ? { advancedSettings: false } : undefined),
            } as RoomData;
            this.displayedInvalidProtocolModal = false;

            this.refreshUi();

            if (this.ws) {
                this.ws.onclose = function () {};
                this.ws.close();
                this.ws = null;
            }

            try {
                this.ws = new WebSocket(url);
                this.ws.onerror = (_e) => {
                    this.ws?.close();
                };
                this.ws.onclose = () => {
                    let errMsg = "";
                    if (!this.joiningGame) {
                        errMsg = this.joined
                            ? "lost_conn"
                            : this.create
                              ? "create_failed"
                              : "join_failed";
                    }
                    this.leave(errMsg);
                };
                this.ws.onopen = () => {
                    if (this.create) {
                        this.sendMessage("create", {
                            roomData: this.roomData,
                            playerData: this.playerData,
                        });
                    } else {
                        this.sendMessage("join", {
                            roomUrl: this.roomData.roomUrl,
                            playerData: this.playerData,
                            importGroupId: this.importGroupId,
                            teamId: this.teamId,
                            spectator: this.spectator || undefined,
                        });
                    }
                };
                this.ws.onmessage = (e) => {
                    if (this.active) {
                        const msg = JSON.parse(e.data);
                        this.onMessage(msg.type, msg.data);
                    }
                };
            } catch (_e) {
                this.leave(this.create ? "create_failed" : "join_failed");
            }
        }
    }

    leave(errType = "") {
        if (this.active) {
            // Captured before the reset below: `isLeader` defaults to true and is
            // only corrected once a "state" arrives, so a failed create/join
            // (which never receives state) would otherwise persist this session's
            // roomData and overwrite the player's real saved settings.
            const wasJoined = this.joined;
            this.ws?.close();
            this.ws = null;
            this.active = false;
            this.joined = false;
            this.joiningGame = false;
            this.afkConfirmPending = false;
            this.selectedPlayerId = -1;
            this.importGroupId = undefined;
            this.teamId = undefined;
            this.spectator = false;
            this.refreshUi();

            // Save state to config for the menu
            this.config.set("gameModeIdx", this.roomData.gameModeIdx);
            if (wasJoined && this.isLeader) {
                this.config.set("region", this.roomData.region);
                this.config.set("privateLobbySettings", {
                    allowMembersJoinTeams: this.roomData.allowMembersJoinTeams,
                    publicSpectating: this.roomData.publicSpectating,
                    advancedSettings: this.roomData.advancedSettings,
                    customLoadoutEnabled: this.roomData.customLoadoutEnabled,
                    customLoadout: this.roomData.customLoadout,
                    extraCustomLoadouts: this.roomData.extraCustomLoadouts,
                    enabledArenaRoles: this.roomData.enabledArenaRoles,
                });
            }
            let errTxt = "";
            if (errType && errType != "") {
                errTxt = errorTypeToString(errType, this.localization);
            }
            this.leaveCb(errTxt);

            SDK.hideInviteButton();
        }
    }

    /**
     * Re-validates persisted loadout settings before they're used to create a
     * lobby. A config corrupted by an older build — most notably a `perks` array
     * with holes that JSON-serialize to `null` — would otherwise fail the
     * server's schema on every `create` and permanently lock the player out of
     * making lobbies. Running the saved loadouts back through the shared
     * validator heals them; everything else is passed through untouched.
     */
    sanitizeSavedSettings(
        settings: SavedPrivateLobbySettings | undefined,
    ): SavedPrivateLobbySettings | undefined {
        if (!settings) return settings;
        const sanitized: SavedPrivateLobbySettings = { ...settings };
        if (sanitized.customLoadout) {
            sanitized.customLoadout = validateCustomLoadout(sanitized.customLoadout);
        }
        if (sanitized.extraCustomLoadouts) {
            sanitized.extraCustomLoadouts = sanitized.extraCustomLoadouts
                .filter(Boolean)
                .map((loadout) => validateCustomLoadout(loadout));
        }
        return sanitized;
    }

    onGameComplete(wonGame = false) {
        if (this.active) {
            this.joiningGame = false;
            const localPlayer = this.getPlayerById(this.localPlayerId);
            this.sendMessage("gameComplete", {
                wonGame,
                lobbyTeamId: wonGame ? (localPlayer?.teamId ?? undefined) : undefined,
            });
        }
    }

    onMessage<T extends ServerToClientPrivateLobbyMsg["type"]>(
        type: T,
        data: ServerToClientPrivateLobbyMsg["data"],
    ) {
        switch (type) {
            case "state": {
                let stateData = data as PrivateLobbyStateMsg["data"];
                this.joined = true;
                const ourRoomData = this.roomData;
                this.roomData = stateData.room;
                this.players = stateData.players;
                this.teamScores = stateData.teamScores ?? {};
                this.localPlayerId = stateData.localPlayerId;
                this.isLeader = this.getPlayerById(this.localPlayerId)!.isLeader;

                // Override room properties with local values if we're
                // the leader; otherwise, the server may override a
                // recent change.
                if (this.isLeader) {
                    this.roomData.region = ourRoomData.region;
                }
                if (!this.getPlayerById(this.selectedPlayerId)) {
                    this.selectedPlayerId = -1;
                }
                this.refreshUi();
                // Since the only way to get the roomID (ig?) is from state, each time receiving state, we can show the invite button
                SDK.showInviteButton(stateData.room.roomUrl.replace("#", ""));
                break;
            }
            case "joinGame": {
                this.joiningGame = true;
                const matchData = data as FindGameMatchData;
                if (matchData.spectator) {
                    this.joinGameAsSpectatorCb(matchData);
                } else {
                    this.joinGameCb(matchData);
                }
                break;
            }
            case "keepAlive":
                break;
            case "kicked":
                this.leave("kicked");
                break;
            case "forceQuit":
                // the leader pulled the lobby out of the match early; force-disconnect
                // from the active game (if we're in one) and head back to the lobby
                this.joiningGame = false;
                this.forceQuitCb();
                break;
            case "error":
                this.leave((data as { type: string }).type);
        }
    }

    sendMessage(type: string, data?: unknown) {
        if (this.ws) {
            if (this.ws.readyState === this.ws.OPEN) {
                const msg = JSON.stringify({
                    type,
                    data,
                });
                this.ws.send(msg);
            } else {
                this.ws.close();
            }
        }
    }

    setRoomProperty<T extends keyof RoomData>(prop: T, val: RoomData[T]) {
        if (this.isLeader && this.roomData[prop] != val) {
            this.roomData[prop] = val;
            this.sendMessage("setRoomProps", this.roomData);
        }
    }

    /** Resolves a selected group to a concrete region, keeping the current playlist when the group offers it. */
    regionForGroup(group: string): string {
        const cats = this.siteInfo.getCategoriesForGroup(group);
        let category = this.siteInfo.regionMeta(this.roomData.region).category;
        if (!cats.some((c) => c.category === category)) {
            category = cats[0]?.category ?? "default";
        }
        return this.siteInfo.resolveRegion(group, category);
    }

    /** Applies a newly selected region: ping it and sync it to the room (leader only). */
    applyRegion(region: string) {
        this.pingTest.start([region]);
        this.connect(false, this.roomData.roomUrl);
        this.setRoomProperty("region", region);
    }

    tryStartGame() {
        if (!this.isLeader || this.roomData.findingGame) return;
        const afkPlayers = this.players.filter((p) => p.afk);
        if (afkPlayers.length > 0 && !this.afkConfirmPending) {
            this.afkConfirmPending = true;
            this.refreshUi();
            return;
        }
        this.afkConfirmPending = false;
        {
            const version = GameConfig.protocolVersion;
            let region = this.roomData.region;
            const paramRegion = helpers.getParameterByName("region");
            if (paramRegion !== undefined && paramRegion.length > 0) {
                region = paramRegion;
            }
            const matchArgs: PrivateLobbyPlayGameMsg["data"] = {
                version,
                region,
            };

            this.sendMessage("playGame", matchArgs);
            this.roomData.findingGame = true;
            this.refreshUi();
        }
    }

    /** Leader-only: pulls every in-game lobby member back to the lobby mid-match. */
    tryEndGame() {
        if (this.isLeader && this.players.some((p) => p.inGame)) {
            this.sendMessage("leaveGame");
        }
    }

    /** Renders a single player entry; reused for every team slot in the grid. */
    renderPlayerEntry(player: PrivateLobbyMenuPlayer) {
        const self = player.playerId == this.localPlayerId;
        const member = $("<div/>", {
            class: `team-menu-member private-lobby-player${
                player.playerId == this.selectedPlayerId
                    ? " private-lobby-player-selected"
                    : ""
            }${player.afk ? " private-lobby-player-afk" : ""}`,
            "data-playerid": player.playerId,
        });

        if (player.isLeader) {
            member.append(
                $("<div/>", {
                    class: "icon icon-leader",
                    "data-playerid": player.playerId,
                }),
            );
        } else if (this.isLeader && !self) {
            // Leader-only actions on another member: hand them ownership, or remove them
            const promoteIcon = $("<div/>", {
                class: "icon icon-promote",
                "data-playerid": player.playerId,
                title: this.localization.translate("index-private-lobby-promote"),
            });
            promoteIcon.on("click", (e) => {
                e.stopPropagation();
                this.sendMessage("promote", { playerId: player.playerId });
            });
            member.append(promoteIcon);

            const kickIcon = $("<div/>", {
                class: "icon icon-kick",
                "data-playerid": player.playerId,
            });
            kickIcon.on("click", (e) => {
                e.stopPropagation();
                this.sendMessage("kick", { playerId: player.playerId });
            });
            member.append(kickIcon);
        } else {
            member.append(
                $("<div/>", {
                    class: "icon",
                    "data-playerid": player.playerId,
                }),
            );
        }

        if (this.editingName && self) {
            const n: JQuery<HTMLInputElement> = $("<input/>", {
                type: "text",
                tabindex: 0,
                class: "name menu-option name-text name-self-input",
                maxLength: net.Constants.PlayerNameMaxLen,
            });
            n.val(player.name);
            const submitName = () => {
                const name = helpers.sanitizeNameInput(n?.val()!);
                this.config.set("playerName", name);
                this.sendMessage("changeName", {
                    name,
                });
                this.editingName = false;
                this.refreshUi();
            };
            const cancelEdit = () => {
                this.editingName = false;
                this.refreshUi();
            };
            n.on("click", (e) => e.stopPropagation());
            n.on("keydown", (e) => {
                if (e.which === 13) {
                    submitName();
                    return false;
                }
            });
            n.on("blur", cancelEdit);
            member.append(n);
            const c = $("<div/>", {
                class: "icon icon-submit-name-change",
            });
            c.on("click", (e) => {
                e.stopPropagation();
                submitName();
            });
            c.on("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
            member.append(c);
            n.trigger("focus");
        } else {
            let nameClass = "name-text";
            if (self) {
                nameClass += " name-self";
            }
            if (player.inGame) {
                nameClass += " name-in-game";
            }
            const nameDiv = $("<div/>", {
                class: `name menu-option ${nameClass}`,
                html: helpers.htmlEscape(player.name),
            });
            if (self) {
                nameDiv.on("click", (e) => {
                    e.stopPropagation();
                    this.editingName = true;
                    this.refreshUi();
                });
            }
            member.append(nameDiv);
            member.append(
                $("<div/>", {
                    class: `icon ${player.inGame ? "icon-in-game" : ""}`,
                }),
            );
        }

        member.on("click", (e) => {
            if (this.editingName || !this.isLeader) return;
            e.stopPropagation();
            if (this.selectedPlayerId >= 0 && this.selectedPlayerId !== player.playerId) {
                // A player was already selected — clicking a different one swaps their team slots
                this.sendMessage("swapTeam", {
                    playerId: this.selectedPlayerId,
                    targetPlayerId: player.playerId,
                });
                this.selectedPlayerId = -1;
            } else {
                this.selectedPlayerId =
                    this.selectedPlayerId == player.playerId ? -1 : player.playerId;
            }
            this.refreshUi();
        });

        if (
            player.spectator ||
            !this.roomData.customLoadoutEnabled ||
            !this.roomData.advancedSettings
        ) {
            return member;
        }

        const loadouts = this.getLoadouts();
        if (loadouts.length <= 1) {
            return member;
        }

        const entry = $("<div/>", { class: "private-lobby-player-entry" });
        entry.append(member);

        const loadoutSelect: JQuery<HTMLSelectElement> = $("<select/>", {
            class: "private-lobby-player-loadout-select",
        });
        for (let i = 0; i < loadouts.length; i++) {
            loadoutSelect.append(
                $("<option/>", {
                    value: i,
                    html: helpers.htmlEscape(this.getLoadoutLabel(i)),
                    selected: i === player.loadoutIndex,
                }),
            );
        }
        if (this.isLeader) {
            loadoutSelect.on("click", (e) => e.stopPropagation());
            loadoutSelect.on("change", (e) => {
                e.stopPropagation();
                this.sendMessage("assignLoadout", {
                    playerId: player.playerId,
                    loadoutIndex: Number(loadoutSelect.val()),
                });
            });
        } else {
            loadoutSelect.prop("disabled", true);
        }
        entry.append(loadoutSelect);

        return entry;
    }

    /** Renders the leader-assignable team grid: one block per team slot, plus an "unassigned" overflow block. */
    renderTeamGrid() {
        const grid = this.teamGrid;
        grid.empty();

        const teamCount = Math.max(1, this.roomData.teamCount);
        const teamSize = Math.max(1, this.roomData.teamSize);
        const maxPlayers = Math.max(1, this.roomData.maxPlayers);

        // Players can be assigned to any slot in [0, maxPlayers) — private lobbies
        // allow custom layouts (e.g. splitting a squad-mode lobby into more, smaller
        // teams), not just the mode's nominal team count (maxPlayers / teamSize).
        // Spectators are excluded here; they get their own section at the bottom.
        const spectatorPlayers = this.players.filter((p) => p.spectator);
        const playersByTeam = new Map<number, PrivateLobbyMenuPlayer[]>();
        const unassigned: PrivateLobbyMenuPlayer[] = [];
        for (const player of this.players) {
            if (player.spectator) continue;
            if (player.teamId < 0 || player.teamId >= maxPlayers) {
                unassigned.push(player);
                continue;
            }
            let bucket = playersByTeam.get(player.teamId);
            if (!bucket) {
                bucket = [];
                playersByTeam.set(player.teamId, bucket);
            }
            bucket.push(player);
        }

        // Remove revealed-empty-team IDs that are now filled or out of range,
        // so "Create Team" can reveal the next free slot again.
        for (const t of this.extraEmptyTeamIds) {
            if (t >= maxPlayers || playersByTeam.has(t)) {
                this.extraEmptyTeamIds.delete(t);
            }
        }

        // Show every team slot up to the mode's nominal count, plus any extra
        // slot that's in use (custom layout) or revealed via "Create Team".
        let displayCount = teamCount;
        for (const t of playersByTeam.keys()) {
            if (t >= displayCount) displayCount = t + 1;
        }
        for (const t of this.extraEmptyTeamIds) {
            if (t >= displayCount) displayCount = t + 1;
        }

        const localPlayerForGrid = this.getPlayerById(this.localPlayerId);
        const canJoinTeams = this.isLeader || this.roomData.allowMembersJoinTeams;

        const teamLabel = this.localization.translate("index-private-lobby-team");
        for (let t = 0; t < displayCount; t++) {
            const members = playersByTeam.get(t) || [];
            // Only show filled teams plus manually-revealed empty slots.
            if (members.length === 0 && !this.extraEmptyTeamIds.has(t)) continue;
            const teamFull = members.length >= teamSize;
            const isMyTeam = localPlayerForGrid?.teamId === t;
            const teamJoinable = canJoinTeams && !teamFull && !isMyTeam;
            const team = $("<div/>", {
                class: `private-lobby-team${teamJoinable ? " private-lobby-team-joinable" : ""}`,
                "data-teamid": t,
            });
            const header = $("<div/>", { class: "private-lobby-team-header" });
            // Left: team name + invite code text
            const headerLeft = $("<div/>", { class: "private-lobby-spectator-label" });
            const wins = this.teamScores[t] ?? 0;
            const winsTag =
                wins > 0 ? ` <span class="private-lobby-team-wins">${wins}W</span>` : "";
            headerLeft.append(
                $("<span/>", {
                    html: `${teamLabel} ${t + 1} (${members.length}/${teamSize})${winsTag}`,
                }),
            );
            if (teamSize > 1 && this.roomData.roomUrl) {
                const teamCodeText = $("<span/>", {
                    class: "private-lobby-invite-code-text",
                    html: helpers.htmlEscape(this.buildInviteUrl(t)),
                });
                teamCodeText.on("click", (e) => {
                    e.stopPropagation();
                    this.copyTeamInviteCode(t, e);
                });
                headerLeft.append(teamCodeText);
            }
            header.append(headerLeft);
            // Right: copy icon
            if (teamSize > 1) {
                const copyLinkBtn = $("<a/>", {
                    class: "private-lobby-team-copy-link",
                    title: this.localization.translate(
                        "index-private-lobby-copy-team-link",
                    ),
                });
                copyLinkBtn.on("click", (e) => {
                    e.stopPropagation();
                    this.copyTeamInviteCode(t, e);
                });
                header.append(copyLinkBtn);
            }
            team.append(header);
            const slot = $("<div/>", { class: "private-lobby-team-slot" });
            for (const player of members) {
                slot.append(this.renderPlayerEntry(player));
            }
            for (let i = members.length; i < teamSize; i++) {
                slot.append($("<div/>", { class: "private-lobby-player-empty" }));
            }
            team.append(slot);
            grid.append(team);
        }

        if (unassigned.length) {
            const team = $("<div/>", {
                class: "private-lobby-team private-lobby-team-unassigned",
            });
            team.append(
                $("<div/>", {
                    class: "private-lobby-team-header",
                    html: this.localization.translate("index-private-lobby-unassigned"),
                }),
            );
            const slot = $("<div/>", { class: "private-lobby-team-slot" });
            for (const player of unassigned) {
                slot.append(this.renderPlayerEntry(player));
            }
            team.append(slot);
            grid.append(team);
        }

        // Spectator section — always visible at the very bottom so the copy-link
        // button is reachable even when no spectators are present yet.
        // Clicking anywhere on the section toggles the local player's spectator status.
        const localPlayerForSpectator = this.getPlayerById(this.localPlayerId);
        const spectatorSection = $("<div/>", {
            class: "private-lobby-team private-lobby-team-spectators",
        });
        spectatorSection.on("click", (e) => {
            if (localPlayerForSpectator) {
                this.sendMessage("setSpectator", {
                    spectator: !localPlayerForSpectator.spectator,
                });
            }
        });

        const spectatorHeader = $("<div/>", { class: "private-lobby-team-header" });
        // Left: "Spectators" label + invite code text
        const spectatorLabel = $("<div/>", { class: "private-lobby-spectator-label" });
        spectatorLabel.append(
            $("<span/>", {
                html: this.localization.translate("index-private-lobby-spectators"),
            }),
        );
        if (this.roomData.roomUrl) {
            const spectatorCodeText = $("<span/>", {
                class: "private-lobby-invite-code-text",
                html: helpers.htmlEscape(this.buildInviteUrl("s")),
            });
            spectatorCodeText.on("click", (e) => {
                e.stopPropagation();
                this.copySpectatorInviteCode(e);
            });
            spectatorLabel.append(spectatorCodeText);
        }
        spectatorHeader.append(spectatorLabel);
        // Right: copy icon
        const copySpectatorBtn = $("<a/>", {
            class: "private-lobby-team-copy-link",
            title: this.localization.translate("index-private-lobby-copy-spectator-link"),
        });
        copySpectatorBtn.on("click", (e) => {
            e.stopPropagation();
            this.copySpectatorInviteCode(e);
        });
        spectatorHeader.append(copySpectatorBtn);
        spectatorSection.append(spectatorHeader);

        if (spectatorPlayers.length) {
            const spectatorSlot = $("<div/>", { class: "private-lobby-team-slot" });
            for (const player of spectatorPlayers) {
                spectatorSlot.append(this.renderPlayerEntry(player));
            }
            spectatorSection.append(spectatorSlot);
        }
        grid.append(spectatorSection);

        // "Reset Scores" — leader-only, only shown when any team has wins
        const hasScores = Object.values(this.teamScores).some((s) => s > 0);
        if (this.isLeader && hasScores) {
            const resetBtn = $("<button/>", {
                class: "btn btn-red private-lobby-reset-scores-btn",
                html: "Reset Scores",
            });
            resetBtn.on("click", (e) => {
                e.stopPropagation();
                this.sendMessage("resetScores");
            });
            grid.append(resetBtn);
        }

        // "Create Team" is leader-only, and disabled while an empty team is
        // already revealed or there's no room left for another team slot
        // (can't usefully have more teams than total player capacity).
        const hasFreeSlot = playersByTeam.size + this.extraEmptyTeamIds.size < maxPlayers;
        const limitOk = !this.limitEmptyTeams || this.extraEmptyTeamIds.size === 0;
        const canCreateTeam = hasFreeSlot && limitOk;
        this.createTeamBtn.css("display", this.isLeader ? "block" : "none");
        this.createTeamBtn.removeClass("btn-darken btn-disabled btn-opaque");
        this.createTeamBtn.addClass(
            canCreateTeam ? "btn-darken" : "btn-disabled btn-opaque",
        );
        this.createTeamBtn.prop("disabled", !canCreateTeam);

        const localPlayer = this.getPlayerById(this.localPlayerId);
        this.afkBtn.css(
            "display",
            this.isLeader || localPlayer?.spectator ? "none" : "block",
        );
        this.afkBtn.toggleClass("afk-active", !!localPlayer?.afk);
    }

    /**
     * Copies a shareable code/link that joins this lobby and places the
     * joiner directly into `teamId` (e.g. lobby code "ABC123" -> "ABC123-2").
     * Mirrors the lobby-wide invite copy handler wired up in the constructor.
     */
    copyTeamInviteCode(teamId: number, e: JQuery.TriggeredEvent) {
        if (!this.roomData.roomUrl) return;

        const toast = $("<div/>", {
            class: "copy-toast",
            html: "Copied!",
        });
        $("#start-menu-wrapper").append(toast);
        toast.css({
            left: (e.pageX ?? 0) - parseInt(toast.css("width")) / 2,
            top: $(e.currentTarget).offset()!.top,
        });
        toast.animate(
            {
                top: "-=20",
                opacity: 1,
            },
            {
                queue: false,
                duration: 300,
                complete: function () {
                    $(this).fadeOut(250, function () {
                        $(this).remove();
                    });
                },
            },
        );

        const roomCode = this.roomData.roomUrl.substring(1);
        const teamCode = `${roomCode}-${teamId}`;

        let codeToCopy = teamCode;
        // if running on an iframe, fall back to the bare code like the lobby-wide copy does
        if (window === window.top) {
            const url = new URL(window.location.href);
            url.search = "";
            url.hash = `${this.roomData.roomUrl}-${teamId}`;
            codeToCopy = url.toString();
        }
        helpers.copyTextToClipboard(codeToCopy);
    }

    /** Returns the full invite URL for `suffix` (e.g. "0", "s"), or the bare code when inside an iframe. */
    buildInviteUrl(suffix: string | number): string {
        const roomCode = this.roomData.roomUrl.substring(1);
        if (window !== window.top) return `${roomCode}-${suffix}`;
        const url = new URL(window.location.href);
        url.search = "";
        url.hash = `${this.roomData.roomUrl}-${suffix}`;
        return url.toString();
    }

    /** Copies a shareable spectator link (`#CODE-s`) for this lobby. */
    copySpectatorInviteCode(e: JQuery.TriggeredEvent) {
        if (!this.roomData.roomUrl) return;

        const toast = $("<div/>", { class: "copy-toast", html: "Copied!" });
        $("#start-menu-wrapper").append(toast);
        toast.css({
            left: (e.pageX ?? 0) - parseInt(toast.css("width")) / 2,
            top: $(e.currentTarget).offset()!.top,
        });
        toast.animate(
            { top: "-=20", opacity: 1 },
            {
                queue: false,
                duration: 300,
                complete: function () {
                    $(this).fadeOut(250, function () {
                        $(this).remove();
                    });
                },
            },
        );

        const roomCode = this.roomData.roomUrl.substring(1);
        let codeToCopy = `${roomCode}-s`;
        if (window === window.top) {
            const url = new URL(window.location.href);
            url.search = "";
            url.hash = `${this.roomData.roomUrl}-s`;
            codeToCopy = url.toString();
        }
        helpers.copyTextToClipboard(codeToCopy);
    }

    /** The map driving the currently selected mode, or undefined while mode lists haven't loaded yet. */
    getSelectedMapDef(): MapDef | undefined {
        const modes =
            this.siteInfo.info.modesByRegion?.[this.roomData.region] ||
            this.siteInfo.info.modes ||
            [];
        const mode = modes[this.roomData.gameModeIdx];
        if (!mode) return undefined;
        return MapDefs[mode.mapName as keyof typeof MapDefs] as MapDef;
    }

    /** Selectable arena roles for the current mode's map (e.g. ["arena1", "arena2"]); empty outside arena mode. */
    getArenaModeRoles(): string[] {
        const mapDef = this.getSelectedMapDef();
        if (!mapDef?.gameMode.arenaMode) return [];
        return mapDef.gameMode.arenaModeRoles ?? [];
    }

    /** Settings tabs that apply to the current mode. Extend this list to add more tabs in the future. */
    getSettingsTabs(): Array<{ id: string; label: string }> {
        const tabs: Array<{ id: string; label: string }> = [];
        tabs.push({
            id: "general",
            label: this.localization.translate("index-private-lobby-tab-general"),
        });
        if (this.getArenaModeRoles().length >= 2 && !this.roomData.customLoadoutEnabled) {
            tabs.push({
                id: "arenaRoles",
                label: this.localization.translate("index-private-lobby-tab-arena-roles"),
            });
        }
        if (this.roomData.advancedSettings) {
            tabs.push({
                id: "advancedSettings",
                label: this.localization.translate(
                    "index-private-lobby-tab-advanced-settings",
                ),
            });
        }
        return tabs;
    }

    /** Renders the tabbed settings box (bottom-right of the options column). Hidden entirely when no tab applies to the current mode. */
    renderSettings() {
        const tabs = this.getSettingsTabs();

        this.settingsContainer.css("display", tabs.length ? "flex" : "none");
        if (!tabs.length) return;

        if (!tabs.some((tab) => tab.id === this.activeSettingsTab)) {
            this.activeSettingsTab = tabs[0].id;
        }

        this.settingsTabs.empty();
        for (const tab of tabs) {
            const btn = $("<a/>", {
                class: `private-lobby-settings-tab${
                    tab.id === this.activeSettingsTab
                        ? " private-lobby-settings-tab-active"
                        : ""
                }`,
                html: tab.label,
            });
            btn.on("click", () => {
                if (this.activeSettingsTab === tab.id) return;
                this.activeSettingsTab = tab.id;
                this.refreshUi();
            });
            this.settingsTabs.append(btn);
        }

        this.settingsContent.empty();
        switch (this.activeSettingsTab) {
            case "general":
                this.settingsContent.append(this.renderGeneralSettingsTab());
                break;
            case "arenaRoles":
                this.settingsContent.append(this.renderArenaRolesTab());
                break;
            case "advancedSettings":
                this.settingsContent.append(this.renderAdvancedSettingsTab());
                break;
        }
    }

    /** "General" tab: lobby-wide settings the leader can toggle. */
    renderGeneralSettingsTab() {
        const wrapper = $("<div/>", { class: "private-lobby-general-settings" });
        wrapper.append(
            this.renderSettingRow(
                this.localization.translate(
                    "index-private-lobby-allow-members-join-teams",
                ),
                !!this.roomData.allowMembersJoinTeams,
                this.isLeader,
                () => {
                    this.roomData.allowMembersJoinTeams =
                        !this.roomData.allowMembersJoinTeams;
                    this.sendMessage("setRoomProps", this.roomData);
                    this.refreshUi();
                },
            ),
        );
        wrapper.append(
            this.renderSettingRow(
                this.localization.translate("index-private-lobby-limit-empty-teams"),
                this.limitEmptyTeams,
                this.isLeader,
                () => {
                    this.limitEmptyTeams = !this.limitEmptyTeams;
                    this.refreshUi();
                },
            ),
        );
        wrapper.append(
            this.renderSettingRow(
                this.localization.translate("index-private-lobby-public-spectating"),
                this.roomData.publicSpectating ?? true,
                this.isLeader,
                () => {
                    this.roomData.publicSpectating = !(
                        this.roomData.publicSpectating ?? true
                    );
                    this.sendMessage("setRoomProps", this.roomData);
                    this.refreshUi();
                },
            ),
        );
        wrapper.append(
            this.renderSettingRow(
                this.localization.translate(
                    "index-private-lobby-advanced-settings-toggle",
                ),
                !!this.roomData.advancedSettings,
                this.isLeader,
                () => {
                    this.roomData.advancedSettings = !this.roomData.advancedSettings;
                    this.sendMessage("setRoomProps", this.roomData);
                    this.refreshUi();
                },
            ),
        );
        if (this.roomData.advancedSettings) {
            wrapper.append(
                $("<div/>", {
                    class: "private-lobby-advanced-settings-warning",
                    html: this.localization.translate(
                        "index-private-lobby-advanced-settings-warning",
                    ),
                }),
            );
        }
        return wrapper;
    }

    /** Renders a single label + ON/OFF toggle row for the General settings tab. */
    renderSettingRow(
        label: string,
        enabled: boolean,
        canToggle: boolean,
        onToggle: () => void,
    ) {
        const row = $("<div/>", { class: "private-lobby-setting-row" });
        row.append($("<span/>", { class: "private-lobby-setting-label", html: label }));
        const toggle = $("<a/>", {
            class: `private-lobby-setting-toggle${enabled ? " private-lobby-setting-toggle-on" : ""}${canToggle ? "" : " private-lobby-setting-toggle-disabled"}`,
            html: enabled
                ? this.localization.translate("index-private-lobby-setting-on")
                : this.localization.translate("index-private-lobby-setting-off"),
        });
        if (canToggle) toggle.on("click", onToggle);
        row.append(toggle);
        return row;
    }

    /** "Arena Roles" tab: lets the leader narrow down which of the map's arena roles get played. */
    renderArenaRolesTab() {
        const wrapper = $("<div/>", { class: "private-lobby-arena-roles" });
        const enabled = new Set(this.roomData.enabledArenaRoles);

        for (const role of this.getArenaModeRoles()) {
            const roleDef = RoleDefs[role] as RoleDef | undefined;
            if (!roleDef) continue;

            const isEnabled = enabled.has(role);
            const card = $("<div/>", {
                class: `private-lobby-arena-role${
                    isEnabled ? " private-lobby-arena-role-enabled" : ""
                }${this.isLeader ? "" : " private-lobby-arena-role-readonly"}`,
            });
            card.append(
                $("<div/>", { class: "private-lobby-arena-role-icon" }).css({
                    "background-image": `url(${roleDef.guiImg})`,
                }),
            );
            card.append(
                $("<div/>", {
                    class: "private-lobby-arena-role-name",
                    html: this.localization.translate(`game-${role}`),
                }),
            );
            if (this.isLeader) {
                card.on("click", () => this.toggleArenaRole(role));
            }
            wrapper.append(card);
        }

        return wrapper;
    }

    /** "Advanced Settings" tab: shown only when the leader has enabled the advanced-settings toggle. Warns that matches won't earn XP. */
    renderAdvancedSettingsTab() {
        const wrapper = $("<div/>", { class: "private-lobby-advanced-settings" });
        wrapper.append(
            $("<div/>", {
                class: "private-lobby-advanced-settings-warning",
                html: this.localization.translate(
                    "index-private-lobby-advanced-settings-warning",
                ),
            }),
        );
        const update = () => {
            this.sendMessage("setRoomProps", this.roomData);
            this.refreshUi();
        };

        const customLoadoutRow = $("<div/>", { class: "private-lobby-setting-row" });
        if (this.roomData.customLoadoutEnabled) {
            this.roomData.customLoadout ??= structuredClone(DEFAULT_CUSTOM_LOADOUT);
            this.roomData.extraCustomLoadouts ??= [];
            customLoadoutRow.append(this.renderLoadoutLabel(0, update));
        } else {
            customLoadoutRow.append(
                $("<span/>", {
                    class: "private-lobby-setting-label",
                    html: this.localization.translate(
                        "index-private-lobby-custom-loadout-toggle",
                    ),
                }),
            );
        }
        const customLoadoutControls = $("<div/>", {
            class: "private-lobby-setting-row-controls",
        });
        const customLoadoutToggle = $("<a/>", {
            class: `private-lobby-setting-toggle${this.roomData.customLoadoutEnabled ? " private-lobby-setting-toggle-on" : ""}${this.isLeader ? "" : " private-lobby-setting-toggle-disabled"}`,
            html: this.roomData.customLoadoutEnabled
                ? this.localization.translate("index-private-lobby-setting-on")
                : this.localization.translate("index-private-lobby-setting-off"),
        });
        if (this.isLeader) {
            customLoadoutToggle.on("click", () => {
                this.roomData.customLoadoutEnabled = !this.roomData.customLoadoutEnabled;
                if (this.roomData.customLoadoutEnabled) {
                    this.roomData.enabledArenaRoles = [];
                    const isArenaMap = !!this.getSelectedMapDef()?.gameMode.arenaMode;
                    const loadout =
                        this.roomData.customLoadout ??
                        structuredClone(DEFAULT_CUSTOM_LOADOUT);
                    if (isArenaMap) loadout.arenaMode = true;
                    loadout.allowPickup = isArenaMap;
                    this.roomData.customLoadout = loadout;
                }
                this.sendMessage("setRoomProps", this.roomData);
                this.refreshUi();
            });
        }
        customLoadoutControls.append(customLoadoutToggle);
        if (this.roomData.customLoadoutEnabled) {
            customLoadoutControls.append(this.renderCollapseToggle(0));
        }
        customLoadoutRow.append(customLoadoutControls);
        wrapper.append(customLoadoutRow);

        if (this.roomData.customLoadoutEnabled) {
            if (!this.collapsedLoadouts.has(0)) {
                wrapper.append(
                    this.renderCustomLoadoutBuilder(this.roomData.customLoadout, update),
                );
            }

            for (let i = 0; i < this.roomData.extraCustomLoadouts.length; i++) {
                wrapper.append(this.renderExtraLoadoutSection(i + 1, update));
            }

            if (
                this.isLeader &&
                this.roomData.extraCustomLoadouts.length < MAX_EXTRA_CUSTOM_LOADOUTS
            ) {
                wrapper.append(this.renderAddLoadoutButton(update));
            }
        }

        wrapper.append(this.renderArenaModeSettings());
        return wrapper;
    }

    /** Renders the expand/collapse arrow toggling whether loadout `index`'s builder is shown. */
    renderCollapseToggle(index: number) {
        const collapsed = this.collapsedLoadouts.has(index);
        const toggle = $("<a/>", {
            class: "private-lobby-collapse-toggle",
            html: collapsed ? "&#9658;" : "&#9660;",
        });
        toggle.on("click", () => {
            if (collapsed) this.collapsedLoadouts.delete(index);
            else this.collapsedLoadouts.add(index);
            this.refreshUi();
        });
        return toggle;
    }

    /** Renders an extra loadout's header (label, collapse arrow, remove button) and, when expanded, its builder. `loadoutIndex` is 1-based (1 = `extraCustomLoadouts[0]`, "Custom Loadout 01"). */
    renderExtraLoadoutSection(loadoutIndex: number, update: () => void) {
        const wrapper = $("<div/>", { class: "private-lobby-custom-loadout" });

        const row = $("<div/>", { class: "private-lobby-setting-row" });
        row.append(this.renderLoadoutLabel(loadoutIndex, update));
        const controls = $("<div/>", { class: "private-lobby-setting-row-controls" });
        controls.append(this.renderCollapseToggle(loadoutIndex));
        if (this.isLeader) {
            const remove = $("<a/>", { class: "private-lobby-setting-remove" });
            remove.on("click", () => {
                this.roomData.extraCustomLoadouts.splice(loadoutIndex - 1, 1);
                this.collapsedLoadouts.delete(loadoutIndex);
                update();
            });
            controls.append(remove);
        }
        row.append(controls);
        wrapper.append(row);

        if (!this.collapsedLoadouts.has(loadoutIndex)) {
            wrapper.append(
                this.renderCustomLoadoutBuilder(
                    this.roomData.extraCustomLoadouts[loadoutIndex - 1],
                    update,
                ),
            );
        }
        return wrapper;
    }

    /** Renders the "+" button (leader-only) that appends a new "Custom Loadout 0N" loadout, up to MAX_EXTRA_CUSTOM_LOADOUTS extras. */
    renderAddLoadoutButton(update: () => void) {
        const row = $("<div/>", { class: "private-lobby-setting-row" });
        const btn = $("<a/>", {
            class: "private-lobby-add-loadout-btn",
            html: `+ ${this.localization.translate("index-private-lobby-custom-loadout-add")}`,
        });
        btn.on("click", () => {
            const loadouts = this.getLoadouts();
            const copy = structuredClone(
                loadouts[loadouts.length - 1] ?? DEFAULT_CUSTOM_LOADOUT,
            );
            copy.name = undefined;
            this.roomData.extraCustomLoadouts.push(copy);
            update();
        });
        row.append(btn);
        return row;
    }

    /** All configured loadouts: index 0 = `customLoadout`, 1+ = `extraCustomLoadouts`. */
    getLoadouts(): CustomLoadoutConfig[] {
        return [
            this.roomData.customLoadout,
            ...(this.roomData.extraCustomLoadouts ?? []),
        ];
    }

    /** Display label for loadout `index`: its player-given name if set, otherwise the default ("Custom Loadout"/"Custom Loadout 0N"). */
    getLoadoutLabel(index: number): string {
        return this.getLoadouts()[index]?.name || this.getDefaultLoadoutLabel(index);
    }

    /** Default label for loadout `index` (0 = "Custom Loadout", 1+ = "Custom Loadout 0N"), ignoring any player-given name. */
    getDefaultLoadoutLabel(index: number): string {
        const base = this.localization.translate(
            "index-private-lobby-custom-loadout-toggle",
        );
        return index === 0 ? base : `${base} ${String(index).padStart(2, "0")}`;
    }

    /** Renders loadout `index`'s name label. The leader can click it to rename the loadout inline. */
    renderLoadoutLabel(index: number, update: () => void) {
        if (this.isLeader && this.editingLoadoutName === index) {
            const loadout = this.getLoadouts()[index];
            const input: JQuery<HTMLInputElement> = $("<input/>", {
                type: "text",
                class: "private-lobby-setting-label-input",
                maxLength: CUSTOM_LOADOUT_NAME_MAX_LEN,
                placeholder: this.getDefaultLoadoutLabel(index),
            });
            // Use the uncommitted in-progress value if present, so a refreshUi()
            // mid-edit (e.g. a member joining a team broadcasts new state) doesn't
            // wipe what the leader is typing.
            input.val(this.editingLoadoutValue ?? loadout.name ?? "");
            const submit = () => {
                loadout.name =
                    (input.val() as string)
                        .trim()
                        .slice(0, CUSTOM_LOADOUT_NAME_MAX_LEN) || undefined;
                this.editingLoadoutName = null;
                this.editingLoadoutValue = null;
                update();
            };
            input.on("click", (e) => e.stopPropagation());
            input.on("input", () => {
                this.editingLoadoutValue = input.val() as string;
            });
            input.on("keydown", (e) => {
                if (e.which === 13) {
                    submit();
                    return false;
                }
            });
            input.on("blur", submit);
            input.trigger("focus");
            // keep the caret at the end after a re-render instead of selecting all
            const el = input[0];
            const len = el.value.length;
            el.setSelectionRange?.(len, len);
            return input;
        }

        const label = $("<span/>", {
            class: `private-lobby-setting-label${this.isLeader ? " private-lobby-setting-label-editable" : ""}`,
            html: helpers.htmlEscape(this.getLoadoutLabel(index)),
        });
        if (this.isLeader) {
            label.on("click", (e) => {
                e.stopPropagation();
                this.editingLoadoutName = index;
                this.editingLoadoutValue = null;
                this.refreshUi();
            });
        }
        return label;
    }

    /** Translates an item type id to its display name, falling back to the def's `name` field. */
    itemLabel(type: string): string {
        if (!type)
            return this.localization.translate("index-private-lobby-custom-loadout-none");
        const def = GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined;
        return this.localization.translate(`game-${type}`) || def?.name || type;
    }

    /** Loadout builder shown when "Custom Loadout" is enabled: lets the leader configure the spawn loadout for every player. */
    renderCustomLoadoutBuilder(
        loadout: CustomLoadoutConfig | undefined,
        update: () => void,
    ) {
        const wrapper = $("<div/>", { class: "private-lobby-custom-loadout" });

        // Defensive: never deref an undefined loadout (e.g. a stale index after a
        // loadout was removed) — that would throw and break the whole lobby render.
        if (!loadout) return wrapper;

        const noneOption = {
            value: "",
            label: this.localization.translate("index-private-lobby-custom-loadout-none"),
        };

        const weaponOptions = (types: string[]) => [
            noneOption,
            ...types.map((type) => ({ value: type, label: this.itemLabel(type) })),
        ];
        const itemOptions = (types: readonly string[]) =>
            types.map((type) => ({ value: type, label: this.itemLabel(type) }));

        const backpackLevel =
            parseInt((loadout.backpack || "backpack00").slice(-1), 10) || 0;

        // Selecting a gun immediately tops up its ammo type to the gun's `ammoSpawnCount`.
        const setWeapon = (slot: 0 | 1, value: string) => {
            loadout.weapons[slot] = value;
            const gunDef = value ? (GunDefs[value] as GunDef | undefined) : undefined;
            if (gunDef) {
                const ammo = gunDef.ammo as InventoryItem;
                const max = GameConfig.bagSizes[ammo][backpackLevel];
                loadout.inventory[ammo] = Math.min(gunDef.ammoSpawnCount, max);
            }
            update();
        };

        // Weapons
        wrapper.append(
            this.renderGroup("index-private-lobby-custom-loadout-group-weapons", [
                this.renderSelectRow(
                    this.localization.translate(
                        "index-private-lobby-custom-loadout-primary",
                    ),
                    weaponOptions(CUSTOM_LOADOUT_GUNS),
                    loadout.weapons[0],
                    this.isLeader,
                    (value) => setWeapon(0, value),
                ),
                this.renderSelectRow(
                    this.localization.translate(
                        "index-private-lobby-custom-loadout-secondary",
                    ),
                    weaponOptions(CUSTOM_LOADOUT_GUNS),
                    loadout.weapons[1],
                    this.isLeader,
                    (value) => setWeapon(1, value),
                ),
                this.renderSelectRow(
                    this.localization.translate(
                        "index-private-lobby-custom-loadout-melee",
                    ),
                    weaponOptions(CUSTOM_LOADOUT_MELEES),
                    loadout.weapons[2],
                    this.isLeader,
                    (value) => {
                        loadout.weapons[2] = value;
                        update();
                    },
                ),
            ]),
        );

        // Armor
        wrapper.append(
            this.renderGroup("index-private-lobby-custom-loadout-group-armor", [
                this.renderSelectRow(
                    this.localization.translate(
                        "index-private-lobby-custom-loadout-helmet",
                    ),
                    itemOptions(CUSTOM_LOADOUT_HELMETS),
                    loadout.helmet,
                    this.isLeader,
                    (value) => {
                        loadout.helmet = value;
                        update();
                    },
                ),
                this.renderSelectRow(
                    this.localization.translate(
                        "index-private-lobby-custom-loadout-chest",
                    ),
                    itemOptions(CUSTOM_LOADOUT_CHESTS),
                    loadout.chest,
                    this.isLeader,
                    (value) => {
                        loadout.chest = value;
                        update();
                    },
                ),
                this.renderSelectRow(
                    this.localization.translate(
                        "index-private-lobby-custom-loadout-backpack",
                    ),
                    itemOptions(CUSTOM_LOADOUT_BACKPACKS),
                    loadout.backpack || "backpack00",
                    this.isLeader,
                    (value) => {
                        loadout.backpack = value;
                        update();
                    },
                ),
            ]),
        );

        // Scopes
        const scopeRows: JQuery[] = [];

        // Extra scopes carried in the inventory besides 1x (which is always carried).
        const inventoryScopes = CUSTOM_LOADOUT_SCOPES.filter(
            (s) => s !== "1xscope" && loadout.inventory[s],
        );

        // Active scope can only be 1x or one of the extra scopes added below.
        const activeScopeOptions: string[] = ["1xscope", ...inventoryScopes];
        const activeScope = activeScopeOptions.includes(loadout.scope)
            ? loadout.scope
            : "1xscope";
        scopeRows.push(
            this.renderSelectRow(
                this.localization.translate("index-private-lobby-custom-loadout-scope"),
                itemOptions(activeScopeOptions),
                activeScope,
                this.isLeader,
                (value) => {
                    loadout.scope = value;
                    update();
                },
            ),
        );

        for (const scope of inventoryScopes) {
            scopeRows.push(
                this.renderRemovableRow(this.itemLabel(scope), this.isLeader, () => {
                    delete loadout.inventory[scope];
                    if (loadout.scope === scope) loadout.scope = "1xscope";
                    update();
                }),
            );
        }

        const addableScopes = CUSTOM_LOADOUT_SCOPES.filter(
            (s) => s !== "1xscope" && !loadout.inventory[s],
        );
        if (this.isLeader && addableScopes.length > 0) {
            scopeRows.push(
                this.renderSelectRow(
                    this.localization.translate(
                        "index-private-lobby-custom-loadout-add-scope",
                    ),
                    [
                        {
                            value: "",
                            label: this.localization.translate(
                                "index-private-lobby-custom-loadout-add-scope-placeholder",
                            ),
                        },
                        ...itemOptions(addableScopes),
                    ],
                    "",
                    true,
                    (value) => {
                        if (!value) return;
                        loadout.inventory[value as InventoryItem] = 1;
                        update();
                    },
                ),
            );
        }
        wrapper.append(
            this.renderGroup(
                "index-private-lobby-custom-loadout-group-scopes",
                scopeRows,
            ),
        );

        // Ammo
        const ammoRows: JQuery[] = [];
        const inventoryAmmos = CUSTOM_LOADOUT_AMMOS.filter(
            (a) => loadout.inventory[a] !== undefined,
        );
        for (const ammo of inventoryAmmos) {
            const max = GameConfig.bagSizes[ammo][backpackLevel];
            ammoRows.push(
                this.renderRemovableNumberRow(
                    this.itemLabel(ammo),
                    loadout.inventory[ammo] ?? 0,
                    0,
                    max,
                    this.isLeader,
                    (value) => {
                        loadout.inventory[ammo] = value;
                        update();
                    },
                    () => {
                        delete loadout.inventory[ammo];
                        update();
                    },
                ),
            );
        }

        const addableAmmos = CUSTOM_LOADOUT_AMMOS.filter(
            (a) => loadout.inventory[a] === undefined,
        );
        if (this.isLeader && addableAmmos.length > 0) {
            ammoRows.push(
                this.renderSelectRow(
                    this.localization.translate(
                        "index-private-lobby-custom-loadout-add-ammo",
                    ),
                    [
                        {
                            value: "",
                            label: this.localization.translate(
                                "index-private-lobby-custom-loadout-add-ammo-placeholder",
                            ),
                        },
                        ...itemOptions(addableAmmos),
                    ],
                    "",
                    true,
                    (value) => {
                        if (!value) return;
                        const ammo = value as InventoryItem;
                        loadout.inventory[ammo] =
                            GameConfig.bagSizes[ammo][backpackLevel];
                        update();
                    },
                ),
            );
        }
        wrapper.append(
            this.renderGroup("index-private-lobby-custom-loadout-group-ammo", ammoRows),
        );

        // Grenades
        const grenadeRows: JQuery[] = [];
        const inventoryGrenades = CUSTOM_LOADOUT_GRENADES.filter(
            (g) => loadout.inventory[g] !== undefined,
        );
        for (const grenade of inventoryGrenades) {
            const max = GameConfig.bagSizes[grenade][backpackLevel];
            grenadeRows.push(
                this.renderRemovableNumberRow(
                    this.itemLabel(grenade),
                    loadout.inventory[grenade] ?? 0,
                    0,
                    max,
                    this.isLeader,
                    (value) => {
                        loadout.inventory[grenade] = value;
                        update();
                    },
                    () => {
                        delete loadout.inventory[grenade];
                        update();
                    },
                ),
            );
        }

        const addableGrenades = CUSTOM_LOADOUT_GRENADES.filter(
            (g) => loadout.inventory[g] === undefined,
        );
        if (this.isLeader && addableGrenades.length > 0) {
            grenadeRows.push(
                this.renderSelectRow(
                    this.localization.translate(
                        "index-private-lobby-custom-loadout-add-grenade",
                    ),
                    [
                        {
                            value: "",
                            label: this.localization.translate(
                                "index-private-lobby-custom-loadout-add-grenade-placeholder",
                            ),
                        },
                        ...itemOptions(addableGrenades),
                    ],
                    "",
                    true,
                    (value) => {
                        if (!value) return;
                        loadout.inventory[value as InventoryItem] = 1;
                        update();
                    },
                ),
            );
        }
        wrapper.append(
            this.renderGroup(
                "index-private-lobby-custom-loadout-group-grenades",
                grenadeRows,
            ),
        );

        // Heals
        const healLabels: Record<(typeof CUSTOM_LOADOUT_HEALS)[number], string> = {
            bandage: "index-private-lobby-custom-loadout-bandages",
            healthkit: "index-private-lobby-custom-loadout-healthkits",
            soda: "index-private-lobby-custom-loadout-soda",
            painkiller: "index-private-lobby-custom-loadout-painkillers",
        };
        wrapper.append(
            this.renderGroup(
                "index-private-lobby-custom-loadout-group-heals",
                CUSTOM_LOADOUT_HEALS.map((heal) => {
                    const max = GameConfig.bagSizes[heal][backpackLevel];
                    return this.renderNumberRow(
                        this.localization.translate(healLabels[heal]),
                        loadout.inventory[heal] ?? 0,
                        0,
                        max,
                        this.isLeader,
                        (value) => {
                            loadout.inventory[heal] = value;
                            update();
                        },
                    );
                }),
            ),
        );

        // Perks
        const perkLabels = [
            "index-private-lobby-custom-loadout-perk1",
            "index-private-lobby-custom-loadout-perk2",
            "index-private-lobby-custom-loadout-perk3",
        ];
        wrapper.append(
            this.renderGroup(
                "index-private-lobby-custom-loadout-group-perks",
                perkLabels.map((labelKey, i) =>
                    this.renderSelectRow(
                        this.localization.translate(labelKey),
                        weaponOptions(CUSTOM_LOADOUT_PERKS),
                        loadout.perks[i] ?? "",
                        this.isLeader,
                        (value) => {
                            if (value) {
                                loadout.perks[i] = value;
                            } else {
                                loadout.perks.splice(i, 1);
                            }
                            // Keep perks a dense string[]: assigning to a non-contiguous
                            // slot (e.g. picking the 3rd perk while the 2nd is still
                            // empty) leaves a hole that JSON-serializes to null, fails the
                            // server's schema, disconnects the leader and corrupts their
                            // saved settings (permanently breaking lobby creation).
                            loadout.perks = loadout.perks.filter((p): p is string => !!p);
                            update();
                        },
                    ),
                ),
            ),
        );

        return wrapper;
    }

    /** Arena Mode + (when off) Unlimited Adrenaline/Ammo settings, shown below the Custom Loadout section while it's enabled. */
    renderArenaModeSettings() {
        const wrapper = $("<div/>", { class: "private-lobby-custom-loadout" });
        const loadout =
            this.roomData.customLoadout ?? structuredClone(DEFAULT_CUSTOM_LOADOUT);
        this.roomData.customLoadout = loadout;

        const update = () => {
            this.sendMessage("setRoomProps", this.roomData);
            this.refreshUi();
        };

        // Arena roles (e.g. arena1/arena2) already grant the "arena" perk
        // (unlimited ammo + adrenaline), so when they're active Arena Mode
        // is locked on and can't be toggled by the leader.
        const arenaRolesActive =
            !!this.getSelectedMapDef()?.gameMode.arenaMode &&
            !this.roomData.customLoadoutEnabled;
        const arenaModeOn = !!loadout.arenaMode || arenaRolesActive;

        wrapper.append(
            this.renderSettingRow(
                this.localization.translate(
                    "index-private-lobby-custom-loadout-arena-mode",
                ),
                arenaModeOn,
                this.isLeader && !arenaRolesActive,
                () => {
                    loadout.arenaMode = !loadout.arenaMode;
                    update();
                },
            ),
        );

        if (!arenaModeOn) {
            wrapper.append(
                this.renderSettingRow(
                    this.localization.translate(
                        "index-private-lobby-custom-loadout-unlimited-adren",
                    ),
                    !!loadout.unlimitedAdren,
                    this.isLeader,
                    () => {
                        loadout.unlimitedAdren = !loadout.unlimitedAdren;
                        update();
                    },
                ),
            );
            wrapper.append(
                this.renderSettingRow(
                    this.localization.translate(
                        "index-private-lobby-custom-loadout-unlimited-ammo",
                    ),
                    !!loadout.unlimitedAmmo,
                    this.isLeader,
                    () => {
                        loadout.unlimitedAmmo = !loadout.unlimitedAmmo;
                        update();
                    },
                ),
            );
        }

        wrapper.append(
            this.renderSettingRow(
                this.localization.translate(
                    "index-private-lobby-custom-loadout-allow-pickup",
                ),
                !!loadout.allowPickup,
                this.isLeader,
                () => {
                    loadout.allowPickup = !loadout.allowPickup;
                    update();
                },
            ),
        );

        return wrapper;
    }

    /** Renders a label + `<select>` dropdown row, used by the Custom Loadout builder. */
    renderSelectRow(
        label: string,
        options: { value: string; label: string }[],
        selected: string,
        canEdit: boolean,
        onChange: (value: string) => void,
    ) {
        const row = $("<div/>", { class: "private-lobby-setting-row" });
        row.append($("<span/>", { class: "private-lobby-setting-label", html: label }));
        const select = $("<select/>", { class: "private-lobby-setting-select" });
        if (!canEdit) select.prop("disabled", true);
        for (const opt of options) {
            select.append(
                $("<option/>", {
                    value: opt.value,
                    html: opt.label,
                    selected: opt.value === selected,
                }),
            );
        }
        if (canEdit) {
            select.on("change", () => onChange(select.val() as string));
        }
        row.append(select);
        return row;
    }

    /** Renders a label + "x" remove button row, used to list extra scopes in the Custom Loadout builder. */
    renderRemovableRow(label: string, canEdit: boolean, onRemove: () => void) {
        const row = $("<div/>", { class: "private-lobby-setting-row" });
        row.append($("<span/>", { class: "private-lobby-setting-label", html: label }));
        const remove = $("<a/>", { class: "private-lobby-setting-remove" });
        if (canEdit) remove.on("click", onRemove);
        else remove.addClass("private-lobby-setting-toggle-disabled");
        row.append(remove);
        return row;
    }

    /** Renders a label + number input row, used by the Custom Loadout builder. */
    renderNumberRow(
        label: string,
        value: number,
        min: number,
        max: number,
        canEdit: boolean,
        onChange: (value: number) => void,
    ) {
        const row = $("<div/>", { class: "private-lobby-setting-row" });
        row.append($("<span/>", { class: "private-lobby-setting-label", html: label }));
        const input = $("<input/>", {
            type: "number",
            class: "private-lobby-setting-number",
            value,
            min,
            max,
        });
        if (!canEdit) input.prop("disabled", true);
        if (canEdit) {
            input.on("change", () => {
                const parsed = Math.max(
                    min,
                    Math.min(max, Math.floor(Number(input.val())) || 0),
                );
                input.val(parsed);
                onChange(parsed);
            });
        }
        row.append(input);
        return row;
    }

    /** Renders a label + number input + "x" remove button row, used to list added grenades/inventory items in the Custom Loadout builder. */
    renderRemovableNumberRow(
        label: string,
        value: number,
        min: number,
        max: number,
        canEdit: boolean,
        onChange: (value: number) => void,
        onRemove: () => void,
    ) {
        const row = $("<div/>", { class: "private-lobby-setting-row" });
        row.append($("<span/>", { class: "private-lobby-setting-label", html: label }));
        const controls = $("<div/>", { class: "private-lobby-setting-row-controls" });
        const input = $("<input/>", {
            type: "number",
            class: "private-lobby-setting-number",
            value,
            min,
            max,
        });
        if (!canEdit) input.prop("disabled", true);
        if (canEdit) {
            input.on("change", () => {
                const parsed = Math.max(
                    min,
                    Math.min(max, Math.floor(Number(input.val())) || 0),
                );
                input.val(parsed);
                onChange(parsed);
            });
        }
        controls.append(input);
        const remove = $("<a/>", { class: "private-lobby-setting-remove" });
        if (canEdit) remove.on("click", onRemove);
        else remove.addClass("private-lobby-setting-toggle-disabled");
        controls.append(remove);
        row.append(controls);
        return row;
    }

    /** Wraps a set of Custom Loadout rows in a titled group for visual separation. */
    renderGroup(titleKey: string, rows: JQuery[]) {
        const group = $("<div/>", { class: "private-lobby-loadout-group" });
        group.append(
            $("<div/>", {
                class: "private-lobby-loadout-group-title",
                html: this.localization.translate(titleKey),
            }),
        );
        for (const row of rows) group.append(row);
        return group;
    }

    /** Leader-only: toggles whether `role` is part of the match's arena role pool. At least one role must stay enabled. */
    toggleArenaRole(role: string) {
        if (!this.isLeader) return;

        const enabled = (this.roomData.enabledArenaRoles ?? []).slice();
        const idx = enabled.indexOf(role);
        if (idx >= 0) {
            if (enabled.length <= 1) return;
            enabled.splice(idx, 1);
        } else {
            enabled.push(role);
        }
        this.roomData.enabledArenaRoles = enabled;
        this.sendMessage("setRoomProps", this.roomData);
    }

    refreshUi() {
        const setButtonState = function (
            el: JQuery<HTMLElement>,
            selected: boolean,
            enabled: boolean,
        ) {
            el.removeClass("btn-darken btn-disabled btn-opaque btn-hollow-selected");
            if (enabled) {
                el.addClass("btn-darken");
            } else {
                el.addClass("btn-disabled");
                if (!selected) {
                    el.addClass("btn-opaque");
                }
            }
            if (selected) {
                el.addClass("btn-hollow-selected");
            }
            el.prop("disabled", !enabled);
        };
        $("#private-lobby-menu").css("display", this.active ? "block" : "none");
        $("#start-menu").css("display", this.active ? "none" : "block");
        $("#right-column").css("display", this.active ? "none" : "block");
        $("#left-column").css("display", this.active ? "none" : "block");
        $("#start-row-header").css("display", this.active ? "none" : "block");
        $("#social-share-block").css("display", this.active ? "none" : "block");

        // Error text
        const hasError = this.roomData.lastError != "";
        const errorTxt = errorTypeToString(this.roomData.lastError, this.localization);
        this.serverWarning.css("opacity", hasError ? 1 : 0);
        this.serverWarning.html(errorTxt);

        if (
            this.roomData.lastError == "find_game_invalid_protocol" &&
            !this.displayedInvalidProtocolModal
        ) {
            $("#modal-refresh").fadeIn(200);
            this.displayedInvalidProtocolModal = true;
        }

        // Show/hide lobby connecting/contents
        if (this.active) {
            $("#private-lobby-menu-joining-text").css(
                "display",
                this.create ? "none" : "block",
            );
            $("#private-lobby-menu-creating-text").css(
                "display",
                this.create ? "block" : "none",
            );
            $("#private-lobby-menu-connecting").css(
                "display",
                this.joined ? "none" : "block",
            );
            $("#private-lobby-menu-contents").css(
                "display",
                this.joined ? "block" : "none",
            );
            $("#btn-private-lobby-leave").css("display", this.joined ? "block" : "none");
        }

        if (this.joined) {
            // Region: geo-group dropdown + category tabs (mirrors the main menu)
            this.siteInfo.updateGroupCounts($("#private-lobby-server-opts"));
            this.siteInfo.renderRegionGroupTabs(
                this.serverSelect,
                this.categoryTabs,
                this.roomData.region,
                this.isLeader,
            );
            this.serverSelect.prop("disabled", !this.isLeader);

            // Mode buttons - lobbies allow any enabled mode (including Solo),
            // so they're built dynamically instead of the fixed Duo/Squad pair teams use
            const modeStyles = this.siteInfo.getGameModeStyles(this.roomData.region);
            this.modesContainer.empty();
            for (const idx of this.roomData.enabledGameModeIdxs) {
                const style = modeStyles[idx];
                if (!style) continue;
                const btn = $("<a/>", {
                    class: "btn-hollow btn-hollow-selected btn-darken team-menu-option btn-team-queue",
                    html: this.localization.translate(`index-play-${style.buttonText}`),
                });
                if (style.icon) {
                    btn.addClass("btn-custom-mode-select");
                    btn.css({ "background-image": `url(${style.icon})` });
                }
                setButtonState(btn, this.roomData.gameModeIdx == idx, this.isLeader);
                btn.on("click", () => {
                    this.setRoomProperty("gameModeIdx", idx);
                });
                this.modesContainer.append(btn);
            }

            // Invite link
            if (this.roomData.roomUrl) {
                const roomCode = this.roomData.roomUrl.substring(1);
                $("#private-lobby-code").text(roomCode);

                if (SDK.supportsInviteLink()) {
                    SDK.getInviteLink(roomCode).then((sdkUrl) => {
                        $("#private-lobby-url").text(sdkUrl!);
                    });
                } else {
                    const url = new URL(window.location.href);
                    url.search = "";
                    url.hash = this.roomData.roomUrl;

                    $("#private-lobby-url").text(url.toString());

                    if (window.history) {
                        window.history.replaceState("", "", this.roomData.roomUrl);
                    }
                }
            }

            // Play button
            this.playBtn.html(
                this.roomData.findingGame || this.joiningGame
                    ? '<div class="ui-spinner"></div>'
                    : this.playBtn.attr("data-label")!,
            );

            for (let i = 0; i < modeStyles.length; i++) {
                this.playBtn.removeClass(modeStyles[i].buttonCss);
            }
            const style = modeStyles[this.roomData.gameModeIdx];
            if (style) {
                this.playBtn.addClass("btn-custom-mode-no-indent");
                this.playBtn.addClass(style.buttonCss);
                this.playBtn.css({
                    "background-image": `url(${style.icon})`,
                });
            } else {
                this.playBtn.css({
                    "background-image": "",
                });
            }
            let playersInGame = false;
            for (let i = 0; i < this.players.length; i++) {
                playersInGame = playersInGame || this.players[i].inGame;
            }

            const waitReason = $("#msg-private-lobby-wait-reason");

            if (this.isLeader) {
                waitReason.html(
                    `${this.localization.translate(
                        "index-game-in-progress",
                    )}<span> ...</span>`,
                );

                const showWaitMessage = playersInGame && !this.joiningGame;
                waitReason.css("display", "none");
                this.stopGameBtn.css("display", showWaitMessage ? "block" : "none");

                // Auto-reset if no more AFK players while dialog is open
                if (this.afkConfirmPending && !this.players.some((p) => p.afk)) {
                    this.afkConfirmPending = false;
                }

                const showAfkConfirm = this.afkConfirmPending && !showWaitMessage;
                if (showAfkConfirm) {
                    const afkNames = this.players
                        .filter((p) => p.afk)
                        .map((p) => helpers.htmlEscape(p.name))
                        .join(", ");
                    this.afkConfirmContainer
                        .find("#private-lobby-afk-confirm-text")
                        .html(
                            `${afkNames} ${this.localization.translate("index-private-lobby-afk-warning")}`,
                        );
                }
                this.afkConfirmContainer.css(
                    "display",
                    showAfkConfirm ? "block" : "none",
                );
                this.playBtn.css(
                    "display",
                    showWaitMessage || showAfkConfirm ? "none" : "block",
                );
            } else {
                this.afkConfirmContainer.css("display", "none");
                this.stopGameBtn.css("display", "none");
                if (this.roomData.findingGame || this.joiningGame) {
                    waitReason.html(
                        `<div class="ui-spinner" style="margin-right:16px"></div>${this.localization.translate(
                            "index-joining-game",
                        )}<span> ...</span>`,
                    );
                } else if (playersInGame) {
                    waitReason.html(
                        `${this.localization.translate(
                            "index-game-in-progress",
                        )}<span> ...</span>`,
                    );
                } else {
                    waitReason.html(
                        `${this.localization.translate(
                            "index-waiting-for-leader",
                        )}<span> ...</span>`,
                    );
                }
                waitReason.css("display", "block");
                this.playBtn.css("display", "none");
            }

            this.renderTeamGrid();
            this.renderSettings();

            // Play a sound if player count has increased
            const localPlayer = this.players.find((player) => {
                return player.playerId == this.localPlayerId;
            });
            const playJoinSound = localPlayer && !localPlayer.inGame;
            if (
                !document.hasFocus() &&
                this.prevPlayerCount < this.players.length &&
                this.players.length > 1 &&
                playJoinSound
            ) {
                this.audioManager.playSound("notification_join_01", {
                    channel: "ui",
                });
            }
            this.prevPlayerCount = this.players.length;
        }
    }
}
