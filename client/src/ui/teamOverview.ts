import $ from "jquery";
import { GameObjectDefs } from "../../../shared/defs/register";
import type { TeamInfoPlayer } from "../../../shared/net/net";
import { TEAM_INFO_HEALS, TEAM_INFO_SCOPES } from "../../../shared/net/net";
import { helpers } from "../helpers";
import type { PlayerBarn } from "../objects/player";
import { healthBarRgb } from "./ui2";

/** Narrowest free strip left of the big map the panel still fits into. */
const MIN_PANEL_WIDTH = 190;

/** The HUD editor's wrapper (static in index.html, so HudLayoutManager can find it):
 *  the editor owns its transform/opacity/visibility, this file only its `display`. */
const WRAPPER_ID = "hud-wrap-teamOverview";
const INNER_ID = "ui-team-overview";

const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function defName(type: string): string {
    return (GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined)?.name ?? type;
}

function level(type: string): number {
    return (GameObjectDefs.typeToDefSafe(type) as { level?: number } | undefined)?.level ?? 0;
}

function icon(type: string, label: string, extra = "", cls = ""): string {
    if (!type) return `<div class="ui-to-slot ui-to-empty" title="${esc(label)}: none"></div>`;
    const src = helpers.getSvgFromGameType(type);
    return `<div class="ui-to-slot${cls}" title="${esc(defName(type))}"><img src="${esc(src)}" alt="">${extra}</div>`;
}

export interface TeamOverviewEntry {
    player: TeamInfoPlayer;
    name: string;
    /** css colour of the teammate's dot */
    color: string;
}

/** The panel's markup for these teammates (shared by the game and the HUD editor preview). */
export function teamOverviewHtml(mates: TeamOverviewEntry[]): string {
    return (
        `<div class="ui-to-title">Team</div>` +
        mates
            .map(({ player: p, name, color }) => {
                const state = p.disconnected
                    ? `<span class="ui-to-state">DC</span>`
                    : p.dead
                      ? `<span class="ui-to-state">DEAD</span>`
                      : p.downed
                        ? `<span class="ui-to-state ui-to-down">DOWN</span>`
                        : "";
                const inactive = p.dead || p.disconnected;
                const hp = Math.round(p.health);
                // same colours (and low-health pulse) as the own health bar
                const [r, g, b] = healthBarRgb(p.health, p.downed);
                const hpClass = p.health <= 25 ? " ui-to-danger" : "";

                const weapons = p.weapons
                    .map((w, i) => {
                        const def = GameObjectDefs.typeToDefSafe(w.type) as { type?: string } | undefined;
                        // rounds in the gun; a throwable slot holds no count (that lives in the inventory)
                        const ammo = def?.type === "gun" ? `<span>${w.ammo}</span>` : "";
                        return icon(w.type, ["Primary", "Secondary", "Melee", "Throwable"][i], ammo);
                    })
                    .join("");
                const gearLevel = (type: string) => (type ? `<span>${level(type) || ""}</span>` : "");
                // the best scope they carry, in the armor row
                const bestScope = [...TEAM_INFO_SCOPES].reverse().find((s) => p.scopes.includes(s)) ?? "1xscope";
                const gear =
                    icon(p.helmet, "Helmet", gearLevel(p.helmet)) +
                    icon(p.chest, "Vest", gearLevel(p.chest)) +
                    icon(p.backpack, "Backpack", gearLevel(p.backpack)) +
                    icon(bestScope, "Scope");
                // always all four, "0" (dimmed) when they have none
                const heals = TEAM_INFO_HEALS.map((h) =>
                    icon(h, defName(h), `<span>${p[h]}</span>`, p[h] > 0 ? "" : " ui-to-none"),
                ).join("");

                return `<div class="ui-to-player${inactive ? " inactive" : ""}">
                    <div class="ui-to-head"><i style="background:${color}"></i><b>${esc(name)}</b>${state}</div>
                    ${inactive ? "" : `
                    <div class="ui-to-bar" title="Health"><div class="ui-to-hp${hpClass}" style="width:${hp}%;background:rgb(${r},${g},${b})"></div><span>${hp}</span></div>
                    <div class="ui-to-bar ui-to-boostbar" title="Adrenaline"><div class="ui-to-boost" style="width:${Math.round(p.boost)}%"></div></div>
                    <div class="ui-to-row">${weapons}</div>
                    <div class="ui-to-row">${gear}</div>
                    <div class="ui-to-row">${heals}</div>`}
                </div>`;
            })
            .join("")
    );
}

