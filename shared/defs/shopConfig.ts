import { Rarity } from "../gameConfig";
import { cosmeticStats } from "../utils/cosmeticStats";
import { GameObjectDefs } from "./gameObjectDefs";
import {
    _allowedCrosshairs,
    _allowedDeathEffects,
    _allowedEmotes,
    _allowedHealEffects,
    _allowedMeleeSkins,
    _allowedOutfits,
} from "./gameObjects/unlockDefs";

/**
 * The curated allow-lists from unlockDefs. ONLY these item types may ever be
 * unlocked/sold (via pass grants or the shop) — nothing outside this set.
 */
const ALLOWED_ITEMS = new Set<string>([
    ..._allowedHealEffects,
    ..._allowedMeleeSkins,
    ..._allowedOutfits,
    ..._allowedEmotes,
    ..._allowedDeathEffects,
    ..._allowedCrosshairs,
]);

export function isAllowedItem(type: string): boolean {
    return ALLOWED_ITEMS.has(type);
}

/**
 * Golden Fries shop economy: prices depend on BOTH rarity and item category.
 * Order cheapest → most expensive: emote < outfit (skin) < particle (heal/boost) < melee.
 * All values are tunable. Calibrated so a common emote costs 25 (≈ a couple of pass
 * levels of Golden Fries), scaling up from there.
 */

export type ShopCategory = "emote" | "outfit" | "particle" | "melee" | "death_effect";

/** Base price per rarity (emote-level). */
export const BASE_RARITY: Record<number, number> = {
    [Rarity.Stock]: 20,
    [Rarity.Common]: 50,
    [Rarity.Uncommon]: 100,
    [Rarity.Rare]: 200,
    [Rarity.Epic]: 360,
    [Rarity.Mythic]: 600,
};

/** Category multiplier applied on top of the rarity base price. */
export const CATEGORY_MULT: Record<ShopCategory, number> = {
    emote: 1,
    particle: 2,
    death_effect: 2.5,
    outfit: 3,
    melee: 4,
};

/** Bundle (daily shop slot 1) gets 10% off the summed item prices. */
export const BUNDLE_DISCOUNT = 0.9;

/**
 * Chance that a death effect takes the place of one of the bundle's four items (so the
 * bundle always holds exactly four). Only bites once a pass containing death effects has
 * ended — until then no death effect is shoppable and the bundle is unaffected.
 */
export const BUNDLE_DEATH_EFFECT_CHANCE = 0.25;

/** When true, the daily shop is the SAME for every player (offers seeded by the day
 *  only). When false, each player gets their own deterministic daily shop. */
export const SHARED_SHOP = false;

/** Marketplace fee (Golden Fries sink). The buyer pays this on top of the seller's ask. */
export const MARKET_FEE = 0.1;

/** Player marketplace: multiples of the shop value used only for the *recommended* price. */
export const MARKET_MIN_MULT = 0.5;
export const MARKET_MAX_MULT = 5;

/**
 * Upper bound for a listing price. Sellers may ask anything from 0 (free) up to this;
 * the cap only keeps price + fee well within the Golden Fries integer range.
 */
export const MARKET_MAX_PRICE = 1_000_000_000;

/** Max simultaneous active listings a single player may have. */
export const MARKET_MAX_LISTINGS = 20;

/** A player may only create one listing per this interval (anti-spam throttle). */
export const MARKET_LIST_COOLDOWN_MS = 30 * 1000;

/** A listing is automatically taken back (expired) this long after it was created. */
export const MARKET_LISTING_TTL_MS = 24 * 60 * 60 * 1000;

/** How long an auction runs before it is settled. Cannot be cancelled early. */
export const AUCTION_DURATION_MS = 24 * 60 * 60 * 1000;

/** A new bid must beat the current highest bid by at least this many Golden Fries. */
export const AUCTION_MIN_INCREMENT = 1;

/** A buy-offer auto-expires this long after it was made if not acted upon. */
export const OFFER_TTL_MS = 24 * 60 * 60 * 1000;

/** Max simultaneous pending buy-offers a single player may have outstanding. */
export const OFFER_MAX_OUTSTANDING = 10;

/**
 * Allowed ask-price range for listing `type` on the player marketplace, anchored to
 * its shop value. Returns null for items with no shop value (e.g. Stock rarity), which
 * therefore can't be listed (no price anchor).
 */
export function getMarketPriceBounds(type: string): { min: number; max: number } | null {
    const price = getItemPrice(type);
    if (price <= 0) return null;
    return {
        min: Math.max(1, Math.floor(price * MARKET_MIN_MULT)),
        max: Math.ceil(price * MARKET_MAX_MULT),
    };
}

/** Marketplace fee the buyer pays on top of the seller's ask `price`. */
export function getMarketFee(price: number): number {
    return Math.ceil(price * MARKET_FEE);
}

/** Total the buyer pays for a listing: the seller's ask plus the fee. */
export function getMarketTotal(price: number): number {
    return price + getMarketFee(price);
}

/** Maps an item type to its shop category, or null if it isn't a shoppable cosmetic. */
export function getItemCategory(type: string): ShopCategory | null {
    const def = GameObjectDefs[type];
    if (!def) return null;
    switch (def.type) {
        case "outfit":
            return "outfit";
        case "melee":
            return "melee";
        case "emote":
            return "emote";
        case "heal_effect":
        case "boost_effect":
            return "particle";
        case "death_effect":
            return "death_effect";
        default:
            return null;
    }
}

/**
 * Returns an item's rarity. Prefers the dynamic ownership-based rarity (so prices and
 * shop weights follow how rare an item actually is); falls back to the static def rarity,
 * then Common. See {@link cosmeticStats}.
 */
export function getItemRarity(type: string): number {
    const stat = cosmeticStats.get(type);
    if (stat) return stat.rarity;
    const def = GameObjectDefs[type] as { rarity?: number } | undefined;
    return def?.rarity ?? Rarity.Common;
}

/**
 * Relative likelihood of an item appearing in the daily shop, by rarity — rarer items
 * show up less often. Only the ratios matter; tune freely.
 */
export const RARITY_SHOP_WEIGHT: Record<number, number> = {
    [Rarity.Stock]: 120,
    [Rarity.Common]: 100,
    [Rarity.Uncommon]: 50,
    [Rarity.Rare]: 25,
    [Rarity.Epic]: 12,
    [Rarity.Mythic]: 5,
};

/** Shop random-pick weight for `type`: higher = more likely (rarer items are lower). */
export function getShopWeight(type: string): number {
    return RARITY_SHOP_WEIGHT[getItemRarity(type)] ?? RARITY_SHOP_WEIGHT[Rarity.Common];
}

/**
 * Price of a single item in Golden Fries, derived from rarity × category.
 * Returns 0 for non-shoppable items or Stock-rarity items (treated as not sellable).
 */
export function getItemPrice(type: string): number {
    const category = getItemCategory(type);
    if (!category) return 0;

    const rarity = getItemRarity(type);
    const base = BASE_RARITY[rarity];
    if (!base) return 0; // Stock or unknown rarity

    return Math.round(base * CATEGORY_MULT[category]);
}
