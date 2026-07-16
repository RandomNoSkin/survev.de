import { z } from "zod";
import { Constants } from "../../shared/net/net";
import { MARKET_MAX_PRICE } from "../defs/shopConfig";
import { type Item, ItemStatus, type Loadout, loadoutSchema } from "../utils/loadout";

export type ProfileResponse =
    | {
          readonly banned: true;
          reason: string;
          /** Epoch ms when the ban auto-expires; null = permanent. */
          expiresAt?: number | null;
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
          /** Gifts received but not yet acknowledged (drives the "you got a gift" popup). */
          gifts: GiftNotification[];
          /** Auction outcomes the caller hasn't acknowledged (won / sold / unsold popups). */
          auctions: AuctionNotification[];
          /** Buy-offers targeting the caller's items (to accept/decline/counter). */
          offersIncoming: Offer[];
          /** Buy-offers the caller has made (to track / withdraw). */
          offersOutgoing: Offer[];
          /** Count of the caller's active auctions that currently have a bid (tab badge). */
          auctionBids: number;
          /** The item instance the caller currently has up for auction, or null (one at a
           *  time) — drives the loadout "in auction" marker + disabled action buttons. */
          activeAuctionItemId: number | null;
          /** The caller's account settings (offers/loadout privacy). */
          settings: AccountSettings;
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

/** Per-account settings edited in the Loadout menu's Settings page. */
export type AccountSettings = {
    /** When true, other players can't make buy-offers on this user's items. */
    offersDisabled: boolean;
    /** When true, this user's loadout is hidden on the stats + advanced-game-stats pages. */
    loadoutPrivate: boolean;
};

export const zSettingsRequest = z.object({
    offersDisabled: z.boolean().optional(),
    loadoutPrivate: z.boolean().optional(),
});
export type SettingsRequest = z.infer<typeof zSettingsRequest>;
export type SettingsResponse = { success: boolean; settings: AccountSettings };

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
    /** 0 = daily single, 1 = daily bundle, 2 = weekly single, 3 = weekly bundle. The id
     *  also selects the period a purchase is keyed by, so ids are stable: they key
     *  purchases, ledger reasons and moderation reverts. */
    slot: number;
    items: ShopOfferItem[];
    /** Total price for the offer (sum, bundle already discounted). */
    price: number;
    purchased: boolean;
};
export type ShopResponse = {
    success: boolean;
    /** Server-local date the daily offers belong to ("YYYY-MM-DD"). */
    day: string;
    /** Key of the week the weekly offers belong to ("w" + its Monday, "wYYYY-MM-DD"). */
    week: string;
    /** Epoch ms when the daily offers next reset (next server-local midnight). */
    resetTime: number;
    /** Epoch ms when the weekly offers next reset (the midnight after Sunday 23:59:59). */
    weeklyResetTime: number;
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
    category: z.enum(["outfit", "melee", "emote", "particle", "death_effect"]).optional(),
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

//
// AUCTIONS — an owner lists an item with a min bid; bidders escrow their bids; 24h; no cancel.
//

/** One active auction shown in the Auction tab. */
export type Auction = {
    auctionId: number;
    itemId: number;
    type: string;
    minBid: number;
    /** Highest bid so far, or null before the first bid. */
    currentBid: number | null;
    currentBidderSlug: string | null;
    sellerSlug: string;
    sellerUsername: string;
    /** Epoch ms the auction ends (drives the countdown). */
    endsAt: number;
    createdAt: number;
    source: string;
    previousOwners: string[];
    games: number;
    wins: number;
    kills: number;
    damage: number;
    /** True when the caller currently holds the top bid. */
    youAreHighBidder?: boolean;
    /** True when the caller created this auction. */
    youAreSeller?: boolean;
};

export type AuctionListResponse = {
    success: boolean;
    auctions: Auction[];
    page: number;
    hasMore: boolean;
};

export const zCreateAuctionRequest = z.object({
    itemId: z.number().int().positive(),
    minBid: z.number().int().min(1).max(MARKET_MAX_PRICE),
});
export type CreateAuctionRequest = z.infer<typeof zCreateAuctionRequest>;
export type CreateAuctionResponse = {
    success: boolean;
    /** "not_owned" | "not_listable" | "bad_price" | "listed" | "already_auctioned" | "already_have_auction" | "error". */
    error?: string;
    retryAfter?: number;
};

export const zPlaceBidRequest = z.object({
    auctionId: z.number().int().positive(),
    amount: z.number().int().min(1).max(MARKET_MAX_PRICE),
});
export type PlaceBidRequest = z.infer<typeof zPlaceBidRequest>;
export type PlaceBidResponse = {
    success: boolean;
    /** "unavailable" | "ended" | "own_auction" | "already_highest" | "bid_too_low" | "insufficient_funds" | "error". */
    error?: string;
    balance: number;
    /** The minimum acceptable bid, echoed on "bid_too_low". */
    minRequired?: number;
};

/** An auction outcome the caller hasn't acknowledged (won / sold / ended unsold). */
export type AuctionNotification = {
    auctionId: number;
    type: string;
    amount: number;
    kind: "won" | "sold" | "no_bids";
    /** Other party's display name (winner for the seller, seller for the winner). */
    otherName: string;
};

export const zAckAuctionsRequest = z.object({
    auctionIds: z.array(z.number().int().positive()).max(100),
});
export type AckAuctionsRequest = z.infer<typeof zAckAuctionsRequest>;
export type AckAuctionsResponse = { success: boolean };

export const zEndAuctionRequest = z.object({
    auctionId: z.number().int().positive(),
});
export type EndAuctionRequest = z.infer<typeof zEndAuctionRequest>;
export type EndAuctionResponse = {
    success: boolean;
    /** "unavailable" | "not_seller" | "error". */
    error?: string;
};

//
// OFFERS — buy-offers on another player's item (charge on accept; owner may counter).
//

/** A buy-offer as seen by either party. */
export type Offer = {
    offerId: number;
    itemId: number;
    type: string;
    amount: number;
    counterAmount: number | null;
    /** pending | countered | accepted | declined | withdrawn | expired */
    status: string;
    fromSlug: string;
    fromUsername: string;
    toSlug: string;
    toUsername: string;
    createdAt: number;
    updatedAt: number;
};

export type OfferListResponse = {
    success: boolean;
    incoming: Offer[];
    outgoing: Offer[];
};

export const zMakeOfferRequest = z.object({
    itemId: z.number().int().positive(),
    amount: z.number().int().min(1).max(MARKET_MAX_PRICE),
});
export type MakeOfferRequest = z.infer<typeof zMakeOfferRequest>;
export type MakeOfferResponse = {
    success: boolean;
    /** "item_not_found" | "self_offer" | "auctioned" | "offers_disabled" | "too_many" | "duplicate" | "error". */
    error?: string;
};

export const zOfferIdRequest = z.object({ offerId: z.number().int().positive() });
export type OfferIdRequest = z.infer<typeof zOfferIdRequest>;

export const zCounterOfferRequest = z.object({
    offerId: z.number().int().positive(),
    counterAmount: z.number().int().min(1).max(MARKET_MAX_PRICE),
});
export type CounterOfferRequest = z.infer<typeof zCounterOfferRequest>;

export type OfferActionResponse = {
    success: boolean;
    /** e.g. "not_found" | "offerer_broke" | "gone" | "error". */
    error?: string;
    balance?: number;
};

/** The instance ids the player has equipped/selected — reported on game join so match
 *  stats attach to the exact owned copy. */
export const zEquippedInstancesRequest = z.object({
    ids: z.array(z.number().int().positive()).max(30),
});
export type EquippedInstancesRequest = z.infer<typeof zEquippedInstancesRequest>;
export type EquippedInstancesResponse = { success: boolean };

//
// SOCIAL — public item ownership ("who owns this item") + player-to-player gifting
//

/** One non-admin owner of a cosmetic type, with how many copies they own. */
export type ItemOwner = {
    slug: string;
    username: string;
    copies: number;
};

export const zItemOwnersRequest = z.object({
    type: z.string().trim().min(1).max(64),
    page: z.number().int().min(0).optional(),
    /** Optional username filter. */
    search: z.string().trim().max(64).optional(),
});
export type ItemOwnersRequest = z.infer<typeof zItemOwnersRequest>;
export type ItemOwnersResponse = {
    success: boolean;
    type: string;
    owners: ItemOwner[];
    /** Distinct non-admin owners matching the query. */
    total: number;
    page: number;
    hasMore: boolean;
};

/** A user match for the gift-recipient picker. */
export type UserSearchResult = { slug: string; username: string };

export const zUserSearchRequest = z.object({
    query: z.string().trim().min(1).max(64),
    limit: z.number().int().min(1).max(25).optional(),
});
export type UserSearchRequest = z.infer<typeof zUserSearchRequest>;
export type UserSearchResponse = {
    success: boolean;
    users: UserSearchResult[];
};

export const zGiftItemRequest = z.object({
    itemId: z.number().int().positive(),
    recipientSlug: z.string().trim().min(1).max(64),
});
export type GiftItemRequest = z.infer<typeof zGiftItemRequest>;
export type GiftItemResponse = {
    success: boolean;
    /** Set on failure: "not_owned" | "not_giftable" | "listed" | "recipient_not_found" | "self_gift" | "error". */
    error?: string;
};

export const zGiftFriesRequest = z.object({
    recipientSlug: z.string().trim().min(1).max(64),
    amount: z.number().int().positive().max(1_000_000),
});
export type GiftFriesRequest = z.infer<typeof zGiftFriesRequest>;
export type GiftFriesResponse = {
    success: boolean;
    /** Set on failure: "insufficient_funds" | "recipient_not_found" | "self_gift" | "error". */
    error?: string;
    /** Sender's balance after the gift (unchanged on failure). */
    balance: number;
};

/** A gift a player received (shown to them as a popup, then acknowledged). */
export type GiftNotification = {
    id: number;
    /** Display name of the gifter (username, falling back to slug). */
    fromName: string;
    kind: "fries" | "item";
    /** Golden Fries amount (kind = "fries"). */
    amount: number;
    /** Cosmetic type (kind = "item"). */
    itemType: string;
};

export const zAckGiftsRequest = z.object({
    ids: z.array(z.number().int().positive()).max(100),
});
export type AckGiftsRequest = z.infer<typeof zAckGiftsRequest>;
export type AckGiftsResponse = { success: boolean };

//
// FRIENDS (directional list) + recently-played players
//

export type Friend = { slug: string; username: string };

/** A live game a friend is currently in (region + gameId, to spectate). */
export type LiveGame = { region: string; gameId: string };

/** An accepted friend with their last-game time and, if playing right now, their live game. */
export type FriendEntry = {
    slug: string;
    username: string;
    /** Epoch ms of their most recent finished game, or null if none. */
    lastGame: number | null;
    /** Set when they're currently in a spectatable live game. */
    live: LiveGame | null;
};

/** A recently-played player, tagged as a teammate ("with") or an opponent ("against"). */
export type RecentPlayer = {
    slug: string;
    username: string;
    relation: "with" | "against";
};

/** An account the caller has blocked (shown in the Social panel's Blocked list). */
export type BlockedUser = { slug: string; username: string };

export type FriendsResponse = {
    success: boolean;
    /** Accepted friends (with last-game / live-spectate info). */
    friends: FriendEntry[];
    /** Friend requests the caller has received (awaiting accept/decline). */
    incoming: Friend[];
    /** Friend requests the caller has sent (awaiting the other side). */
    outgoing: Friend[];
    recent: RecentPlayer[];
    /** Accounts the caller has blocked (they can't offer/friend/gift the caller). */
    blocked: BlockedUser[];
};

export const zFriendActionRequest = z.object({
    slug: z.string().trim().min(1).max(64),
});
export type FriendActionRequest = z.infer<typeof zFriendActionRequest>;
export type FriendActionResponse = {
    success: boolean;
    /** Set on failure: "not_found" | "self" | "no_request" | "error". */
    error?: string;
};
