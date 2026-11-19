import { MapObjectDefs } from "../../../shared/defs/register.ts";
import type { Collider } from "../../../shared/utils/coldet.ts";
import { collider } from "../../../shared/utils/collider.ts";
import { mapHelpers } from "../../../shared/utils/mapHelpers.ts";
import { math } from "../../../shared/utils/math.ts";
import { type Vec2, v2 } from "../../../shared/utils/v2.ts";

interface Shape {
    col: Collider;
    color: number;
    scale: number;
}

type Def = {
    type?: string;
    map?: { display?: boolean; color?: number; scale?: number; shapes?: { collider: Collider; color: number; scale?: number }[] };
    layers?: { type: string; pos: Vec2; ori: number }[];
};

/** Same shapes the minimap draws for a building; structures use their surface layer. */
function collect(type: string, pos: Vec2, ori: number, out: Shape[], depth = 0) {
    const def = MapObjectDefs.typeToDefSafe(type) as Def | undefined;
    if (!def || depth > 3) return;
    if (def.type === "structure") {
        const top = def.layers?.[0];
        if (top) {
            const lpos = v2.add(pos, v2.rotate(top.pos, math.oriToRad(ori)));
            collect(top.type, lpos, (ori + top.ori) % 4, out, depth + 1);
        }
        return;
    }
    const rot = math.oriToRad(ori);
    if (def.map?.shapes?.length) {
        for (const s of def.map.shapes) {
            out.push({ col: collider.transform(s.collider, pos, rot, 1), color: s.color, scale: s.scale ?? 1 });
        }
        return;
    }
    const bounds = mapHelpers.getBoundingCollider(type);
    if (bounds) {
        out.push({ col: collider.transform(bounds, pos, rot, 1), color: def.map?.color ?? 0x6b6b6b, scale: def.map?.scale ?? 1 });
    }
}

interface SpriteImg {
    sprite: string;
    pos?: Vec2;
    scale: number;
    alpha?: number;
    tint?: number;
    rot?: number;
    mirrorX?: boolean;
    mirrorY?: boolean;
}

type MapObjDef = {
    type?: string;
    img?: SpriteImg;
    floor?: { imgs?: SpriteImg[] };
    ceiling?: { imgs?: SpriteImg[] };
    layers?: { type: string; pos: Vec2; ori: number }[];
    mapObjects?: { type?: string | Record<string, number>; pos: Vec2; ori: number; scale?: number; inheritOri?: boolean }[];
};

/** One sprite to draw: world position (y up) and its look. */
interface DrawOp {
    sprite: string;
    x: number;
    y: number;
    /** canvas rotation in radians (clockwise) */
    rot: number;
    scale: number;
    alpha: number;
    tint?: number;
    mirrorX?: boolean;
    mirrorY?: boolean;
}

/** A random child (weighted object) is drawn as its most likely pick. */
function childType(t: string | Record<string, number> | undefined) {
    if (!t) return "";
    if (typeof t === "string") return t;
    let best = "";
    let bestW = -1;
    for (const [k, w] of Object.entries(t)) {
        if (w > bestW) {
            best = k;
            bestW = w;
        }
    }
    return best;
}

/** Same placement as the server (math.addAdjust): quarter turns counterclockwise, y up. */
function turn(p: Vec2, ori: number): Vec2 {
    switch (((ori % 4) + 4) % 4) {
        case 1:
            return v2.create(-p.y, p.x);
        case 2:
            return v2.create(-p.x, -p.y);
        case 3:
            return v2.create(p.y, -p.x);
        default:
            return v2.create(p.x, p.y);
    }
}

/**
 * Everything the object shows from above, back to front: a building's floor, then its
 * child objects (bushes of a brush clump, crates, walls...), then its roof; a
 * structure (bunker) its underground part faded, then the surface.
 */
