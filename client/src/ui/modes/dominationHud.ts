import $ from "jquery";
import * as PIXI from "pixi.js-legacy";
import { DOMINATION_RESPAWN_DELAY_S, DOMINATION_WARMUP_RESPAWN_DELAY_S, DOMINATION_ZONES } from "../../../../shared/defs/modes/dominationDefs";
import { GameObjectDefs } from "../../../../shared/defs/register";
import { ArenaLoadoutAction } from "../../../../shared/net/arenaLoadoutSelectMsg";
import { ModePhase, type ModeZone } from "../../../../shared/net/modeStandingsMsg";
import { type Vec2, v2 } from "../../../../shared/utils/v2";
import type { Camera } from "../../camera";
import { helpers } from "../../helpers";
import { ARENA_STREAKS } from "../../../../shared/defs/modes/arenaStreakDefs";
import { arenaIconOf } from "../arenaMenu";
import type { Renderer } from "../../renderer";

/** A dashed circle: `dashes` arcs with gaps between them. */
function dashedCircle(g: PIXI.Graphics, x: number, y: number, r: number, dashes = 16) {
    const step = (Math.PI * 2) / dashes;
    for (let i = 0; i < dashes; i++) {
        const a0 = i * step;
        const a1 = a0 + step * 0.55;
        g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
        g.arc(x, y, r, a0, a1);
    }
}

/** What an underground zone says it is (map, minimap, the ground above it). */
const UNDERGROUND_TAG = "▼ UNDERGROUND";

