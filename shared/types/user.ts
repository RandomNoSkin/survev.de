import { z } from "zod";
import { MARKET_MAX_PRICE } from "../defs/shopConfig";
import { Constants } from "../../shared/net/net";
import { type Item, ItemStatus, type Loadout, loadoutSchema } from "../utils/loadout";

export type ProfileResponse =
    | {
          readonly banned: true;
          reason: string;
          success?: false;
      }
    | {
          banned?: false;
          readonly success: true;
          profile: {
              slug: string;
              username: string;
              usernameSet: boolean;
              linked: boolean;
              usernameChangeTime: number;
              goldenFries: number;
          };
          loadout: Loadout;
          items: Item[];
          /** The caller's own active marketplace listings. */
          listings: MyListing[];
          /** Marketplace sales the seller hasn't acknowledged yet (drives the popup). */
          sales: SaleNotification[];
      };

/** A completed marketplace sale the seller is being notified of. */
export type SaleNotification = {
    listingId: number;
    type: string;
    /** Golden Fries the seller received. */
    price: number;
    /** Display name of the buyer (username, falling back to slug). */
    buyerName: string;
};

export const zUsernameRequest = z.object({
    username: z.string().trim().min(1).max(Constants.PlayerNameMaxLen),
});
export type UsernameRequest = z.infer<typeof zUsernameRequest>;
export type UsernameResponse =
    | {
          result: "success";
      }
    | {
          result: "failed" | "invalid" | "taken" | "change_time_not_expired";
      };

export const zLoadoutRequest = z.object({ loadout: loadoutSchema });

export type LoadoutRequest = z.infer<typeof zLoadoutRequest>;
export type LoadoutResponse = {
    loadout: Loadout;
};

export const zSetItemStatusRequest = z.object({
    status: z.nativeEnum(ItemStatus),
    itemTypes: z.array(z.string()).max(50),
});

export type SetItemStatusRequest = z.infer<typeof zSetItemStatusRequest>;
export type SetItemStatusResponse = {};

//
// PASS
//

export const zSetQuestRequest = z.object({
    questType: z.string(),
    idx: z.number(),
});
export type SetQuestRequest = z.infer<typeof zSetQuestRequest>;
export type SetQuestResponse = {};

export const zSetPassUnlockRequest = z.object({
    unlockType: z.string(),
});
export type SetPassUnlockRequest = z.infer<typeof zSetPassUnlockRequest>;
export type SetPassUnlockResponse = { success: boolean };

export type Quest = {
    idx: number;
    type: string;
    timeAcquired: number;
    progress: number;
    target: number;
    complete: boolean;
    rerolled: boolean;
    timeToRefresh: number;
};

export type PassType = {
    type: string;
    level: number;
    xp: number;
    totalXp?: number;
    newItems?: boolean;
};

export const zGetPassRequest = z.object({
    tryRefreshQuests: z.boolean(),
});
export type GetPassRequest = z.infer<typeof zGetPassRequest>;
export type GetPassResponse = {
    success: boolean;
    pass?: PassType;
    quests?: Quest[];
    questPriv?: string;
    /** Golden Fries granted by the pass during this request (0 if none). */
    goldenFriesAwarded?: number;
};
export const zRefreshQuestRequest = z.object({
    idx: z.number(),
});
export type RefreshQuestRequest = z.infer<typeof zRefreshQuestRequest>;
export type RefreshQuestResponse = { success: boolean };

//
// SHOP (daily Golden Fries shop)
//

export type ShopOfferItem = { type: string; price: number };
export type ShopOffer = {
    /** 0 = single cosmetic, 1 = 4-item bundle. */
    slot: number;
    items: ShopOfferItem[];
    /** Total price for the offer (sum, bundle already discounted). */
    price: number;
    purchased: boolean;
};
export type ShopResponse = {
    success: boolean;
    /** Server-local date the offers belong to ("YYYY-MM-DD"). */
    day: string;
    /** Epoch ms when the shop next resets (next server-local midnight). */
    resetTime: number;
    balance: number;
    offers: ShopOffer[];
};

export const zBuyShopRequest = z.object({ slot: z.number().int().min(0).max(1) });
export type BuyShopRequest = z.infer<typeof zBuyShopRequest>;
export type BuyShopResponse = {
    success: boolean;
    /** Set on failure: "already_purchased" | "insufficient_funds" | "invalid_slot" | "error". */
    error?: string;
    balance: number;
};