function collectDraws(type: string, pos: Vec2, ori: number, scale: number, alpha: number, out: DrawOp[], depth = 0) {
    const def = MapObjectDefs.typeToDefSafe(type) as MapObjDef | undefined;
    if (!def || depth > 4) return;
    const rad = math.oriToRad(ori);
    const addImg = (img: SpriteImg) => {
        if (!img.sprite || img.sprite === "none") return;
        const at = v2.add(pos, turn(v2.mul(img.pos ?? v2.create(0, 0), scale), ori));
        out.push({
            sprite: img.sprite,
            x: at.x,
            y: at.y,
            rot: -rad + math.oriToRad(img.rot ?? 0),
            scale: img.scale * scale,
            alpha: (img.alpha ?? 1) * alpha,
            tint: img.tint,
            mirrorX: img.mirrorX,
            mirrorY: img.mirrorY,
        });
    };
    if (def.type === "obstacle") {
        if (def.img) addImg({ ...def.img, pos: v2.create(0, 0), rot: 0 });
        return;
    }
    if (def.type === "structure") {
        const layers = def.layers ?? [];
        // underground first and faded, the surface on top
        for (const l of layers.slice(1)) {
            collectDraws(l.type, v2.add(pos, turn(l.pos, ori)), (l.ori + ori) % 4, scale, alpha * 0.45, out, depth + 1);
        }
        const top = layers[0];
        if (top) collectDraws(top.type, v2.add(pos, turn(top.pos, ori)), (top.ori + ori) % 4, scale, alpha, out, depth + 1);
        return;
    }
    if (def.type !== "building") return;
    for (const img of def.floor?.imgs ?? []) addImg(img);
    for (const child of def.mapObjects ?? []) {
        const t = childType(child.type);
        if (!t) continue;
        const childOri = child.inheritOri === false ? child.ori : (child.ori + ori) % 4;
        collectDraws(t, v2.add(pos, turn(v2.mul(child.pos, scale), ori)), childOri, scale * (child.scale ?? 1), alpha, out, depth + 1);
    }
    for (const img of def.ceiling?.imgs ?? []) addImg(img);
}

const svgCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadSvg(sprite: string) {
    let p = svgCache.get(sprite);
    if (!p) {
        p = new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = `img/map/${sprite.replace(/\.img$/, ".svg")}`;
        });
        svgCache.set(sprite, p);
    }
    return p;
}

/** Game sprites are drawn at (svg px * scale) screen px at 16 px per world unit. */
const PX_PER_UNIT = 16;

const spriteCache = new Map<string, Promise<string>>();

/**
 * Data URL of the object drawn with its real sprites, like in the game seen from
 * above (see collectDraws). Resolves "" when it has none; shapes are the fallback.
 */
export function buildingSpriteUrl(type: string, size = 96): Promise<string> {
    const key = `${type}:${size}`;
    let hit = spriteCache.get(key);
    if (hit) return hit;
    hit = (async () => {
        const ops: DrawOp[] = [];
        collectDraws(type, v2.create(0, 0), 0, 1, 1, ops);
        if (!ops.length) return "";
        const loaded = await Promise.all(ops.map((o) => loadSvg(o.sprite)));
        const parts = ops.flatMap((op, i) => {
            const el = loaded[i];
            if (!el || !el.naturalWidth) return [];
            const w = (el.naturalWidth * op.scale) / PX_PER_UNIT;
            const h = (el.naturalHeight * op.scale) / PX_PER_UNIT;
            const c = Math.abs(Math.cos(op.rot));
            const s = Math.abs(Math.sin(op.rot));
            return [{ op, el, w, h, ex: (w * c + h * s) / 2, ey: (w * s + h * c) / 2 }];
        });
        if (!parts.length) return "";
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of parts) {
            minX = Math.min(minX, p.op.x - p.ex);
            maxX = Math.max(maxX, p.op.x + p.ex);
            // canvas y points down
            minY = Math.min(minY, -p.op.y - p.ey);
            maxY = Math.max(maxY, -p.op.y + p.ey);
        }
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d")!;
        const pad = 3;
        const scale = (size - pad * 2) / Math.max(maxX - minX, maxY - minY, 1);
        const ox = (size - (maxX - minX) * scale) / 2 - minX * scale;
        const oy = (size - (maxY - minY) * scale) / 2 - minY * scale;
        for (const p of parts) {
            ctx.save();
            ctx.globalAlpha = p.op.alpha;
            ctx.translate(ox + p.op.x * scale, oy - p.op.y * scale);
            ctx.rotate(p.op.rot);
            ctx.scale(p.op.mirrorX ? -1 : 1, p.op.mirrorY ? -1 : 1);
            ctx.drawImage(tint(p.el, p.op.tint), (-p.w * scale) / 2, (-p.h * scale) / 2, p.w * scale, p.h * scale);
            ctx.restore();
        }
        return canvas.toDataURL();
    })().catch(() => "");
    spriteCache.set(key, hit);
    return hit;
}

