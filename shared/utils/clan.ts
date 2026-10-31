import { z } from "zod";

/** Golden Fries it costs to found a clan. */
export const CLAN_CREATE_COST = 500;

export const CLAN_NAME_MIN = 3;
export const CLAN_NAME_MAX = 20;
export const CLAN_TAG_MIN = 2;
export const CLAN_TAG_MAX = 5;
/** Members per clan, owner included. */
export const CLAN_MAX_MEMBERS = 50;
/** Open invites + join requests per clan. */
export const CLAN_MAX_PENDING = 50;

/** Letters, digits, spaces and a few separators; no leading/trailing/double spaces. */
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 _.\-]*[A-Za-z0-9])?$/;
/** Tags are stored upper-case. */
const TAG_RE = /^[A-Z0-9]+$/;

export function normalizeClanName(name: string): string {
    return name.trim().replace(/\s+/g, " ");
}

export function normalizeClanTag(tag: string): string {
    return tag.trim().toUpperCase();
}

/** Null when fine, else an error code ("name_length" | "name_chars" | "tag_length" | "tag_chars"). */
export function validateClan(name: string, tag: string): string | null {
    if (name.length < CLAN_NAME_MIN || name.length > CLAN_NAME_MAX) return "name_length";
    if (!NAME_RE.test(name) || name.includes("  ")) return "name_chars";
    if (tag.length < CLAN_TAG_MIN || tag.length > CLAN_TAG_MAX) return "tag_length";
    if (!TAG_RE.test(tag)) return "tag_chars";
    if (CLAN_RESERVED_TAGS.has(tag)) return "tag_reserved";
    return null;
}

export const zClanEditRequest = z.object({
    name: z.string().max(64),
    tag: z.string().max(16),
    /** An emote type the owner owns, or "" for none. */
    icon: z.string().max(64),
    /** index into CLAN_TAG_COLORS (must be unlocked by the clan level) */
    tagColor: z.number().int().min(0).max(63).optional(),
    /** index into CLAN_BANNERS (0 = none, must be unlocked by the clan level) */
    banner: z.number().int().min(0).max(63).optional(),
});
export type ClanEditRequest = z.infer<typeof zClanEditRequest>;

export const zClanListRequest = z.object({ search: z.string().max(32).optional() });
export const zClanSlugRequest = z.object({ slug: z.string().min(1).max(64) });
export const zClanRespondRequest = z.object({ accept: z.boolean() });
export const zClanInviteRespondRequest = z.object({ clanId: z.number().int().positive(), accept: z.boolean() });
export const zClanRequestRespondRequest = z.object({ slug: z.string().min(1).max(64), accept: z.boolean() });
export const zClanIdRequest = z.object({ clanId: z.number().int().positive() });
export const zClanCodeRequest = z.object({ code: z.string().min(4).max(32) });
export const zClanLinkRequest = z.object({ regenerate: z.boolean().optional() });
export const zClanRoleRequest = z.object({
    slug: z.string().min(1).max(64),
    role: z.enum(["lieutenant", "member"]),
});

/** owner: everything; lieutenant: invite, accept requests, kick regular members. */
export type ClanRole = "owner" | "lieutenant" | "member";

export interface ClanMember {
    slug: string;
    username: string;
    icon: string;
    role: ClanRole;
    joinedAt: number;
}

export interface ClanSummary {
    id: number;
    name: string;
    tag: string;
    icon: string;
    members: number;
    ownerSlug: string;
    ownerName: string;
    createdAt: number;
    /** weeks this clan finished #1 in the league */
    titles: number;
    /** clan progress (see clanLevel) */
    xp: number;
    /** index into CLAN_TAG_COLORS */
    tagColor: number;
    /** index into CLAN_BANNERS (0 = none) */
    banner: number;
}

/** A player waiting to join (owner's view): invited by the owner, or asking via the link. */
export interface ClanPendingPlayer {
    slug: string;
    username: string;
    icon: string;
    at: number;
}

export interface ClanDetails extends ClanSummary {
    memberList: ClanMember[];
    myRole: ClanRole;
    /** this week's totals, shown next to the clan name */
    weekStats: ClanWeekSummary;
    /** league keys waiting to be handed out by the owner */
    pool: Record<string, number>;
    /** Owner and lieutenants: the invite link and the pending joins. */
    manage?: {
        inviteCode: string | null;
        requests: ClanPendingPlayer[];
        invites: ClanPendingPlayer[];
    };
}

export interface MyClanResponse {
    clan: ClanDetails | null;
    /** Clans that invited me (only while I'm in no clan). */
    invites: ClanSummary[];
    /** Clans I asked to join via a link, still waiting for the owner. */
    requests: ClanSummary[];
}

