import * as PIXI from "pixi.js-legacy";
import { GameObjectDefs } from "../../../shared/defs/gameObjectDefs";
import { ExplosionDefs } from "../../../shared/defs/gameObjects/explosionsDefs";
import type { ThrowableDef } from "../../../shared/defs/gameObjects/throwableDefs";
import { GameConfig } from "../../../shared/gameConfig";
import { math } from "../../../shared/utils/math";
import { type Vec2, v2 } from "../../../shared/utils/v2";
import type { Camera } from "../camera";
import { device } from "../device";
import type { PlayerBarn } from "../objects/player";
import type { ProjectileBarn } from "../objects/projectile";
import type { GodViewSnapshot } from "../replay/godView";

// Colour used for ESP lines / enemy name labels. Enemies are always shown red
// regardless of game mode so they read clearly against the world.
const ENEMY_COLOR = 0xff4d4d;
// Name colour for the spectated player's own label (shown only in freecam, where
// the camera has left them). Green so it reads as "not an enemy".
const SPECTATED_COLOR = 0x66ff7a;
// Colour for grenade fuse timers + explosion-radius rings.
const NADE_COLOR = 0xffcc33;

// Default / clamp range for the requested culling-zoom radius (sent to the
// server). Kept in sync with the server-side clamp in player.ts.
const MIN_ZOOM = 14;
const MAX_ZOOM = 300;
const DEFAULT_ZOOM = 48;

interface EnemyLabel {
    container: PIXI.Container;
    nameText: PIXI.Text;
    statsText: PIXI.Text;
}

/** User-facing advanced spectator toggles persisted across games/sessions (in the client config). */
export interface AdvSpecSettings {
    freecam: boolean;
    transparentSurfaces: boolean;
    enemiesOnMap: boolean;
    zoom: boolean;
    espLines: boolean;
    enemyLabels: boolean;
    nadeEsp: boolean;
    layer: number;
    zoomLevel: number;
}

export function defaultAdvSpecSettings(): AdvSpecSettings {
    return {
        freecam: false,
        transparentSurfaces: false,
        enemiesOnMap: false,
        zoom: false,
        espLines: false,
        enemyLabels: false,
        nadeEsp: false,
        layer: 0,
        zoomLevel: DEFAULT_ZOOM,
    };
}

function createLabelText(tint: number) {
    const text = new PIXI.Text("", {
        fontFamily: "Arial",
        fontWeight: "bold",
        fontSize: device.pixelRatio > 1 ? 30 : 22,
        align: "center",
        fill: tint,
        dropShadow: true,
        dropShadowColor: "#000000",
        dropShadowBlur: 1,
        dropShadowAngle: Math.PI / 3,
        dropShadowDistance: 1,
    } satisfies Partial<PIXI.ITextStyle>);
    text.anchor.set(0.5, 0.5);
    text.scale.set(0.5, 0.5);
    return text;
}

/**
 * Admin-only advanced spectator overlay. Holds the feature toggles + free-camera
 * state and renders the ESP lines / enemy labels into its own PIXI container
 * (added to the stage above the world). The data it needs (enemy positions,
 * health, boost) is delivered by the server's extended player status stream,
 * which is only sent to admins that joined as spectators.
 */
export class AdvancedSpectator {
    // Master toggle + per-feature toggles
    enabled = false;
    freecam = false;
    transparentSurfaces = false;
    enemiesOnMap = false;
    zoom = false;
    espLines = false;
    enemyLabels = false;
    // Show fuse timers + explosion-radius rings on thrown grenades.
    nadeEsp = false;

    /** Render layer the spectator is viewing (0 = surface, 1 = underground). */
    layer = 0;

    // Free camera / custom zoom state
    freecamInitialized = false;
    freecamPos: Vec2 = v2.create(0, 0);
    /** Requested culling-zoom radius (world units) sent to the server. */
    zoomLevel = DEFAULT_ZOOM;

    // Throttle / edge-detection for the SpectatorAdvancedMsg sent to the server
    sendTimer = 0;
    wasEnabled = false;

    container = new PIXI.Container();
    private espGfx = new PIXI.Graphics();
    private labelPool: EnemyLabel[] = [];
    private nadeTextPool: PIXI.Text[] = [];

    constructor() {
        this.container.interactiveChildren = false;
        this.container.addChild(this.espGfx);
    }

    adjustZoom(delta: number) {
        this.zoomLevel = math.clamp(this.zoomLevel + delta, MIN_ZOOM, MAX_ZOOM);
    }

    /** Snapshot of the persisted toggle settings (excludes session/positional state). */
    getSettings(): AdvSpecSettings {
        return {
            freecam: this.freecam,
            transparentSurfaces: this.transparentSurfaces,
            enemiesOnMap: this.enemiesOnMap,
            zoom: this.zoom,
            espLines: this.espLines,
            enemyLabels: this.enemyLabels,
            nadeEsp: this.nadeEsp,
            layer: this.layer,
            zoomLevel: this.zoomLevel,
        };
    }