/**
 * An <img> of the object: its map shape right away, swapped for the real sprites
 * once they loaded. Objects with neither show an empty-set mark.
 */
export function objectPreviewImg(type: string, size: number, className: string): HTMLImageElement {
    const img = document.createElement("img");
    img.className = className;
    img.alt = "";
    const shape = buildingPreviewUrl(type, size);
    if (shape) img.src = shape;
    else img.classList.add("custom-map-preview-none");
    buildingSpriteUrl(type, size).then((url) => {
        if (!url) return;
        img.src = url;
        img.classList.remove("custom-map-preview-none");
    });
    return img;
}

/** Multiplies the image by `color` like a PIXI tint (white = unchanged). */
function tint(el: HTMLImageElement, color: number | undefined): CanvasImageSource {
    if (color === undefined || color === 0xffffff) return el;
    const c = document.createElement("canvas");
    c.width = el.naturalWidth;
    c.height = el.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(el, 0, 0);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(el, 0, 0);
    return c;
}

const cache = new Map<string, string>();

/** Data URL of a building as it appears on the map; "" when it has nothing to draw. */
export function buildingPreviewUrl(type: string, size = 96): string {
    const key = `${type}:${size}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    const shapes: Shape[] = [];
    collect(type, v2.create(0, 0), 0, shapes);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const extend = (x0: number, y0: number, x1: number, y1: number) => {
        minX = Math.min(minX, x0); minY = Math.min(minY, y0);
        maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
    };
    for (const s of shapes) {
        if (s.col.type === collider.Type.Circle) {
            const r = s.col.rad * s.scale;
            extend(s.col.pos.x - r, s.col.pos.y - r, s.col.pos.x + r, s.col.pos.y + r);
        } else {
            extend(s.col.min.x, s.col.min.y, s.col.max.x, s.col.max.y);
        }
    }
    if (!shapes.length || !Number.isFinite(minX)) {
        cache.set(key, "");
        return "";
    }

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const pad = 4;
    const scale = (size - pad * 2) / Math.max(maxX - minX, maxY - minY, 1);
    const ox = pad + ((size - pad * 2) - (maxX - minX) * scale) / 2;
    const oy = pad + ((size - pad * 2) - (maxY - minY) * scale) / 2;
    // world y points up, canvas y points down
    const tx = (x: number) => ox + (x - minX) * scale;
    const ty = (y: number) => oy + (maxY - y) * scale;
    for (const s of shapes) {
        ctx.fillStyle = `#${s.color.toString(16).padStart(6, "0")}`;
        if (s.col.type === collider.Type.Circle) {
            ctx.beginPath();
            ctx.arc(tx(s.col.pos.x), ty(s.col.pos.y), s.col.rad * s.scale * scale, 0, Math.PI * 2);
            ctx.fill();
        } else {
            const cx = (s.col.min.x + s.col.max.x) / 2;
            const cy = (s.col.min.y + s.col.max.y) / 2;
            const hw = ((s.col.max.x - s.col.min.x) / 2) * s.scale;
            const hh = ((s.col.max.y - s.col.min.y) / 2) * s.scale;
            ctx.fillRect(tx(cx - hw), ty(cy + hh), hw * 2 * scale, hh * 2 * scale);
        }
    }
    const url = canvas.toDataURL();
    cache.set(key, url);
    return url;
}
