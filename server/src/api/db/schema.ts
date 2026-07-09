import { sql } from "drizzle-orm";
import {
    bigint,
    boolean,
    index,
    integer,
    json,
    numeric,
    pgTable,
    primaryKey,
    serial,
    text,
    timestamp,
    unique,
    uniqueIndex,
    uuid,
} from "drizzle-orm/pg-core";
import { TeamMode } from "../../../../shared/gameConfig";
import { ItemStatus, type Loadout, loadout } from "../../../../shared/utils/loadout";
import { table } from "node:console";

export const sessionTable = pgTable("session", {
    id: text("id").primaryKey(),
    userId: text("user_id")
        .notNull()
        .references(() => usersTable.id, {
            onDelete: "cascade",
            onUpdate: "cascade",
        }),
    expiresAt: timestamp("expires_at").notNull(),
});

export type SessionTableSelect = typeof sessionTable.$inferSelect;

export const usersTable = pgTable("users", {
    id: text("id").notNull().primaryKey(),
    authId: text("auth_id").notNull(),
    slug: text("slug").notNull().unique(),
    admin: boolean("admin").notNull().default(false),
    banned: boolean("banned").notNull().default(false),
    banReason: text("ban_reason").notNull().default(""),
    bannedBy: text("banned_by").notNull().default(""),
    // When the account ban auto-expires. null = permanent (or no ban). Temporary
    // account bans are lifted by the ban-expiry sweep (see db/banExpiry.ts).
    banExpiresAt: timestamp("ban_expires_at", { withTimezone: true }),
    username: text("username").notNull().default(""),
    usernameSet: boolean("username_set").notNull().default(false),
    userCreated: timestamp("user_created", { withTimezone: true }).notNull().defaultNow(),
    lastUsernameChangeTime: timestamp("last_username_change_time"),
    linked: boolean("linked").notNull().default(false),
    linkedGoogle: boolean("linked_google").notNull().default(false),
    linkedDiscord: boolean("linked_discord").notNull().default(false),
    loadout: json("loadout")
        .notNull()
        .default(loadout.validate({} as Loadout))
        .$type<Loadout>(),
    goldenFries: integer("golden_fries").notNull().default(0),
    // Instance ids the player had selected/equipped at their last game join, so match
    // stats can attach to the exact owned copy (snapshot per game; falls back to the
    // oldest instance of a type when absent). The client reports these on join.
    equippedInstanceIds: json("equipped_instance_ids")
        .$type<number[]>()
        .notNull()
        .default([]),
});

export type UsersTableInsert = typeof usersTable.$inferInsert;
export type UsersTableSelect = typeof usersTable.$inferSelect;

// Instance-based inventory: one row per owned item instance, so a player can own
// the same `type` multiple times (needed for trading). Equipping stays type-based.
export const itemsTable = pgTable(
    "items",
    {
        id: serial("id").primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),
        type: text("type").notNull(),
        timeAcquired: bigint("time_acquired", { mode: "number" }).notNull(),
        source: text("source").notNull().default("unlock_new_account"),
        status: integer("status").notNull().default(ItemStatus.New),
        // Ownership history (slugs), appended each time the instance is traded.
        previousOwners: json("previous_owners").$type<string[]>().notNull().default([]),
        // Lifetime match stats accrued by this instance while equipped in a game.
        games: integer("games").notNull().default(0),
        wins: integer("wins").notNull().default(0),
        kills: integer("kills").notNull().default(0),
        damage: integer("damage").notNull().default(0),
    },
    (table) => [
        index("items_user_idx").on(table.userId),
        index("items_user_type_idx").on(table.userId, table.type),
    ],
);

export type ItemsTableSelect = typeof itemsTable.$inferSelect;

// Idempotent record of pass/premium item grants, independent of current ownership
// (so selling a pass item can't make the reconcile re-grant it for free). The item
// is part of the key so newly-added items on a level get granted retroactively.
export const passItemGrantsTable = pgTable(
    "pass_item_grants",
    {
        userId: text("user_id")
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),
        // e.g. "pass:pass_survivr1:5:outfitWhite" or "premium:pass_survivr1:8:..."
        grantKey: text("grant_key").notNull(),
        grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.userId, table.grantKey] }),
    }),
);

