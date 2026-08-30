import { type ConfigManager, HUD_ELEMENT_DEFAULTS, type HudElementConfig } from "../config";

/** One customizable HUD element: a stable id, the CSS id of its `.hud-drag-wrapper`
 *  (see client/css/game.css), a settings-panel label, and whether it has a click
 *  action worth offering a "disable clicking" toggle for (see Stage 6). */
export interface HudElementDef {
    id: string;
    wrapperId: string;
    label: string;
    hasClickAction: boolean;
    /** Overrides HUD_ELEMENT_DEFAULTS.visible for this element specifically - used by
     *  the Stage 9 counters (FPS/ping/HP/adrenaline numerics), which are new additions
     *  to players' HUDs and so should be opt-in rather than suddenly appearing for
     *  everyone, unlike every pre-existing element above (which stay on by default so
     *  this feature landing doesn't change anyone's HUD unless they touch it). */
    defaultVisible?: boolean;
    /** A transform this element's own base CSS already relies on (e.g. `translateX(-50%)`
     *  for horizontal centering) - prepended to every transform HudLayoutManager sets on
     *  this wrapper (see `elementTransform`), instead of the usual approach of avoiding
     *  the conflict entirely by targeting a different element, for the rare case (like
     *  the ammo counter) where every candidate descendant is itself load-bearing for
     *  some OTHER absolutely-positioned descendant's offset (see the ammoCounter entry
     *  below and #ui-reload-button-container in index.html for the specific case that
     *  forced this). */
    baseTransform?: string;
    /** True for an element whose `display` is ALSO driven by other, live game-state
     *  code - e.g. the spectator bar's `.ui-spectate-mode` CSS defaults to
     *  `display:none` and is only shown by an inline `display:"block"` real spectate
     *  logic sets while actually spectating. HudLayoutManager's usual "visible ? clear
     *  the inline override : display:none" approach assumes clearing the override
     *  reveals a SHOWN state - for these elements it instead reveals that same
     *  `display:none` default, stomping the other code's override the next time
     *  ANY HUD setting changes (not just this element's), which is exactly what made
     *  the whole spectate panel vanish after touching an unrelated HUD toggle. For
     *  these elements, applyElementStyles() uses `visibility` instead of `display` to
     *  represent the user's own hide/show choice, so `display` is left entirely to
     *  whatever other code already owns it. */
    usesExternalDisplayGate?: boolean;
}

/**
 * Registry of every HUD element the player can drag/hide/fade (and, where
 * `hasClickAction`, disable clicking on). `wrapperId` is either an existing container
 * that turned out to have no conflicting CSS/JS of its own (reused directly - e.g.
 * `ui-weapon-container`), or a purpose-built `hud-wrap-*` div inserted around content
 * that didn't already have a safe single container (see the "Core design note" on
 * conflicts: several existing containers carry their own responsive `transform`/
 * `opacity`/`display` rules or JS-driven toggles, which a naive reuse would clobber -
 * each entry below was individually checked against client/css/game.css and the
 * relevant *.ts before picking its target).
 */
export const HUD_ELEMENTS: HudElementDef[] = [
    { id: "healthBar", wrapperId: "hud-wrap-healthBar", label: "Health Bar", hasClickAction: false },
    { id: "boostBar", wrapperId: "hud-wrap-boostBar", label: "Boost Bar", hasClickAction: false },
    { id: "weaponSlots", wrapperId: "ui-weapon-container", label: "Weapon Slots", hasClickAction: true },
    { id: "scopeRow", wrapperId: "ui-top-center-scopes", label: "Scope Row", hasClickAction: true },
    { id: "lootRow", wrapperId: "hud-wrap-lootRow", label: "Heal/Boost/Ammo Row", hasClickAction: true },
    {
        id: "ammoCounter",
        wrapperId: "ui-equipped-ammo-wrapper",
        label: "Ammo Counter",
        hasClickAction: false,
        baseTransform: "translateX(-50%)",
    },
    { id: "gearRow", wrapperId: "hud-wrap-gearRow", label: "Gear Row", hasClickAction: true },
    { id: "perkRow", wrapperId: "hud-wrap-perkRow", label: "Perk Row", hasClickAction: true },
    { id: "minimap", wrapperId: "ui-map-wrapper", label: "Minimap", hasClickAction: false },
    { id: "killfeed", wrapperId: "ui-killfeed", label: "Killfeed", hasClickAction: false },
    { id: "killLeader", wrapperId: "hud-wrap-killLeader", label: "Kill Leader Banner", hasClickAction: false },
    {
        id: "spectatorBar",
        wrapperId: "ui-spectate-options",
        label: "Spectator Bar",
        hasClickAction: false,
        usesExternalDisplayGate: true,
    },
    { id: "teamHealthBars", wrapperId: "ui-team", label: "Team Health Bars", hasClickAction: false },
    { id: "aliveCount", wrapperId: "ui-leaderboard", label: "Alive Count", hasClickAction: false },
    { id: "fpsCounter", wrapperId: "hud-wrap-fpsCounter", label: "FPS Counter", hasClickAction: false, defaultVisible: false },
    { id: "pingCounter", wrapperId: "hud-wrap-pingCounter", label: "Ping Counter", hasClickAction: false, defaultVisible: false },
    { id: "hpNumeric", wrapperId: "hud-wrap-hpNumeric", label: "HP Number", hasClickAction: false, defaultVisible: false },
    { id: "adrenalineNumeric", wrapperId: "hud-wrap-adrenalineNumeric", label: "Adrenaline Number", hasClickAction: false, defaultVisible: false },
];

