import $ from "jquery";
import * as PIXI from "pixi.js-legacy";
import { DOMINATION_RESPAWN_DELAY_S, DOMINATION_ZONES } from "../../../../shared/defs/modes/dominationDefs";
import { GameObjectDefs } from "../../../../shared/defs/register";
import { ArenaLoadoutAction } from "../../../../shared/net/arenaLoadoutSelectMsg";
import { ModePhase, type ModeZone } from "../../../../shared/net/modeStandingsMsg";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
import type { Camera } from "../../camera";
import { helpers } from "../../helpers";
import { ARENA_STREAKS } from "../../../../shared/defs/modes/arenaStreakDefs";
import { arenaIconOf } from "../arenaMenu";
import type { Renderer } from "../../renderer";

/** Seen from the player: neutral, own team, enemy (as in other team shooters). */
const NEUTRAL = 0xd8d8d8;
const OWN = 0x3d8bff;
const ENEMY = 0xe0433a;
const css = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
const SLOT_LABELS = ["Main gun", "Pistol", "Throwable", "Perk"];
const nameOf = (type: string) => (GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined)?.name ?? type;

/**
 * Domination in the client: the score bar with A / B / C at the top (own team blue,
 * enemy red), the zones on the ground and on the minimap, a status line while standing
 * in one - and the loadout menu (like the arena's class select): open on joining, and
 * from the "Change loadout" button while dead.
 */
export class DominationHud {
    private root = $("<div/>", { id: "ui-domination", class: "js-ui-map-hidden" });
    private scoreEls: JQuery<HTMLElement>[] = [];
    /** the team scores, where the "Alive" counter is otherwise (top right) */
    private scoreBox = $("<div/>", { id: "ui-leaderboard-domination" });
    private aliveHeader = $("#ui-leaderboard .ui-leaderboard-header");
    private aliveHeaderHtml = "";
    private statusEl = $("<div/>", { class: "dom-status" });
    /** the kill streak: kills in a row, the bonus ready to fire (its key), the one running */
    private streakEl = $("<div/>", { class: "dom-streak" });
    private streakKills = 0;
    private streakReady = "";
    private streakActive: string[] = [];
    private streakKeyShown = "";
    /** the next tier (index in ARENA_STREAKS), -1: none left */
    private streakNext = 0;
    /** while dead: "SPECTATING <name>" and the time to the respawn */
    private spectateEl = $("<div/>", { id: "ui-dom-spectate" });
    private spectateKey = "";
    /** the game's own "Spectating <name>" (top center) is shown by this HUD right now */
    private showsSpectateText = false;
    private menu = $("<div/>", { id: "ui-dom-loadout-wrapper" });
    /** the loadout menu is open (instead of asking the DOM every frame) */
    private menuOpen = false;
    private changeBtnShown = false;
    /** what the score bar shows: own team, the team ids, the scores (see renderBar) */
    private barShown = [-1, -1, -1, -1, -1];
    /** the match is over (see onGameOver) */
    private over = false;
    private changeBtn = $("<div/>", { id: "ui-dom-change-loadout", text: "Change loadout" });
    private world = new PIXI.Container();
    private worldZones: Array<{ gfx: PIXI.Graphics; label: PIXI.Text }> = [];
    minimap = new PIXI.Graphics();

    private zones: ModeZone[] = [];
    /** the progress drawn per zone - eased towards the last sent one, so the ring moves smoothly */
    private shownProgress: number[] = [];
    private lastRender = performance.now();
    private teamIds: number[] = [];
    private teamScores: number[] = [];
    private phase = ModePhase.Waiting;
    private loadouts: string[][] = [];
    private picked = 0;
    private respawnUntil = 0;
    private statusKey = "";

