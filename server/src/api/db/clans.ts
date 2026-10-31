import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql } from "drizzle-orm";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import { UnlockDefs } from "../../../../shared/defs/gameObjects/unlockDefs";
import {
    CLAN_CREATE_COST,
    CLAN_LIST_PAGE,
    CLAN_MAX_MEMBERS,
    CLAN_MAX_PENDING,
    CLAN_BANNERS,
    CLAN_TAG_COLORS,
    clanLevel,
    clanTextBlocked,
    type ClanActionResponse,
    type ClanDetails,
    type ClanEditRequest,
    type ClanLinkInfoResponse,
    type ClanListEntry,
    type ClanListSort,
    type ClanMember,
    type ClanViewResponse,
    type ClanLinkResponse,
    type ClanPendingPlayer,
    type ClanSummary,
    type MyClanResponse,
    normalizeClanName,
    normalizeClanTag,
    validateClan,
} from "../../../../shared/utils/clan";
import { checkForBadWords } from "../../utils/serverHelpers";
import { adoptWeekStats, getClanPool, getClanStats, getClanWeekTotals, weekKey } from "./clanStats";
import { getGoldenFries } from "./goldenFries";
import { db } from "./index";
import { playerIcon, playerIconColumns } from "./playerIcon";
import {
    blocksTable,
    clanWeekRewardsTable,
    clanInvitesTable,
    clanKeyPoolTable,
    clanMembersTable,
    clanWeekGoalsTable,
    clanWeekStatsTable,
    clansTable,
    goldenFriesLedgerTable,
    itemsTable,
    usersTable,
} from "./schema";

class ClanError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const DEFAULT_UNLOCKS = new Set(UnlockDefs.unlock_default?.unlocks ?? []);

/** An emote the user owns (default emotes count), or "" for no icon. */
async function iconAllowed(tx: Tx, userId: string, icon: string): Promise<boolean> {
    if (!icon) return true;
    if (GameObjectDefs.typeToDefSafe(icon)?.type !== "emote") return false;
    if (DEFAULT_UNLOCKS.has(icon)) return true;
    const [owned] = await tx
        .select({ id: itemsTable.id })
        .from(itemsTable)
        .where(and(eq(itemsTable.userId, userId), eq(itemsTable.type, icon)))
        .limit(1);
    return !!owned;
}

/** Validates name / tag / icon and checks they're free (other than `clanId`'s own). */
async function checkFields(tx: Tx, userId: string, req: ClanEditRequest, clanId?: number) {
    const name = normalizeClanName(req.name);
    const tag = normalizeClanTag(req.tag);
    const invalid = validateClan(name, tag);
    if (invalid) throw new ClanError(invalid);
    const tagColor = req.tagColor ?? 0;
    const color = CLAN_TAG_COLORS[tagColor];
    if (!color) throw new ClanError("bad_color");
    const banner = req.banner ?? 0;
    const bannerDef = CLAN_BANNERS[banner];
    if (!bannerDef) throw new ClanError("bad_banner");
    const needLevel = Math.max(color.level, bannerDef.level);
    if (needLevel > 1) {
        const [c] = clanId ? await tx.select({ xp: clansTable.xp }).from(clansTable).where(eq(clansTable.id, clanId)) : [];
        const level = clanLevel(c?.xp ?? 0).level;
        if (level < color.level) throw new ClanError("color_locked");
        if (level < bannerDef.level) throw new ClanError("banner_locked");
    }
    if (checkForBadWords(name) || checkForBadWords(tag) || clanTextBlocked(name) || clanTextBlocked(tag)) {
        throw new ClanError("bad_words");
    }
    if (!(await iconAllowed(tx, userId, req.icon))) throw new ClanError("bad_icon");
    const clash = await tx
        .select({ id: clansTable.id, name: clansTable.name, tag: clansTable.tag })
        .from(clansTable)
        .where(or(sql`lower(${clansTable.name}) = lower(${name})`, sql`upper(${clansTable.tag}) = ${tag}`));
    for (const c of clash) {
        if (c.id === clanId) continue;
        throw new ClanError(c.name.toLowerCase() === name.toLowerCase() ? "name_taken" : "tag_taken");
    }
    return { name, tag, icon: req.icon, tagColor, banner };
}

/** Unique-index races (two players taking the same name at once) end up here. */
function uniqueError(err: unknown): string | null {
    const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
    const code = e?.code ?? e?.cause?.code;
    const constraint = e?.constraint ?? e?.cause?.constraint ?? "";
    if (code !== "23505") return null;
    if (constraint.includes("name")) return "name_taken";
    if (constraint.includes("tag")) return "tag_taken";
    return "already_in_clan";
}

