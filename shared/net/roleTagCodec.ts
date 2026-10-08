import type { DisplayRoleTag } from "../types/user";

/**
 * Wire encoding for the in-game name tag - a single byte instead of separate booleans,
 * used by PlayerInfo/JoinFeedMsg (see updateMsg.ts, joinFeedMsg.ts) so both serialize
 * and deserialize agree on the mapping from one source of truth.
 *
 * Deliberately its own file, separate from shared/types/user.ts: this only
 * TYPE-imports the tag union (erased at compile time), so shared/net/* never
 * runtime-imports shared/types/user.ts - that file already runtime-imports FROM
 * shared/net/net.ts, and a runtime import the other way would form a cycle that breaks
 * module init order.
 */
// Append-only: the index IS the wire value, so never reorder or remove entries.
const ROLE_TAG_DECODE: DisplayRoleTag[] = [null, "premium", "mod", "admin", "bot"];

export function encodeRoleTag(tag: DisplayRoleTag): number {
    const idx = tag ? ROLE_TAG_DECODE.indexOf(tag) : 0;
    return idx < 0 ? 0 : idx;
}

export function decodeRoleTag(byte: number): DisplayRoleTag {
    return ROLE_TAG_DECODE[byte] ?? null;
}
