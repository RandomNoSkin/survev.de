import { z } from "zod";
import { TeamMode } from "../gameConfig.ts";
import { ALL_TEAM_MODES } from "./stats.ts";

export const OAUTH_SCOPES = ["read:discord", "read:stats", "read:inventory", "read:market"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
export const zOAuthScope = z.enum(OAUTH_SCOPES);

export const OAUTH_APP_STATUSES = ["pending", "approved", "rejected", "suspended"] as const;
export type OAuthAppStatus = (typeof OAUTH_APP_STATUSES)[number];

export const zRedirectUri = z
    .string()
    .url()
    .refine(
        (value) => value.startsWith("https://") || value.startsWith("http://localhost"),
        "redirect_uri must use https:// (http://localhost is allowed for local development)",
    );

export const zCreateAppRequest = z.object({
    name: z.string().trim().min(1).max(64),
    description: z.string().trim().max(280).default(""),
    redirectUris: z.array(zRedirectUri).max(10).default([]),
});
export type CreateAppRequest = z.infer<typeof zCreateAppRequest>;

export const zUpdateAppRequest = z.object({
    applicationId: z.string().min(1),
    name: z.string().trim().min(1).max(64),
    description: z.string().trim().max(280).default(""),
    redirectUris: z.array(zRedirectUri).max(10).default([]),
});
export type UpdateAppRequest = z.infer<typeof zUpdateAppRequest>;

export type OAuthApp = {
    id: string;
    name: string;
    description: string;
    redirectUris: string[];
    status: OAuthAppStatus;
    reviewNote: string;
    secretLastFour: string;
    createdAt: string;
    secretRotatedAt: string | null;
};

export type CreateAppResponse = {
    app: OAuthApp;
    /** Shown once — never retrievable again. */
    clientSecret: string;
};

export const zAuthorizeRequest = z.object({
    clientId: z.string().min(1),
    redirectUri: z.string().min(1),
    scope: z.array(zOAuthScope).min(1),
    state: z.string().max(512).default(""),
});
export type AuthorizeRequest = z.infer<typeof zAuthorizeRequest>;

export type AuthorizeInfoResponse =
    | {
          error: string;
      }
    | {
          appName: string;
          ownerSlug: string;
          scopes: OAuthScope[];
      };

export type AuthorizeDecisionResponse = {
    redirectUrl: string;
};

export const zDeviceCodeRequest = z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    scope: z.array(zOAuthScope).min(1),
});
export type DeviceCodeRequest = z.infer<typeof zDeviceCodeRequest>;

export type DeviceCodeResponse = {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
};

export const zDeviceLookupRequest = z.object({
    userCode: z.string().min(1),
});

export const zDeviceDecisionRequest = z.object({
    userCode: z.string().min(1),
});

export const zTokenRequest = z.discriminatedUnion("grantType", [
    z.object({
        grantType: z.literal("authorization_code"),
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        code: z.string().min(1),
        redirectUri: z.string().min(1),
    }),
    z.object({
        grantType: z.literal("device_code"),
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        deviceCode: z.string().min(1),
    }),
]);
export type TokenRequest = z.infer<typeof zTokenRequest>;

export type TokenResponse = {
    accessToken: string;
    tokenType: "bearer";
    scope: OAuthScope[];
};

export type TokenErrorResponse = {
    error:
        | "invalid_client"
        | "invalid_grant"
        | "app_not_approved"
        | "authorization_pending"
        | "slow_down"
        | "access_denied"
        | "expired_token";
};

export type OAuthGrantEntry = {
    applicationId: string;
    appName: string;
    scopes: OAuthScope[];
    createdAt: string;
    lastUsedAt: string | null;
};

export const zApplicationIdRequest = z.object({
    applicationId: z.string().min(1),
});

export type DiscordLinkResponse = {
    linked: boolean;
    discordUserId: string | null;
    /** The survev.de account's identity — always present regardless of `linked`. */
    slug: string;
    username: string;
};

/** One owned cosmetic instance, with its trade history and current value (scope
 *  `read:inventory`). */
export type InventoryItem = {
    /** Inventory instance id (absent for virtual default-unlock items). */
    id?: number;
    type: string;
    /** Display name from the item's definition (not localized). */
    name: string;
    rarity: number;
    lore?: string;
    /** Current Golden Fries shop value (0 for non-shoppable/Stock items). */
    value: number;
    /** Golden Fries the current owner paid to acquire this instance (null = unknown,
     *  e.g. default unlocks). */
    pricePaid: number | null;
    /** Ownership history (slugs), oldest first — present for traded items. */
    previousOwners: string[];
    timeAcquired: number;
    source: string;
    /** Lifetime match stats accrued by this instance while equipped. */
    games: number;
    wins: number;
    kills: number;
    damage: number;
};

/** The account's full owned-item inventory (scope `read:inventory`) — every cosmetic
 *  copy the user owns, not just what's currently equipped. Unlike the public
 *  `/api/user_loadout` (slug-based) endpoint, this ignores `loadoutPrivate` — the user
 *  explicitly granted this app access, so their public-visibility preference doesn't
 *  apply to it. */
export type InventoryResponse = {
    slug: string;
    username: string;
    items: InventoryItem[];
};

export const zExternalMatchHistoryRequest = z
    .object({
        /** Epoch ms, inclusive range start. Omit for "no lower bound" (the most recent
         *  `count` games, optionally still capped by `to`). */
        from: z.number().int().nonnegative().optional(),
        /** Epoch ms, inclusive range end. Omit for "up to now". */
        to: z.number().int().nonnegative().optional(),
        teamModeFilter: z
            .union([
                z.literal(TeamMode.Solo),
                z.literal(TeamMode.Duo),
                z.literal(TeamMode.Squad),
                z.literal(ALL_TEAM_MODES),
            ])
            .default(ALL_TEAM_MODES),
        offset: z.number().int().nonnegative().default(0),
        count: z.number().int().min(1).max(200).default(50),
        /** Only games where every one of these survev.de slugs also played. */
        withSlugs: z.array(z.string().min(1)).max(10).optional(),
    })
    .refine((v) => v.from == null || v.to == null || v.from <= v.to, {
        message: "`from` must be <= `to`",
    });
export type ExternalMatchHistoryRequest = z.infer<typeof zExternalMatchHistoryRequest>;

//
// Moderation dashboard: app review
//

export const zAppReviewRequest = z.object({
    applicationId: z.string().min(1),
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().max(280).default(""),
});
export type AppReviewRequest = z.infer<typeof zAppReviewRequest>;

export type PendingApp = OAuthApp & { ownerSlug: string };
