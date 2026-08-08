import { and, eq, notInArray } from "drizzle-orm";
import { Hono } from "hono";
import { UnlockDefs } from "../../../../../shared/defs/gameObjects/unlockDefs.ts";
import { GameObjectDefs } from "../../../../../shared/defs/register.ts";
import { getItemPrice } from "../../../../../shared/defs/shopConfig.ts";
import { Rarity } from "../../../../../shared/gameConfig.ts";
import {
    type DiscordLinkResponse,
    type InventoryItem,
    type InventoryResponse,
    zExternalMatchHistoryRequest,
} from "../../../../../shared/types/oauth.ts";
import { type MatchHistoryResponse, type UserStatsResponse, zUserStatsRequest } from "../../../../../shared/types/stats.ts";
import type { ShopResponse } from "../../../../../shared/types/user.ts";
import { databaseEnabledMiddleware, validateParams } from "../../auth/middleware.ts";
import { oauthAppRateLimitMiddleware, requireOAuthScope } from "../../auth/oauthMiddleware.ts";
import { db } from "../../db/index.ts";
import { matchHistoryQuery } from "../../db/matchHistory.ts";
import { itemsTable } from "../../db/schema.ts";
import { getShopForUser } from "../../db/shop.ts";
import { userStatsSqlQuery } from "../../db/stats.ts";
import type { Context } from "../../index.ts";

const zExternalStatsRequest = zUserStatsRequest.omit({ slug: true });

/**
 * Resource API for third-party applications: bearer-token authenticated (see
 * `requireOAuthScope`), one endpoint per scope, called server-to-server by an app's
 * own backend (no session cookie, no CORS concern) on behalf of a user who granted
 * that scope through the /authorize or /link consent flow.
 */
export const ExternalRouter = new Hono<Context>();

ExternalRouter.use(databaseEnabledMiddleware);

ExternalRouter.post(
    "/discord_link",
    requireOAuthScope("read:discord"),
    oauthAppRateLimitMiddleware,
    async (c) => {
        const user = c.get("user")!;
        return c.json<DiscordLinkResponse>({
            linked: user.linkedDiscord,
            discordUserId: user.linkedDiscord ? user.authId : null,
            slug: user.slug,
            username: user.username,
        });
    },
);

ExternalRouter.post(
    "/stats",
    requireOAuthScope("read:stats"),
    oauthAppRateLimitMiddleware,
    validateParams(zExternalStatsRequest),
    async (c) => {
        const user = c.get("user")!;
        const { interval, mapIdFilter } = c.req.valid("json");

        const data = await userStatsSqlQuery(user.id, mapIdFilter, interval);

        return c.json<UserStatsResponse>(data);
    },
);

ExternalRouter.post(
    "/match_history",
    requireOAuthScope("read:stats"),
    oauthAppRateLimitMiddleware,
    validateParams(zExternalMatchHistoryRequest),
    async (c) => {
        const user = c.get("user")!;
        const { from, to, teamModeFilter, offset, count, withSlugs } = c.req.valid("json");

        const data = await matchHistoryQuery({
            userId: user.id,
            teamModeFilter,
            from: from != null ? new Date(from) : undefined,
            to: to != null ? new Date(to) : undefined,
            offset,
            limit: count,
            withSlugs,
        });

        return c.json<MatchHistoryResponse>(data);
    },
);

ExternalRouter.post(
    "/inventory",
    requireOAuthScope("read:inventory"),
    oauthAppRateLimitMiddleware,
    async (c) => {
        const user = c.get("user")!;
        const defaultUnlockItems = UnlockDefs["unlock_default"].unlocks;

        const rows = await db
            .select({
                id: itemsTable.id,
                type: itemsTable.type,
                timeAcquired: itemsTable.timeAcquired,
                source: itemsTable.source,
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

        const items: InventoryItem[] = rows.map((row) => {
            const def = GameObjectDefs.typeToDefSafe(row.type) as
                | { name: string; rarity?: number; lore?: string }
                | undefined;
            return {
                id: row.id,
                type: row.type,
                name: def?.name ?? row.type,
                rarity: def?.rarity ?? Rarity.Common,
                lore: def?.lore,
                value: getItemPrice(row.type),
                pricePaid: row.pricePaid,
                previousOwners: row.previousOwners,
                timeAcquired: row.timeAcquired,
                source: row.source,
                games: row.games,
                wins: row.wins,
                kills: row.kills,
                damage: row.damage,
            };
        });

        return c.json<InventoryResponse>({
            slug: user.slug,
            username: user.username,
            items,
        });
    },
);

ExternalRouter.post(
    "/market",
    requireOAuthScope("read:market"),
    oauthAppRateLimitMiddleware,
    async (c) => {
        const user = c.get("user")!;
        const data = await getShopForUser(user.id);
        return c.json<ShopResponse>(data);
    },
);
