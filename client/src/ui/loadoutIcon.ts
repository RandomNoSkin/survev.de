import * as PIXI from "pixi.js-legacy";
import { GameObjectDefs } from "../../../shared/defs/gameObjectDefs";
import type { OutfitDef } from "../../../shared/defs/gameObjects/outfitDefs";

/**
 * Renders full top-down character previews for outfits — body + backpack + fists
 * (+ skin accessory) — mirroring the in-game player composition, so every skin
 * shows how it actually looks in game instead of a generic shirt. The rendered
 * PNG data URL is cached per outfit and produced with an offscreen PIXI renderer
 * that reuses the same atlas textures, scales and tints as `Player.updateVisuals`.
 */

// Layer scales and the idle "fists" hand pose, taken verbatim from
// Player.updateVisuals (objects/player.ts) and IdlePoses.fists (animData.ts) so
// the icon matches the in-game character exactly.
const BODY_SCALE = 0.25;
const HAND_SCALE = 0.175;
const BACKPACK_SCALE = 0.215; // pack level 1: (0.4 + 1 * 0.03) * 0.5
const FRONT_SCALE = 0.27;
const BACKPACK_OFFSET = 10.25; // bagOffsets[0]
const HAND_L = { x: 14, y: -12.25 };
const HAND_R = { x: 14, y: 12.25 };

// Higher-res render so the icon stays crisp when scaled in the grid.
const ICON_RESOLUTION = 5;

const iconCache = new Map<string, string | null>();
let renderer: PIXI.IRenderer | undefined;

function getRenderer(): PIXI.IRenderer {
    if (!renderer) {
        renderer = PIXI.autoDetectRenderer({
            width: 256,
            height: 256,
            backgroundAlpha: 0,
            antialias: true,
        });
    }
    return renderer;
}

function hasTexture(name?: string): name is string {
    return !!name && !!PIXI.utils.TextureCache[name];
}

function addLayer(
    parent: PIXI.Container,
    sprite: string | undefined,
    tint: number,
    x: number,
    y: number,
    scale: number,
): void {
    if (!hasTexture(sprite)) return;
    const s = PIXI.Sprite.from(sprite);
    s.anchor.set(0.5);
    s.tint = tint;
    s.position.set(x, y);
    s.scale.set(scale);
    parent.addChild(s);
}

// Costumes render as an obstacle and ghillie as foliage, not as a character, so a
// composed body preview would be misleading — those are never composed.
function getComposableOutfit(outfitType: string): OutfitDef | null {
    const def = GameObjectDefs[outfitType] as OutfitDef | undefined;
    if (!def || def.type !== "outfit" || def.ghillie || def.obstacleType) {
        return null;
    }
    return def;
}

/**
 * Builds the layered character container (body + backpack + fists + accessory),
 * rotated to the icon orientation. Returns `null` if the atlas textures aren't
 * loaded yet. The caller owns the container and must `destroy` it.
 */
function buildOutfitContent(def: OutfitDef): PIXI.Container | null {
    const img = def.skinImg;
    // The atlas may not be parsed yet.
    if (!hasTexture(img.baseSprite)) return null;

    // Compose the layers bottom-to-top, matching the in-game child order.
    const content = new PIXI.Container();
    addLayer(content, img.backpackSprite, img.backpackTint, -BACKPACK_OFFSET, 0, BACKPACK_SCALE);
    addLayer(content, img.baseSprite, img.baseTint, 0, 0, BODY_SCALE);

    const fp = img.frontSpritePos ?? { x: 0, y: 0 };
    if (img.frontSprite && !img.aboveHand) {
        addLayer(content, img.frontSprite, 0xffffff, fp.x, fp.y, FRONT_SCALE);
    }
    addLayer(content, img.handSprite, img.handTint, HAND_L.x, HAND_L.y, HAND_SCALE);
    addLayer(content, img.handSprite, img.handTint, HAND_R.x, HAND_R.y, HAND_SCALE);
    if (img.frontSprite && img.aboveHand) {
        addLayer(content, img.frontSprite, 0xffffff, fp.x, fp.y, FRONT_SCALE);
    }

    // The player model faces +x; rotate so the icon is oriented like the other
    // (hand-drawn) loadout icons.
    content.rotation = Math.PI / 2;
    return content;
}

/**
 * Returns a PNG data URL of the composed character preview for `outfitType`, or
 * `null` if it can't be rendered (not an outfit, a costume/ghillie skin, or the
 * atlas textures aren't loaded yet — in which case the caller should fall back
 * and can retry once the atlas is ready).
 */
export function getOutfitIconUrl(outfitType: string): string | null {
    const cached = iconCache.get(outfitType);
    if (cached !== undefined) return cached;

    const def = getComposableOutfit(outfitType);
    if (!def) {
        iconCache.set(outfitType, null);
        return null;
    }

    const content = buildOutfitContent(def);
    if (!content) return null; // atlas not ready — retry later

    const root = new PIXI.Container();
    root.addChild(content);

    // Square icon with a margin so the character sits a bit smaller in the grid
    // cell (like the hand-drawn icons), centred regardless of its aspect ratio.
    const bounds = root.getLocalBounds();
    const maxDim = Math.max(bounds.width, bounds.height, 1);
    const size = Math.ceil(maxDim * 1.2);
    content.position.set(
        size / 2 - (bounds.x + bounds.width / 2),
        size / 2 - (bounds.y + bounds.height / 2),
    );

    const renderTexture = PIXI.RenderTexture.create({
        width: size,
        height: size,
        resolution: ICON_RESOLUTION,
    });

    let url: string | null = null;
    try {
        const r = getRenderer();
        r.render(root, { renderTexture });
        const canvas = r.extract.canvas(renderTexture) as HTMLCanvasElement;
        url = canvas.toDataURL("image/png");
    } catch {
        url = null;
    } finally {
        renderTexture.destroy(true);
        root.destroy({ children: true });
    }

    // Only remember successful renders — a failure is likely a not-yet-ready atlas.
    if (url) iconCache.set(outfitType, url);
    return url;
}

// Loot textures are rendered with the live game renderer (so they can be used
// directly by in-game loot sprites) and are therefore tied to that renderer's GL
// context — cache them per-renderer and drop the cache when it changes (new game).
const LOOT_RESOLUTION = 5;
let lootRenderer: PIXI.IRenderer | undefined;
const lootTextureCache = new Map<string, PIXI.RenderTexture>();

/**
 * Returns a texture of the composed character for use by in-game loot sprites,
 * rendered with the passed game `renderer` so it lives in the same GL context.
 * Returns `null` for non-composable skins or before the atlas is ready.
 */
export function getOutfitLootTexture(
    outfitType: string,
    renderer: PIXI.IRenderer,
): PIXI.RenderTexture | null {
    if (lootRenderer !== renderer) {
        lootTextureCache.forEach((tex) => tex.destroy(true));
        lootTextureCache.clear();
        lootRenderer = renderer;
    }

    const cached = lootTextureCache.get(outfitType);
    if (cached) return cached;

    const def = getComposableOutfit(outfitType);
    if (!def) return null;

    const content = buildOutfitContent(def);
    if (!content) return null; // atlas not ready — retry later

    const root = new PIXI.Container();
    root.addChild(content);

    let texture: PIXI.RenderTexture | null = null;
    try {
        texture = renderer.generateTexture(root, { resolution: LOOT_RESOLUTION });
    } catch {
        texture = null;
    } finally {
        root.destroy({ children: true });
    }

    if (texture) lootTextureCache.set(outfitType, texture);
    return texture;
}
