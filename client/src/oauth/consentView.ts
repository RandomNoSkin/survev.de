import type { OAuthScope } from "../../../shared/types/oauth";

const SCOPE_LABELS: Record<OAuthScope, string> = {
    "read:discord": "See whether your account is linked to Discord, and your Discord user ID.",
    "read:stats": "Read your match stats (kills, damage, wins, time alive, ...).",
    "read:inventory": "Read your full item inventory, including trade history, value, and lore.",
    "read:market": "Read your daily and weekly market offers and Golden Fries balance.",
};

function escapeHtml(value: string): string {
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
}

/**
 * Renders the "App X wants to: ..." consent card shared by the redirect-flow
 * (/oauth-authorize) and device-flow (/link) pages, so the two don't duplicate this UI.
 */
export function renderConsent(opts: {
    container: HTMLElement;
    appName: string;
    ownerSlug: string;
    scopes: OAuthScope[];
    onApprove: () => void;
    onDeny: () => void;
}) {
    const { container, appName, ownerSlug, scopes, onApprove, onDeny } = opts;

    const scopeItems = scopes
        .map((scope) => `<li>${escapeHtml(SCOPE_LABELS[scope] ?? scope)}</li>`)
        .join("");

    container.innerHTML = `
        <div class="oauth-consent-card">
            <h1>${escapeHtml(appName)}</h1>
            <p class="oauth-consent-owner">by ${escapeHtml(ownerSlug)}</p>
            <p>This application would like to:</p>
            <ul class="oauth-consent-scopes">${scopeItems}</ul>
            <p class="oauth-muted">
                You can revoke this access at any time from your account settings.
            </p>
            <div class="oauth-consent-actions">
                <button type="button" class="oauth-btn oauth-btn-deny" id="oauth-deny-btn">Deny</button>
                <button type="button" class="oauth-btn oauth-btn-approve" id="oauth-approve-btn">Approve</button>
            </div>
        </div>
    `;

    container.querySelector<HTMLButtonElement>("#oauth-approve-btn")!.addEventListener(
        "click",
        onApprove,
    );
    container.querySelector<HTMLButtonElement>("#oauth-deny-btn")!.addEventListener(
        "click",
        onDeny,
    );
}

export function renderMessage(container: HTMLElement, message: string, isError = false) {
    container.innerHTML = `<div class="oauth-card"><p class="${isError ? "oauth-error" : "oauth-muted"}">${
        escapeHtml(message)
    }</p></div>`;
}