/**
 * Owns the player-configurable HUD layout: per-element drag offset, opacity,
 * visibility, and (for clickable elements) whether clicking is enabled. Reads/writes
 * `ConfigManager`'s `hudLayout` record and applies it to each element's
 * `.hud-drag-wrapper` DOM node via `transform`/`opacity`/`display` - properties
 * gameplay code never touches on that OUTER wrapper (it targets the elements nested
 * inside it), so the two can never stomp each other. See the "Core design note" in the
 * project plan for why a wrapper, not the element itself, owns these three properties.
 */
export class HudLayoutManager {
    /** Whether "Edit HUD Layout" is currently on - only while true do the wrappers
     *  accept pointer events for dragging (see setupDragging) and show the dashed
     *  outline (see the `body.hud-edit-mode` CSS in game.css). Off by default so
     *  normal gameplay clicking/click-through is never affected. */
    editModeActive = false;

    /** Whether the player is currently "thrown into a game preview" from the pre-game
     *  Settings modal - i.e. #game-area-wrapper (normally display:none outside a match,
     *  which no descendant CSS can override) is forced visible with a plain green
     *  backdrop standing in for terrain, its 3 non-HUD siblings (touch controls,
     *  role-menu overlays) are suppressed, and the real #ui-game-menu (the in-game ESC
     *  menu) is force-opened straight to its HUD tab - the exact same tab/list/buttons
     *  used mid-match, just reached without a live game. #btn-game-resume/#btn-game-quit
     *  normally only get click handlers from UiManager (which only exists once a real
     *  Game is running) - see setupUi for the preview-only listeners added here that
     *  make those buttons exit the preview back to the main menu instead. Never touches
     *  main.ts's `this.active`/setAppActive - that has unrelated side effects (input
     *  binding, network state, etc.) this feature has no business triggering. */
    previewModeActive = false;

    /** Live-drag hook for the "minimap" element specifically - its actual terrain is a
     *  PIXI sprite positioned by ui.ts#redraw's own math (see the comment there), which
     *  reads from persisted config, not an in-progress drag. UiManager sets this in its
     *  constructor (so it exists only while a real Game/UiManager is around) to repaint
     *  the sprite/border/mask at the live (dx, dy) on every pointermove, and back at
     *  `null` once the drag ends and the real config catches up. No-op the rest of the
     *  time (nothing sets it pre-game or for any other element). */
    onMinimapDrag: ((live: { dx: number; dy: number } | null) => void) | null = null;

    constructor(public config: ConfigManager) {
        // Initial load fires this with no key (see ConfigManager#load), and any later
        // change to `hudLayout`/`hudGlobalScale`/`hudGlobalOpacity` (e.g. a live drag, a
        // resize, or a reset) re-fires it - all should reapply every element's styles.
        this.config.addModifiedListener((key) => {
            if (!key || key === "hudLayout" || key === "hudGlobalScale" || key === "hudGlobalOpacity") {
                this.applyElementStyles();
                // The minimap's actual terrain is a PIXI sprite, not read from CSS at
                // all (see onMinimapDrag/redraw in ui.ts) - applyElementStyles() alone
                // only moves its DOM icon chrome, so any committed change (a drag
                // ending, a reset, a slider edit) needs this too, or the sprite/border/
                // mask silently keep showing the OLD position/size forever. `null`
                // means "no live override, read the just-committed config" - same as
                // what happens naturally when a live drag ends.
                this.onMinimapDrag?.(null);
            }
        });
        this.setupDragging();
        this.setupResizing();
        this.setupUi();
    }