// One row per purchased daily shop offer, to prevent buying the same slot twice a day.
export const shopPurchasesTable = pgTable(
    "shop_purchases",
    {
        userId: text("user_id")
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),
        day: text("day").notNull(), // UTC date "YYYY-MM-DD"
        slot: integer("slot").notNull(),
        purchasedAt: timestamp("purchased_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.userId, table.day, table.slot] }),
    }),
);

// Player-to-player marketplace listings. `status` moves active → sold | cancelled.
// The partial-unique index on item_id (where status='active') is the lock that
// prevents the same item instance being listed twice at once.
export const marketListingsTable = pgTable(
    "market_listings",
    {
        id: serial("id").primaryKey(),
        itemId: integer("item_id")
            .notNull()
            .references(() => itemsTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),
        sellerId: text("seller_id")
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),
        // Denormalized for storefront/display and category filtering without joins.
        sellerSlug: text("seller_slug").notNull(),
        type: text("type").notNull(),
        category: text("category").notNull(), // shop category, for browse filtering
        rarity: integer("rarity").notNull().default(0), // denormalized, for browse filtering
        price: integer("price").notNull(), // seller's ask (what the seller receives)
        status: text("status").notNull().default("active"), // active | sold | cancelled | expired
        // Target buyer's slug for a private listing (null = public, anyone may buy).
        buyerSlug: text("target_buyer_slug"),
        buyerId: text("buyer_id"),
        // false until the seller has seen the "your item sold" notification.
        sellerAcked: boolean("seller_acked").notNull().default(false),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        closedAt: timestamp("closed_at", { withTimezone: true }),
    },
    (table) => [
        uniqueIndex("market_active_item_idx")
            .on(table.itemId)
            .where(sql`${table.status} = 'active'`),
        index("market_status_created_idx").on(table.status, table.createdAt),
        index("market_status_cat_created_idx").on(
            table.status,
            table.category,
            table.createdAt,
        ),
        index("market_seller_status_idx").on(table.sellerId, table.status),
        index("market_buyer_status_idx").on(table.buyerSlug, table.status),
    ],
);

export type MarketListingSelect = typeof marketListingsTable.$inferSelect;

export const matchDataTable = pgTable(
    "match_data",
    {
        userId: text("user_id").default(""),
        userBanned: boolean("user_banned").default(false),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        region: text("region").notNull(),
        mapId: integer("map_id").notNull(),
        gameId: uuid("game_id").notNull(),
        mapSeed: bigint("map_seed", { mode: "number" }).notNull(),
        username: text("username").notNull(),
        playerId: integer("player_id").notNull(),
        teamMode: integer("team_mode").$type<TeamMode>().notNull(),
        teamCount: integer("team_count").notNull(),
        teamTotal: integer("team_total").notNull(),
        teamId: integer("team_id").notNull(),
        timeAlive: integer("time_alive").notNull(),
        rank: integer("rank").notNull(),
        died: boolean("died").notNull(),
        kills: integer("kills").notNull(),
        assists: integer("assists").notNull().default(0),
        teamKills: integer("team_kills").notNull().default(0),
        damageDealt: integer("damage_dealt").notNull(),
        damageTaken: integer("damage_taken").notNull(),
        killerId: integer("killer_id").notNull(),
        killedIds: integer("killed_ids").array().notNull(),
        assistedIds: integer("assisted_ids").array().notNull().default([]),
        encodedIp: text("encoded_ip").notNull().default(""),
        // Set true when a moderator marks this player's participation in the game as
        // "botted": voided rows are excluded from EVERY XP aggregation (reconcile,
        // /get_pass, the XP-gain leaderboard) so the revoked XP never re-accrues.
        // Reversible — clearing the flag lets the XP be recomputed again.
        voided: boolean("voided").notNull().default(false),
        // Set when a moderator "removes" this player from the game: their user_id is
        // moved here and user_id is blanked, so the row becomes a guest row and the
        // game disappears from that account's stats AND the leaderboard (both filter
        // user_id <> ''), without deleting the game. Reversible — restore moves it back.
        removedUserId: text("removed_user_id"),
    },
    (table) => [
        index("idx_match_data_user_stats").on(
            table.userId,
            table.teamMode,
            table.rank,
            table.kills,
            table.assists,
            table.damageDealt,
            table.timeAlive,
        ),
        index("idx_game_id").on(table.gameId),
        index("idx_user_id").on(table.userId),
        index("idx_match_data_team_query").on(
            table.teamMode,
            table.mapId,
            table.createdAt,
            table.gameId,
            table.teamId,
            table.region,
            table.kills,
            table.assists,
        ),
    ],
);

