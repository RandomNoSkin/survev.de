import $ from "jquery";
import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import { UnlockDefs } from "../../../../shared/defs/gameObjects/unlockDefs";
import { getItemPrice, getItemRarity } from "../../../../shared/defs/shopConfig";
import { helpers } from "../../helpers";
import { loadSkinsAtlas } from "../../ui/skinsAtlas";

/** Scoped styles for the read-only loadout viewer modal (self-contained, injected once). */
export const LOADOUT_MODAL_CSS = `
.loadout-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:10000;}
.loadout-modal{background:#2a2a2a;border:2px solid #f2d63b;border-radius:10px;width:680px;max-width:92vw;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;color:#fff;}
.ld-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:#1e1e1e;font-weight:700;font-size:18px;}
.ld-close{cursor:pointer;padding:0 6px;line-height:1;}
.ld-valuebar{display:flex;align-items:center;gap:6px;padding:9px 18px;background:#252525;border-bottom:1px solid rgba(255,255,255,0.08);font-size:13px;color:#ccc;}
.ld-value-num{font-weight:700;color:#f2d63b;}
.ld-fries{width:16px;height:16px;display:inline-block;background:url('/img/gui/golden-fries.svg') center/contain no-repeat;}
.ld-body{padding:16px;overflow-y:auto;}
.ld-section{font-weight:700;color:#f2d63b;margin:6px 2px 10px;text-transform:uppercase;font-size:13px;letter-spacing:.5px;}
.ld-count{color:#9a9a9a;font-weight:400;font-size:12px;}
.ld-grid{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;}
.ld-tile{width:104px;box-sizing:border-box;background:rgba(255,255,255,0.05);border:1px solid transparent;border-radius:8px;padding:6px;text-align:center;}
.ld-tile-market{border-color:#1e90ff;cursor:pointer;}
.ld-tile-market:hover{background:rgba(30,144,255,0.15);}
.ld-badges{display:flex;flex-wrap:wrap;gap:4px;justify-content:center;min-height:15px;}
.ld-badge{font-size:9px;font-weight:700;padding:1px 5px;border-radius:6px;line-height:14px;}
.ld-badge-eq{background:#2e7d32;color:#fff;}
.ld-badge-count{background:rgba(255,255,255,0.15);color:#ddd;}
.ld-img{width:64px;height:64px;margin:5px auto;background-size:contain;background-repeat:no-repeat;background-position:center;}
.ld-name{font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ld-rarity{font-size:11px;font-weight:700;}
.ld-market{margin-top:4px;font-size:10px;font-weight:700;color:#4da3ff;}
.ld-offer-btn{margin-top:6px;font-size:10px;font-weight:700;color:#1e1e1e;background:#f2d63b;border-radius:5px;padding:3px 0;cursor:pointer;user-select:none;}
.ld-offer-btn:hover{filter:brightness(92%);}
.ld-empty{color:#9a9a9a;padding:10px 2px;font-size:14px;}
.ld-offer-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:10001;}
.ld-offer-dialog{background:#2a2a2a;border:2px solid #f2d63b;border-radius:10px;padding:18px;width:340px;max-width:92vw;color:#fff;box-sizing:border-box;}
.ld-offer-title{font-weight:700;font-size:16px;margin-bottom:6px;}
.ld-offer-est{font-size:13px;color:#c5c5c5;margin-bottom:10px;}
.ld-offer-input{width:100%;box-sizing:border-box;padding:9px;border-radius:6px;border:1px solid #555;background:#1e1e1e;color:#fff;font-size:15px;}
.ld-offer-msg{min-height:16px;font-size:13px;margin:8px 0;}
.ld-offer-actions{display:flex;gap:8px;justify-content:flex-end;}
.ld-offer-send,.ld-offer-cancel{padding:8px 16px;border-radius:6px;font-weight:700;cursor:pointer;user-select:none;}
.ld-offer-send{background:#f2d63b;color:#1e1e1e;}
.ld-offer-send:hover{filter:brightness(92%);}
.ld-offer-cancel{background:rgba(255,255,255,0.12);color:#ddd;}
.ld-offer-disabled{opacity:0.6;pointer-events:none;}
`;