    private getGlobalScale(): number {
        return this.config.get("hudGlobalScale") ?? 1;
    }

    private getGlobalOpacity(): number {
        return this.config.get("hudGlobalOpacity") ?? 1;
    }

    private elementTransform(dx: number, dy: number, scale: number, baseTransform?: string): string {
        const parts: string[] = [];
        if (baseTransform) parts.push(baseTransform);
        if (dx || dy) parts.push(`translate(${dx}px, ${dy}px)`);
        if (scale !== 1) parts.push(`scale(${scale})`);
        return parts.join(" ");
    }

    /** Attaches (once, for the lifetime of the page) drag-to-reposition pointer
     *  handlers to every registered wrapper. Gated on `editModeActive` inside the
     *  handlers themselves (checked live) rather than by attaching/detaching listeners,
     *  same pattern as the click-disable guards in ui2.ts/ui.ts. `pointer-events` on
     *  these wrappers is normally `none` (several sit under `.click-through` ancestors
     *  so gameplay clicks reach the canvas) - the `body.hud-edit-mode` CSS forces it
     *  back to `auto` only while editing, so dragging never steals clicks otherwise. */
    private setupDragging() {
        for (const def of HUD_ELEMENTS) {
            const el = document.getElementById(def.wrapperId);
            if (!el) continue;

            let dragging = false;
            let startX = 0;
            let startY = 0;
            let startDx = 0;
            let startDy = 0;
            let dragScale = 1;

            el.addEventListener("pointerdown", (e) => {
                if (!this.editModeActive) return;
                e.preventDefault();
                e.stopPropagation();
                dragging = true;
                startX = e.clientX;
                startY = e.clientY;
                const cfg = this.getElementConfig(def.id);
                startDx = cfg.dx;
                startDy = cfg.dy;
                dragScale = cfg.scale * this.getGlobalScale();
                el.setPointerCapture(e.pointerId);
            });
            el.addEventListener("pointermove", (e) => {
                if (!dragging) return;
                // Live-set the transform directly (not via updateElementConfig, which
                // would write to localStorage on every pixel of movement) - the final
                // position is persisted once, on release. Scale is carried through
                // unchanged (frozen at drag start) so dragging never visually resets it.
                const dx = startDx + (e.clientX - startX);
                const dy = startDy + (e.clientY - startY);
                el.style.transform = this.elementTransform(dx, dy, dragScale, def.baseTransform);
                if (def.id === "minimap") this.onMinimapDrag?.({ dx, dy });
            });
            const endDrag = (e: PointerEvent) => {
                if (!dragging) return;
                dragging = false;
                const dx = startDx + (e.clientX - startX);
                const dy = startDy + (e.clientY - startY);
                this.updateElementConfig(def.id, { dx, dy });
                if (def.id === "minimap") this.onMinimapDrag?.(null);
            };
            el.addEventListener("pointerup", endDrag);
            el.addEventListener("pointercancel", endDrag);
        }
    }

