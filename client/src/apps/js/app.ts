import "../../../css/oauth.css";
import type { CreateAppResponse, OAuthApp } from "../../../../shared/types/oauth";
import { ajaxRequest } from "../../ajax";
import { api } from "../../api";

document.body.classList.add("oauth-page");

const root = document.getElementById("oauth-root")!;

let apps: OAuthApp[] = [];

function redirectToLogin() {
    const returnTo = encodeURIComponent(window.location.href);
    window.location.href = api.resolveUrl(`/api/auth/discord?redirect=${returnTo}`);
}

function escapeHtml(value: string): string {
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
}

function parseRedirectUris(raw: string): string[] {
    return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

function statusBadge(status: OAuthApp["status"]): string {
    const labels: Record<OAuthApp["status"], string> = {
        pending: "Pending review",
        approved: "Approved",
        rejected: "Rejected",
        suspended: "Suspended",
    };
    return `<span class="oauth-badge oauth-badge-${status}">${labels[status]}</span>`;
}

function renderSecretReveal(container: HTMLElement, app: OAuthApp, clientSecret: string) {
    container.innerHTML = `
        <div class="oauth-card">
            <h1>${escapeHtml(app.name)}</h1>
            <p class="oauth-muted">
                Save this client secret now — it will not be shown again. If you lose it,
                rotate the secret to get a new one (this invalidates the old one).
            </p>
            <div class="oauth-field">
                <label>Client ID</label>
                <div class="oauth-secret-reveal">${escapeHtml(app.id)}</div>
            </div>
            <div class="oauth-field">
                <label>Client secret</label>
                <div class="oauth-secret-reveal">${escapeHtml(clientSecret)}</div>
            </div>
            <div class="oauth-form-actions">
                <button type="button" class="oauth-btn oauth-btn-approve" id="oauth-back-btn">Done</button>
            </div>
        </div>
    `;
    container.querySelector("#oauth-back-btn")!.addEventListener("click", render);
}

function render() {
    const createFormHtml = `
        <div class="oauth-card">
            <h1>Register a new application</h1>
            <p class="oauth-muted">
                New applications must be approved by an admin before users can authorize
                them. You'll see the status below once submitted.
            </p>
            <div class="oauth-field">
                <label for="oauth-app-name">Name</label>
                <input id="oauth-app-name" type="text" maxlength="64" placeholder="My Discord Bot">
            </div>
            <div class="oauth-field">
                <label for="oauth-app-desc">Description</label>
                <input id="oauth-app-desc" type="text" maxlength="280" placeholder="What does your app do?">
            </div>
            <div class="oauth-field">
                <label for="oauth-app-redirects">
                    Redirect URIs (one per line — only needed for the redirect flow; leave
                    empty if you're only using the device-code flow)
                </label>
                <textarea id="oauth-app-redirects" rows="3" placeholder="https://example.com/callback"></textarea>
            </div>
            <div class="oauth-form-actions">
                <button type="button" class="oauth-btn oauth-btn-approve" id="oauth-app-create-btn">Create application</button>
            </div>
        </div>
    `;

    const appsListHtml = apps.length
        ? apps
              .map((app) => {
                  const uris = app.redirectUris.length
                      ? app.redirectUris.map(escapeHtml).join("<br>")
                      : '<span class="oauth-muted">–</span>';
                  const reviewNote = app.reviewNote
                      ? `<div class="oauth-muted">Note: ${escapeHtml(app.reviewNote)}</div>`
                      : "";
                  return `
                    <tr>
                        <td>
                            <div><b>${escapeHtml(app.name)}</b></div>
                            <div class="oauth-muted">${escapeHtml(app.description || "–")}</div>
                            <div class="oauth-muted" style="font-family:monospace;">${escapeHtml(app.id)}</div>
                        </td>
                        <td>${statusBadge(app.status)}${reviewNote}</td>
                        <td>${uris}</td>
                        <td>
                            <div class="oauth-app-list-item-actions">
                                <button type="button" class="oauth-btn-sm" data-action="rotate" data-id="${escapeHtml(app.id)}">Rotate secret</button>
                                <button type="button" class="oauth-btn-sm oauth-btn-danger" data-action="delete" data-id="${escapeHtml(app.id)}">Delete</button>
                            </div>
                        </td>
                    </tr>
                `;
              })
              .join("")
        : "";

    const appsListSection = apps.length
        ? `
            <div class="oauth-card">
                <h1>My applications</h1>
                <table class="oauth-table">
                    <thead><tr><th>App</th><th>Status</th><th>Redirect URIs</th><th>Actions</th></tr></thead>
                    <tbody>${appsListHtml}</tbody>
                </table>
            </div>
        `
        : `<div class="oauth-card"><p class="oauth-muted">You haven't registered any applications yet.</p></div>`;

    root.innerHTML = createFormHtml + appsListSection;

    root.querySelector("#oauth-app-create-btn")!.addEventListener("click", onCreate);
    root.querySelectorAll<HTMLButtonElement>("[data-action='rotate']").forEach((btn) => {
        btn.addEventListener("click", () => onRotate(btn.dataset.id!));
    });
    root.querySelectorAll<HTMLButtonElement>("[data-action='delete']").forEach((btn) => {
        btn.addEventListener("click", () => onDelete(btn.dataset.id!));
    });
}

function onCreate() {
    const name = (root.querySelector<HTMLInputElement>("#oauth-app-name")!).value.trim();
    const description = (root.querySelector<HTMLInputElement>("#oauth-app-desc")!).value.trim();
    const redirectUris = parseRedirectUris(
        (root.querySelector<HTMLTextAreaElement>("#oauth-app-redirects")!).value,
    );

    if (!name) {
        window.alert("Please enter a name for your application.");
        return;
    }

    ajaxRequest(
        "/api/oauth/apps/create",
        { name, description, redirectUris },
        (err, res: CreateAppResponse & { error?: string }) => {
            if (err) {
                window.alert("Failed to create application. Please try again.");
                return;
            }
            if (res.error === "too_many_pending") {
                window.alert(
                    "You have too many applications awaiting review. Please wait for one to be reviewed before creating another.",
                );
                return;
            }
            apps = [...apps, res.app];
            renderSecretReveal(root, res.app, res.clientSecret);
        },
    );
}

function onRotate(applicationId: string) {
    if (!window.confirm("Rotate this app's client secret? The old secret stops working immediately.")) {
        return;
    }
    ajaxRequest(
        "/api/oauth/apps/rotate_secret",
        { applicationId },
        (err, res: CreateAppResponse) => {
            if (err) {
                window.alert("Failed to rotate secret. Please try again.");
                return;
            }
            apps = apps.map((a) => (a.id === res.app.id ? res.app : a));
            renderSecretReveal(root, res.app, res.clientSecret);
        },
    );
}

function onDelete(applicationId: string) {
    if (
        !window.confirm(
            "Delete this application? Every user who authorized it will immediately lose access, and this cannot be undone.",
        )
    ) {
        return;
    }
    ajaxRequest("/api/oauth/apps/delete", { applicationId }, (err) => {
        if (err) {
            window.alert("Failed to delete application. Please try again.");
            return;
        }
        apps = apps.filter((a) => a.id !== applicationId);
        render();
    });
}

function init() {
    ajaxRequest("/api/oauth/apps/list", {}, (err, res: OAuthApp[]) => {
        if (err) {
            if (err.status === 401) {
                redirectToLogin();
                return;
            }
            root.innerHTML = `<div class="oauth-card"><p class="oauth-error">Failed to load your applications. Please refresh the page.</p></div>`;
            return;
        }
        apps = res;
        render();
    });
}

type TabName = "myapps" | "docs";

function initTabs() {
    const tabs = document.querySelectorAll<HTMLButtonElement>(".oauth-sidebar-tab");
    const panes: Record<TabName, HTMLElement> = {
        myapps: document.getElementById("oauth-tab-myapps")!,
        docs: document.getElementById("oauth-tab-docs")!,
    };

    function showTab(name: TabName) {
        for (const tab of tabs) {
            tab.classList.toggle("oauth-sidebar-tab-active", tab.dataset.tab === name);
        }
        for (const key of Object.keys(panes) as TabName[]) {
            panes[key].hidden = key !== name;
        }
        history.replaceState(null, "", name === "docs" ? "#docs" : window.location.pathname);
    }

    for (const tab of tabs) {
        tab.addEventListener("click", () => showTab(tab.dataset.tab as TabName));
    }

    showTab(window.location.hash === "#docs" ? "docs" : "myapps");
}

initTabs();
init();
