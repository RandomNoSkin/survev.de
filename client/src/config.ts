import type { MapDefKey, MapDefs } from "../../shared/defs/mapDefs.ts";
import { GameConfig } from "../../shared/gameConfig.ts";
import type { SavedPrivateLobbySettings } from "../../shared/types/privateLobby.ts";
import loadout from "../../shared/utils/loadout.ts";
import { util } from "../../shared/utils/util.ts";
import { v2 } from "../../shared/utils/v2.ts";
import type { AdvSpecSettings } from "./ui/advancedSpectator.ts";
import type { Locale } from "./ui/localization.ts";

export const debugToolsConfig = {
    enabled: false,

    zoomEnabled: false,
    zoom: GameConfig.scopeZoomRadius.desktop["1xscope"],

    speedEnabled: false,
    speed: GameConfig.player.moveSpeed,

    gameSpeedEnabled: false,
    gameSpeed: 1,

    mapSeed: 0,

    loot: "",
    role: "",

    noClip: false,
    godMode: false,
    teleportToPings: false,
    moveObjs: false,
    preventGameStart: false,
};

export const debugRenderConfig = {
    enabled: false,
    players: false,
    obstacles: false,
    loot: false,
    explosions: false,
    rivers: false,
    buildings: {
        buildingBounds: false,
        obstacleBounds: false,
        bridge: false,
        waterEdge: false,
        ceiling: false,
        floors: false,
        minimap: false,
    },
    structures: {
        buildingBounds: false,
        obstacleBounds: false,
        bridge: false,
        waterEdge: false,
        stairs: false,
        layerMasks: false,
    },
};

export const debugHUDConfig = {
    enabled: false,
    position: false,
    objectPools: false,
    fps: {
        show: false,
        showGraph: false,
    },
    ping: {
        show: false,
        showGraph: false,
    },
    netIn: {
        show: false,
        showGraph: false,
    },
    updateInterval: {
        show: false,
        showGraph: false,
    },
};

export type DebugRenderOpts = typeof debugRenderConfig;

/**
 * Per-element HUD customization (position/visibility/opacity/click) - see
 * client/src/ui/hudLayoutManager.ts, which owns reading/writing this. Stored as a flat
 * Record keyed by HUD element id rather than one `defaultConfig` field per element, so
 * new elements (Stage 7/9) never need a defaultConfig change - an id absent from this
 * record just resolves to HUD_ELEMENT_DEFAULTS (all four fields at their "untouched"
 * value), exactly like `hudLayout: {}` being the default for the whole record.
 */
export interface HudElementConfig {
    /** Drag offset from the element's normal CSS position, in px. */
    dx: number;
    dy: number;
    visible: boolean;
    /** 0-1. */
    opacity: number;
    /** Only meaningful for elements with a click action (see HUD_ELEMENTS.hasClickAction) - ignored otherwise. */
    clickable: boolean;
    /** Per-element size multiplier, on top of `hudGlobalScale` below - set by dragging
     *  the resize handle in the corner of the element while in HUD edit mode. */
    scale: number;
}

export const HUD_ELEMENT_DEFAULTS: HudElementConfig = {
    dx: 0,
    dy: 0,
    visible: true,
    opacity: 1,
    clickable: true,
    scale: 1,
};

export const BuildingEditorConfig = {
    zoom: 1,
    pos: v2.create(0, 0),
    object: "house_red_01",
    map: "main" as MapDefKey,
    grid: true,
};

