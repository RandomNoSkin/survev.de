import "../../../css/oauth.css";
import type { AuthorizeInfoResponse } from "../../../../shared/types/oauth";
import { ajaxRequest } from "../../ajax";
import { api } from "../../api";
import { renderConsent, renderMessage } from "../../oauth/consentView";

document.body.classList.add("oauth-page");

const root = document.getElementById("oauth-root")!;

function redirectToLogin() {
    const returnTo = encodeURIComponent(window.location.href);
    window.location.href = api.resolveUrl(`/api/auth/discord?redirect=${returnTo}`);
}

function renderCodeForm(prefill: string) {
    root.innerHTML = `
        <div class="oauth-card">
            <h1>Connect an app</h1>
            <p class="oauth-muted">
                Enter the code shown by the application (e.g. your Discord bot) to
                review and approve what it can access.
            </p>
            <div class="oauth-field">
                <label for="oauth-code-input">Code</label>
                <input id="oauth-code-input" type="text" placeholder="ABCD-1234"
                    autocomplete="off" autocapitalize="characters" spellcheck="false"
                    value="${prefill.replace(/"/g, "")}">
            </div>
            <div class="oauth-form-actions">
                <button type="button" class="oauth-btn oauth-btn-approve" id="oauth-code-submit">Continue</button>
            </div>
        </div>
    `;

    const input = root.querySelector<HTMLInputElement>("#oauth-code-input")!;
    const submit = root.querySelector<HTMLButtonElement>("#oauth-code-submit")!;

    const trySubmit = () => {
        const code = input.value.trim().toUpperCase();
        if (code) lookupCode(code);
    };
    submit.addEventListener("click", trySubmit);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") trySubmit();
    });

    if (prefill) trySubmit();
}

function lookupCode(userCode: string) {
    renderMessage(root, "Looking up code…");
    ajaxRequest(
        "/api/oauth/device/lookup",
        { userCode },
        (err, res: AuthorizeInfoResponse) => {
            if (err) {
                if (err.status === 401) {
                    redirectToLogin();
                    return;
                }
                renderMessage(root, "Invalid or expired code. Please double-check it and try again.", true);
                return;
            }
            if ("error" in res) {
                renderMessage(root, "Invalid or expired code. Please double-check it and try again.", true);
                return;
            }

            renderConsent({
                container: root,
                appName: res.appName,
                ownerSlug: res.ownerSlug,
                scopes: res.scopes,
                onApprove: () => decide(userCode, "approve"),
                onDeny: () => decide(userCode, "deny"),
            });
        },
    );
}

function decide(userCode: string, action: "approve" | "deny") {
    renderMessage(root, "Working…");
    ajaxRequest(`/api/oauth/device/${action}`, { userCode }, (err) => {
        if (err) {
            renderMessage(root, "Something went wrong. Please try again.", true);
            return;
        }
        renderMessage(
            root,
            action === "approve"
                ? "Approved! You can close this tab and return to the app."
                : "Denied. You can close this tab.",
        );
    });
}

const prefill = new URLSearchParams(window.location.search).get("code") ?? "";
renderCodeForm(prefill);