    /** Attaches a small corner handle to every registered wrapper for resizing (see
     *  `HudElementConfig.scale`) - same always-attached/gated-on-`editModeActive`
     *  pattern as setupDragging, and same reason (attaching/detaching per edit-mode
     *  toggle would be more moving parts for no benefit). The handle itself is only
     *  ever visible/interactive via the `body.hud-edit-mode .hud-resize-handle` CSS
     *  rule in game.css, same as the dashed drag outline. */
    private setupResizing() {
        for (const def of HUD_ELEMENTS) {
            const el = document.getElementById(def.wrapperId);
            if (!el) continue;

            const handle = document.createElement("div");
            handle.className = "hud-resize-handle";
            el.appendChild(handle);

            let resizing = false;
            let startX = 0;
            let startY = 0;
            let startScale = 1;
            let frozenDx = 0;
            let frozenDy = 0;

            handle.addEventListener("pointerdown", (e) => {
                if (!this.editModeActive) return;
                e.preventDefault();
                // Stop this from also bubbling up into the wrapper's own pointerdown
                // drag handler (setupDragging) - resizing and dragging are mutually
                // exclusive per gesture.
                e.stopPropagation();
                resizing = true;
                startX = e.clientX;
                startY = e.clientY;
                const cfg = this.getElementConfig(def.id);
                startScale = cfg.scale;
                frozenDx = cfg.dx;
                frozenDy = cfg.dy;
                handle.setPointerCapture(e.pointerId);
            });
            handle.addEventListener("pointermove", (e) => {
                if (!resizing) return;
                e.stopPropagation();
                // Diagonal drag distance from the corner handle, converted to a scale
                // delta (100px of diagonal movement ~= 1.0x scale) and clamped to a
                // sane 0.3x-3x range.
                const diagonal = ((e.clientX - startX) + (e.clientY - startY)) / 2;
                const scale = Math.min(3, Math.max(0.3, startScale + diagonal / 100));
                el.style.transform = this.elementTransform(frozenDx, frozenDy, scale * this.getGlobalScale(), def.baseTransform);
            });
            const endResize = (e: PointerEvent) => {
                if (!resizing) return;
                resizing = false;
                e.stopPropagation();
                const diagonal = ((e.clientX - startX) + (e.clientY - startY)) / 2;
                const scale = Math.min(3, Math.max(0.3, startScale + diagonal / 100));
                this.updateElementConfig(def.id, { scale });
            };
            handle.addEventListener("pointerup", endResize);
            handle.addEventListener("pointercancel", endResize);
        }
    }

    /** Wires the in-game menu's HUD tab: the edit-mode toggle, the reset-all button,
     *  and the initial settings-list render. The tab's markup (#ui-game-tab-hud) is
     *  static page HTML, so this can run once here rather than needing a per-game
     *  hook - see ui.ts#setCurrentGameTab for the one thing that DOES need a per-open
     *  hook (refreshing the panel's displayed values when the tab is selected). */
    private setupUi() {
        const toggleBtn = document.getElementById("btn-hud-edit-toggle");
        toggleBtn?.addEventListener("click", () => this.setEditMode(!this.editModeActive));

        const resetBtn = document.getElementById("btn-hud-reset-all");
        resetBtn?.addEventListener("click", () => {
            this.resetAll();
            this.renderSettingsPanel();
        });

        // Global Scale/Opacity sliders are no longer static page HTML - they're built
        // fresh (with their own listeners) by renderSettingsPanel(), as the first two
        // rows inside #ui-hud-settings-list, so they scroll along with the rest of the
        // list instead of being fixed rows that keep needing the panel's overall height
        // re-tuned every time one is added (see the #ui-game-tab-hud CSS comment).

        // #btn-hud-preview-toggle (the pre-game Settings modal's HUD tab button) is
        // wired in menu.ts instead of here, since entering the preview also needs to
        // hide the Settings modal itself (via its MenuModal instance, which lives
        // there) - this class has no reference to it and has no business reaching into
        // menu.ts's module state to get one.

        // #btn-game-resume/#btn-game-quit only get their real click handlers from
        // UiManager, which is only constructed for a live Game - these listeners exist
        // for the entire lifetime of the page but no-op unless a preview is open, so
        // they never fire alongside (or instead of) the real in-match handlers.
        document.getElementById("btn-game-resume")?.addEventListener("click", () => {
            if (this.previewModeActive) this.setPreviewMode(false);
        });
        document.getElementById("btn-game-quit")?.addEventListener("click", () => {
            if (this.previewModeActive) this.setPreviewMode(false);
        });

        this.renderSettingsPanel();
    }

    setEditMode(active: boolean) {
        this.editModeActive = active;
        document.body.classList.toggle("hud-edit-mode", active);
        const btn = document.getElementById("btn-hud-edit-toggle");
        if (btn) btn.textContent = active ? "Done Editing" : "Edit HUD Layout";
    }