    /** Applies persisted settings (e.g. when advanced spectator is (re)activated). */
    applySettings(s?: Partial<AdvSpecSettings> | null): void {
        if (!s) return;
        if (typeof s.freecam === "boolean") this.freecam = s.freecam;
        if (typeof s.transparentSurfaces === "boolean")
            this.transparentSurfaces = s.transparentSurfaces;
        if (typeof s.enemiesOnMap === "boolean") this.enemiesOnMap = s.enemiesOnMap;
        if (typeof s.zoom === "boolean") this.zoom = s.zoom;
        if (typeof s.espLines === "boolean") this.espLines = s.espLines;
        if (typeof s.enemyLabels === "boolean") this.enemyLabels = s.enemyLabels;
        if (typeof s.nadeEsp === "boolean") this.nadeEsp = s.nadeEsp;
        if (typeof s.layer === "number") this.layer = s.layer;
        if (typeof s.zoomLevel === "number")
            this.zoomLevel = math.clamp(s.zoomLevel, MIN_ZOOM, MAX_ZOOM);
    }

    private getLabel(index: number): EnemyLabel {
        let label = this.labelPool[index];
        if (!label) {
            const container = new PIXI.Container();
            // White fill so the per-render tint (enemy red / spectated green) shows.
            const nameText = createLabelText(0xffffff);
            nameText.position.set(0, -42);
            const statsText = createLabelText(0xffffff);
            statsText.position.set(0, -28);
            container.addChild(nameText);
            container.addChild(statsText);
            this.container.addChild(container);
            label = { container, nameText, statsText };
            this.labelPool[index] = label;
        }
        return label;
    }

    private getNadeText(index: number): PIXI.Text {
        let text = this.nadeTextPool[index];
        if (!text) {
            // White fill so the per-render NADE_COLOR tint shows.
            text = createLabelText(0xffffff);
            this.container.addChild(text);
            this.nadeTextPool[index] = text;
        }
        return text;
    }

    m_render(
        camera: Camera,
        playerBarn: PlayerBarn,
        projectileBarn: ProjectileBarn,
        activeId: number,
        localId: number,
        godView?: GodViewSnapshot | null,
    ) {
        this.espGfx.clear();
        for (const label of this.labelPool) {
            label.container.visible = false;
        }
        for (const text of this.nadeTextPool) {
            text.visible = false;
        }

        if (!this.enabled || (!this.espLines && !this.enemyLabels && !this.nadeEsp)) {
            this.container.visible = false;
            return;
        }
        this.container.visible = true;

        // Resolves a player's team. The god-view roster is preferred when it carries a
        // valid team (server-authoritative), but older/broken track files have an empty
        // roster (teamId -1 for everyone) — comparing -1 against -1 made every player
        // read as a teammate (green labels, no ESP lines). Fall back to the playerInfo
        // stream, which in a replay contains every player in the game.
        const teamOf = (id: number, gvTeamId?: number): number => {
            if (gvTeamId !== undefined && gvTeamId > 0) return gvTeamId;
            return playerBarn.getPlayerInfo(id).teamId;
        };
        // Team of the spectated player.
        const activeTeamId = teamOf(activeId, godView?.get(activeId)?.teamId);
        const centerX = camera.m_screenWidth * 0.5;
        const centerY = camera.m_screenHeight * 0.5;

        const players = playerBarn.playerPool.m_getPool();
        let labelIdx = 0;

        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            if (!p.active || p.__id === localId || p.m_netData.m_dead) {
                continue;
            }
            const info = playerBarn.getPlayerInfo(p.__id);
            // Prefer god-view data (server-authoritative team + health + boost for every
            // player) over the POV's local status stream, which in replay carries no
            // enemy status at all and no boost for teammates → otherwise HP/AD read 0.
            const gv = godView?.get(p.__id);
            // teammates share a teamId with the spectated player; everyone else
            // is an enemy. We label both, so the spectator also sees the info of
            // the watched player's squad (not just enemies).
            const isEnemy = teamOf(p.__id, gv?.teamId) !== activeTeamId;
            // Don't double-label the followed player in normal mode — the HUD
            // already shows them. In freecam the camera has left them, so we do
            // want their label.
            const isFollowed = p.__id === activeId && !this.freecam;
            if (isFollowed) {
                continue;
            }

            const screenPos = camera.m_pointToScreen(p.m_visualPos);

            // ESP lines run from the screen center to enemies; pointless in freecam
            // (no player at the center), so they're skipped there.
            if (this.espLines && isEnemy && !this.freecam) {
                this.espGfx.lineStyle(1.5, ENEMY_COLOR, 0.5);
                this.espGfx.moveTo(centerX, centerY);
                this.espGfx.lineTo(screenPos.x, screenPos.y);
            }

            if (this.enemyLabels) {
                const status = playerBarn.getPlayerStatus(p.__id);
                const hp = Math.round(gv?.health ?? status?.health ?? 0);
                const boost = Math.round(gv?.boost ?? status?.boost ?? 0);
                const label = this.getLabel(labelIdx++);
                label.container.visible = true;
                label.container.position.set(screenPos.x, screenPos.y);
                label.nameText.text = info.name;
                label.nameText.tint = isEnemy ? ENEMY_COLOR : SPECTATED_COLOR;
                label.statsText.text = `HP ${hp}  AD ${boost}`;
            }
        }