export interface ClanLinkInfoResponse {
    clan: ClanSummary | null;
    /** what the visitor can do: request, or they're already in / waiting */
    state: "request" | "member" | "requested" | "invited" | "in_clan" | "full" | "blocked";
}

export interface ClanLinkResponse {
    success: boolean;
    code?: string;
    error?: string;
}

export interface ClanListResponse {
    clans: ClanSummary[];
}

export interface ClanActionResponse {
    success: boolean;
    /** validation codes from validateClan, plus "name_taken" | "tag_taken" | "bad_words" |
     *  "bad_icon" | "already_in_clan" | "not_owner" | "insufficient_funds" | "not_found" |
     *  "already_member" | "already_invited" | "clan_full" | "too_many_pending" | "self" |
     *  "owner_cannot_leave" | "not_member" | "blocked" | "no_permission" | "error" */
    error?: string;
    balance?: number;
    /** invite: the player had already asked to join, so they joined right away */
    joined?: boolean;
}

// ── Weekly clan stats (public, full Comp lobbies) + league + rewards ──────────

/**
 * League views. "rated" decides the weekly rewards; the others are just for fun.
 *
 * Rated win rate = (wins + PRIOR × league average) / (games + PRIOR): every clan starts
 * with PRIOR "average" games on top of its real ones. A few lucky games can't put a
 * clan on top, a big sample counts almost purely by its real win rate - so quality wins,
 * not clan size or grinding volume, and stopping to protect a lead doesn't help either.
 */
export type ClanLeagueMetric = "rated" | "wins" | "winrate" | "damage";

/** The "average games" every clan starts with in the rated win rate. */
export const CLAN_RATING_PRIOR_GAMES = 20;

export function ratedWinRate(wins: number, games: number, leagueAverage: number): number {
    return (wins + CLAN_RATING_PRIOR_GAMES * leagueAverage) / (games + CLAN_RATING_PRIOR_GAMES);
}

/** Only games with at least this many human players count (a full Comp lobby). */
export const CLAN_MIN_LOBBY_PLAYERS = 8;
/** Wins/game and damage/game need this many games this week to be ranked. */
export const CLAN_LEAGUE_MIN_GAMES = 10;
/** Rewards only go to clans with this many members who played ... */
export const CLAN_REWARD_MIN_ACTIVE = 3;
/** ... at least this many games each this week. */
export const CLAN_REWARD_MIN_GAMES_EACH = 5;

/** The weekly key pool for places 1-3 (handed out by the owner). */
export const CLAN_WEEK_REWARDS: Record<number, Record<string, number>> = {
    1: { key_airdrop: 4, key_soviet: 6, key_wooden: 2 },
    2: { key_airdrop: 1, key_soviet: 4, key_wooden: 3 },
    3: { key_soviet: 1, key_wooden: 4 },
};

export const zClanIdOptRequest = z.object({ clanId: z.number().int().positive().optional() });
export const zClanLeagueRequest = z.object({ metric: z.enum(["rated", "wins", "winrate", "damage"]) });
export const zClanPoolGiveRequest = z.object({
    slug: z.string().min(1).max(64),
    keyType: z.string().min(1).max(64),
    amount: z.number().int().min(1).max(100),
});

export interface ClanModeStats {
    games: number;
    wins: number;
    damage: number;
    kills: number;
    /** wins weighted by the team bonus - what the rated win rate uses */
    weightedWins: number;
}

/** A clan's week: totals, how many members played (and how many qualify for rewards). */
export interface ClanWeekSummary extends ClanModeStats {
    /** members who played at least one counted game this week */
    players: number;
    /** members with CLAN_REWARD_MIN_GAMES_EACH+ games */
    qualified: number;
    /** the rated (smoothed) win rate that decides the rewards, 0..1 */
    rating: number;
    /** enough qualified members to get rewards */
    eligible: boolean;
    /** average games of the qualified members (weekly goals) */
    avgGames: number;
    /** weekly goal tiers reached so far (0-3) */
    goalTier: number;
}

/** Monday 00:00 → next Monday 00:00 (server-local), epoch ms. */
export interface ClanWeek {
    start: number;
    end: number;
}

export interface ClanStatsResponse {
    week: ClanWeek;
    /** everything played for the clan this week (also by players who left since) */
    totals: ClanWeekSummary;
    /** current members, with what they played for the clan this week */
    members: {
        slug: string;
        username: string;
        icon: string;
        role: ClanRole;
        stats: ClanModeStats;
    }[];
}

/** A clan as anyone can look at it (league / clan list popup). */
export interface ClanViewResponse {
    clan: (ClanSummary & { memberList: ClanMember[] }) | null;
    stats: ClanStatsResponse | null;
}

export interface ClanLeagueEntry extends ClanWeekSummary {
    id: number;
    name: string;
    tag: string;
    icon: string;
    tagColor: number;
    banner: number;
    titles: number;
    /** the value of the chosen metric */
    value: number;
}