    /** Enters/exits the "thrown into a game preview" mode (see `previewModeActive`
     *  doc). Entering reveals #game-area-wrapper with a green backdrop, hides its 3
     *  non-HUD siblings, fills the health/boost bars with placeholder values (they're
     *  otherwise blank - no match is running to compute real ones), force-opens
     *  #ui-game-menu straight to its HUD tab, and turns on edit mode so wrappers are
     *  immediately draggable. Exiting reverses all of it, dropping the player back at
     *  whatever's normally behind the (still-hidden) game area - the main menu. Safe to
     *  call redundantly (e.g. from the Settings modal's onHide, as a safety net). */
    setPreviewMode(active: boolean) {
        if (active === this.previewModeActive) return;
        this.previewModeActive = active;
        document.body.classList.toggle("hud-preview-mode", active);

        // #game-area-wrapper itself is deliberately NOT touched via inline style here:
        // main.ts#refreshUi runs constantly (on nearly every menu/config change) and
        // unconditionally sets `display`/`opacity` inline on this same element based on
        // `this.active`, which would silently re-hide the preview moments after opening
        // it. The `body.hud-preview-mode #game-area-wrapper` CSS rule uses `!important`
        // specifically so it keeps winning over refreshUi's plain inline styles no
        // matter how many times refreshUi fires while previewing.
        for (const id of ["game-touch-area", "ui-role-menu-wrapper", "ui-arena-role-menu-wrapper"]) {
            const el = document.getElementById(id);
            if (el) el.style.display = active ? "none" : "";
        }

        const escMenu = document.getElementById("ui-game-menu");
        if (escMenu) escMenu.style.display = active ? "block" : "none";

        if (active) {
            this.applyPreviewPlaceholders();
            this.showInGameHudTab();
        } else {
            this.clearPreviewPlaceholders();
        }
        this.setEditMode(active);
    }

    /** Replicates ui.ts#setCurrentGameTab("hud")'s DOM effect (show the HUD pane,
     *  select its tab button) without going through UiManager, which doesn't exist
     *  without a live Game. Same `.ui-game-tab`/`.btn-game-tab-select` classes and
     *  `#ui-game-tab-{tab}`/`#btn-game-{tab}` id convention as the real switcher. */
    private showInGameHudTab() {
        document.querySelectorAll<HTMLElement>(".ui-game-tab").forEach((el) => {
            el.style.display = "none";
        });
        document.querySelectorAll(".btn-game-tab-select").forEach((el) => {
            el.classList.remove("btn-game-menu-selected");
        });
        const pane = document.getElementById("ui-game-tab-hud");
        if (pane) pane.style.display = "block";
        document.getElementById("btn-game-hud")?.classList.add("btn-game-menu-selected");
        this.renderSettingsPanel();
    }

    private static readonly PREVIEW_TEAMMATE_NAMES = ["Alpha", "Bravo", "Charlie"];
    private static readonly PREVIEW_KILLFEED_LINES = [
        "Alpha killed Charlie with M870",
        "Bravo killed Delta with Mosin-Nagant",
        "You killed Foxtrot with Bowie",
    ];
    private static readonly PREVIEW_LOOT_COUNTS: Record<string, string> = {
        "ui-loot-bandage": "5",
        "ui-loot-healthkit": "1",
        "ui-loot-soda": "2",
        "ui-loot-painkiller": "1",
    };