/** Cosmetics everyone owns by default (base skin, default emotes/crosshairs, …) — hidden in the viewer. */
export const DEFAULT_UNLOCKED = new Set<string>([
    ...UnlockDefs.unlock_default.unlocks,
    ...UnlockDefs.unlock_new_account.unlocks,
]);

export const RARITY_COLORS = [
    "#c5c5c5",
    "#c5c5c5",
    "#12ff00",
    "#00deff",
    "#f600ff",
    "#d96100",
];
export const RARITY_NAMES = ["Stock", "Common", "Uncommon", "Rare", "Epic", "Mythic"];

/** Stats page is served from /stats/; the helper returns root-relative "img/..." paths. */
export function svgFor(type: string): string {
    const s = helpers.getSvgFromGameType(type);
    return s.startsWith("img/") ? `/${s}` : s;
}

/**
 * Markup for a cosmetic's image. Tagged with its type so the skin art can be
 * swapped in once the atlas loads — see `upgradeSkinImages`.
 */
export function imgHtml(type: string): string {
    return `<div class="ld-img" data-type="${type}" style="background-image:url('${svgFor(type)}')"></div>`;
}

/**
 * Skins render through `helpers.getSvgFromGameType`, which composes a character
 * preview only once the player sprites are in PIXI's texture cache. The stats
 * page loads no map, so the first paint always falls back to a flat tinted
 * shirt; fetch the sprites and repaint the outfits with the real preview.
 *
 * Fire-and-forget: on failure the fallback art simply stays.
 */
export function upgradeSkinImages($root: JQuery<HTMLElement>): void {
    loadSkinsAtlas("/")
        .then(() => {
            $root.find(".ld-img[data-type]").each((_i, el) => {
                const type = el.dataset.type!;
                if (
                    (GameObjectDefs[type] as { type?: string } | undefined)?.type !==
                    "outfit"
                ) {
                    return;
                }
                el.style.backgroundImage = `url('${svgFor(type)}')`;
            });
        })
        .catch(() => {});
}

export function nameFor(type: string): string {
    return (GameObjectDefs[type] as { name?: string } | undefined)?.name || type;
}

/**
 * Shows the cosmetics a player had equipped in a specific match, with their total worth.
 * Read-only: unlike the collection viewer these tiles carry no market/offer actions.
 */
export function showMatchLoadout(username: string, cosmetics: string[]): void {
    $(".loadout-modal-overlay").remove();

    const shown = cosmetics.filter(
        (t) => !DEFAULT_UNLOCKED.has(t) && !!GameObjectDefs[t],
    );
    const total = shown.reduce((s, t) => s + getItemPrice(t), 0);
    const tiles = shown
        .map((type) => {
            const r = getItemRarity(type);
            const name = helpers.htmlEscape(nameFor(type));
            return `<div class="ld-tile">
                ${imgHtml(type)}
                <div class="ld-name" title="${name}">${name}</div>
                <div class="ld-rarity" style="color:${RARITY_COLORS[r] ?? "#c5c5c5"}">${RARITY_NAMES[r] ?? "Common"}</div>
            </div>`;
        })
        .join("");

    const body = tiles
        ? `<div class="ld-grid">${tiles}</div>`
        : `<div class="ld-empty">Only default cosmetics equipped.</div>`;
    const $modal = $(
        `<div class="loadout-modal-overlay">` +
            `<style>${LOADOUT_MODAL_CSS}</style>` +
            `<div class="loadout-modal">` +
            `<div class="ld-header"><span>Match loadout — ${helpers.htmlEscape(username)}</span><span class="ld-close">✕</span></div>` +
            (shown.length
                ? `<div class="ld-valuebar">Loadout value <span class="ld-value-num">${total.toLocaleString("en-US")}</span><span class="ld-fries"></span></div>`
                : "") +
            `<div class="ld-body">${body}</div>` +
            `</div></div>`,
    );
    $modal.on("click", (e) => {
        if (
            $(e.target).is(".loadout-modal-overlay") ||
            $(e.target).closest(".ld-close").length
        ) {
            $modal.remove();
        }
    });
    $("body").append($modal);
    upgradeSkinImages($modal);
}