//
// MARKET (player-to-player marketplace)
//

/** A public marketplace listing as shown to buyers. */
export type MarketListing = {
    listingId: number;
    itemId: number;
    type: string;
    /** Seller's ask (what the seller receives). */
    price: number;
    /** Fee the buyer pays on top of the ask. */
    fee: number;
    /** price + fee — the amount the buyer is charged. */
    total: number;
    sellerSlug: string;
    sellerUsername: string;
    /** Epoch ms the listing was created. */
    createdAt: number;
    /** Provenance of the underlying item instance, shown to buyers. */
    source: string;
    previousOwners: string[];
    /** Lifetime match stats the instance has accrued while equipped. */
    games: number;
    wins: number;
    kills: number;
    damage: number;
};

/** One of the caller's own active listings (returned in ProfileResponse). */
export type MyListing = {
    listingId: number;
    itemId: number;
    type: string;
    price: number;
    /** Epoch ms the listing was created (drives the auto-expiry countdown). */
    createdAt: number;
    /** Target buyer's slug for a private listing, or null for a public one. */
    buyerSlug?: string | null;
};

export const zListItemRequest = z.object({
    itemId: z.number().int().positive(),
    // 0 is allowed (free listing); the upper bound keeps price + fee inside the
    // Golden Fries integer range. Matches the server-side check in listItem().
    price: z.number().int().min(0).max(MARKET_MAX_PRICE),
    /** Optional: restrict the sale to this player (private listing). */
    buyerSlug: z.string().trim().min(1).max(64).optional(),
});
export type ListItemRequest = z.infer<typeof zListItemRequest>;
export type ListItemResponse = {
    success: boolean;
    /** Set on failure: "not_owned" | "not_listable" | "bad_price" | "too_many_listings" | "already_listed" | "rate_limited" | "buyer_not_found" | "self_buyer" | "error". */
    error?: string;
    listing?: MyListing;
    /** On "rate_limited": epoch ms when the player may list again. */
    retryAfter?: number;
};

export const zBuyListingRequest = z.object({ listingId: z.number().int().positive() });
export type BuyListingRequest = z.infer<typeof zBuyListingRequest>;
export type BuyListingResponse = {
    success: boolean;
    /** Set on failure: "unavailable" | "own_listing" | "insufficient_funds" | "error". */
    error?: string;
    balance: number;
};

export const zCancelListingRequest = z.object({ listingId: z.number().int().positive() });
export type CancelListingRequest = z.infer<typeof zCancelListingRequest>;
export type CancelListingResponse = {
    success: boolean;
    /** Set on failure: "not_found" | "error". */
    error?: string;
};

export const zMarketBrowseRequest = z.object({
    category: z.enum(["outfit", "melee", "emote", "particle"]).optional(),
    rarity: z.number().int().min(0).max(5).optional(),
    sellerSlug: z.string().optional(),
    page: z.number().int().min(0).optional(),
    /** Free-text search over cosmetic name / source / owner. */
    search: z.string().trim().max(64).optional(),
    /** Cosmetic types the client resolved as name matches for `search` (OR-ed in). */
    searchTypes: z.array(z.string()).max(300).optional(),
});
export type MarketBrowseRequest = z.infer<typeof zMarketBrowseRequest>;
export type MarketListResponse = {
    success: boolean;
    listings: MarketListing[];
    page: number;
    hasMore: boolean;
};

export const zStorefrontRequest = z.object({ slug: z.string().min(1) });
export type StorefrontRequest = z.infer<typeof zStorefrontRequest>;

export const zAckSalesRequest = z.object({
    listingIds: z.array(z.number().int().positive()).max(100),
});
export type AckSalesRequest = z.infer<typeof zAckSalesRequest>;
export type AckSalesResponse = { success: boolean };

/** The instance ids the player has equipped/selected — reported on game join so match
 *  stats attach to the exact owned copy. */
export const zEquippedInstancesRequest = z.object({
    ids: z.array(z.number().int().positive()).max(30),
});
export type EquippedInstancesRequest = z.infer<typeof zEquippedInstancesRequest>;
export type EquippedInstancesResponse = { success: boolean };