    /** Fills in placeholder values for HUD elements that are normally only ever
     *  populated by ui2.ts once a match is running, so the preview isn't just empty
     *  bars, and force-reveals elements gated behind a CSS class that only real
     *  in-match JS ever clears (kill-leader banner has no such gate - it already ships
     *  with static "Waiting for new leader" text, no placeholder needed). */
    private applyPreviewPlaceholders() {
        const healthActual = document.getElementById("ui-health-actual");
        if (healthActual) healthActual.style.width = "100%";
        for (let i = 0; i < 4; i++) {
            const seg = document.getElementById(`ui-boost-counter-${i}`)?.firstElementChild as HTMLElement | null;
            if (seg) seg.style.width = "100%";
        }
        // #ui-spectate-options carries the `.ui-spectate-mode` class, which is
        // `display:none` by default and only ever cleared by real spectate-mode JS -
        // without a live game that JS never runs, so it'd otherwise never appear here.
        const spectatorBar = document.getElementById("ui-spectate-options");
        if (spectatorBar) spectatorBar.style.display = "block";

        // #ui-leaderboard-alive is display:none by default (ui2.ts picks solo-count vs.
        // faction-split display depending on team mode) - force it on with a placeholder
        // count so the Alive Count element isn't just an empty box here.
        const leaderboardAlive = document.getElementById("ui-leaderboard-alive");
        if (leaderboardAlive) leaderboardAlive.style.display = "block";
        const aliveCount = document.querySelector("#ui-leaderboard-alive .js-ui-players-alive");
        if (aliveCount) aliveCount.textContent = "83";

        // Fake teammates: each .ui-team-member row is display:none until real team-sync
        // JS reveals it - revealing a few here also demonstrates the FPS/Ping counters'
        // default position (right after #ui-team in document flow, see game.css) with
        // an actual roster above them instead of the empty/solo case.
        document.querySelectorAll<HTMLElement>("#ui-team .ui-team-member").forEach((member, i) => {
            const name = HudLayoutManager.PREVIEW_TEAMMATE_NAMES[i];
            if (!name) return;
            member.style.display = "block";
            const nameEl = member.querySelector<HTMLElement>(".ui-team-member-name");
            if (nameEl) nameEl.textContent = name;
            const healthEl = member.querySelector<HTMLElement>(".ui-health-actual");
            if (healthEl) healthEl.style.width = "100%";
        });

        // Fake killfeed lines - real ones are built by ui2.ts's UiManager constructor
        // (#ui-killfeed-${i}.killfeed-div > .killfeed-text), which doesn't exist without
        // a live Game, so #ui-killfeed-contents would otherwise stay empty here.
        const killfeedContents = document.getElementById("ui-killfeed-contents");
        if (killfeedContents) {
            HudLayoutManager.PREVIEW_KILLFEED_LINES.forEach((text, i) => {
                const line = document.createElement("div");
                line.className = "killfeed-div hud-preview-fake-killfeed-line";
                line.style.top = `${i * 26}px`;
                const textEl = document.createElement("div");
                textEl.className = "killfeed-text";
                textEl.textContent = text;
                line.appendChild(textEl);
                killfeedContents.appendChild(line);
            });
        }

        // Fake ammo counter and medical/adrenaline loot counts - both already show
        // static "0" defaults, swapped for more demonstrative example values here.
        const currentClip = document.getElementById("ui-current-clip");
        if (currentClip) currentClip.textContent = "30";
        const remainingAmmo = document.getElementById("ui-remaining-ammo");
        if (remainingAmmo) remainingAmmo.textContent = "90";
        for (const [id, count] of Object.entries(HudLayoutManager.PREVIEW_LOOT_COUNTS)) {
            const countEl = document.getElementById(id)?.querySelector(".ui-loot-count");
            if (countEl) countEl.textContent = count;
        }
    }

    /** Undoes applyPreviewPlaceholders on exit, so stale inline styles/fake content
     *  aren't left behind for ui2.ts to inherit from if a real game starts right after. */
    private clearPreviewPlaceholders() {
        const healthActual = document.getElementById("ui-health-actual");
        if (healthActual) healthActual.style.width = "";
        for (let i = 0; i < 4; i++) {
            const seg = document.getElementById(`ui-boost-counter-${i}`)?.firstElementChild as HTMLElement | null;
            if (seg) seg.style.width = "";
        }
        const spectatorBar = document.getElementById("ui-spectate-options");
        if (spectatorBar) spectatorBar.style.display = "";

        const leaderboardAlive = document.getElementById("ui-leaderboard-alive");
        if (leaderboardAlive) leaderboardAlive.style.display = "";
        const aliveCount = document.querySelector("#ui-leaderboard-alive .js-ui-players-alive");
        if (aliveCount) aliveCount.textContent = "0";

        document.querySelectorAll<HTMLElement>("#ui-team .ui-team-member").forEach((member) => {
            member.style.display = "";
            const nameEl = member.querySelector<HTMLElement>(".ui-team-member-name");
            if (nameEl) nameEl.textContent = "";
            const healthEl = member.querySelector<HTMLElement>(".ui-health-actual");
            if (healthEl) healthEl.style.width = "";
        });

        document.querySelectorAll(".hud-preview-fake-killfeed-line").forEach((el) => el.remove());

        const currentClip = document.getElementById("ui-current-clip");
        if (currentClip) currentClip.textContent = "0";
        const remainingAmmo = document.getElementById("ui-remaining-ammo");
        if (remainingAmmo) remainingAmmo.textContent = "0";
        for (const id of Object.keys(HudLayoutManager.PREVIEW_LOOT_COUNTS)) {
            const countEl = document.getElementById(id)?.querySelector(".ui-loot-count");
            if (countEl) countEl.textContent = "0";
        }
    }