    constructor(
        renderer: Renderer,
        loadoutTypes: string[],
        private onPick: (slot: number, action: ArenaLoadoutAction) => void,
        /** the local player's team (a spectator: the watched player's) */
        private myTeamId: () => number,
        /** joined as a spectator: only the scores and zones - no loadout menu, no
         *  respawn overlay, no kill streak (the game's own spectate UI does the rest) */
        private spectator = false,
    ) {
        // the player's loadouts, 4 types each (main gun, pistol, throwable, perk)
        if (!spectator) for (let i = 0; i < loadoutTypes.length; i += 4) this.loadouts.push(loadoutTypes.slice(i, i + 4));

        // the team scores (own blue, enemy red) take the "Alive" counter's place - the
        // zones are on the map itself
        this.scoreEls = [OWN, ENEMY].map((c) => $("<div/>", { class: "dom-score", css: { color: css(c) }, text: "0" }));
        this.scoreBox.append(...this.scoreEls);
        $("#ui-leaderboard").addClass("dom-active").prepend(this.scoreBox);
        this.aliveHeaderHtml = this.aliveHeader.html();
        this.aliveHeader.text("Score");
        this.root.append(this.spectateEl.hide());
        // the zone status right above the ammo counter (bottom center; moves with it)
        $("#ui-equipped-ammo-wrapper").prepend(this.statusEl);
        // the kill streak: a fixed spot right of the gas timer (the HUD editor moves it)
        $("#hud-wrap-killstreak").append(this.streakEl);
        this.renderStreak();
        // under the scope row; the wrapper is in the HUD editor ("Domination Status")
        $("#hud-wrap-domination").append(this.root);

        // the menu and its button sit on the body: clickable whatever the game UI does
        for (const el of [this.menu, this.changeBtn]) {
            el.on("mousedown pointerdown touchstart", (e) => e.stopPropagation());
        }
        this.changeBtn
            .on("click", () => {
                // stay dead (and in the menu) until "Enter game"
                this.onPick(this.picked, ArenaLoadoutAction.Hold);
                this.openMenu();
            })
            .hide();
        $(document.body).append(this.menu, this.changeBtn);
        this.menu.hide();
        // pick one before the first spawn counts (the server swaps it in right away)
        console.info(`Domination: ${this.loadouts.length} arena loadout(s) from the server`);
        if (this.loadouts.length) this.openMenu();

        renderer.addPIXIObj(this.world, 0, 5);
    }

    /** The game's own spectate line (#ui-spectate-text) - without its spectate menu. */
    private setSpectateText(name: string) {
        const text = $("#ui-spectate-text");
        if (name) {
            text.find("#spectate-player").text(name);
            text.css("display", "block");
            this.showsSpectateText = true;
        } else if (this.showsSpectateText) {
            text.css("display", "");
            this.showsSpectateText = false;
        }
    }

    destroy() {
        // the shared "Spectating <name>" back to the game's own handling, whatever was shown
        this.showsSpectateText = true;
        this.setSpectateText("");
        this.spectateEl.remove();
        // the "Alive" counter back for other games
        this.scoreBox.remove();
        this.statusEl.remove();
        this.streakEl.remove();
        $("#ui-leaderboard").removeClass("dom-active");
        this.aliveHeader.html(this.aliveHeaderHtml);
        this.root.remove();
        this.menu.remove();
        this.changeBtn.remove();
        this.world.destroy({ children: true });
        this.minimap.destroy();
    }

    /** own team / enemy / neutral for a teamId */
    private colorOf(teamId: number): number {
        if (!teamId) return NEUTRAL;
        return teamId === this.myTeamId() ? OWN : ENEMY;
    }

    /** KillstreakMsg */
    setStreak(kills: number, ready: string, active: string[], next: number) {
        this.streakNext = next;
        this.streakKills = kills;
        this.streakReady = ready;
        this.streakActive = active;
        this.renderStreak();
    }

