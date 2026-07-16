import fs from "node:fs";
import Path from "node:path";
import { GameObjectDefs } from "../../../shared/defs/gameObjectDefs";
import type { OutfitDef } from "../../../shared/defs/gameObjects/outfitDefs";
import type { AtlasDef } from "../atlasDefs";

/**
 * The player sprites needed to compose outfit previews (body + backpack + fists
 * + accessory) — see `getOutfitIconUrl` in client/src/ui/loadoutIcon.ts.
 *
 * These all also live in the loadout atlas, which the game loads with its map
 * assets. This atlas exists for pages that render skins but load no map (the
 * stats page): it holds only the player sprites, so it costs ~0.7MB instead of
 * the loadout sheet's ~3MB. It is deliberately absent from every mapDef's
 * `assets.atlases` — only an explicit `loadAtlas("skins")` fetches it.
 *
 * The list is derived from the outfit defs rather than hand-maintained, so a new
 * skin can't be forgotten here and silently fall back to a plain tinted shirt.
 */

const imageFolder = Path.resolve(import.meta.dirname, "../../public/img");

/** Every image under public/img, by lowercased file name. */
function indexImages(): Map<string, string> {
    const index = new Map<string, string>();
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const path = Path.join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else index.set(entry.name.toLowerCase(), path);
        }
    };
    walk(imageFolder);
    return index;
}

function skinSprites(): string[] {
    const index = indexImages();
    const images = new Set<string>();

    for (const def of Object.values(GameObjectDefs)) {
        const outfit = def as OutfitDef;
        // Mirrors `getComposableOutfit`: costumes render as an obstacle and
        // ghillie as foliage, so they're never composed as a character.
        if (outfit.type !== "outfit" || outfit.ghillie || outfit.obstacleType) continue;

        const img = outfit.skinImg;
        // The layers buildOutfitContent draws. footSprite is not among them.
        for (const sprite of [
            img.baseSprite,
            img.handSprite,
            img.backpackSprite,
            img.frontSprite,
        ]) {
            if (!sprite) continue;
            const base = sprite.replace(/\.img$/, "").toLowerCase();
            const file = index.get(`${base}.svg`) ?? index.get(`${base}.png`);
            // A sprite with no art file is already broken in game; the atlas
            // builder would throw on it, so leave it out and let the compositor
            // skip that layer.
            if (file) {
                images.add(Path.relative(imageFolder, file).replace(/\\/g, "/"));
            }
        }
    }

    return [...images].sort();
}

export const SkinsAtlas: AtlasDef = {
    // Same as the loadout atlas: too many colors for 256-color quantization.
    compress: false,
    images: skinSprites(),
};
