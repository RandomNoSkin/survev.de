import { and, eq, gte, inArray, ne, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { PassDefs } from "../../../../../shared/defs/gameObjects/passDefs";
import { QuestDefs } from "../../../../../shared/defs/gameObjects/questDefs";
import {
    _allowedCrosshairs,
    _allowedDeathEffects,
    _allowedEmotes,
    _allowedHealEffects,
    _allowedMeleeSkins,
    _allowedOutfits,
    UnlockDefs,
} from "../../../../../shared/defs/gameObjects/unlockDefs";
import { getMapDefById, MapDefs } from "../../../../../shared/defs/mapDefs";
import { mapDef } from "../../../../../shared/defs/maps/2v2Defs";
import { MapId } from "../../../../../shared/defs/types/misc";
import { ExperienceConverter, GameConfig } from "../../../../../shared/gameConfig";
import {
    type AckAuctionsResponse,
    type AckGiftsResponse,
    type AckSalesResponse,
    type AuctionListResponse,
    type BuyListingResponse,
    type BuyShopResponse,
    type CancelListingResponse,
    type CreateAuctionResponse,
    type EndAuctionResponse,
    type EquippedInstancesResponse,
    type FriendActionResponse,
    type FriendEntry,
    type FriendsResponse,
    type GetPassResponse,
    type GiftFriesResponse,
    type GiftItemResponse,
    type ItemOwnersResponse,
    type ListItemResponse,
    type LoadoutResponse,
    type MakeOfferResponse,
    type MarketListResponse,
    type OfferActionResponse,
    type OfferListResponse,
    type PlaceBidResponse,
    type ProfileResponse,
    type RefreshQuestResponse,
    type SetPassUnlockResponse,
    type SettingsResponse,
    type ShopResponse,
    type UsernameResponse,
    type UserSearchResponse,
    zAckAuctionsRequest,
    zAckGiftsRequest,
    zAckSalesRequest,
    zBuyListingRequest,
    zBuyShopRequest,
    zCancelListingRequest,
    zCounterOfferRequest,
    zCreateAuctionRequest,
    zEndAuctionRequest,
    zEquippedInstancesRequest,
    zFriendActionRequest,
    zGetPassRequest,
    zGiftFriesRequest,
    zGiftItemRequest,
    zItemOwnersRequest,
    zListItemRequest,
    zLoadoutRequest,
    zMakeOfferRequest,
    zMarketBrowseRequest,
    zOfferIdRequest,
    zPlaceBidRequest,
    zRefreshQuestRequest,
    zSetItemStatusRequest,
    zSetPassUnlockRequest,
    zSettingsRequest,
    zStorefrontRequest,
    zUsernameRequest,
    zUserSearchRequest,
} from "../../../../../shared/types/user";
import loadout from "../../../../../shared/utils/loadout";
import { apiPrivateRouter, validateUserName } from "../../../utils/serverHelpers";
import { server } from "../../apiServer";
import {
    authMiddleware,
    databaseEnabledMiddleware,
    rateLimitMiddleware,
    validateParams,
} from "../../auth/middleware";
import { db } from "../../db";
import {
    ackAuctions,
    createAuction,
    endAuction,
    getActiveAuctionItemId,
    getActiveAuctions,
    getMyAuctionBidCount,
    getUnackedAuctions,
    placeBid,
} from "../../db/auctions";
import { blockUser, getBlocked, unblockUser } from "../../db/blocks";
import {
    acceptFriendRequest,
    getFriendsDetailed,
    getIncomingRequests,
    getOutgoingRequests,
    getRecentPlayers,
    removeFriend,
    sendFriendRequest,
} from "../../db/friends";
import {
    ackGiftNotifications,
    getGiftNotifications,
    getItemOwners,
    giftGoldenFries,
    giftItem,
    searchUsers,
} from "../../db/gifts";
import { awardNewPassGoldenFries } from "../../db/goldenFries";
import {
    ackSales,
    buyListing,
    cancelListing,
    getMarketListings,
    getPrivateOffers,
    getStorefront,
    getUnackedSales,
    getUserListings,
    listItem,
} from "../../db/market";
import {
    acceptOffer,
    counterOffer,
    declineOffer,
    getOffersForUser,
    makeOffer,
    withdrawOffer,
} from "../../db/offers";
import { grantPassItems } from "../../db/passGrants";
import { itemsTable, matchDataTable, usersTable, userXpTable } from "../../db/schema";
import { buyShopOffer, getShopForUser } from "../../db/shop";
import type { Context } from "../../index";
import {
    getTimeUntilNextUsernameChange,
    logoutUser,
    sanitizeSlug,
} from "./auth/authUtils";

export const UserRouter = new Hono<Context>();

UserRouter.use(databaseEnabledMiddleware);
UserRouter.use(rateLimitMiddleware(40, 60 * 1000));
UserRouter.use(authMiddleware);

UserRouter.post("/profile", async (c) => {
    const user = c.get("user")!;

    const {
        loadout,
        slug,
        linked,
        username,
        usernameSet,
        lastUsernameChangeTime,
        banned,
        banReason,
        banExpiresAt,
        goldenFries,
    } = user;

    // A time-limited account ban whose duration has run out is treated as lifted
    // right away; the ban-expiry sweep clears the DB row + writes history shortly
    // after (see db/banExpiry.ts). Permanent bans have a null banExpiresAt.
    const banActive =
        banned && (banExpiresAt == null || banExpiresAt.getTime() > Date.now());
    if (banActive) {
        const session = c.get("session")!;
        await logoutUser(c, session.id);

        return c.json<ProfileResponse>({
            banned: true,
            reason: banReason,
            expiresAt: banExpiresAt ? banExpiresAt.getTime() : null,
        });
    }

    const timeUntilNextChange = getTimeUntilNextUsernameChange(lastUsernameChangeTime);

    const defaultUnlockItems = UnlockDefs["unlock_default"].unlocks;

    const items = await db
        .select({
            id: itemsTable.id,
            type: itemsTable.type,
            timeAcquired: itemsTable.timeAcquired,
            source: itemsTable.source,
            status: itemsTable.status,
            previousOwners: itemsTable.previousOwners,
            games: itemsTable.games,
            wins: itemsTable.wins,
            kills: itemsTable.kills,
            damage: itemsTable.damage,
            pricePaid: itemsTable.pricePaid,
        })
        .from(itemsTable)
        .where(
            and(
                eq(itemsTable.userId, user.id),
                notInArray(itemsTable.type, defaultUnlockItems),
            ),
        );

    return c.json<ProfileResponse>(
        {
            success: true,
            profile: {
                slug,
                linked,
                username,
                usernameSet,
                usernameChangeTime: timeUntilNextChange,
                goldenFries,
            },
            loadout,
            items: items,
            listings: await getUserListings(user.id),
            sales: await getUnackedSales(user.id),
            gifts: await getGiftNotifications(user.id),
            auctions: await getUnackedAuctions(user.id),
            auctionBids: await getMyAuctionBidCount(user.id),
            activeAuctionItemId: await getActiveAuctionItemId(user.id),
            settings: {
                offersDisabled: user.offersDisabled,
                loadoutPrivate: user.loadoutPrivate,
            },
            ...(await (async () => {
                const offers = await getOffersForUser(user.id);
                return {
                    offersIncoming: offers.incoming,
                    offersOutgoing: offers.outgoing,
                };
            })()),
        },
        200,
    );
});

UserRouter.post(
    "/username",
    validateParams(zUsernameRequest, { result: "invalid" } satisfies UsernameResponse),
    async (c) => {
        const user = c.get("user")!;
        const { username } = c.req.valid("json");
        const timeUntilNextChange = getTimeUntilNextUsernameChange(
            user.lastUsernameChangeTime,
        );

        if (timeUntilNextChange > 0) {
            return c.json<UsernameResponse>({ result: "change_time_not_expired" }, 200);
        }

        const { validName, originalWasInvalid } = validateUserName(username);

        if (originalWasInvalid) {
            return c.json<UsernameResponse>({ result: "invalid" }, 200);
        }

        const slug = sanitizeSlug(validName);

        const slugTaken = await db.query.usersTable.findFirst({
            where: and(eq(usersTable.slug, slug), ne(usersTable.id, user.id)),
            columns: {
                id: true,
            },
        });

        if (slugTaken) {
            return c.json<UsernameResponse>({ result: "taken" }, 200);
        }

        try {
            await db
                .update(usersTable)
                .set({
                    username: validName,
                    slug: slug,
                    usernameSet: true,
                    lastUsernameChangeTime: new Date(),
                })
                .where(eq(usersTable.id, user.id));
        } catch (err) {
            server.logger.error("/api/username: Error updating username", err);
            return c.json<UsernameResponse>({ result: "failed" }, 500);
        }

        return c.json<UsernameResponse>({ result: "success" }, 200);
    },
);

UserRouter.post("/settings", validateParams(zSettingsRequest), async (c) => {
    const user = c.get("user")!;
    const { offersDisabled, loadoutPrivate } = c.req.valid("json");
    const patch: Partial<{ offersDisabled: boolean; loadoutPrivate: boolean }> = {};
    if (offersDisabled !== undefined) patch.offersDisabled = offersDisabled;
    if (loadoutPrivate !== undefined) patch.loadoutPrivate = loadoutPrivate;
    if (Object.keys(patch).length) {
        await db.update(usersTable).set(patch).where(eq(usersTable.id, user.id));
    }
    return c.json<SettingsResponse>({
        success: true,
        settings: {
            offersDisabled: offersDisabled ?? user.offersDisabled,
            loadoutPrivate: loadoutPrivate ?? user.loadoutPrivate,
        },
    });
});

UserRouter.post("/loadout", validateParams(zLoadoutRequest), async (c) => {
    const user = c.get("user")!;
    const { loadout: userLoadout } = c.req.valid("json");

    const items = await db
        .select({
            type: itemsTable.type,
            timeAcquired: itemsTable.timeAcquired,
            source: itemsTable.source,
            status: itemsTable.status,
        })
        .from(itemsTable)
        .where(eq(itemsTable.userId, user.id));

    const validatedLoadout = loadout.validateWithAvailableItems(userLoadout, items);

    await db
        .update(usersTable)
        .set({ loadout: validatedLoadout })
        .where(eq(usersTable.id, user.id));

    return c.json<LoadoutResponse>(
        {
            loadout: validatedLoadout,
        },
        200,
    );
});

UserRouter.post("/logout", async (c) => {
    const session = c.get("session")!;

    await logoutUser(c, session.id);

    return c.json({}, 200);
});

UserRouter.post("/delete", async (c) => {
    const user = c.get("user")!;
    const session = c.get("session")!;

    // logout out the user
    await logoutUser(c, session.id);

    // delete the account
    await db.delete(usersTable).where(eq(usersTable.id, user.id));

    // remove reference to the user from match data
    await db
        .update(matchDataTable)
        .set({ userId: null })
        .where(eq(matchDataTable.userId, user.id));

    return c.json({}, 200);
});

UserRouter.post("/set_item_status", validateParams(zSetItemStatusRequest), async (c) => {
    const user = c.get("user")!;
    const { itemTypes, status } = c.req.valid("json");

    await db
        .update(itemsTable)
        .set({
            status: status,
        })
        .where(and(eq(itemsTable.userId, user.id), inArray(itemsTable.type, itemTypes)));

    return c.json({}, 200);
});

UserRouter.post("/shop", async (c) => {
    const user = c.get("user")!;
    const shop = await getShopForUser(user.id);
    return c.json<ShopResponse>(shop, 200);
});

UserRouter.post("/shop/buy", validateParams(zBuyShopRequest), async (c) => {
    const user = c.get("user")!;
    const { slot } = c.req.valid("json");
    const result = await buyShopOffer(user.id, slot);
    return c.json<BuyShopResponse>(result, 200);
});

//
// MARKET (player-to-player marketplace)
//

UserRouter.post("/market/list", validateParams(zListItemRequest), async (c) => {
    const user = c.get("user")!;
    const { itemId, price, buyerSlug } = c.req.valid("json");
    const result = await listItem(user.id, itemId, price, buyerSlug);
    return c.json<ListItemResponse>(result, 200);
});

UserRouter.post("/market/listings", validateParams(zMarketBrowseRequest), async (c) => {
    const { category, rarity, sellerSlug, page, search, searchTypes } =
        c.req.valid("json");
    const result = await getMarketListings({
        category,
        rarity,
        sellerSlug,
        page,
        search,
        searchTypes,
    });
    return c.json<MarketListResponse>(result, 200);
});

UserRouter.post("/market/storefront", validateParams(zStorefrontRequest), async (c) => {
    const { slug } = c.req.valid("json");
    const result = await getStorefront(slug);
    return c.json<MarketListResponse>(result, 200);
});

UserRouter.post("/market/private", async (c) => {
    const user = c.get("user")!;
    const result = await getPrivateOffers(user.slug);
    return c.json<MarketListResponse>(result, 200);
});

UserRouter.post("/market/buy", validateParams(zBuyListingRequest), async (c) => {
    const user = c.get("user")!;
    const { listingId } = c.req.valid("json");
    const result = await buyListing(user.id, user.slug, listingId);
    return c.json<BuyListingResponse>(result, 200);
});

UserRouter.post("/market/cancel", validateParams(zCancelListingRequest), async (c) => {
    const user = c.get("user")!;
    const { listingId } = c.req.valid("json");
    const result = await cancelListing(user.id, listingId);
    return c.json<CancelListingResponse>(result, 200);
});

UserRouter.post("/market/ack_sales", validateParams(zAckSalesRequest), async (c) => {
    const user = c.get("user")!;
    const { listingIds } = c.req.valid("json");
    await ackSales(user.id, listingIds);
    return c.json<AckSalesResponse>({ success: true }, 200);
});

//
// AUCTIONS
//

UserRouter.post("/auction/create", validateParams(zCreateAuctionRequest), async (c) => {
    const user = c.get("user")!;
    const { itemId, minBid } = c.req.valid("json");
    const result = await createAuction(user.id, itemId, minBid);
    return c.json<CreateAuctionResponse>(result, 200);
});

UserRouter.post("/auction/bid", validateParams(zPlaceBidRequest), async (c) => {
    const user = c.get("user")!;
    const { auctionId, amount } = c.req.valid("json");
    const result = await placeBid(user.id, auctionId, amount);
    return c.json<PlaceBidResponse>(result, 200);
});

UserRouter.post("/auction/list", validateParams(zMarketBrowseRequest), async (c) => {
    const user = c.get("user")!;
    const { category, rarity, page } = c.req.valid("json");
    const result = await getActiveAuctions(
        {
            category: category as "outfit" | "melee" | "emote" | "particle" | undefined,
            rarity,
            page,
        },
        user.id,
    );
    return c.json<AuctionListResponse>(result, 200);
});

UserRouter.post("/auction/ack", validateParams(zAckAuctionsRequest), async (c) => {
    const user = c.get("user")!;
    const { auctionIds } = c.req.valid("json");
    await ackAuctions(user.id, auctionIds);
    return c.json<AckAuctionsResponse>({ success: true }, 200);
});

UserRouter.post("/auction/end", validateParams(zEndAuctionRequest), async (c) => {
    const user = c.get("user")!;
    const { auctionId } = c.req.valid("json");
    const result = await endAuction(user.id, auctionId);
    return c.json<EndAuctionResponse>(result, 200);
});

//
// OFFERS (buy-offers on another player's item)
//

UserRouter.post("/offer/make", validateParams(zMakeOfferRequest), async (c) => {
    const user = c.get("user")!;
    const { itemId, amount } = c.req.valid("json");
    const result = await makeOffer(user.id, itemId, amount);
    return c.json<MakeOfferResponse>(result, 200);
});

UserRouter.post("/offer/accept", validateParams(zOfferIdRequest), async (c) => {
    const user = c.get("user")!;
    const { offerId } = c.req.valid("json");
    const result = await acceptOffer(user.id, offerId);
    return c.json<OfferActionResponse>(result, 200);
});

UserRouter.post("/offer/decline", validateParams(zOfferIdRequest), async (c) => {
    const user = c.get("user")!;
    const { offerId } = c.req.valid("json");
    const result = await declineOffer(user.id, offerId);
    return c.json<OfferActionResponse>(result, 200);
});

UserRouter.post("/offer/counter", validateParams(zCounterOfferRequest), async (c) => {
    const user = c.get("user")!;
    const { offerId, counterAmount } = c.req.valid("json");
    const result = await counterOffer(user.id, offerId, counterAmount);
    return c.json<OfferActionResponse>(result, 200);
});

UserRouter.post("/offer/withdraw", validateParams(zOfferIdRequest), async (c) => {
    const user = c.get("user")!;
    const { offerId } = c.req.valid("json");
    const result = await withdrawOffer(user.id, offerId);
    return c.json<OfferActionResponse>(result, 200);
});

UserRouter.post("/offer/list", async (c) => {
    const user = c.get("user")!;
    const result = await getOffersForUser(user.id);
    return c.json<OfferListResponse>(result, 200);
});

//
// SOCIAL (public item ownership + player-to-player gifting)
//

// Public "who owns this cosmetic" view (admins excluded). Auth'd like everything else on
// this router, but returns only public display data (username + slug + copy count).
UserRouter.post("/item_owners", validateParams(zItemOwnersRequest), async (c) => {
    const { type, page, search } = c.req.valid("json");
    const result = await getItemOwners(type, page ?? 0, search);
    return c.json<ItemOwnersResponse>(result, 200);
});

// Username search for the gift-recipient picker.
UserRouter.post("/search", validateParams(zUserSearchRequest), async (c) => {
    const user = c.get("user")!;
    const { query, limit } = c.req.valid("json");
    const users = await searchUsers(user.id, query, limit);
    return c.json<UserSearchResponse>({ success: true, users }, 200);
});

// Gift an owned item instance to another player (instant, free transfer).
UserRouter.post("/gift/item", validateParams(zGiftItemRequest), async (c) => {
    const user = c.get("user")!;
    const { itemId, recipientSlug } = c.req.valid("json");
    const result = await giftItem(
        user.id,
        user.slug,
        user.username,
        itemId,
        recipientSlug,
    );
    return c.json<GiftItemResponse>(result, 200);
});

// Gift Golden Fries to another player.
UserRouter.post("/gift/fries", validateParams(zGiftFriesRequest), async (c) => {
    const user = c.get("user")!;
    const { recipientSlug, amount } = c.req.valid("json");
    const result = await giftGoldenFries(
        user.id,
        user.slug,
        user.username,
        recipientSlug,
        amount,
    );
    return c.json<GiftFriesResponse>(result, 200);
});

// Acknowledge received-gift notifications so their popups won't fire again.
UserRouter.post("/gifts/ack", validateParams(zAckGiftsRequest), async (c) => {
    const user = c.get("user")!;
    const { ids } = c.req.valid("json");
    await ackGiftNotifications(user.id, ids);
    return c.json<AckGiftsResponse>({ success: true }, 200);
});

// Friends, incoming/outgoing requests, and recently-played players (with/against).
UserRouter.post("/friends/list", async (c) => {
    const user = c.get("user")!;
    const [detailed, incoming, outgoing, recent, blocked, liveMap] = await Promise.all([
        getFriendsDetailed(user.id),
        getIncomingRequests(user.id),
        getOutgoingRequests(user.id),
        getRecentPlayers(user.id),
        getBlocked(user.id),
        server.getLivePlayers(),
    ]);
    const friends: FriendEntry[] = detailed.map((f) => ({
        slug: f.slug,
        username: f.username,
        lastGame: f.lastGame,
        live: liveMap.get(f.userId) ?? null,
    }));
    return c.json<FriendsResponse>(
        { success: true, friends, incoming, outgoing, recent, blocked },
        200,
    );
});

UserRouter.post("/friends/block", validateParams(zFriendActionRequest), async (c) => {
    const user = c.get("user")!;
    const { slug } = c.req.valid("json");
    const result = await blockUser(user.id, slug);
    return c.json<FriendActionResponse>(result, 200);
});

UserRouter.post("/friends/unblock", validateParams(zFriendActionRequest), async (c) => {
    const user = c.get("user")!;
    const { slug } = c.req.valid("json");
    const result = await unblockUser(user.id, slug);
    return c.json<FriendActionResponse>(result, 200);
});

// Send a friend request (auto-accepts if the other side already requested you).
UserRouter.post("/friends/request", validateParams(zFriendActionRequest), async (c) => {
    const user = c.get("user")!;
    const { slug } = c.req.valid("json");
    return c.json<FriendActionResponse>(await sendFriendRequest(user.id, slug), 200);
});

// Accept a request you received.
UserRouter.post("/friends/accept", validateParams(zFriendActionRequest), async (c) => {
    const user = c.get("user")!;
    const { slug } = c.req.valid("json");
    return c.json<FriendActionResponse>(await acceptFriendRequest(user.id, slug), 200);
});

// Remove a friend, decline an incoming request, or cancel an outgoing one.
UserRouter.post("/friends/remove", validateParams(zFriendActionRequest), async (c) => {
    const user = c.get("user")!;
    const { slug } = c.req.valid("json");
    return c.json<FriendActionResponse>(await removeFriend(user.id, slug), 200);
});

// Reported by the client on game join: the owned instance ids it currently has equipped.
// Stored as a per-game snapshot so cosmetic match stats attach to the exact copy the
// player selected (see attributeCosmeticStats). Only the caller's own items can ever be
// affected — the attribution query is scoped to the user — so unowned/forged ids are inert.
UserRouter.post(
    "/equipped_instances",
    validateParams(zEquippedInstancesRequest),
    async (c) => {
        const user = c.get("user")!;
        const { ids } = c.req.valid("json");
        await db
            .update(usersTable)
            .set({ equippedInstanceIds: ids })
            .where(eq(usersTable.id, user.id));
        return c.json<EquippedInstancesResponse>({ success: true }, 200);
    },
);

UserRouter.post("/reset_stats", async (c) => {
    const user = c.get("user")!;

    await db
        .update(matchDataTable)
        .set({ userId: null })
        .where(eq(matchDataTable.userId, user.id));

    return c.json({}, 200);
});

//
// NOT IMPLEMENTED
//
UserRouter.post("/set_pass_unlock", validateParams(zSetPassUnlockRequest), (c) => {
    return c.json<SetPassUnlockResponse>({ success: true }, 200);
});

UserRouter.post("/get_pass", validateParams(zGetPassRequest), async (c) => {
    const user = c.get("user")!;
    const passType = GameConfig.serverSettings.currentPass;
    // get lastUpdated from user_xp table to check if we need to recalculate the pass progress
    const userXpRecord = await db.query.userXpTable.findFirst({
        where: and(eq(userXpTable.userId, user.id), eq(userXpTable.passType, passType)),
    });
    const seasonStart = new Date(GameConfig.serverSettings.seasonStart);
    const lastUpdated =
        userXpRecord && userXpRecord.lastUpdated > seasonStart
            ? userXpRecord.lastUpdated
            : seasonStart;

    const currentXp = userXpRecord ? Number(userXpRecord.xp) : 0;
    const stats = await db
        .select({
            gameId: matchDataTable.gameId,
            kills: sql<number>`max(${matchDataTable.kills})`,
            damage: sql<number>`max(${matchDataTable.damageDealt})`,
            timeAlive: sql<number>`max(${matchDataTable.timeAlive})`,
            rank: sql<number>`min(${matchDataTable.rank})`,
            mapId: sql<number>`max(${matchDataTable.mapId})`,
            createdAt: sql<Date>`max(${matchDataTable.createdAt})`,
            entryCount: sql<number>`count(*)`,
        })
        .from(matchDataTable)
        .where(
            and(
                eq(matchDataTable.userId, user.id),
                gte(matchDataTable.createdAt, lastUpdated),
                // Skip games a moderator voided (botted): their XP must not re-accrue.
                eq(matchDataTable.voided, false),
            ),
        )
        .groupBy(matchDataTable.gameId)
        .having(sql`count(*) = 1`);

    // Build reverse lookup: MapId number → map type name string
    const mapIdToName = Object.fromEntries(
        Object.entries(MapDefs).map(([name, def]) => [def.mapId, name]),
    ) as Record<number, string>;

    // Returns the XP boost multiplier for a given pass/map/time, or 1 if none active
    function getXpBoost(mapTypeName: string, matchTime: Date): number {
        const boostEvents = GameConfig.serverSettings.xpBoostEvents?.[passType];
        if (!boostEvents) return 1;
        const t =
            matchTime instanceof Date
                ? matchTime.getTime()
                : new Date(matchTime).getTime();
        for (const event of Object.values(boostEvents)) {
            if (
                t >= new Date(event.start).getTime() &&
                t <= new Date(event.end).getTime() &&
                event.maps.includes(mapTypeName)
            ) {
                return event.boost;
            }
        }
        return 1;
    }

    let totalXp = 0;
    for (const stat of stats) {
        const mapDef = getMapDefById(stat.mapId);
        const xpMultiplier = mapDef?.gameMode?.xpMultiplier || {
            kill: 0,
            damage: 0,
            win: 0,
            timeSurvived: 0,
        };
        const mapTypeName = mapIdToName[stat.mapId] ?? "";
        const boost = getXpBoost(mapTypeName, stat.createdAt);

        let matchXp = 0;
        matchXp += stat.kills * xpMultiplier.kill;
        matchXp += stat.damage * xpMultiplier.damage;
        matchXp += (stat.rank === 1 ? 1 : 0) * xpMultiplier.win;
        matchXp += stat.timeAlive * xpMultiplier.timeSurvived;
        totalXp += matchXp * boost;
    }
    // round to avoid float drift while preserving fractional XP (smallest multiplier is 0.00025)
    totalXp = Math.round(totalXp * 1e5) / 1e5;
    console.log(
        `User ${user.username} earned ${totalXp} XP from ${stats.length} matches since last update`,
    );

    const newTotalXp = currentXp + totalXp;

    const { level, xp } = getPassLevelAndXp(passType, newTotalXp);

    // Grant any pass cosmetics the player has reached but not yet been granted
    // (idempotent via pass_item_grants — survives selling the item later).
    const newUnlocks = await grantPassItems(user.id, passType, level);

    // Pay out pass Golden Fries for levels the player just crossed since
    // their last recorded pass level. Retroactive backfill of older levels
    // is handled separately by the moderation "reconcile" action.
    const oldLevel = userXpRecord?.level ?? 0;
    const goldenFriesAwarded = await awardNewPassGoldenFries(
        user.id,
        passType,
        oldLevel,
        level,
    );
    console.log(
        `User ${user.username} has ${totalXp} XP, level ${level}, ${newUnlocks} new unlocks, golden fries awarded: ${goldenFriesAwarded}`,
    );

    const pass = {
        type: passType,
        level,
        xp,
        newTotalXp,
        newItems: false,
    };
    if (newUnlocks > 0) {
        pass.newItems = true;
    }

    // neue xp und level in der user_xp db speichern
    if (stats.length > 0) {
        await db
            .insert(userXpTable)
            .values({
                userId: user.id,
                passType,
                xp: String(newTotalXp),
                level,
                lastUpdated: new Date(),
            })
            .onConflictDoUpdate({
                target: [userXpTable.userId, userXpTable.passType],
                set: {
                    xp: String(newTotalXp),
                    level,
                    lastUpdated: new Date(),
                },
            });
    }

    const quests = Object.keys(QuestDefs).map((questType, idx) => {
        const questDef = QuestDefs[questType];

        return {
            idx,
            type: questType,
            timeAcquired: Date.now(),
            progress: 0,
            target: questDef.target,
            complete: false,
            rerolled: false,
            timeToRefresh: 0,
        };
    });

    return c.json<GetPassResponse>(
        {
            success: true,
            pass,
            quests,
            questPriv: "",
            goldenFriesAwarded,
        },
        200,
    );
});

UserRouter.post("/refresh_quest", validateParams(zRefreshQuestRequest), (c) => {
    return c.json<RefreshQuestResponse>({ success: true }, 200);
});

const PASS_MAX_LEVEL = GameConfig.serverSettings.passMaxLevel;

function getPassLevelXp(passType: string, level: number) {
    const passDef = PassDefs[passType];
    const levelIdx = level - 1;

    if (levelIdx < passDef.xp.length) {
        return passDef.xp[levelIdx];
    }

    // aktuell gleiches Verhalten wie dein bestehendes passUtil
    return passDef.xp[passDef.xp.length - 1];
}

function getPassLevelAndXp(passType: string, passXp: number) {
    let xp = passXp;
    let level = 1;

    while (level < PASS_MAX_LEVEL) {
        const levelXp = getPassLevelXp(passType, level);

        if (xp < levelXp) {
            break;
        }

        xp -= levelXp;
        level++;
    }

    return {
        level,
        xp,
        nextLevelXp: getPassLevelXp(passType, level),
    };
}
