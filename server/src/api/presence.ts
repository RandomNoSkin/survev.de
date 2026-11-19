import type { TeamInvite } from "../../../shared/types/user";

/**
 * Who has the site open right now, and the team / lobby invites waiting for them. Kept in
 * the API server's memory only: both are short-lived (a restart just means everyone is
 * "offline" until their next heartbeat, ~20 s) and never need to survive one.
 */

/** A heartbeat older than this means the player left (the client sends one every 20 s
 *  while the page is visible). */
const ONLINE_MS = 60_000;
/** An invite nobody picked up is dropped after this. */
const INVITE_TTL_MS = 2 * 60_000;
/** One sender can't flood a player: at most this many pending invites per recipient. */
const MAX_PENDING_INVITES = 5;

const lastSeen = new Map<string, number>();
const invites = new Map<string, TeamInvite[]>();
let nextInviteId = 1;

export function touchPresence(userId: string) {
    lastSeen.set(userId, Date.now());
}

/** The player closed the site (sent from the page as it unloads). */
export function setOffline(userId: string) {
    lastSeen.delete(userId);
}

export function isOnline(userId: string): boolean {
    const t = lastSeen.get(userId);
    return t !== undefined && Date.now() - t < ONLINE_MS;
}

/** Queues an invite for `toUserId`; a newer one from the same sender replaces the old. */
export function addInvite(toUserId: string, invite: Omit<TeamInvite, "id" | "at">) {
    const now = Date.now();
    const list = (invites.get(toUserId) ?? []).filter((i) => now - i.at < INVITE_TTL_MS && i.fromSlug !== invite.fromSlug);
    list.push({ ...invite, id: nextInviteId++, at: now });
    invites.set(toUserId, list.slice(-MAX_PENDING_INVITES));
}

/** The player's pending invites - handed out once, then gone. */
export function takeInvites(userId: string): TeamInvite[] {
    const list = invites.get(userId);
    if (!list) return [];
    invites.delete(userId);
    const now = Date.now();
    return list.filter((i) => now - i.at < INVITE_TTL_MS);
}

// keep the maps from growing with everyone who ever visited
setInterval(() => {
    const now = Date.now();
    for (const [id, t] of lastSeen) if (now - t > ONLINE_MS * 5) lastSeen.delete(id);
    for (const [id, list] of invites) {
        const live = list.filter((i) => now - i.at < INVITE_TTL_MS);
        if (live.length) invites.set(id, live);
        else invites.delete(id);
    }
}, 5 * 60_000).unref?.();
