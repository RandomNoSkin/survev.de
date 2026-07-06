import fs from "node:fs";
import Path from "node:path";
import { createCanvas, loadImage } from "canvas";
import sharp from "sharp";
import {
    atlasLogger,
    type ImgCache,
    imageFolder,
    imagesCacheFolder,
} from "./atlasBuilder";
import { scaledSprites } from "./atlasDefs";
import { detectEdges, type Edges } from "./detectEdges";

const tmpCanvas = createCanvas(0, 0);
const tmpCtx = tmpCanvas.getContext("2d");

/**
 * Some SVGs are just a thin wrapper around a single embedded base64 raster
 * (`<image href="data:image/png;base64,...">`). Older librsvg (e.g. on the production
 * box) can't decode `data:` URIs and renders them fully transparent, which then fails
 * edge detection ("Can't detect edges") and ships a blank sprite.
 *
 * For a *pure* wrapper (the raster is the only content) we decode it ourselves and hand
 * the raw PNG/JPEG bytes to node-canvas, which decodes them without librsvg — fastest and
 * keeps the raster's native resolution. Returns the raster bytes, or null when the SVG has
 * real vector content (e.g. a clip-path shaping the raster) that must actually be rendered.
 */
function extractWrapperRaster(txt: string): Buffer | null {
    const m = txt.match(/data:image\/(?:png|jpe?g);base64,([^"']+)/);
    if (!m) return null;
    // Only when the embedded raster is the sole content (no vector elements to render).
    if ((txt.match(/<image\b/g) || []).length !== 1) return null;
    if (
        /<(?:path|rect|circle|ellipse|polygon|polyline|line|text|tspan|use|symbol|pattern|lineargradient|radialgradient|stop|g)\b/i.test(
            txt,
        )
    ) {
        return null;
    }
    return Buffer.from(m[1].replace(/\s/g, ""), "base64");
}

/**
 * Loads a sprite as a node-canvas image, working around the old-librsvg `data:` URI bug.
 *
 * SVGs that embed a base64 raster but ALSO carry vector content (typically a `<clip-path>`
 * shaping the raster — e.g. player-base-outfitGalaxy/Diamond/Damascussteel) can't take the
 * pure-wrapper shortcut, and node-canvas' librsvg blanks the raster on the prod box. For those
 * we rasterize with sharp, which bundles its own modern librsvg (independent of the system one),
 * then feed node-canvas the resulting PNG — so clip + transforms are preserved and it renders on
 * every environment. Plain vector SVGs (no embedded raster) keep going straight through librsvg.
 */
async function loadSpriteImage(fullPath: string) {
    if (!fullPath.endsWith(".svg")) return loadImage(fullPath);

    const txt = fs.readFileSync(fullPath, "utf8");
    if (!/data:image\/(?:png|jpe?g);base64,/.test(txt)) {
        return loadImage(fullPath); // plain vector SVG — librsvg handles it fine
    }

    const raster = extractWrapperRaster(txt);
    if (raster) {
        try {
            return await loadImage(raster);
        } catch {
            // Rare: the embedded raster has a chunk node-canvas' libpng rejects. Fall
            // through to sharp, which decodes it.
        }
    }

    try {
        const png = await sharp(fullPath).png().toBuffer();
        return await loadImage(png);
    } catch {
        return loadImage(fullPath); // last resort: original (possibly-blank) behaviour
    }
}

async function renderImage(path: string, hash: string) {
    const pngFileName = Path.join(imagesCacheFolder, `${hash}.png`);

    const scale = scaledSprites[path] ?? 1;

    const fullPath = Path.join(imageFolder, path);
    const image = await loadSpriteImage(fullPath);
    tmpCanvas.width = Math.ceil(image.width * scale);
    tmpCanvas.height = Math.ceil(image.height * scale);

    tmpCtx.drawImage(image, 0, 0, tmpCanvas.width, tmpCanvas.height);

    let edges: Edges;

    try {
        edges = detectEdges(tmpCanvas, {
            tolerance: 0,
        });
    } catch (error) {
        atlasLogger.error(`Failed to detect edges for ${path}`, error);
        edges = {
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
        };
    }

    const buff = tmpCanvas.toBuffer("image/png");
    fs.writeFileSync(pngFileName, buff);

    return edges;
}

export interface ParentMsg {
    images: Array<{ path: string; hash: string }>;
}

process.on("message", async (data: ParentMsg) => {
    const images: ImgCache = {};

    for (const image of data.images) {
        const edges = await renderImage(image.path, image.hash);
        images[image.path] = {
            hash: image.hash,
            edges,
        };
    }

    process.send!(images);
});