    private renderStreak() {
        const tierOf = (item: string) => ARENA_STREAKS.find((t) => t.options.includes(item));
        // (the server knows which tiers this player switched off)
        const next = this.streakNext >= 0 ? ARENA_STREAKS[this.streakNext] : undefined;
        this.streakEl.empty();
        // the earned one, with its key
        if (this.streakReady) {
            this.streakEl.append(
                $("<div/>", { class: "dom-streak-row dom-streak-ready-row" }).append(
                    $("<div/>", { class: "dom-streak-icon" }).css("background-image", `url(${arenaIconOf(this.streakReady)})`),
                    $("<div/>", { class: "dom-streak-text" }).append(
                        $("<span/>", { class: "dom-streak-key", text: this.streakKeyShown || "?" }),
                        $("<span/>", { text: ` ${tierOf(this.streakReady)?.name ?? ""}` }),
                    ),
                ),
            );
        }
        // the ones running
        for (const item of this.streakActive) {
            this.streakEl.append(
                $("<div/>", { class: "dom-streak-row" }).append(
                    $("<div/>", { class: "dom-streak-icon dom-streak-icon-small" }).css("background-image", `url(${arenaIconOf(item)})`),
                    $("<div/>", { class: "dom-streak-active", text: `${tierOf(item)?.name ?? ""} active` }),
                ),
            );
        }
        // how far to the next tier
        if (next) {
            this.streakEl.append(
                $("<div/>", { class: "dom-streak-next", text: `Streak ${this.streakKills}/${next.kills} · ${next.name}` }),
            );
        }
        // there from the join on (the warmup too) - only the game over hides it
        this.streakEl.css("display", this.over || this.spectator ? "none" : "flex");
        this.streakEl.toggleClass("dom-streak-ready", !!this.streakReady);
    }

    /** ModeStandingsMsg */
    setStandings(phase: ModePhase, teamIds: number[], teamScores: number[], scoreLimit: number, zones: ModeZone[]) {
        const phaseChanged = this.phase !== phase;
        this.phase = phase;
        this.zones = zones;
        if (phaseChanged) this.renderStreak();
        this.teamIds = teamIds;
        this.teamScores = teamScores;
    }

    private renderBar() {
        const mine = this.myTeamId();
        const [a = 0, b = 0] = this.teamScores;
        const [ta = 0, tb = 0] = this.teamIds;
        const last = this.barShown;
        if (last[0] === mine && last[1] === ta && last[2] === tb && last[3] === a && last[4] === b) return;
        last[0] = mine;
        last[1] = ta;
        last[2] = tb;
        last[3] = a;
        last[4] = b;
        const ownIdx = Math.max(0, this.teamIds.indexOf(mine));
        this.scoreEls[0].text(String(this.teamScores[ownIdx] ?? 0));
        this.scoreEls[1].text(String(this.teamScores[1 - ownIdx] ?? 0));
    }

    /** The local player died: the button to the loadout menu until the respawn. */
    onLocalDeath() {
        if (this.over || this.spectator) return;
        this.respawnUntil = performance.now() + DOMINATION_RESPAWN_DELAY_S * 1000;
    }

    /**
     * The match is over (GameOverMsg): the loadout menu, the respawn overlay, the
     * kill streak box go away - nothing may sit over the game over screen.
     */
    onGameOver() {
        this.over = true;
        this.respawnUntil = 0;
        this.closeMenu();
        this.changeBtn.hide();
        this.changeBtnShown = false;
        this.spectateEl.empty().hide();
        this.spectateKey = "";
        this.setSpectateText("");
        this.streakEl.hide();
    }

    // ── the loadout menu ────────────────────────────────────────────────────

    private openMenu() {
        if (this.over) return;
        this.renderMenu();
        this.menu.show();
        this.menuOpen = true;
    }

    private closeMenu() {
        this.menu.hide();
        this.menuOpen = false;
    }

