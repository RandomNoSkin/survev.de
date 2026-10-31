import { and, asc, count, desc, eq, gte, ilike, or, sql } from "drizzle-orm";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import { UnlockDefs } from "../../../../shared/defs/gameObjects/unlockDefs";
import {
    CLAN_CREATE_COST,
    CLAN_MAX_MEMBERS,
    CLAN_MAX_PENDING,
    CLAN_BANNERS,
    CLAN_TAG_COLORS,
    clanLevel,
    type ClanActionResponse,
    type ClanDetails,
    type ClanEditRequest,
    type ClanLinkInfoResponse,
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
import { adoptWeekStats, getClanPool, getClanStats, getClanWeekTotals } from "./clanStats";
import { getGoldenFries } from "./goldenFries";
import { db } from "./index";
import { playerIcon, playerIconColumns } from "./playerIcon";
import {
    blocksTable,
    clanWeekRewardsTable,
    clanInvitesTable,
    clanMembersTable,
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
    if (checkForBadWords(name) || checkForBadWords(tag)) throw new ClanError("bad_words");
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

/** Clans by size (biggest first), optionally filtered by name or tag. */
export async function listClans(search?: string): Promise<ClanSummary[]> {
    const q = search?.trim();
    const rows = await db
        .select(summaryColumns)
        .from(clansTable)
        .innerJoin(usersTable, eq(usersTable.id, clansTable.ownerId))
        .where(q ? or(ilike(clansTable.name, `%${q.replace(/[%_\\]/g, "")}%`), ilike(clansTable.tag, `%${q.replace(/[%_\\]/g, "")}%`)) : undefined)
        .orderBy(desc(summaryColumns.members), asc(clansTable.createdAt))
        .limit(50);
    return rows.map(toSummary);
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