const defaultConfig = {
    muteAudio: false,
    masterVolume: 1,
    soundVolume: 1,
    musicVolume: 1,
    gameMusicVolume: 1,
    highResTex: true,
    interpolation: true,
    localRotation: false,
    screenShake: true,
    anonPlayerNames: false,
    autoDownloadStats: false,
    /** When on, the player only picks up Ghillie suits in-game (keeps their loadout skin). */
    onlyGhilliePickup: true,
    touchMoveStyle: "anywhere" as "locked" | "anywhere",
    touchAimStyle: "anywhere" as "locked" | "anywhere",
    touchAimLine: true,
    touchAimAssist: true,
    touchAutoSwitch: true,
    profile: null as { slug: string } | null,
    playerName: "",
    region: "na",
    /** Selected geographic region group (e.g. "eu", "asia"); resolves to `region`. */
    regionGroup: "" as string,
    /** Selected playlist category (e.g. "normal", "arena", "scrims"); resolves to `region`. */
    playlist: "" as string,
    gameModeIdx: 2,
    /** Private lobby settings the leader last configured, re-applied (minus `advancedSettings`) the next time they create a lobby. */
    privateLobbySettings: {} as SavedPrivateLobbySettings,
    teamAutoFill: true,
    language: "en" as Locale,
    prerollGamesPlayed: 0,
    totalGamesPlayed: 0,
    promptAppRate: true,
    regionSelected: false,
    lastNewsTimestamp: 0,
    perkModeRole: "",
    arenaModeRole: "",
    /** Last-used advanced spectator toggles, re-applied whenever advanced spectator is activated. */
    advancedSpectatorSettings: {
        freecam: false,
        transparentSurfaces: false,
        enemiesOnMap: false,
        zoom: false,
        espLines: false,
        enemyLabels: false,
        nadeEsp: false,
        layer: 0,
        zoomLevel: 48,
    } as AdvSpecSettings,
    loadout: loadout.defaultLoadout(),
    /** Per-category instance id of the item last selected in the loadout menu, so the
     *  exact owned copy stays selected across reloads (the loadout itself only stores
     *  the equipped *type*). Falls back to the equipped type when the id is gone. */
    selectedItemIds: {} as Record<string, number>,
    sessionCookie: "" as string | null,
    binds: "",
    rulesAcceptedVersion: 0,
    /** Last Golden Fries balance the player saw (persisted so the unlock animation
     *  fires whenever the current balance is higher than this), and the account slug
     *  it belongs to (guards against cross-account false triggers on one device). */
    goldenFriesSeen: 0,
    goldenFriesSeenSlug: "",
    cachedBgImg: "img/main_splash.png",
    version: 1,
    /** Per-element HUD customization (position/visibility/opacity/click), keyed by HUD
     *  element id. An absent id means "untouched" (see HUD_ELEMENT_DEFAULTS) - this
     *  starts empty rather than pre-populated with every element's defaults. */
    hudLayout: {} as Record<string, HudElementConfig>,
    /** Global size multiplier applied on top of every element's own `scale` (see
     *  HudElementConfig) - the "resize everything at once" switch, as opposed to the
     *  per-element resize handle. */
    hudGlobalScale: 1,
    /** Global opacity multiplier applied on top of every element's own `opacity` (see
     *  HudElementConfig) - the "fade everything at once" switch, as opposed to each
     *  element's own opacity slider. */
    hudGlobalOpacity: 1,
    /** Renders the loop via a non-vsync setTimeout(0) instead of PIXI's default
     *  requestAnimationFrame ticker, to exceed the monitor's refresh rate (see
     *  Game#setRenderLoopMode in main.ts). Off by default: rAF/vsync stays the norm. */
    uncapFps: false,
    /* STRIP_FROM_PROD_CLIENT:START */
    debugTools: debugToolsConfig,
    debugRenderer: debugRenderConfig,
    /* STRIP_FROM_PROD_CLIENT:END */
    debugHUD: debugHUDConfig,
    buildingEditor: BuildingEditorConfig,
};

export type ConfigType = typeof defaultConfig;
export type ConfigKey = keyof ConfigType;

export class ConfigManager {
    loaded = false;
    localStorageAvailable = true;
    config = {} as ConfigType;
    onModifiedListeners: Array<(key?: string) => void> = [];

    load(onLoadCompleteCb: () => void) {
        const onLoaded = (strConfig: string) => {
            let data = {};
            try {
                data = JSON.parse(strConfig);
            } catch (_e) {}
            this.config = util.mergeDeep({}, defaultConfig, data);
            this.checkUpgradeConfig();
            this.onModified();
            this.loaded = true;
            onLoadCompleteCb();
        };
        let storedConfig: string | null = "{}";
        try {
            storedConfig = localStorage.getItem("surviv_config")!;
        } catch (_err) {
            this.localStorageAvailable = false;
        }
        onLoaded(storedConfig);
    }

    store() {
        const strData = JSON.stringify(this.config);
        if (this.localStorageAvailable) {
            // In browsers, like Safari, localStorage setItem is
            // disabled in private browsing mode.
            // This try/catch is here to handle that situation.
            try {
                localStorage.setItem("surviv_config", strData);
            } catch (_e) {}
        }
    }

    set<T extends ConfigKey>(key: T, value: ConfigType[T]) {
        if (!key) {
            return;
        }
        const path = key.split(".");

        let elem = this.config;
        while (path.length > 1) {
            // @ts-expect-error bleh
            elem = elem[path.shift()];
        }
        // @ts-expect-error bleh
        elem[path.shift()] = value;

        this.store();
        this.onModified(key);
    }

    get<T extends ConfigKey>(key: T): ConfigType[T] | undefined {
        if (!key) {
            return undefined;
        }

        const path = key.split(".");
        let elem = this.config as any;
        for (let i = 0; i < path.length; i++) {
            elem = elem[path[i]];
        }
        return elem;
    }

    addModifiedListener(e: (key?: string) => void) {
        this.onModifiedListeners.push(e);
    }

    onModified(key?: string) {
        for (let i = 0; i < this.onModifiedListeners.length; i++) {
            this.onModifiedListeners[i](key);
        }
    }

    checkUpgradeConfig() {
        // validation logic
        this.config.loadout = loadout.validate(this.config.loadout);

        // seem not to be implemeted yet
        // this.get("version");
        // // @TODO: Put upgrade code here
        // this.set("version", 1);
    }
}