        // Replay god-view: draw labels / ESP lines for players the watched POV could
        // NOT see (they're absent from the local stream above). Same toggles apply.
        if (godView) {
            const localIds = new Set<number>();
            for (let i = 0; i < players.length; i++) {
                if (players[i].active) localIds.add(players[i].__id);
            }
            for (const gp of godView.values()) {
                if (gp.dead || gp.id === localId || gp.id === activeId) continue;
                if (localIds.has(gp.id)) continue; // already drawn from the live stream
                const isEnemy = teamOf(gp.id, gp.teamId) !== activeTeamId;
                const screenPos = camera.m_pointToScreen(gp.pos);

                if (this.espLines && isEnemy && !this.freecam) {
                    this.espGfx.lineStyle(1.5, ENEMY_COLOR, 0.5);
                    this.espGfx.moveTo(centerX, centerY);
                    this.espGfx.lineTo(screenPos.x, screenPos.y);
                }
                if (this.enemyLabels) {
                    const label = this.getLabel(labelIdx++);
                    label.container.visible = true;
                    label.container.position.set(screenPos.x, screenPos.y);
                    // Empty-roster track files carry no names — playerInfo has them.
                    label.nameText.text =
                        gp.name || playerBarn.getPlayerInfo(gp.id).name;
                    label.nameText.tint = isEnemy ? ENEMY_COLOR : SPECTATED_COLOR;
                    label.statsText.text = `HP ${Math.round(gp.health)}  AD ${Math.round(gp.boost)}`;
                }
            }
        }

        if (this.nadeEsp) {
            const projectiles = projectileBarn.projectilePool.m_getPool();
            let nadeIdx = 0;
            for (let i = 0; i < projectiles.length; i++) {
                const p = projectiles[i];
                if (!p.active) continue;
                const def = GameObjectDefs[p.type] as ThrowableDef | undefined;
                // Only timed grenades: skip dynamite/mine/very-long-fuse throwables
                // (snowball, potato, proximity mines, ...).
                if (
                    !def ||
                    def.type !== "throwable" ||
                    def.explodeOnImpact ||
                    def.proximityMine ||
                    def.fuseTime > 16
                ) {
                    continue;
                }

                const screenPos = camera.m_pointToScreen(p.pos);

                // Explosion radius rings (inner = full damage, outer = falloff edge).
                const explosion = ExplosionDefs[def.explosionType];
                if (explosion) {
                    this.espGfx.lineStyle(1.5, NADE_COLOR, 0.5);
                    this.espGfx.drawCircle(
                        screenPos.x,
                        screenPos.y,
                        camera.m_scaleToScreen(explosion.rad.max),
                    );
                    this.espGfx.lineStyle(1, NADE_COLOR, 0.85);
                    this.espGfx.drawCircle(
                        screenPos.x,
                        screenPos.y,
                        camera.m_scaleToScreen(explosion.rad.min),
                    );
                }

                const text = this.getNadeText(nadeIdx++);
                text.visible = true;
                text.position.set(screenPos.x, screenPos.y);
                text.text = p.fuseTimer.toFixed(1);
                text.tint = NADE_COLOR;
            }

            // Cooking grenades aren't projectiles yet — they're held in the
            // player's hand. Show the remaining fuse over any player playing the
            // Cook animation with a cookable timed grenade equipped. The cook
            // ticker (anim.ticker) mirrors how long the pin has been pulled.
            for (let i = 0; i < players.length; i++) {
                const p = players[i];
                if (
                    !p.active ||
                    p.__id === localId ||
                    p.m_netData.m_dead ||
                    p.currentAnim() !== GameConfig.Anim.Cook
                ) {
                    continue;
                }
                const def = GameObjectDefs[p.m_netData.m_activeWeapon] as
                    | ThrowableDef
                    | undefined;
                if (
                    !def ||
                    def.type !== "throwable" ||
                    !def.cookable ||
                    def.explodeOnImpact ||
                    def.proximityMine ||
                    def.fuseTime > 16
                ) {
                    continue;
                }

                const remaining = Math.max(0, def.fuseTime - p.anim.ticker);
                const screenPos = camera.m_pointToScreen(p.m_visualPos);
                const text = this.getNadeText(nadeIdx++);
                text.visible = true;
                text.position.set(screenPos.x, screenPos.y);
                text.text = remaining.toFixed(1);
                text.tint = NADE_COLOR;
            }
        }
    }
}
