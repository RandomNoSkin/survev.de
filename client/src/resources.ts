import * as PIXI from "pixi.js-legacy";
import { type Atlas, type MapDefKey, MapDefs } from "../../shared/defs/mapDefs.ts";
import { MapObjectDefs } from "../../shared/defs/register.ts";
import type { AudioManager } from "./audioManager.ts";
import type { ConfigManager } from "./config.ts";
import { device } from "./device.ts";
import SoundDefs from "./soundDefs.ts";

type AtlasDef = Record<Atlas, PIXI.ISpritesheetData[]>;

/** The sprite frame data of one texture resolution (~480 KB of JS each). Loaded on
 *  demand - both used to sit in the main bundle although a device only ever uses one. */
function importAtlasDefs(res: "high" | "low"): Promise<AtlasDef> {
    const load = () =>
        (res === "high" ? import("virtual-atlases-high") : import("virtual-atlases-low")).then(
            (m) => ((m as { default?: unknown }).default ?? m) as AtlasDef,
        );
    return load().catch(load); // one retry on a flaky connection
}

/**
 * Every "*.img" sprite and every other string (sound names etc.) the map object defs
 * of `types` reference, following child objects and structure layers.
 */
function collectObjectRefs(types: Iterable<string>): { sprites: Set<string>; strings: Set<string> } {
    const sprites = new Set<string>();
    const strings = new Set<string>();
    const seen = new Set<string>();
    const walk = (value: unknown, depth: number) => {
        if (depth > 12 || value === null) return;
        if (typeof value === "string") {
            if (value.endsWith(".img")) {
                sprites.add(value);
                return;
            }
            strings.add(value);
            if (!seen.has(value) && MapObjectDefs.typeToDefSafe(value)) visit(value);
            return;
        }
        if (typeof value !== "object") return;
        for (const [k, v] of Object.entries(value)) {
            // random picks are { type: weight } - the types are the keys
            if (typeof v === "number" && !seen.has(k) && MapObjectDefs.typeToDefSafe(k)) visit(k);
            walk(v, depth + 1);
        }
    };
    const visit = (type: string) => {
        seen.add(type);
        walk(MapObjectDefs.typeToDefSafe(type), 0);
    };
    for (const type of types) if (!seen.has(type)) visit(type);
    return { sprites, strings };
}

/** Every map's own sounds by name (buildings bring theirs: club music, fireplaces...). */
let mapSoundsByName: Map<string, { name: string; channel: string }> | undefined;
function getMapSounds() {
    if (!mapSoundsByName) {
        mapSoundsByName = new Map();
        for (const def of Object.values(MapDefs)) {
            for (const sound of def.assets.audio) mapSoundsByName.set(sound.name, sound);
        }
    }
    return mapSoundsByName;
}

function loadTexture(renderer: PIXI.IRenderer, url: string) {
    const tex = PIXI.Texture.from(url);
    const baseTex = tex.baseTexture;
    let loadAttempts = 0;

    if (!baseTex.valid) {
        baseTex.on("loaded", (baseTex) => {
            console.log("Loaded texture", url);
            renderer.prepare.upload(baseTex);
        });

        baseTex.on("error", (baseTex) => {
            console.log("BaseTex load error, retrying", url);
            if (loadAttempts++ <= 3) {
                setTimeout(
                    () => {
                        if (baseTex.source) {
                            baseTex.updateSourceImage("");
                            baseTex.updateSourceImage(url.substring(5, url.length));
                        }
                    },
                    (loadAttempts - 1) * 1000,
                );
            }
        });
    }
    return baseTex;
}

function loadSpritesheet(
    renderer: PIXI.IRenderer,
    basePath: string,
    data: PIXI.ISpritesheetData,
) {
    const baseTex = loadTexture(renderer, basePath + data.meta.image!);

    const sheet = new PIXI.Spritesheet(baseTex, data);
    sheet.resolution = baseTex.resolution;
    sheet.parse();

    return sheet;
}