/** Shrinks the panel to fit under the screen's bottom edge (a full squad can be taller). */
function fitToScreen() {
    const wrapper = document.getElementById(WRAPPER_ID);
    const inner = document.getElementById(INNER_ID);
    if (!wrapper || !inner) return;
    inner.style.transform = "";
    const avail = window.innerHeight - 12 - wrapper.getBoundingClientRect().top;
    const height = inner.scrollHeight;
    if (height > avail && avail > 0) inner.style.transform = `scale(${avail / height})`;
}

const previewPlayer = (over: Partial<TeamInfoPlayer>): TeamInfoPlayer => ({
    playerId: 0,
    dead: false,
    downed: false,
    disconnected: false,
    health: 100,
    boost: 0,
    weapons: [
        { type: "mosin", ammo: 5 },
        { type: "mp5", ammo: 30 },
        { type: "fists", ammo: 0 },
        { type: "frag", ammo: 0 },
    ],
    scope: "4xscope",
    scopes: ["1xscope", "2xscope", "4xscope"],
    helmet: "helmet02",
    chest: "chest02",
    backpack: "backpack02",
    bandage: 10,
    healthkit: 1,
    soda: 3,
    painkiller: 0,
    ...over,
});

/** HUD editor: fills the panel with example teammates so it can be placed without a
 *  game / open big map. Returns false when the real panel is already showing. */
export function showTeamOverviewPreview(): boolean {
    const wrapper = document.getElementById(WRAPPER_ID);
    const inner = document.getElementById(INNER_ID);
    if (!wrapper || !inner || wrapper.style.display === "block") return false;
    inner.innerHTML = teamOverviewHtml([
        { player: previewPlayer({ health: 82, boost: 45 }), name: "Alpha", color: "#ffff00" },
        { player: previewPlayer({ health: 18, downed: false, soda: 0, scope: "2xscope", scopes: ["1xscope", "2xscope"] }), name: "Bravo", color: "#ff00ff" },
    ]);
    wrapper.style.display = "block";
    wrapper.dataset.preview = "1";
    fitToScreen();
    return true;
}

export function hideTeamOverviewPreview() {
    const wrapper = document.getElementById(WRAPPER_ID);
    const inner = document.getElementById(INNER_ID);
    if (!wrapper || !inner || wrapper.dataset.preview !== "1") return;
    delete wrapper.dataset.preview;
    inner.innerHTML = "";
    wrapper.style.display = "none";
}

/**
 * The teammate overview on the left of the big map (G): health, adrenaline, weapons,
 * gear and healing items of every teammate. The data comes from the server's
 * TeamInfoMsg - the client knows nothing but teammates' health otherwise. Position,
 * size, opacity and on/off come from the HUD editor ("Team Overview").
 */
export class TeamOverview {
    private players: TeamInfoPlayer[] = [];
    private mapOpen = false;

    setData(players: TeamInfoPlayer[], playerBarn: PlayerBarn, activeId: number) {
        this.players = players;
        this.render(playerBarn, activeId);
    }

    setMapOpen(open: boolean, playerBarn: PlayerBarn, activeId: number) {
        this.mapOpen = open;
        this.render(playerBarn, activeId);
    }

    render(playerBarn: PlayerBarn, activeId: number) {
        const wrapper = document.getElementById(WRAPPER_ID);
        const inner = document.getElementById(INNER_ID);
        if (!wrapper || !inner) return;
        // the HUD editor's example content gives way to the real thing
        delete wrapper.dataset.preview;

        const mates = this.players.filter((p) => p.playerId !== activeId);
        const freeWidth = (window.innerWidth - Math.min(window.innerWidth, window.innerHeight)) / 2;
        const show = this.mapOpen && mates.length > 0 && freeWidth >= MIN_PANEL_WIDTH;
        wrapper.style.display = show ? "block" : "none";
        // the top-left team list (names + health) says the same - hide it, and the
        // corner readouts, so the panel doesn't sit on top of them (unless the player
        // turned the panel off in the HUD editor)
        $("#ui-game").toggleClass("team-overview-open", show && wrapper.style.visibility !== "hidden");
        if (!show) return;
        inner.style.maxWidth = `${Math.min(300, freeWidth - 24)}px`;

        inner.innerHTML = teamOverviewHtml(
            mates.map((p) => ({
                player: p,
                name: playerBarn.getPlayerInfo(p.playerId)
                    ? playerBarn.getPlayerName(p.playerId, activeId, false)
                    : "Teammate",
                color: `#${playerBarn.getGroupColor(p.playerId).toString(16).padStart(6, "0")}`,
            })),
        );
        fitToScreen();
    }

    free() {
        $("#ui-game").removeClass("team-overview-open");
        const wrapper = document.getElementById(WRAPPER_ID);
        const inner = document.getElementById(INNER_ID);
        if (inner) inner.innerHTML = "";
        if (wrapper) wrapper.style.display = "none";
    }
}