/** Seen from the player: neutral, own team, enemy (as in other team shooters). */
const NEUTRAL = 0xd8d8d8;
const OWN = 0x3d8bff;
const ENEMY = 0xe0433a;
const css = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
const SLOT_LABELS = ["Gun 1", "Gun 2", "Throwable", "Perk"];
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
    /** the underground zones (the bunker / basement layer) */
    private worldUnder = new PIXI.Container();
    /** per zone: its area and letter on its own layer, and (underground zones) a dashed
     *  marker on the ground above so players up there see it's below them */
    private worldZones: Array<{ gfx: PIXI.Graphics; label: PIXI.Text; ghost: PIXI.Graphics; ghostLabel: PIXI.Text }> = [];
    /** the zones on the minimap: the circles and their letters */
    minimap = new PIXI.Container();
    private minimapGfx = new PIXI.Graphics();
    private minimapLabels: PIXI.Text[] = [];
    /** "▼ UNDERGROUND" under an underground zone's letter */
    private minimapTags: PIXI.Text[] = [];

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
        // the player's loadouts, 4 types each (two guns, throwable, perk)
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
        renderer.addPIXIObj(this.worldUnder, 1, 5);
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
        this.worldUnder.destroy({ children: true });
        this.minimap.destroy({ children: true });
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
        // (the warmup: a short one - see DOMINATION_WARMUP_RESPAWN_DELAY_S)
        const delay = this.phase === ModePhase.Running ? DOMINATION_RESPAWN_DELAY_S : DOMINATION_WARMUP_RESPAWN_DELAY_S;
        this.respawnUntil = performance.now() + delay * 1000;
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
                $("<div/>", { class: "dom-menu-option-icon" }).css("background-image", `url(${arenaIconOf(types.find((t) => !!t) ?? "")})`),
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
                    $("<div/>", { class: "dom-menu-item-icon" }).css("background-image", type ? `url(${arenaIconOf(type)})` : "none"),
                    $("<div/>", { class: "dom-menu-item-name", text: type ? nameOf(type) : "Empty" }),
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
            const ghost = new PIXI.Graphics();
            const ghostLabel = new PIXI.Text(`${DOMINATION_ZONES[this.worldZones.length]?.name ?? "?"}\n${UNDERGROUND_TAG}`, {
                fontFamily: "Arial",
                fontSize: 40,
                fontWeight: "bold",
                fill: 0xffffff,
                align: "center",
                stroke: 0x000000,
                strokeThickness: 6,
            });
            ghostLabel.anchor.set(0.5, 0.5);
            this.world.addChild(gfx, label, ghost, ghostLabel);
            this.worldZones.push({ gfx, label, ghost, ghostLabel });
        }
        // (stairs: layer 2 ground side, 3 underground side)
        const localLayer = local.layer & 1;
        this.world.visible = local.layer === 0;
        this.worldUnder.visible = localLayer === 1;
        // screen pixels per world unit (m_pixels is the zoom only)
        const px = camera.m_scaleToScreen(1);
        this.minimapGfx.clear();
        if (!this.minimapGfx.parent) this.minimap.addChild(this.minimapGfx);
        while (this.minimapLabels.length < this.zones.length) {
            const text = new PIXI.Text(DOMINATION_ZONES[this.minimapLabels.length]?.name ?? "?", {
                fontFamily: "Arial",
                fontSize: 32,
                fontWeight: "bold",
                fill: 0xffffff,
                stroke: 0x000000,
                strokeThickness: 5,
            });
            text.anchor.set(0.5, 0.5);
            const tag = new PIXI.Text(UNDERGROUND_TAG, {
                fontFamily: "Arial",
                fontSize: 32,
                fontWeight: "bold",
                fill: 0xffffff,
                stroke: 0x000000,
                strokeThickness: 6,
            });
            tag.anchor.set(0.5, 0);
            this.minimap.addChild(text, tag);
            this.minimapLabels.push(text);
            this.minimapTags.push(tag);
        }
        this.minimapLabels.forEach((t, i) => (t.visible = i < this.zones.length));
        this.minimapTags.forEach((t, i) => (t.visible = i < this.zones.length && this.zones[i].layer === 1));
        let status = "";
        const now = performance.now();
        const ease = Math.min(1, ((now - this.lastRender) / 1000) * 12);
        this.lastRender = now;
        this.zones.forEach((z, i) => {
            const { gfx, label, ghost, ghostLabel } = this.worldZones[i];
            const under = z.layer === 1;
            const color = this.colorOf(z.owner);
            // on its own layer (an underground zone only shows underground)
            const parent = z.layer === 1 ? this.worldUnder : this.world;
            if (gfx.parent !== parent) parent.addChild(gfx, label);
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
            // on the ground above an underground zone: a dashed ring and "B ▼ UNDERGROUND"
            ghost.clear();
            ghost.visible = ghostLabel.visible = under;
            if (under) {
                ghost.position.set(screen.x, screen.y);
                ghost.lineStyle(Math.max(3, px * 0.3), color, 0.9);
                dashedCircle(ghost, 0, 0, r, 20);
                ghostLabel.position.set(screen.x, screen.y);
                ghostLabel.scale.set((px * 2.2) / 40);
                ghostLabel.tint = color;
            }

            const m = minimapPos(z.pos);
            const mr = Math.max(4, z.rad * minimapScale);
            if (under) {
                // underground: a dark disc with a dashed ring in the zone's color
                this.minimapGfx.lineStyle(0);
                this.minimapGfx.beginFill(0x15181c, 0.9);
                this.minimapGfx.drawCircle(m.x, m.y, mr);
                this.minimapGfx.endFill();
                this.minimapGfx.lineStyle(Math.max(2, mr * 0.25), color, 1);
                dashedCircle(this.minimapGfx, m.x, m.y, mr, 12);
            } else {
                // on the ground: a solid disc in the zone's color
                this.minimapGfx.beginFill(color, 0.85);
                this.minimapGfx.lineStyle(1.5, 0x000000, 0.6);
                this.minimapGfx.drawCircle(m.x, m.y, mr);
                this.minimapGfx.endFill();
            }
            // its letter in the middle (underground: in the zone's color on the dark disc)
            const letter = this.minimapLabels[i];
            letter.position.set(m.x, m.y);
            letter.scale.set(Math.max(11, mr * 1.1) / 32);
            letter.tint = under ? color : 0xffffff;
            const tag = this.minimapTags[i];
            tag.visible = under;
            tag.position.set(m.x, m.y + mr + 2);
            tag.scale.set(Math.max(8, mr * 0.45) / 32);
            // the capture progress on the map too: a ring in the taking team's color
            if (taking) {
                this.minimapGfx.lineStyle(Math.max(2, mr * 0.35), this.colorOf(taking), 1);
                this.minimapGfx.arc(m.x, m.y, mr + Math.max(1.5, mr * 0.2), -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
            }

            // where the local player stands
            // (only in the match - the warmup takes nothing)
            // right above an underground zone: it doesn't count up here
            if (
                this.phase === ModePhase.Running && !dead && under && local.layer === 0
                && v2.distance(local.pos, z.pos) <= z.rad && !status
            ) {
                status = `Zone ${DOMINATION_ZONES[i]?.name ?? "?"} is underground - take the stairs down`;
            }
            if (this.phase === ModePhase.Running && !dead && local.layer === z.layer && v2.distance(local.pos, z.pos) <= z.rad) {
                const mine = this.myTeamId();
                const name = `${DOMINATION_ZONES[i]?.name ?? "?"}${z.layer === 1 ? " (underground)" : ""}`;
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