export type MatchDataTable = typeof matchDataTable.$inferInsert;

//
// LOGS
//
export const ipLogsTable = pgTable(
    "ip_logs",
    {
        id: serial().primaryKey(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        region: text("region").notNull(),
        gameId: text("game_id").notNull(),
        mapId: integer("map_id").notNull(),
        username: text("username").notNull(),
        userId: text("user_id").default(""),
        encodedIp: text("encoded_ip").notNull(),
        teamMode: integer("team_mode").$type<TeamMode>().notNull().default(TeamMode.Solo),
        ip: text("ip").notNull(),
        // also store the IP that was used in api/find_game...
        // since one could exploit that to never get banned
        // by requesting it with a different IP than the in-game one
        findGameIp: text("find_game_ip").notNull(),
        findGameEncodedIp: text("find_game_encoded_ip").notNull(),
        isp: text("isp").notNull().default(""),
    },
    (table) => [index("name_created_at_idx").on(table.username, table.createdAt)],
);

export type IpLogsTable = typeof ipLogsTable.$inferSelect;

export const chatLogsTable = pgTable(
    "chat_logs",
    {
        id: serial().primaryKey(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        gameId: text("game_id").notNull(),
        username: text("username").notNull(),
        userId: text("user_id").notNull().default(""),
        encodedIp: text("encoded_ip").notNull(),
        channel: integer("channel").notNull().default(0), // 0 = all, 1 = team
        message: text("message").notNull(),
    },
    (table) => [
        index("chat_logs_username_idx").on(table.username, table.createdAt),
        index("chat_logs_ip_idx").on(table.encodedIp, table.createdAt),
        index("chat_logs_user_id_idx").on(table.userId, table.createdAt),
    ],
);

export type ChatLogsTable = typeof chatLogsTable.$inferSelect;

export const bannedIpsTable = pgTable("banned_ips", {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresIn: timestamp("expires_in").notNull(),
    encodedIp: text("encoded_ip").notNull().primaryKey(),
    permanent: boolean("permanent").notNull().default(false),
    reason: text("reason").notNull().default(""),
    bannedBy: text("banned_by").notNull().default("admin"),
});

export const chatBannedIpsTable = pgTable("chat_banned_ips", {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresIn: timestamp("expires_in").notNull(),
    encodedIp: text("encoded_ip").notNull().primaryKey(),
    permanent: boolean("permanent").notNull().default(false),
    reason: text("reason").notNull().default(""),
    bannedBy: text("banned_by").notNull().default("admin"),
});

export const banCommentsTable = pgTable(
    "ban_comments",
    {
        id: serial().primaryKey(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        banType: text("ban_type").notNull(), // "ip" | "account" | "chat"
        banTarget: text("ban_target").notNull(), // encoded IP hash or account slug
        comment: text("comment").notNull(),
        createdBy: text("created_by").notNull(),
    },
    (table) => [
        index("ban_comments_target_idx").on(table.banType, table.banTarget, table.createdAt),
    ],
);

export type BanCommentsTable = typeof banCommentsTable.$inferSelect;

/**
 * Append-only audit log of ban actions, so the full history survives even after a
 * ban is lifted (the live `banned_ips`/`chat_banned_ips` rows are deleted on unban).
 * One row per ban action; the matching active row(s) get `unbannedAt`/`unbannedBy`
 * set when the ban is removed. Mirrors the `banType`/`banTarget` convention used by
 * `ban_comments` (target = encoded IP hash for ip/chat, account slug for account).
 */
export const banHistoryTable = pgTable(
    "ban_history",
    {
        id: serial().primaryKey(),
        banType: text("ban_type").notNull(), // "ip" | "account" | "chat"
        banTarget: text("ban_target").notNull(), // encoded IP hash or account slug
        reason: text("reason").notNull().default(""),
        bannedBy: text("banned_by").notNull(), // admin slug
        bannedAt: timestamp("banned_at", { withTimezone: true }).notNull().defaultNow(),
        expiresAt: timestamp("expires_at", { withTimezone: true }), // null = no auto-expiry (account bans)
        permanent: boolean("permanent").notNull().default(false),
        unbannedAt: timestamp("unbanned_at", { withTimezone: true }), // null = still active
        unbannedBy: text("unbanned_by"), // null = still active
    },
    (table) => [
        index("ban_history_target_idx").on(table.banType, table.banTarget, table.bannedAt),
    ],
);

export type BanHistoryTable = typeof banHistoryTable.$inferSelect;

/**
 * Per-(game, player) moderation flag, set from the XP-gain "Games" view.
 *
 *   status = "sus"    → watchlist label only, no effect on XP.
 *   status = "botted" → the XP this player gained in this game, plus the pass
 *                       cosmetics and Golden Fries earned from it, are revoked.
 *
 * Reversible: the exact per-pass XP amount removed is stored in `xpDeltas`, so
 * clearing a "botted" flag adds it back (and the idempotent grant helpers restore
 * the cosmetics + fries). Mirrors the reversible-audit shape of `ban_history`.
 */
export const gameModerationTable = pgTable(
    "game_moderation",
    {
        gameId: uuid("game_id").notNull(),
        userId: text("user_id").notNull(),
        status: text("status").notNull(), // "sus" | "botted" | "removed"
        note: text("note").notNull().default(""),
        markedBy: text("marked_by").notNull(), // admin slug
        markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
        // For "botted": the exact XP removed per pass, so a later un-bott restores it
        // precisely. Empty for "sus".
        xpDeltas: json("xp_deltas")
            .$type<{ passType: string; xpDelta: number }[]>()
            .notNull()
            .default([]),
    },
    (table) => [
        primaryKey({ columns: [table.gameId, table.userId] }),
        index("game_moderation_user_idx").on(table.userId),
    ],
);

export type GameModerationTable = typeof gameModerationTable.$inferSelect;

export const userXpTable = pgTable("user_xp", {
    userId: text("user_id").notNull()
    .references(() => usersTable.id, {
            onDelete: "cascade",
            onUpdate: "cascade",
        }),
    passType: text("pass_type").notNull(),
    level: integer("level").notNull(),
    xp: numeric("xp").notNull(),
    lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
    // Deprecated/unused — kept only to avoid a destructive migration; superseded by
    // the reconcile anchor below.
    manualOverride: boolean("manual_override").notNull().default(false),
    // Reconcile anchor for admin XP edits: when an admin sets the XP, we store that
    // value as `reconcileBaseXp` and the time as `reconcileFrom`. The reconcile job
    // then computes XP as `reconcileBaseXp + matches after reconcileFrom`, so the
    // admin value sticks (old matches aren't re-counted) while new matches still
    // accrue. `reconcileFrom = null` ⇒ no override (count the whole season).
    reconcileBaseXp: numeric("reconcile_base_xp").notNull().default("0"),
    reconcileFrom: timestamp("reconcile_from", { withTimezone: true }),
},
    (table) => ({
        pk: primaryKey({ columns: [table.userId, table.passType] }),
    }),
);

/**
 * Append-only ledger of every Golden Fries balance change (earn or spend).
 * `amount` is a signed delta (+ earn, - spend); `balanceAfter` is the user's
 * `users.golden_fries` value right after the transaction was applied.
 */
export const goldenFriesLedgerTable = pgTable(
    "golden_fries_ledger",
    {
        id: serial().primaryKey(),
        userId: text("user_id")
            .notNull()
            .references(() => usersTable.id, {
                onDelete: "cascade",
                onUpdate: "cascade",
            }),
        amount: integer("amount").notNull(), // + = earn, - = spend
        reason: text("reason").notNull(), // e.g. "pass_level", "admin_grant", "purchase:<item>"
        balanceAfter: integer("balance_after").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("golden_fries_ledger_user_idx").on(table.userId, table.createdAt),
        // Idempotency lock for pass fries payouts: at most one ledger row per
        // (user, pass-level reason), so concurrent /get_pass or reconcile can't
        // double-award. Scoped to `pass:%` so market/shop reasons are unaffected.
        uniqueIndex("golden_fries_ledger_pass_reason_idx")
            .on(table.userId, table.reason)
            .where(sql`${table.reason} LIKE 'pass:%'`),
    ],
);

export type GoldenFriesLedgerTable = typeof goldenFriesLedgerTable.$inferSelect;