export interface ClanLeagueResponse {
    week: ClanWeek;
    minGames: number;
    /** ranked; for "rated" only the clans that can get rewards */
    entries: ClanLeagueEntry[];
    /** "rated" only: clans that played but don't qualify for rewards yet */
    unranked: ClanLeagueEntry[];
    /** this week's win rate over all clans (what the rating pulls towards) */
    leagueAverage: number;
}

export function perGame(total: number, games: number): number {
    return games > 0 ? total / games : 0;
}

// ── Team bonus, weekly goals, clan level ──────────────────────────────────────

/** A win counts more for the rated win rate when clan mates were in the same team. */
export const CLAN_TEAM_BONUS: Record<number, number> = { 2: 1.25, 3: 1.5, 4: 1.75 };

export function clanTeamBonus(clanMatesInTeam: number): number {
    if (clanMatesInTeam >= 4) return CLAN_TEAM_BONUS[4];
    return CLAN_TEAM_BONUS[clanMatesInTeam] ?? 1;
}

/**
 * Weekly activity goals: the average games of the clan's players with
 * CLAN_REWARD_MIN_GAMES_EACH+ games. Every tier reached pays one key to each of those
 * players directly (tiers add up: reaching 100 pays the 50 tier too).
 */
export const CLAN_GOAL_TIERS: { avgGames: number; key: string }[] = [
    { avgGames: 50, key: "key_wooden" },
    { avgGames: 100, key: "key_soviet" },
    { avgGames: 150, key: "key_airdrop" },
];

export function clanGoalTier(avgGames: number): number {
    return CLAN_GOAL_TIERS.filter((t) => avgGames >= t.avgGames).length;
}

/** Total clan XP needed for each level (index 0 = level 1). The members' match XP - the
 *  same XP they earn for the battle pass - adds up into it. */
// a Comp match is worth ~7 XP: an active 5-player clan (~20 games each) makes ~700 a week
export const CLAN_LEVEL_XP = [0, 350, 900, 1750, 3500, 7000, 12000, 19000, 28000, 42000];

export function clanLevel(xp: number): { level: number; levelXp: number; nextXp: number | null } {
    let level = 1;
    while (level < CLAN_LEVEL_XP.length && xp >= CLAN_LEVEL_XP[level]) level++;
    return { level, levelXp: CLAN_LEVEL_XP[level - 1], nextXp: CLAN_LEVEL_XP[level] ?? null };
}

/**
 * Tag colours a clan can unlock with its level. None of them may look like a staff /
 * premium tag (owner #c77dff, admin #ff4d4d, mod #4dc9ff, premium #f2d63b, bot #7ddba6).
 */
export const CLAN_TAG_COLORS: { name: string; color: string; level: number }[] = [
    { name: "White", color: "#ffffff", level: 1 },
    { name: "Silver", color: "#b8c0cc", level: 1 },
    { name: "Orange", color: "#ff9a3c", level: 2 },
    { name: "Lime", color: "#a8e63b", level: 3 },
    { name: "Pink", color: "#ff6fb5", level: 4 },
    { name: "Teal", color: "#22d3c5", level: 5 },
    { name: "Royal", color: "#5b7cff", level: 6 },
    { name: "Bronze", color: "#cd7f32", level: 7 },
    { name: "Rose", color: "#f4a7b9", level: 8 },
    { name: "Emerald", color: "#2ecc71", level: 9 },
    { name: "Crimson", color: "#e0245e", level: 10 },
];

export function clanTagColor(index: number): string {
    return CLAN_TAG_COLORS[index]?.color ?? CLAN_TAG_COLORS[0].color;
}

/** Tags that look like staff / premium prefixes can't be used. */
export const CLAN_RESERVED_TAGS = new Set(["OWNER", "ADMIN", "MOD", "PREM", "BOT", "STAFF", "DEV"]);

/**
 * Clan banners: patterns drawn behind the clan's header (clan page, clan popup) and as a
 * strip behind its row in the league / clan list. They take the clan's tag colour. The
 * look lives in CSS (.clan-banner-<key>); the clan level unlocks them like tag colours.
 */
export const CLAN_BANNERS: { key: string; name: string; level: number }[] = [
    { key: "none", name: "None", level: 1 },
    { key: "stripes", name: "Stripes", level: 2 },
    { key: "dots", name: "Dots", level: 3 },
    { key: "camo", name: "Camo", level: 4 },
    { key: "chevron", name: "Chevron", level: 5 },
    { key: "sunburst", name: "Sunburst", level: 6 },
    { key: "waves", name: "Waves", level: 7 },
    { key: "flames", name: "Flames", level: 8 },
    { key: "carbon", name: "Carbon", level: 9 },
    { key: "galaxy", name: "Galaxy", level: 10 },
];
