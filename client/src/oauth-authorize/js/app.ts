import "../../../css/oauth.css";
import type {
    AuthorizeDecisionResponse,
    AuthorizeInfoResponse,
    OAuthScope,
} from "../../../../shared/types/oauth";
import { ajaxRequest } from "../../ajax";
import { api } from "../../api";
import { renderConsent, renderMessage } from "../../oauth/consentView";

document.body.classList.add("oauth-page");

const root = document.getElementById("oauth-root")!;

const params = new URLSearchParams(window.location.search);
const clientId = params.get("client_id") ?? "";
const redirectUri = params.get("redirect_uri") ?? "";
const state = params.get("state") ?? "";
const scopes = (params.get("scope") ?? "")
    .split(/[\s,]+/)
    .filter(Boolean) as OAuthScope[];

function describeError(error: string): string {
    switch (error) {
        case "invalid_request":
            return "This link is missing required information (client_id, redirect_uri or scope).";
        case "app_not_approved":
            return "This application hasn't been approved yet. Please contact its developer.";
        default:
            return "This authorization link is invalid or has expired.";
    }
}

function redirectToLogin() {
    const returnTo = encodeURIComponent(window.location.href);
    window.location.href = api.resolveUrl(`/api/auth/discord?redirect=${returnTo}`);
}

async function init() {
    if (!clientId || !redirectUri || !scopes.length) {
        renderMessage(root, describeError("invalid_request"), true);
        return;
    }

    const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scopes.join(" "),
    });
    if (state) query.set("state", state);

    let res: Response;
    try {
        res = await fetch(api.resolveUrl(`/api/oauth/authorize?${query.toString()}`));
    } catch {
        renderMessage(root, "Could not reach survev.de. Please try again.", true);
        return;
    }

    if (res.status === 401) {
        redirectToLogin();
        return;
    }

    const info = (await res.json()) as AuthorizeInfoResponse;
    if ("error" in info) {
        renderMessage(root, describeError(info.error), true);
        return;
    }

    renderConsent({
        container: root,
        appName: info.appName,
        ownerSlug: info.ownerSlug,
        scopes: info.scopes,
        onApprove: () => decide("approve"),
        onDeny: () => decide("deny"),
    });
}

function decide(action: "approve" | "deny") {
    renderMessage(root, "Working…");
    ajaxRequest(
        `/api/oauth/authorize/${action}`,
        { clientId, redirectUri, scope: scopes, state },
        (err, res: AuthorizeDecisionResponse) => {
            if (err || !res?.redirectUrl) {
                renderMessage(
                    root,
                    "Something went wrong. Please close this tab and try again from the app.",
                    true,
                );
                return;
            }
            window.location.href = res.redirectUrl;
        },
    );
}

init();
