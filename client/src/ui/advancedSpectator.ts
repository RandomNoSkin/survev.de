import * as PIXI from "pixi.js-legacy";
import { math } from "../../../shared/utils/math";
import { type Vec2, v2 } from "../../../shared/utils/v2";
import type { Camera } from "../camera";
import { device } from "../device";
import type { PlayerBarn } from "../objects/player";

// Colour used for ESP lines / enemy name labels. Enemies are always shown red
// regardless of game mode so they read clearly against the world.
const ENEMY_COLOR = 0xff4d4d;
// Name colour for the spectated player's own label (shown only in freecam, where
// the camera has left them). Green so it reads as "not an enemy".
const SPECTATED_COLOR = 0x66ff7a;

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

    constructor() {
        this.container.interactiveChildren = false;
        this.container.addChild(this.espGfx);
    }

    adjustZoom(delta: number) {
        this.zoomLevel = math.clamp(this.zoomLevel + delta, MIN_ZOOM, MAX_ZOOM);
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

    m_render(camera: Camera, playerBarn: PlayerBarn, activeId: number, localId: number) {
        this.espGfx.clear();
        for (const label of this.labelPool) {
            label.container.visible = false;
        }

        if (!this.enabled || (!this.espLines && !this.enemyLabels)) {
            this.container.visible = false;
            return;
        }
        this.container.visible = true;

        const activeTeamId = playerBarn.getPlayerInfo(activeId).teamId;
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
            // teammates share a teamId; everyone else is an enemy
            const isEnemy = info.teamId !== activeTeamId;
            // In freecam the camera leaves the spectated player, so label them too.
            const isSpectated = p.__id === activeId && this.freecam;
            if (!isEnemy && !isSpectated) {
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
                const hp = Math.round(status?.health ?? 0);
                const boost = Math.round(status?.boost ?? 0);
                const label = this.getLabel(labelIdx++);
                label.container.visible = true;
                label.container.position.set(screenPos.x, screenPos.y);
                label.nameText.text = info.name;
                label.nameText.tint = isEnemy ? ENEMY_COLOR : SPECTATED_COLOR;
                label.statsText.text = `HP ${hp}  AD ${boost}`;
            }
        }
    }
}