    private renderMenu() {
        this.menu.empty();
        const panel = $("<div/>", { id: "ui-dom-loadout-menu" });
        const header = $("<div/>", { class: "dom-menu-header" });
        this.loadouts.forEach((types, slot) => {
            const opt = $("<div/>", { class: `dom-menu-option${slot === this.picked ? " dom-menu-option-picked" : ""}` }).append(
                $("<div/>", { class: "dom-menu-option-icon" }).css("background-image", `url(${arenaIconOf(types[0])})`),
                $("<div/>", { class: "dom-menu-option-name", text: `Loadout ${slot + 1}` }),
            );
            opt.on("click", () => {
                if (this.picked === slot) return;
                this.picked = slot;
                this.onPick(slot, ArenaLoadoutAction.Pick);
                this.renderMenu();
            });
            header.append(opt);
        });

        const body = $("<div/>", { class: "dom-menu-body" });
        (this.loadouts[this.picked] ?? []).forEach((type, i) => {
            body.append(
                $("<div/>", { class: "dom-menu-item" }).append(
                    $("<div/>", { class: "dom-menu-item-label", text: SLOT_LABELS[i] ?? "" }),
                    $("<div/>", { class: "dom-menu-item-icon" }).css("background-image", `url(${arenaIconOf(type)})`),
                    $("<div/>", { class: "dom-menu-item-name", text: nameOf(type) }),
                ),
            );
        });

        const footer = $("<div/>", { class: "dom-menu-footer" }).append(
            $("<div/>", { class: "dom-menu-footer-desc", text: "SELECT A LOADOUT" }),
            $("<div/>", { class: "dom-menu-footer-enter", text: "ENTER GAME" }).on("click", () => {
                // out of the menu: spawn (once the respawn time is over)
                this.onPick(this.picked, ArenaLoadoutAction.Deploy);
                this.closeMenu();
            }),
        );
        panel.append(header, body, footer);
        this.menu.append(panel);
    }

    // ── every frame ─────────────────────────────────────────────────────────