    /** The effective config for one element - HUD_ELEMENT_DEFAULTS (with `visible`
     *  narrowed by the element's own `defaultVisible`, if it declares one) for
     *  anything not yet customized, since `hudLayout` only stores entries once they
     *  diverge from that baseline. */
    getElementConfig(id: string): HudElementConfig {
        const layout = this.config.get("hudLayout") ?? {};
        const def = HUD_ELEMENTS.find((d) => d.id === id);
        const defaults = def?.defaultVisible === undefined
            ? HUD_ELEMENT_DEFAULTS
            : { ...HUD_ELEMENT_DEFAULTS, visible: def.defaultVisible };
        return { ...defaults, ...layout[id] };
    }

    /** Merges `patch` into one element's config and persists + re-applies immediately. */
    updateElementConfig(id: string, patch: Partial<HudElementConfig>) {
        const layout = { ...(this.config.get("hudLayout") ?? {}) };
        layout[id] = { ...this.getElementConfig(id), ...patch };
        this.config.set("hudLayout", layout);
    }

    /** Reverts one element back to HUD_ELEMENT_DEFAULTS. */
    resetElement(id: string) {
        const layout = { ...(this.config.get("hudLayout") ?? {}) };
        delete layout[id];
        this.config.set("hudLayout", layout);
    }

    /** Reverts every element, including the global scale/opacity switches (the
     *  settings panel's "Reset to default" action). */
    resetAll() {
        this.config.set("hudLayout", {});
        this.config.set("hudGlobalScale", 1);
        this.config.set("hudGlobalOpacity", 1);
    }

    /** Pushes every registered element's current config onto its wrapper's inline
     *  style. Safe to call before a match starts - the wrappers exist in the static
     *  page DOM regardless of whether the HUD is currently visible. */
    applyElementStyles() {
        const globalScale = this.getGlobalScale();
        const globalOpacity = this.getGlobalOpacity();
        for (const def of HUD_ELEMENTS) {
            const el = document.getElementById(def.wrapperId);
            if (!el) continue;
            const cfg = this.getElementConfig(def.id);
            el.style.transform = this.elementTransform(cfg.dx, cfg.dy, cfg.scale * globalScale, def.baseTransform);
            el.style.opacity = String(cfg.opacity * globalOpacity);
            if (def.usesExternalDisplayGate) {
                // Never touch `display` here - see the field's doc comment. `visibility`
                // stacks independently: `display:none` (from either source) always wins
                // regardless of this, and when `display` isn't `none` (i.e. whatever
                // other code shows this element decided to), this is what actually
                // reflects the user's own hide/show choice.
                el.style.visibility = cfg.visible ? "" : "hidden";
            } else {
                el.style.display = cfg.visible ? "" : "none";
            }
        }
    }

    /** Wraps an emoji icon in a fixed-size, `overflow:hidden` span (see `.hud-icon-
     *  glyph` in game.css) - some emoji (🖱 in particular) fall back to a much larger
     *  glyph than their declared font-size on some platforms/browsers, blowing out of
     *  the settings row and overlapping neighboring rows; clipping to a fixed box is a
     *  simple, environment-independent fix without switching to real icon assets. */
    private makeIconGlyph(emoji: string): HTMLElement {
        const span = document.createElement("span");
        span.className = "hud-icon-glyph";
        span.textContent = emoji;
        return span;
    }

