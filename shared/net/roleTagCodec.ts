import type { RoleTag } from "../types/user";

/**
 * Wire encoding for RoleTag - a single byte instead of separate booleans, used by
 * PlayerInfo/JoinFeedMsg (see updateMsg.ts, joinFeedMsg.ts) so both serialize and
 * deserialize agree on the mapping from one source of truth.
 *
 * Deliberately its own file, separate from shared/types/user.ts: this only
 * TYPE-imports RoleTag (erased at compile time), so shared/net/* never runtime-imports
 * shared/types/user.ts - that file already runtime-imports FROM shared/net/net.ts, and
 * a runtime import the other way would form a cycle that breaks module init order.
 */
const ROLE_TAG_DECODE: RoleTag[] = [null, "premium", "mod", "admin"];

export function encodeRoleTag(tag: RoleTag): number {
    const idx = tag ? ROLE_TAG_DECODE.indexOf(tag) : 0;
    return idx < 0 ? 0 : idx;
}

export function decodeRoleTag(byte: number): RoleTag {
    return ROLE_TAG_DECODE[byte] ?? null;
}