function selectTextureRes(renderer: PIXI.IRenderer, config: ConfigManager) {
    let minDim = Math.min(window.screen.width, window.screen.height);
    let maxDim = Math.max(window.screen.width, window.screen.height);
    minDim *= window.devicePixelRatio;
    maxDim *= window.devicePixelRatio;
    const smallScreen = maxDim < 1366 && minDim < 768;
    let textureRes: "high" | "low" = config.get("highResTex") ? "high" : "low";

    if (
        smallScreen
        || (device.mobile && !device.tablet)
        || renderer.type == PIXI.RENDERER_TYPE.CANVAS
    ) {
        textureRes = "low";
    }
    if (renderer.type == PIXI.RENDERER_TYPE.WEBGL) {
        const s = (renderer as PIXI.Renderer).gl;
        if (s.getParameter(s.MAX_TEXTURE_SIZE) < 4096) {
            textureRes = "low";
        }
    }
    console.log(
        "TextureRes",
        textureRes,
        "screenDims",
        window.screen.width,
        window.screen.height,
    );
    return textureRes;
}

export class ResourceManager {
    atlases = {} as Record<
        Atlas,
        {
            loaded: boolean;
            spritesheets: PIXI.Spritesheet[];
        }
    >;

    loadTicker = 0;
    loaded = false;

    textureRes!: "high" | "low";
    mapName!: string;
    preloadMap!: boolean;

    /** This device's atlas frame data, once loaded (see importAtlasDefs). */
    private defs: AtlasDef | null = null;
    atlasDefsReady = false;
    /** Atlases asked for before the frame data arrived - loaded right after. */
    private pendingAtlases: Atlas[] = [];
    /** Resolves once the atlas frame data is there: games, spectating, replays and the
     *  loadout preview wait for it (they build sprites from the atlases right away). */
    readonly ready: Promise<void>;

    constructor(
        public renderer: PIXI.IRenderer,
        public audioManager: AudioManager,
        public config: ConfigManager,
        public basePath = "",
    ) {
        this.textureRes = selectTextureRes(this.renderer, this.config);
        PIXI.BasePrepare.uploadsPerFrame = 1;
        this.ready = importAtlasDefs(this.textureRes).then((defs) => {
            this.defs = defs;
            this.atlasDefsReady = true;
            const pending = this.pendingAtlases;
            this.pendingAtlases = [];
            for (const name of pending) this.loadAtlasSheets(name);
        });
    }

    isAtlasLoaded(name: Atlas) {
        return this.atlases[name]?.loaded;
    }

    atlasTexturesLoaded(name: Atlas) {
        if (!this.isAtlasLoaded(name)) {
            return false;
        }

        if (this.pendingAtlases.includes(name)) return false;
        const atlas = this.atlases[name];
        for (let i = 0; i < atlas.spritesheets.length; i++) {
            const spritesheet = atlas.spritesheets[i];
            if (!spritesheet.baseTexture.valid) {
                return false;
            }
        }

        return true;
    }

    loadAtlas(name: Atlas) {
        if (this.isAtlasLoaded(name)) {
            return;
        }

        console.log("Load atlas", name);

        this.atlases[name] = this.atlases[name] || {
            loaded: false,
            spritesheets: [],
        };
        if (!this.defs) {
            // counts as loaded already (no double loads); the sheets follow the data
            this.atlases[name].loaded = true;
            this.pendingAtlases.push(name);
            return;
        }
        this.loadAtlasSheets(name);
    }

    private loadAtlasSheets(name: Atlas) {
        const atlasDef = this.defs![name];
        for (let i = 0; i < atlasDef.length; i++) {
            const atlas = loadSpritesheet(this.renderer, this.basePath, atlasDef[i]);
            this.atlases[name].spritesheets.push(atlas);
        }
        this.atlases[name].loaded = true;
    }

    unloadAtlas(name: Atlas) {
        if (!this.isAtlasLoaded(name)) {
            return;
        }

        console.log("Unload atlas", name);
        this.pendingAtlases = this.pendingAtlases.filter((a) => a !== name);

        const atlas = this.atlases[name];
        for (let i = 0; i < atlas.spritesheets.length; i++) {
            atlas.spritesheets[i].destroy(true);
        }
        atlas.loaded = false;
        atlas.spritesheets = [];
    }