function fail(err: unknown): string {
    if (err instanceof ClanError) return err.code;
    return uniqueError(err) ?? "error";
}

export async function createClan(userId: string, req: ClanEditRequest): Promise<ClanActionResponse> {
    try {
        const balance = await db.transaction(async (tx) => {
            const [member] = await tx
                .select({ clanId: clanMembersTable.clanId })
                .from(clanMembersTable)
                .where(eq(clanMembersTable.userId, userId));
            if (member) throw new ClanError("already_in_clan");
            const fields = await checkFields(tx, userId, req);

            const [bal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} - ${CLAN_CREATE_COST}` })
                .where(and(eq(usersTable.id, userId), gte(usersTable.goldenFries, CLAN_CREATE_COST)))
                .returning({ balance: usersTable.goldenFries });
            if (!bal) throw new ClanError("insufficient_funds");
            await tx.insert(goldenFriesLedgerTable).values({
                userId,
                amount: -CLAN_CREATE_COST,
                reason: `clan:create:${fields.tag}`,
                balanceAfter: bal.balance,
            });

            const [clan] = await tx
                .insert(clansTable)
                .values({ ...fields, ownerId: userId })
                .returning({ id: clansTable.id });
            await tx.insert(clanMembersTable).values({ userId, clanId: clan.id, role: "owner" });
            await adoptWeekStats(tx, userId, clan.id);
            return bal.balance;
        });
        return { success: true, balance };
    } catch (err) {
        return { success: false, error: fail(err), balance: await getGoldenFries(userId) };
    }
}

/** Owner only: new name / tag / icon. */
export async function updateClan(userId: string, req: ClanEditRequest): Promise<ClanActionResponse> {
    try {
        await db.transaction(async (tx) => {
            const [clan] = await tx.select({ id: clansTable.id }).from(clansTable).where(eq(clansTable.ownerId, userId));
            if (!clan) throw new ClanError("not_owner");
            const fields = await checkFields(tx, userId, req, clan.id);
            await tx.update(clansTable).set(fields).where(eq(clansTable.id, clan.id));
        });
        return { success: true };
    } catch (err) {
        return { success: false, error: fail(err) };
    }
}

/** Owner only: deletes the clan (members are removed with it). No refund. */
export async function disbandClan(userId: string): Promise<ClanActionResponse> {
    const gone = await db.delete(clansTable).where(eq(clansTable.ownerId, userId)).returning({ id: clansTable.id });
    return gone.length ? { success: true } : { success: false, error: "not_owner" };
}

const summaryColumns = {
    id: clansTable.id,
    name: clansTable.name,
    tag: clansTable.tag,
    icon: clansTable.icon,
    createdAt: clansTable.createdAt,
    ownerSlug: usersTable.slug,
    ownerName: usersTable.username,
    members: sql<number>`(SELECT count(*) FROM ${clanMembersTable} WHERE ${clanMembersTable.clanId} = ${clansTable.id})`,
    xp: clansTable.xp,
    tagColor: clansTable.tagColor,
    banner: clansTable.banner,
    // weeks the clan finished #1 in the league
    titles: sql<number>`(SELECT count(*) FROM ${clanWeekRewardsTable} WHERE ${clanWeekRewardsTable.clanId} = ${clansTable.id} AND ${clanWeekRewardsTable.rank} = 1)`,
};

function toSummary(r: {
    id: number;
    name: string;
    tag: string;
    icon: string;
    createdAt: Date;
    ownerSlug: string;
    ownerName: string;
    members: number;
    titles: number;
    xp: number;
    tagColor: number;
    banner: number;
}): ClanSummary {
    return { ...r, members: Number(r.members), titles: Number(r.titles), createdAt: r.createdAt.getTime() };
}

/** Players waiting on `clanId` of one kind (invited by the owner / asking via the link). */
async function pendingPlayers(clanId: number, kind: "invite" | "request"): Promise<ClanPendingPlayer[]> {
    const rows = await db
        .select({ slug: usersTable.slug, username: usersTable.username, at: clanInvitesTable.createdAt, ...playerIconColumns })
        .from(clanInvitesTable)
        .innerJoin(usersTable, eq(usersTable.id, clanInvitesTable.userId))
        .where(and(eq(clanInvitesTable.clanId, clanId), eq(clanInvitesTable.kind, kind)))
        .orderBy(asc(clanInvitesTable.createdAt));
    return rows.map((r) => ({ slug: r.slug, username: r.username, icon: playerIcon(r), at: r.at.getTime() }));
}

/** Clans with a pending row of `kind` for the player. */
async function pendingClans(userId: string, kind: "invite" | "request"): Promise<ClanSummary[]> {
    const rows = await db
        .select(summaryColumns)
        .from(clanInvitesTable)
        .innerJoin(clansTable, eq(clansTable.id, clanInvitesTable.clanId))
        .innerJoin(usersTable, eq(usersTable.id, clansTable.ownerId))
        .where(and(eq(clanInvitesTable.userId, userId), eq(clanInvitesTable.kind, kind)))
        .orderBy(desc(clanInvitesTable.createdAt));
    return rows.map(toSummary);
}

/** A clan's members: owner first, then lieutenants, then by join date. */
async function membersOf(clanId: number): Promise<ClanMember[]> {
    const rows = await db
        .select({
            slug: usersTable.slug,
            username: usersTable.username,
            role: clanMembersTable.role,
            joinedAt: clanMembersTable.joinedAt,
            ...playerIconColumns,
        })
        .from(clanMembersTable)
        .innerJoin(usersTable, eq(usersTable.id, clanMembersTable.userId))
        .where(eq(clanMembersTable.clanId, clanId))
        .orderBy(
            desc(sql`${clanMembersTable.role} = 'owner'`),
            desc(sql`${clanMembersTable.role} = 'lieutenant'`),
            asc(clanMembersTable.joinedAt),
        );
    return rows.map((r) => ({
        slug: r.slug,
        username: r.username,
        icon: playerIcon(r),
        role: r.role === "owner" ? "owner" : r.role === "lieutenant" ? "lieutenant" : "member",
        joinedAt: r.joinedAt.getTime(),
    }));
}

/** Any clan as other players see it (league / clan list popup): members + this week. */
export async function getClanView(clanId: number): Promise<ClanViewResponse> {
    const [clan] = await db
        .select(summaryColumns)
        .from(clansTable)
        .innerJoin(usersTable, eq(usersTable.id, clansTable.ownerId))
        .where(eq(clansTable.id, clanId));
    if (!clan) return { clan: null, stats: null };
    return {
        clan: { ...toSummary(clan), memberList: await membersOf(clanId) },
        stats: await getClanStats(clanId),
    };
}

/** The player's clan with its members (and, for the owner, the pending joins), plus the
 *  invites / requests of a player who isn't in a clan. */
export async function getMyClan(userId: string): Promise<MyClanResponse> {
    const [m] = await db
        .select({ clanId: clanMembersTable.clanId, role: clanMembersTable.role })
        .from(clanMembersTable)
        .where(eq(clanMembersTable.userId, userId));
    if (!m) {
        return {
            clan: null,
            invites: await pendingClans(userId, "invite"),
            requests: await pendingClans(userId, "request"),
        };
    }
    const [clan] = await db
        .select({ ...summaryColumns, ownerId: clansTable.ownerId, inviteCode: clansTable.inviteCode })
        .from(clansTable)
        .innerJoin(usersTable, eq(usersTable.id, clansTable.ownerId))
        .where(eq(clansTable.id, m.clanId));
    if (!clan) return { clan: null, invites: [], requests: [] };
    const { ownerId, inviteCode, ...summary } = clan;
    const details: ClanDetails = {
        ...toSummary(summary),
        memberList: await membersOf(m.clanId),
        myRole: ownerId === userId ? "owner" : m.role === "lieutenant" ? "lieutenant" : "member",
        weekStats: await getClanWeekTotals(m.clanId),
        pool: await getClanPool(m.clanId),
    };
    if (details.myRole !== "member") {
        details.manage = {
            inviteCode,
            requests: await pendingPlayers(m.clanId, "request"),
            invites: await pendingPlayers(m.clanId, "invite"),
        };
    }
    return { clan: details, invites: [], requests: [] };
}

/**
 * The clan list (Discover tab), one page at a time. `search` matches the clan's name or
 * tag, or the username / slug of one of its members - those hits say which members.
 */
export async function listClans(
    search?: string,
    sort: ClanListSort = "members",
    offset = 0,
): Promise<{ clans: ClanListEntry[]; hasMore: boolean }> {
    const q = search?.trim().replace(/[%_\\]/g, "");
    const like = `%${q}%`;
    const memberHit = (clanId: typeof clansTable.id) =>
        sql`EXISTS (SELECT 1 FROM ${clanMembersTable} m JOIN ${usersTable} u ON u.id = m.user_id
            WHERE m.clan_id = ${clanId} AND (u.username ILIKE ${like} OR u.slug ILIKE ${like}))`;
    const weekGames = sql<number>`(SELECT coalesce(sum(${clanWeekStatsTable.games}), 0) FROM ${clanWeekStatsTable}
        WHERE ${clanWeekStatsTable.clanId} = ${clansTable.id} AND ${clanWeekStatsTable.week} = ${weekKey()})`;
    const order = {
        members: [desc(summaryColumns.members), asc(clansTable.createdAt)],
        active: [desc(weekGames), desc(summaryColumns.members)],
        level: [desc(clansTable.xp), asc(clansTable.createdAt)],
        titles: [desc(summaryColumns.titles), desc(clansTable.xp)],
        newest: [desc(clansTable.createdAt)],
    }[sort];
    const rows = await db
        .select({ ...summaryColumns, weekGames })
        .from(clansTable)
        .innerJoin(usersTable, eq(usersTable.id, clansTable.ownerId))
        .where(q ? or(ilike(clansTable.name, like), ilike(clansTable.tag, like), memberHit(clansTable.id)) : undefined)
        .orderBy(...order, asc(clansTable.id))
        .limit(CLAN_LIST_PAGE + 1)
        .offset(offset);
    const page = rows.slice(0, CLAN_LIST_PAGE);
    // which members made a clan match (when its name / tag didn't)
    const viaMembers = q
        ? page.filter((r) => !r.name.toLowerCase().includes(q.toLowerCase()) && !r.tag.toLowerCase().includes(q.toLowerCase()))
        : [];
    const matched = new Map<number, string[]>();
    if (viaMembers.length) {
        const hits = await db
            .select({ clanId: clanMembersTable.clanId, username: usersTable.username, slug: usersTable.slug })
            .from(clanMembersTable)
            .innerJoin(usersTable, eq(usersTable.id, clanMembersTable.userId))
            .where(
                and(
                    inArray(clanMembersTable.clanId, viaMembers.map((r) => r.id)),
                    or(ilike(usersTable.username, like), ilike(usersTable.slug, like)),
                ),
            );
        for (const h of hits) matched.set(h.clanId, [...(matched.get(h.clanId) ?? []), h.username || h.slug]);
    }
    return {
        clans: page.map(({ weekGames: games, ...r }) => ({
            ...toSummary(r),
            weekGames: Number(games),
            ...(matched.has(r.id) ? { matched: matched.get(r.id)!.slice(0, 3) } : {}),
        })),
        hasMore: rows.length > CLAN_LIST_PAGE,
    };
}


// ── Joining: invites (owner → player) and link requests (player → owner) ──────

async function ownedClan(tx: Tx, ownerId: string) {
    const [clan] = await tx
        .select({ id: clansTable.id, inviteCode: clansTable.inviteCode })
        .from(clansTable)
        .where(eq(clansTable.ownerId, ownerId));
    if (!clan) throw new ClanError("not_owner");
    return clan;
}

/** The clan the user runs: as owner, or as a lieutenant (invite, accept, kick). */
async function managedClan(tx: Tx, userId: string) {
    const [r] = await tx
        .select({
            id: clansTable.id,
            inviteCode: clansTable.inviteCode,
            role: clanMembersTable.role,
        })
        .from(clanMembersTable)
        .innerJoin(clansTable, eq(clansTable.id, clanMembersTable.clanId))
        .where(eq(clanMembersTable.userId, userId));
    if (!r || (r.role !== "owner" && r.role !== "lieutenant")) throw new ClanError("not_owner");
    return r;
}

/** Whether the clan's owner has blocked the player - then they can't get in at all. */
async function blockedByOwner(tx: Tx | typeof db, clanId: number, userId: string): Promise<boolean> {
    const [r] = await tx
        .select({ id: blocksTable.userId })
        .from(blocksTable)
        .innerJoin(clansTable, eq(clansTable.ownerId, blocksTable.userId))
        .where(and(eq(clansTable.id, clanId), eq(blocksTable.blockedId, userId)))
        .limit(1);
    return !!r;
}

async function userBySlug(tx: Tx, slug: string) {
    const [u] = await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.slug, slug.trim().toLowerCase()));
    if (!u) throw new ClanError("not_found");
    return u;
}

async function memberCount(tx: Tx, clanId: number): Promise<number> {
    const [r] = await tx.select({ n: count() }).from(clanMembersTable).where(eq(clanMembersTable.clanId, clanId));
    return Number(r?.n ?? 0);
}

/** Puts the player into the clan and drops every other pending invite / request of theirs. */
async function addMember(tx: Tx, userId: string, clanId: number) {
    if (await blockedByOwner(tx, clanId, userId)) throw new ClanError("blocked");
    if ((await memberCount(tx, clanId)) >= CLAN_MAX_MEMBERS) throw new ClanError("clan_full");
    const [added] = await tx
        .insert(clanMembersTable)
        .values({ userId, clanId, role: "member" })
        .onConflictDoNothing()
        .returning({ userId: clanMembersTable.userId });
    if (!added) throw new ClanError("already_in_clan");
    await tx.delete(clanInvitesTable).where(eq(clanInvitesTable.userId, userId));
    await adoptWeekStats(tx, userId, clanId);
}

async function pendingCount(tx: Tx, clanId: number): Promise<number> {
    const [r] = await tx.select({ n: count() }).from(clanInvitesTable).where(eq(clanInvitesTable.clanId, clanId));
    return Number(r?.n ?? 0);
}

async function run(fn: (tx: Tx) => Promise<ClanActionResponse | void>): Promise<ClanActionResponse> {
    try {
        return (await db.transaction(fn)) ?? { success: true };
    } catch (err) {
        return { success: false, error: fail(err) };
    }
}

/** Owner or lieutenant invites a player. If that player already asked via the link,
 *  they join now. */
export function inviteToClan(actorId: string, slug: string) {
    return run(async (tx) => {
        const clan = await managedClan(tx, actorId);
        const target = await userBySlug(tx, slug);
        if (target.id === actorId) throw new ClanError("self");
        if (await blockedByOwner(tx, clan.id, target.id)) throw new ClanError("blocked");
        const [member] = await tx
            .select({ clanId: clanMembersTable.clanId })
            .from(clanMembersTable)
            .where(eq(clanMembersTable.userId, target.id));
        if (member) throw new ClanError(member.clanId === clan.id ? "already_member" : "already_in_clan");
        const [existing] = await tx
            .select({ kind: clanInvitesTable.kind })
            .from(clanInvitesTable)
            .where(and(eq(clanInvitesTable.clanId, clan.id), eq(clanInvitesTable.userId, target.id)));
        if (existing?.kind === "request") {
            await addMember(tx, target.id, clan.id);
            return { success: true, joined: true };
        }
        if (existing) throw new ClanError("already_invited");
        if ((await pendingCount(tx, clan.id)) >= CLAN_MAX_PENDING) throw new ClanError("too_many_pending");
        await tx.insert(clanInvitesTable).values({ clanId: clan.id, userId: target.id, kind: "invite" });
    });
}

/** Owner or lieutenant takes back an invite. */
export function cancelInvite(actorId: string, slug: string) {
    return run(async (tx) => {
        const clan = await managedClan(tx, actorId);
        const target = await userBySlug(tx, slug);
        await tx
            .delete(clanInvitesTable)
            .where(and(eq(clanInvitesTable.clanId, clan.id), eq(clanInvitesTable.userId, target.id), eq(clanInvitesTable.kind, "invite")));
    });
}

/** The invited player accepts (joins) or declines. */
export function respondInvite(userId: string, clanId: number, accept: boolean) {
    return run(async (tx) => {
        const [inv] = await tx
            .delete(clanInvitesTable)
            .where(and(eq(clanInvitesTable.clanId, clanId), eq(clanInvitesTable.userId, userId), eq(clanInvitesTable.kind, "invite")))
            .returning({ id: clanInvitesTable.id });
        if (!inv) throw new ClanError("not_found");
        if (accept) await addMember(tx, userId, clanId);
    });
}

/** Owner or lieutenant accepts or declines a join request from the link. */
export function respondRequest(actorId: string, slug: string, accept: boolean) {
    return run(async (tx) => {
        const clan = await managedClan(tx, actorId);
        const target = await userBySlug(tx, slug);
        const [req] = await tx
            .delete(clanInvitesTable)
            .where(and(eq(clanInvitesTable.clanId, clan.id), eq(clanInvitesTable.userId, target.id), eq(clanInvitesTable.kind, "request")))
            .returning({ id: clanInvitesTable.id });
        if (!req) throw new ClanError("not_found");
        if (accept) await addMember(tx, target.id, clan.id);
    });
}

/** The player withdraws their own join request. */
export function withdrawRequest(userId: string, clanId: number) {
    return run(async (tx) => {
        await tx
            .delete(clanInvitesTable)
            .where(and(eq(clanInvitesTable.clanId, clanId), eq(clanInvitesTable.userId, userId), eq(clanInvitesTable.kind, "request")));
    });
}

function newInviteCode(): string {
    const chars = "abcdefghjkmnpqrstuvwxyz23456789";
    let s = "";
    for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

/** The clan's invite-link code (made on first use, lieutenants too); only the owner may
 *  `regenerate` it, which kills the old link. */
export async function getInviteCode(actorId: string, regenerate = false): Promise<ClanLinkResponse> {
    try {
        const code = await db.transaction(async (tx) => {
            const clan = await managedClan(tx, actorId);
            if (regenerate && clan.role !== "owner") throw new ClanError("no_permission");
            if (clan.inviteCode && !regenerate) return clan.inviteCode;
            const code = newInviteCode();
            await tx.update(clansTable).set({ inviteCode: code }).where(eq(clansTable.id, clan.id));
            return code;
        });
        return { success: true, code };
    } catch (err) {
        return { success: false, error: fail(err) };
    }
}

async function clanByCode(code: string) {
    const [clan] = await db
        .select(summaryColumns)
        .from(clansTable)
        .innerJoin(usersTable, eq(usersTable.id, clansTable.ownerId))
        .where(eq(clansTable.inviteCode, code.trim().toLowerCase()));
    return clan ? toSummary(clan) : null;
}

/** What an invite link points at, and what the visitor can do with it. */
export async function getLinkInfo(userId: string, code: string): Promise<ClanLinkInfoResponse> {
    const clan = await clanByCode(code);
    if (!clan) return { clan: null, state: "request" };
    const [member] = await db
        .select({ clanId: clanMembersTable.clanId })
        .from(clanMembersTable)
        .where(eq(clanMembersTable.userId, userId));
    if (member) return { clan, state: member.clanId === clan.id ? "member" : "in_clan" };
    const [pending] = await db
        .select({ kind: clanInvitesTable.kind })
        .from(clanInvitesTable)
        .where(and(eq(clanInvitesTable.clanId, clan.id), eq(clanInvitesTable.userId, userId)));
    if (await blockedByOwner(db, clan.id, userId)) return { clan, state: "blocked" };
    if (pending) return { clan, state: pending.kind === "invite" ? "invited" : "requested" };
    if (clan.members >= CLAN_MAX_MEMBERS) return { clan, state: "full" };
    return { clan, state: "request" };
}

/** Visitor of an invite link asks to join; the owner has to accept. If the owner had
 *  already invited them, they join right away. */
export function requestJoin(userId: string, code: string) {
    return run(async (tx) => {
        const [clan] = await tx
            .select({ id: clansTable.id, ownerId: clansTable.ownerId })
            .from(clansTable)
            .where(eq(clansTable.inviteCode, code.trim().toLowerCase()));
        if (!clan) throw new ClanError("not_found");
        const [member] = await tx
            .select({ clanId: clanMembersTable.clanId })
            .from(clanMembersTable)
            .where(eq(clanMembersTable.userId, userId));
        if (member) throw new ClanError(member.clanId === clan.id ? "already_member" : "already_in_clan");
        if (await blockedByOwner(tx, clan.id, userId)) throw new ClanError("blocked");
        const [existing] = await tx
            .select({ kind: clanInvitesTable.kind })
            .from(clanInvitesTable)
            .where(and(eq(clanInvitesTable.clanId, clan.id), eq(clanInvitesTable.userId, userId)));
        if (existing?.kind === "invite") {
            await tx.delete(clanInvitesTable).where(and(eq(clanInvitesTable.clanId, clan.id), eq(clanInvitesTable.userId, userId)));
            await addMember(tx, userId, clan.id);
            return { success: true, joined: true };
        }
        if (existing) return { success: true };
        if ((await memberCount(tx, clan.id)) >= CLAN_MAX_MEMBERS) throw new ClanError("clan_full");
        if ((await pendingCount(tx, clan.id)) >= CLAN_MAX_PENDING) throw new ClanError("too_many_pending");
        await tx.insert(clanInvitesTable).values({ clanId: clan.id, userId, kind: "request" });
    });
}

/** A member leaves (the owner disbands instead). */
export function leaveClan(userId: string) {
    return run(async (tx) => {
        const [m] = await tx
            .select({ role: clanMembersTable.role })
            .from(clanMembersTable)
            .where(eq(clanMembersTable.userId, userId));
        if (!m) throw new ClanError("not_member");
        if (m.role === "owner") throw new ClanError("owner_cannot_leave");
        await tx.delete(clanMembersTable).where(eq(clanMembersTable.userId, userId));
    });
}

/** Removes a member: the owner can kick anyone, a lieutenant only regular members. */
export function kickMember(actorId: string, slug: string) {
    return run(async (tx) => {
        const clan = await managedClan(tx, actorId);
        const target = await userBySlug(tx, slug);
        if (target.id === actorId) throw new ClanError("self");
        const [m] = await tx
            .select({ role: clanMembersTable.role })
            .from(clanMembersTable)
            .where(and(eq(clanMembersTable.userId, target.id), eq(clanMembersTable.clanId, clan.id)));
        if (!m) throw new ClanError("not_member");
        if (m.role === "owner" || (m.role === "lieutenant" && clan.role !== "owner")) {
            throw new ClanError("no_permission");
        }
        await tx.delete(clanMembersTable).where(eq(clanMembersTable.userId, target.id));
    });
}

/** Owner only: makes a member a lieutenant, or back to a regular member. */
export function setMemberRole(ownerId: string, slug: string, role: "lieutenant" | "member") {
    return run(async (tx) => {
        const clan = await ownedClan(tx, ownerId);
        const target = await userBySlug(tx, slug);
        if (target.id === ownerId) throw new ClanError("self");
        const changed = await tx
            .update(clanMembersTable)
            .set({ role })
            .where(and(eq(clanMembersTable.userId, target.id), eq(clanMembersTable.clanId, clan.id)))
            .returning({ userId: clanMembersTable.userId });
        if (!changed.length) throw new ClanError("not_member");
    });
}

// ── Moderation dashboard (admins): any clan, no owner / level / ownership checks ──

/** Every clan for the dashboard: newest first, filtered by name, tag or owner slug. */
export async function adminListClans(search?: string) {
    const q = search?.trim().replace(/[%_\\]/g, "");
    const rows = await db
        .select({ ...summaryColumns, inviteCode: clansTable.inviteCode })
        .from(clansTable)
        .innerJoin(usersTable, eq(usersTable.id, clansTable.ownerId))
        .where(
            q
                ? or(ilike(clansTable.name, `%${q}%`), ilike(clansTable.tag, `%${q}%`), ilike(usersTable.slug, `%${q}%`))
                : undefined,
        )
        .orderBy(desc(clansTable.createdAt))
        .limit(500);
    return rows.map(({ inviteCode, ...r }) => ({ ...toSummary(r), level: clanLevel(r.xp).level, hasLink: !!inviteCode }));
}

/** One clan with everything staff may need: members, pending joins, key pool, this
 *  week's stats and the league history. */
export async function adminGetClan(clanId: number) {
    const [clan] = await db
        .select({ ...summaryColumns, inviteCode: clansTable.inviteCode })
        .from(clansTable)
        .innerJoin(usersTable, eq(usersTable.id, clansTable.ownerId))
        .where(eq(clansTable.id, clanId));
    if (!clan) return null;
    const { inviteCode, ...summary } = clan;
    const rewards = await db
        .select({ week: clanWeekRewardsTable.week, rank: clanWeekRewardsTable.rank, rating: clanWeekRewardsTable.rating, keys: clanWeekRewardsTable.keys })
        .from(clanWeekRewardsTable)
        .where(eq(clanWeekRewardsTable.clanId, clanId))
        .orderBy(desc(clanWeekRewardsTable.week));
    const goals = await db
        .select({ week: clanWeekGoalsTable.week, tier: clanWeekGoalsTable.tier, players: clanWeekGoalsTable.players })
        .from(clanWeekGoalsTable)
        .where(eq(clanWeekGoalsTable.clanId, clanId))
        .orderBy(desc(clanWeekGoalsTable.week));
    return {
        clan: { ...toSummary(summary), level: clanLevel(summary.xp).level, inviteCode },
        members: await membersOf(clanId),
        invites: await pendingPlayers(clanId, "invite"),
        requests: await pendingPlayers(clanId, "request"),
        pool: await getClanPool(clanId),
        stats: await getClanStats(clanId),
        rewards,
        goals,
    };
}

async function adminClan(tx: Tx, clanId: number) {
    const [c] = await tx
        .select({ id: clansTable.id, name: clansTable.name, tag: clansTable.tag, ownerId: clansTable.ownerId })
        .from(clansTable)
        .where(eq(clansTable.id, clanId));
    if (!c) throw new ClanError("not_found");
    return c;
}

async function adminMember(tx: Tx, clanId: number, slug: string) {
    const target = await userBySlug(tx, slug);
    const [m] = await tx
        .select({ role: clanMembersTable.role })
        .from(clanMembersTable)
        .where(and(eq(clanMembersTable.userId, target.id), eq(clanMembersTable.clanId, clanId)));
    if (!m) throw new ClanError("not_member");
    return { id: target.id, role: m.role };
}

/** Renames a clan / clears an offensive icon. Format, reserved tags and uniqueness still
 *  apply; bad words, level locks and icon ownership don't (staff decide). */
export function adminEditClan(clanId: number, req: { name: string; tag: string; clearIcon?: boolean; tagColor?: number; banner?: number }) {
    return run(async (tx) => {
        await adminClan(tx, clanId);
        const name = normalizeClanName(req.name);
        const tag = normalizeClanTag(req.tag);
        const invalid = validateClan(name, tag);
        if (invalid) throw new ClanError(invalid);
        if (req.tagColor !== undefined && !CLAN_TAG_COLORS[req.tagColor]) throw new ClanError("bad_color");
        if (req.banner !== undefined && !CLAN_BANNERS[req.banner]) throw new ClanError("bad_banner");
        const clash = await tx
            .select({ id: clansTable.id, name: clansTable.name })
            .from(clansTable)
            .where(or(sql`lower(${clansTable.name}) = lower(${name})`, sql`upper(${clansTable.tag}) = ${tag}`));
        for (const c of clash) {
            if (c.id === clanId) continue;
            throw new ClanError(c.name.toLowerCase() === name.toLowerCase() ? "name_taken" : "tag_taken");
        }
        await tx
            .update(clansTable)
            .set({
                name,
                tag,
                ...(req.clearIcon ? { icon: "" } : {}),
                ...(req.tagColor !== undefined ? { tagColor: req.tagColor } : {}),
                ...(req.banner !== undefined ? { banner: req.banner } : {}),
            })
            .where(eq(clansTable.id, clanId));
    });
}

/** Removes any member. The owner can't be kicked - transfer ownership first. */
export function adminKickMember(clanId: number, slug: string) {
    return run(async (tx) => {
        await adminClan(tx, clanId);
        const m = await adminMember(tx, clanId, slug);
        if (m.role === "owner") throw new ClanError("owner_cannot_leave");
        await tx.delete(clanMembersTable).where(eq(clanMembersTable.userId, m.id));
    });
}

/** Makes a member lieutenant / member, or the new owner (the old owner becomes lieutenant). */
export function adminSetRole(clanId: number, slug: string, role: "owner" | "lieutenant" | "member") {
    return run(async (tx) => {
        const clan = await adminClan(tx, clanId);
        const m = await adminMember(tx, clanId, slug);
        if (m.role === "owner") throw new ClanError(role === "owner" ? "already_owner" : "owner_cannot_leave");
        if (role !== "owner") {
            await tx.update(clanMembersTable).set({ role }).where(eq(clanMembersTable.userId, m.id));
            return;
        }
        await tx.update(clanMembersTable).set({ role: "lieutenant" }).where(eq(clanMembersTable.userId, clan.ownerId));
        await tx.update(clanMembersTable).set({ role: "owner" }).where(eq(clanMembersTable.userId, m.id));
        await tx.update(clansTable).set({ ownerId: m.id }).where(eq(clansTable.id, clanId));
    });
}

/** Kills the invite link (a new one only exists when the owner makes it again). */
export function adminResetLink(clanId: number) {
    return run(async (tx) => {
        await adminClan(tx, clanId);
        await tx.update(clansTable).set({ inviteCode: null }).where(eq(clansTable.id, clanId));
        await tx.delete(clanInvitesTable).where(and(eq(clanInvitesTable.clanId, clanId), eq(clanInvitesTable.kind, "request")));
    });
}

/** Sets how many keys of one type wait in the clan's pool (0 = none). */
export function adminSetPool(clanId: number, keyType: string, amount: number) {
    return run(async (tx) => {
        await adminClan(tx, clanId);
        await tx
            .insert(clanKeyPoolTable)
            .values({ clanId, keyType, amount })
            .onConflictDoUpdate({ target: [clanKeyPoolTable.clanId, clanKeyPoolTable.keyType], set: { amount } });
    });
}

/** Wipes this week's league stats of the clan, or of one member (cheated / boosted games). */
export function adminResetWeekStats(clanId: number, slug?: string) {
    return run(async (tx) => {
        await adminClan(tx, clanId);
        const user = slug ? await userBySlug(tx, slug) : null;
        await tx
            .delete(clanWeekStatsTable)
            .where(
                and(
                    eq(clanWeekStatsTable.clanId, clanId),
                    eq(clanWeekStatsTable.week, weekKey()),
                    user ? eq(clanWeekStatsTable.userId, user.id) : undefined,
                ),
            );
    });
}

/** Sets the clan's XP (and with it the level). Colours / banners above the new level stay
 *  as they are until the owner edits the clan. */
export function adminSetXp(clanId: number, xp: number) {
    return run(async (tx) => {
        await adminClan(tx, clanId);
        await tx.update(clansTable).set({ xp }).where(eq(clansTable.id, clanId));
    });
}

/** Deletes the clan (members, pool and stats go with it). No refund. */
export function adminDisbandClan(clanId: number) {
    return run(async (tx) => {
        await adminClan(tx, clanId);
        await tx.delete(clansTable).where(eq(clansTable.id, clanId));
    });
}

/** Name / tag / role of an account's clan, for the account view. */
export async function adminClanOf(userId: string) {
    const [r] = await db
        .select({ id: clansTable.id, name: clansTable.name, tag: clansTable.tag, role: clanMembersTable.role })
        .from(clanMembersTable)
        .innerJoin(clansTable, eq(clansTable.id, clanMembersTable.clanId))
        .where(eq(clanMembersTable.userId, userId));
    return r ?? null;
}