    /** One settings row for `def`, wired to live-update this element's config. Built
     *  fresh per call (not shared/cloned across the two lists - see renderSettingsPanel)
     *  since DOM nodes can't live in two containers and cloning would drop listeners. */
    private buildSettingsRow(def: HudElementDef): HTMLElement {
        const cfg = this.getElementConfig(def.id);
        const row = document.createElement("div");
        row.className = "hud-settings-row";

        const label = document.createElement("span");
        label.className = "hud-settings-label";
        label.textContent = def.label;
        row.appendChild(label);

        const visLabel = document.createElement("label");
        visLabel.className = "hud-settings-checkbox-label";
        visLabel.title = "Visible";
        const visCheckbox = document.createElement("input");
        visCheckbox.type = "checkbox";
        visCheckbox.checked = cfg.visible;
        visCheckbox.addEventListener("change", () => {
            this.updateElementConfig(def.id, { visible: visCheckbox.checked });
        });
        visLabel.append(visCheckbox, this.makeIconGlyph("👁"));
        row.appendChild(visLabel);

        const opacitySlider = document.createElement("input");
        opacitySlider.type = "range";
        opacitySlider.min = "0.1";
        opacitySlider.max = "1";
        opacitySlider.step = "0.05";
        opacitySlider.value = String(cfg.opacity);
        opacitySlider.className = "hud-settings-opacity slider";
        opacitySlider.title = "Opacity";
        opacitySlider.addEventListener("input", () => {
            this.updateElementConfig(def.id, { opacity: parseFloat(opacitySlider.value) });
        });
        row.appendChild(opacitySlider);

        if (def.hasClickAction) {
            const clickLabel = document.createElement("label");
            clickLabel.className = "hud-settings-checkbox-label";
            clickLabel.title = "Clickable";
            const clickCheckbox = document.createElement("input");
            clickCheckbox.type = "checkbox";
            clickCheckbox.checked = cfg.clickable;
            clickCheckbox.addEventListener("change", () => {
                this.updateElementConfig(def.id, { clickable: clickCheckbox.checked });
            });
            clickLabel.append(clickCheckbox, this.makeIconGlyph("🖱"));
            row.appendChild(clickLabel);
        }

        const resetBtn = document.createElement("a");
        resetBtn.className = "hud-settings-reset-btn btn-darken";
        resetBtn.textContent = "↺";
        resetBtn.title = "Reset this element";
        resetBtn.addEventListener("click", () => {
            this.resetElement(def.id);
            this.renderSettingsPanel();
        });
        row.appendChild(resetBtn);

        return row;
    }

    /** One "Global Scale"/"Global Opacity"-style row: a label and a slider spanning
     *  the whole row width, built fresh each render (same reason as buildSettingsRow -
     *  simplest way to keep it in sync without a separate value-sync step). Lives
     *  inside #ui-hud-settings-list itself (see renderSettingsPanel) rather than as
     *  static rows above it, so it scrolls along with the list instead of needing the
     *  panel's fixed height re-tuned by hand every time one of these is added. */
    private buildGlobalSliderRow(
        id: string,
        label: string,
        min: number,
        max: number,
        step: number,
        getValue: () => number,
        setValue: (v: number) => void,
    ): HTMLElement {
        const row = document.createElement("div");
        row.id = id;
        row.className = "hud-settings-row hud-global-slider-row";

        const labelEl = document.createElement("span");
        labelEl.className = "hud-settings-label";
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = String(min);
        slider.max = String(max);
        slider.step = String(step);
        slider.value = String(getValue());
        slider.className = "hud-global-slider slider";
        slider.addEventListener("input", () => setValue(parseFloat(slider.value)));
        row.appendChild(slider);

        return row;
    }

    /** (Re)builds the HUD settings list (#ui-hud-settings-list, found via the
     *  `.js-hud-settings-list` class it carries) - the Global Scale/Global Opacity
     *  rows first, then one row per registered element: a visibility checkbox, an
     *  opacity slider, a clickable checkbox (only where `hasClickAction`), and a
     *  per-element reset button. Call whenever the panel becomes visible (real game or
     *  preview, see showInGameHudTab) so displayed values stay in sync with whatever
     *  was last dragged/resized/toggled/reset. */
    renderSettingsPanel() {
        const lists = document.querySelectorAll<HTMLElement>(".js-hud-settings-list");
        for (const list of lists) {
            list.innerHTML = "";
            list.appendChild(this.buildGlobalSliderRow(
                "hud-global-scale-row",
                "Global Scale",
                0.5,
                2,
                0.05,
                () => this.getGlobalScale(),
                (v) => this.config.set("hudGlobalScale", v),
            ));
            list.appendChild(this.buildGlobalSliderRow(
                "hud-global-opacity-row",
                "Global Opacity",
                0.1,
                1,
                0.05,
                () => this.getGlobalOpacity(),
                (v) => this.config.set("hudGlobalOpacity", v),
            ));
            for (const def of HUD_ELEMENTS) {
                list.appendChild(this.buildSettingsRow(def));
            }
        }
    }
}