    /**
     * Loads every atlas holding a sprite of `types` (map object types, children
     * included) that no loaded atlas has, and the map sounds they use. Each map only
     * loads its own atlases and sounds, but a custom map can place buildings from
     * other maps.
     */
    loadAssetsForObjects(types: Iterable<string>) {
        if (!this.defs) {
            const list = [...types];
            void this.ready.then(() => this.loadAssetsForObjects(list));
            return;
        }
        const { sprites, strings } = collectObjectRefs(types);
        const mapSounds = getMapSounds();
        setTimeout(() => {
            for (const name of strings) {
                const sound = mapSounds.get(name);
                if (sound) this.loadMapSound(sound);
            }
        }, 0);

        const defs = this.defs;
        const has = (atlas: Atlas, sprite: string) =>
            (defs[atlas] ?? []).some((sheet) => sprite in sheet.frames);
        const loaded = (Object.keys(this.atlases) as Atlas[]).filter((a) => this.isAtlasLoaded(a));
        let missing = [...sprites].filter((s) => !loaded.some((a) => has(a, s)));
        const candidates = (Object.keys(defs) as Atlas[]).filter((a) => a !== "skins" && !loaded.includes(a));
        // greedy: the atlas covering the most missing sprites first, so as few as possible load
        while (missing.length && candidates.length) {
            let best = -1;
            let bestCount = 0;
            candidates.forEach((a, i) => {
                const count = missing.filter((s) => has(a, s)).length;
                if (count > bestCount) {
                    best = i;
                    bestCount = count;
                }
            });
            if (best < 0) break; // the rest is in no atlas at all
            const [atlas] = candidates.splice(best, 1);
            this.loadAtlas(atlas);
            missing = missing.filter((s) => !has(atlas, s));
        }
    }

    loadMapAssets(mapName: string) {
        console.log("Load map", mapName);

        const mapDef = MapDefs[mapName as MapDefKey];
        if (!mapDef) {
            throw new Error(`Failed loading mapDef ${this.mapName}`);
        }

        //
        // Textures
        //
        const atlasList = mapDef.assets.atlases;

        // Unload all atlases that aren't in the new list
        const keys = Object.keys(this.atlases) as Atlas[];
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (!atlasList.includes(key)) {
                this.unloadAtlas(key);
            }
        }

        // Load all new atlases
        for (let i = 0; i < atlasList.length; i++) {
            const atlas = atlasList[i];
            if (!this.isAtlasLoaded(atlas)) {
                this.loadAtlas(atlas);
            }
        }

        //
        // Audio
        //
        // PIXI spritesheets internally defer loading textures if the spritesheet
        // has more than 1000 images as a part of its internal batching process.
        //
        // Because we want images to load before audio, we'll also defer loading
        // audio in a similar fashion.
        setTimeout(() => {
            // Load shared audio
            this.audioManager.preloadSounds();

            // Load audio specific to the map
            for (const sound of mapDef.assets.audio) this.loadMapSound(sound);
        }, 0);
    }

    /** Sounds loaded on top of the shared ones (per map, plus what custom maps pull in). */
    private loadedMapSounds = new Set<string>();

    private loadMapSound(sound: { name: string; channel: string }) {
        if (this.loadedMapSounds.has(sound.name)) return;
        // @HACK: Sometimes the channel doesn't correspond to where
        // the sound is defined in sound-defs.js; this is the case
        // with "players" sounds. Use an alternate method for looking
        // up the sound def.
        let soundsList = SoundDefs.Sounds[sound.channel];
        if (!soundsList) {
            const channelDef = SoundDefs.Channels[sound.channel];
            soundsList = SoundDefs.Sounds[channelDef.list];
        }

        const soundDef = soundsList?.[sound.name];
        if (!soundDef) return;
        this.loadedMapSounds.add(sound.name);

        const options = {
            canCoalesce: soundDef.canCoalesce!,
            channels: soundDef.maxInstances,
            volume: soundDef.volume,
        };

        this.audioManager.loadSound({
            name: sound.name,
            channel: sound.channel,
            path: soundDef.path,
            options,
        });
    }

    update(dt: number) {
        // Debug
        if (!this.loaded) {
            this.loadTicker += dt;

            let loaded = !this.preloadMap;
            const keys = Object.keys(this.atlases) as Atlas[];
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                if (!this.atlasTexturesLoaded(key)) {
                    loaded = false;
                }
            }
            if (!this.audioManager.allLoaded()) {
                loaded = false;
            }

            if (loaded) {
                console.log("Resource load complete", this.loadTicker.toFixed(2));
                this.loaded = true;
            }
        }
    }
}
