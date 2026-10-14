import { isPremiumActive } from "./premium";

/**
 * The subset of a user row `resolveRoleTag` needs - satisfied by any select that
 * includes these columns, not just a full `usersTable` row. The boolean fields accept
 * `null`/`undefined` too so a `leftJoin` onto a possibly-missing/deleted user (e.g. a
 * gift's sender) can be passed straight through without a separate null-check - a
 * missing row resolves to no tag, same as an account with every role/toggle off.
 */
export interface RoleTagInput {
    owner: boolean | null | undefined;
    admin: boolean | null | undefined;
    moderator: boolean | null | undefined;
    premiumUntil: Date | null | undefined;
    showOwnerPrefix: boolean | null | undefined;
    showAdminPrefix: boolean | null | undefined;
    showModPrefix: boolean | null | undefined;
    showPremiumPrefix: boolean | null | undefined;
}

/**
 * Resolves the single name-prefix tag to show for a user, or null for none.
 * Priority OWNER > ADMIN > MOD > PREM, but each role's own toggle gates only itself - a
 * role whose toggle is off is skipped (not treated as disqualifying the whole account),
 * so an admin with showAdminPrefix=false but showPremiumPrefix=true still shows "premium"
 * if they also have Premium active. This is the single choke point for turning the
 * independent role toggles into the one tag every display surface (web + in-game) uses -
 * every server response that shows a username should call this instead of resolving
 * `premium`/`admin`/`moderator` ad hoc.
 */
export function resolveRoleTag(
    user: RoleTagInput,
): "owner" | "admin" | "mod" | "premium" | null {
    if (user.owner && user.showOwnerPrefix) return "owner";
    if (user.admin && user.showAdminPrefix) return "admin";
    // admins hold every mod permission (see the moderation dashboard gate) without the
    // moderator flag being set, so ADMIN off must still fall through to MOD for them
    if ((user.moderator || user.admin) && user.showModPrefix) return "mod";
    if (isPremiumActive(user.premiumUntil ?? null) && user.showPremiumPrefix) return "premium";
    return null;
}
