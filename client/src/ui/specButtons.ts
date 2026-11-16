/**
 * The spectator bar's buttons (#ui-spectate-buttons): the player picks which show and
 * in what order in the HUD editor ("Spectator" view). Applied with CSS `order` and a
 * hiding class only - which buttons the game itself shows (advanced spectator on/off,
 * ...) stays with UiManager. Leave isn't in here: it always sits on top.
 */
export const SPEC_BUTTONS: ReadonlyArray<{ id: string; elId: string; label: string }> = [
    { id: "next", elId: "btn-spectate-next-player", label: "Next Teammate" },
    { id: "prev", elId: "btn-spectate-prev-player", label: "Previous Teammate" },
    { id: "stats", elId: "btn-spectate-view-stats", label: "Match Stats" },
    { id: "advanced", elId: "btn-spectate-advanced", label: "Advanced Spectator" },
];

export interface SpecButtonsConfig {
    order: string[];
    hidden: string[];
}

/** Next / previous player: off unless turned on (the arrow keys do it) */
export const SPEC_BUTTONS_DEFAULT: SpecButtonsConfig = { order: [], hidden: ["next", "prev"] };

/** Every button's id in the player's order (new / unknown ones: at their default place). */
export function specButtonOrder(cfg: SpecButtonsConfig | undefined): string[] {
    const ids = SPEC_BUTTONS.map((b) => b.id);
    const order = (cfg?.order ?? []).filter((id, i, all) => ids.includes(id) && all.indexOf(id) === i);
    for (const id of ids) {
        if (order.includes(id)) continue;
        // after the one it follows by default
        const before = ids.slice(0, ids.indexOf(id)).reverse().find((b) => order.includes(b));
        order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
    }
    return order;
}

export function applySpecButtons(cfg: SpecButtonsConfig | undefined) {
    const order = specButtonOrder(cfg);
    const hidden = new Set((cfg ?? SPEC_BUTTONS_DEFAULT).hidden);
    for (const b of SPEC_BUTTONS) {
        const el = document.getElementById(b.elId);
        if (!el) continue;
        el.style.order = String(order.indexOf(b.id));
        el.classList.toggle("spec-user-hidden", hidden.has(b.id));
    }
}
