import fs from "node:fs";
import Path from "node:path";
import { createCanvas, loadImage } from "canvas";
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
 * For these pure wrappers we decode the embedded raster ourselves and hand the raw
 * PNG/JPEG bytes to node-canvas, which decodes them without librsvg — so it works on
 * every environment. Returns the raster bytes, or null when the SVG has real vector
 * content that must actually be rasterized.
 */
function extractWrapperRaster(file: string): Buffer | null {
    const txt = fs.readFileSync(file, "utf8");
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

async function renderImage(path: string, hash: string) {
    const pngFileName = Path.join(imagesCacheFolder, `${hash}.png`);

    const scale = scaledSprites[path] ?? 1;

    const fullPath = Path.join(imageFolder, path);
    const embedded = path.endsWith(".svg") ? extractWrapperRaster(fullPath) : null;
    let image: Awaited<ReturnType<typeof loadImage>>;
    if (embedded) {
        try {
            image = await loadImage(embedded);
        } catch {
            // Rare: the embedded raster has a chunk node-canvas' libpng rejects but
            // librsvg tolerates. Fall back to rendering the SVG itself.
            image = await loadImage(fullPath);
        }
    } else {
        image = await loadImage(fullPath);
    }
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
