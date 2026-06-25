// Adsterra Popunder, scoped to the start menu so it never fires during an active
// match. The script is injected while the menu is visible and removed (along with
// any DOM it appends to <body>) once a game starts. Adsterra throttles how often it
// actually pops via the zone's Frequency Cap (set in the Adsterra dashboard).
const SOCIAL_BAR_SRC =
    "https://pl29894911.effectivecpmnetwork.com/32/e0/d0/32e0d0acba9fbe0f455cc4ae24272eab.js";

let scriptEl: HTMLScriptElement | null = null;
let observer: MutationObserver | null = null;
const injectedNodes = new Set<ChildNode>();

/**
 * Toggle the menu-only ad script. Idempotent: safe to call on every UI refresh.
 * @param active true while the start menu is shown, false during a match.
 */
export function setMenuAdsActive(active: boolean): void {
    if (active) {
        if (scriptEl) return; // already loaded for this menu visit

        // Record any top-level nodes the ad script appends so we can remove them later.
        observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach((node) => injectedNodes.add(node as ChildNode));
            }
        });
        observer.observe(document.body, { childList: true });

        scriptEl = document.createElement("script");
        scriptEl.src = SOCIAL_BAR_SRC;
        scriptEl.async = true;
        document.body.appendChild(scriptEl);
    } else {
        observer?.disconnect();
        observer = null;
        scriptEl?.remove();
        scriptEl = null;
        for (const node of injectedNodes) {
            node.remove?.();
        }
        injectedNodes.clear();
    }
}