    /** The zones in the world and on the minimap, the status line, the menu button. */
    render(
        camera: Camera,
        local: {
            pos: Vec2;
            layer: number;
            watchingOther: boolean;
            watchingName: string;
            /** knocked (and no Revivify): the key that gives up, for the hint */
            giveUpKey?: string;
            /** the kill streak key */
            streakKey?: string;
        },
        minimapPos: (pos: Vec2) => Vec2,
        minimapScale: number,
    ) {
        // the menu stays open until "Enter game" (the server holds the respawn back meanwhile)
        // (every frame: no DOM reads - `:visible` forces a layout - and DOM writes only on a change)
        const dead = !this.over && !this.spectator && (this.respawnUntil > performance.now() || local.watchingOther);
        const showBtn = dead && this.loadouts.length > 0 && !this.menuOpen;
        if (showBtn !== this.changeBtnShown) {
            this.changeBtnShown = showBtn;
            this.changeBtn.toggle(showBtn);
        }

        // dead: whom you watch, and when you're back
        const left = Math.ceil((this.respawnUntil - performance.now()) / 1000);
        const spectateKey = dead
            ? `${local.watchingName}|${left > 0 ? left : this.menuOpen ? "menu" : "soon"}`
            : "";
        if (spectateKey !== this.spectateKey) {
            this.spectateKey = spectateKey;
            this.spectateEl.empty().toggle(dead);
            // whom you watch: the game's usual "Spectating <name>" at the top
            this.setSpectateText(dead && local.watchingName ? local.watchingName : "");
            if (dead) {
                this.spectateEl.append(
                    $("<div/>", {
                        class: "dom-spectate-timer",
                        text: left > 0
                            ? `Respawn in ${left}s`
                            : this.menuOpen
                              ? "Respawn when you press ENTER GAME"
                              : "Respawning...",
                    }),
                );
            }
        }
        if (!dead) this.respawnUntil = 0;

        while (this.worldZones.length < this.zones.length) {
            const gfx = new PIXI.Graphics();
            const label = new PIXI.Text(DOMINATION_ZONES[this.worldZones.length]?.name ?? "?", {
                fontFamily: "Arial",
                fontSize: 64,
                fontWeight: "bold",
                fill: 0xffffff,
            });
            label.anchor.set(0.5, 0.5);
            label.alpha = 0.55;
            this.world.addChild(gfx, label);
            this.worldZones.push({ gfx, label });
        }
        this.world.visible = local.layer === 0;
        // screen pixels per world unit (m_pixels is the zoom only)
        const px = camera.m_scaleToScreen(1);
        this.minimap.clear();
        let status = "";
        const now = performance.now();
        const ease = Math.min(1, ((now - this.lastRender) / 1000) * 12);
        this.lastRender = now;
        this.zones.forEach((z, i) => {
            const { gfx, label } = this.worldZones[i];
            const color = this.colorOf(z.owner);
            // (a jump - taken, neutral, the other team - is drawn right away)
            const shown = this.shownProgress[i];
            const progress = shown === undefined || Math.abs(z.progress - shown) > 0.3
                ? z.progress
                : shown + (z.progress - shown) * ease;
            this.shownProgress[i] = progress;
            const screen = camera.m_pointToScreen(z.pos);
            const r = z.rad * px;
            gfx.clear();
            gfx.position.set(screen.x, screen.y);
            // the area that counts: a filled disc with a clear edge
            gfx.beginFill(color, 0.16);
            gfx.lineStyle(Math.max(3, px * 0.25), color, z.contested ? 1 : 0.85);
            gfx.drawCircle(0, 0, r);
            gfx.endFill();
            // a capture in progress: a ring in the taking team's color
            const taking = z.capTeam || (z.owner && z.progress < 1 ? z.owner : 0);
            if (taking) {
                gfx.lineStyle(Math.max(6, px * 0.5), this.colorOf(taking), 0.95);
                gfx.arc(0, 0, r - Math.max(4, px * 0.4), -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
            }
            label.position.set(screen.x, screen.y);
            label.scale.set((px * 5) / 64);
            label.tint = color;

            const m = minimapPos(z.pos);
            this.minimap.beginFill(color, 0.85);
            this.minimap.lineStyle(1.5, 0x000000, 0.6);
            const mr = Math.max(4, z.rad * minimapScale);
            this.minimap.drawCircle(m.x, m.y, mr);
            this.minimap.endFill();
            // the capture progress on the map too: a ring in the taking team's color
            if (taking) {
                this.minimap.lineStyle(Math.max(2, mr * 0.35), this.colorOf(taking), 1);
                this.minimap.arc(m.x, m.y, mr + Math.max(1.5, mr * 0.2), -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
            }

            // where the local player stands
            // (only in the match - the warmup takes nothing)
            if (this.phase === ModePhase.Running && !local.watchingOther && local.layer === 0 && v2.distance(local.pos, z.pos) <= z.rad) {
                const mine = this.myTeamId();
                const name = DOMINATION_ZONES[i]?.name ?? "?";
                if (z.contested) status = `Zone ${name}: contested`;
                else if (z.owner === mine && z.progress >= 1) status = `Zone ${name}: holding${z.mult > 1 ? ` · ${z.mult}x points` : ""}`;
                else if (z.owner && z.owner !== mine) status = `Zone ${name}: neutralizing ${Math.round((1 - z.progress) * 100)}%`;
                else status = `Zone ${name}: capturing ${Math.round(z.progress * 100)}%`;
            }
        });
        if (this.streakKeyShown !== (local.streakKey ?? "")) {
            this.streakKeyShown = local.streakKey ?? "";
            this.renderStreak();
        }
        // knocked: how to give up (and respawn right away)
        if (local.giveUpKey) status = `Knocked · press ${local.giveUpKey} to give up`;
        if (status !== this.statusKey) {
            this.statusKey = status;
            this.statusEl.text(status).toggle(!!status);
        }
        this.renderBar();
    }
}
