import * as PIXI from "pixi.js-legacy";

/**
 * Loads the player sprites that `getOutfitIconUrl` composes outfit previews from
 * (see loadoutIcon.ts) into PIXI's global texture cache.
 *
 * The game already has these: it loads the loadout atlas along with its map
 * assets. Pages that render skins without ever loading a map — the stats page —
 * have an empty texture cache, so the compositor bails and skins fall back to a
 * flat tinted shirt. Calling this first makes them render as they do in game.
 *
 * The "skins" atlas is a subset of the loadout atlas holding just those player
 * sprites (~0.7MB vs ~3MB). Both the frame data and the sheet are fetched on
 * demand, so pages that never show a skin pay nothing.
 */

let loadPromise: Promise<void> | undefined;

async function parseSheet(basePath: string, data: PIXI.ISpritesheetData): Promise<void> {
    const baseTex = PIXI.BaseTexture.from(basePath + data.meta.image!);

    if (!baseTex.valid) {
        await new Promise<void>((resolve, reject) => {
            baseTex.once("loaded", () => resolve());
            baseTex.once("error", () =>
                reject(new Error(`Failed to load atlas image ${data.meta.image}`)),
            );
        });
    }

    const sheet = new PIXI.Spritesheet(baseTex, data);
    sheet.resolution = baseTex.resolution;
    // Populates PIXI.utils.TextureCache, which is what the compositor reads.
    await sheet.parse();
}

/**
 * Resolves once skin previews can be composed. Idempotent — concurrent callers
 * share one load. Rejects if the atlas can't be fetched; callers should treat
 * that as "keep the shirt fallback", not as fatal.
 *
 * `basePath` prefixes the sheet's image path. Pass "/" from any page not served
 * at the site root (the stats page is served from /stats/): a build rewrites the
 * path to "assets/…", which would otherwise resolve to /stats/assets/… and 404.
 * "/" is also correct in dev, where the path points into the builder's on-disk
 * cache as "../node_modules/…" and the leading ".." is clamped at the root.
 */
export function loadSkinsAtlas(basePath = ""): Promise<void> {
    loadPromise ??= (async () => {
        // Low res only: previews are small, and it halves the download.
        const { default: sheets } = await import("virtual-atlas-skins-low");
        await Promise.all(sheets.map((data) => parseSheet(basePath, data)));
    })().catch((err) => {
        // Let a later call retry rather than caching the failure forever.
        loadPromise = undefined;
        throw err;
    });

    return loadPromise;
}
