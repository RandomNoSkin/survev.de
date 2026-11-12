import $ from "jquery";
import {
    ARENA_CHALLENGES,
    ARENA_LEVEL_UNLOCKS,
    ARENA_LOADOUT_SLOTS,
    ARENA_JUGGERNAUT_M249_KILLS,
    ARENA_MAX_LEVEL,
    ARENA_PERK_DEFS,
    type ArenaLoadout,
} from "../../../shared/defs/modes/arenaDefs";
import {
    ARENA_AIRDROP_WEAPONS,
    ARENA_DEFAULT_STREAKS,
    ARENA_STREAK_DESCRIPTIONS,
    ARENA_STREAKS,
    type ArenaStreakSettings,
} from "../../../shared/defs/modes/arenaStreakDefs";
import { GunDefs } from "../../../shared/defs/gameObjects/gunDefs";
import { type GunCategory, gunCategory } from "../../../shared/defs/gameObjects/gunCategories";
import { GameObjectDefs } from "../../../shared/defs/register";
import {
    ARENA_DEFAULT_LOADOUT,
    type ArenaProfileResponse,
    type ArenaSlot,
    arenaItems,
    arenaFitsSlot,
    arenaUnlockLevel,
    challengeProgress,
} from "../../../shared/utils/arena";
import type { Account } from "../account";
import { helpers } from "../helpers";

const SLOT_LABELS: Record<ArenaSlot, string> = {
    primary: "Main gun",
    pistol: "Pistol",
    throwable: "Throwable",
    perk: "Perk",
};
const CATEGORY_LABELS: Partial<Record<GunCategory, string>> = {
    smg: "SMGs",
    rifle: "Assault rifles & LMGs",
    sniper: "Snipers & DMRs",
    shotgun: "Shotguns",
};

/** The kill streak tab's "slot" (the loadouts are 0..ARENA_LOADOUT_SLOTS-1). */
const STREAK_TAB = -1;

/** Icons of their own in the arena (Cast Ironskin is a level 3 vest there). */
const ARENA_ICONS: Record<string, string> = {
    steelskin: "img/loot/loot-perk-steelskin-arena.svg",
};
export const arenaIconOf = (type: string) => ARENA_ICONS[type] ?? helpers.getSvgFromGameType(type);

/** The pistol slot's groups: pistols, dual pistols, main guns allowed as secondary. */
/** The pistol slot's groups: pistols, dual pistols - then main guns (the MP220 / P90, or
 *  any with Quickswitch) by their category like in the main gun slot. */
function pistolGroup(type: string): string {
    if (gunCategory(type) !== "pistol") return CATEGORY_LABELS[gunCategory(type)] ?? "Other";
    return (GunDefs[type] as { isDual?: boolean }).isDual ? "Dual pistols" : "Pistols";
}
const PISTOL_GROUPS = ["Pistols", "Dual pistols"];

/** Names the game has none for (kills counted under their own name). */
const ARENA_NAMES: Record<string, string> = {
    [ARENA_JUGGERNAUT_M249_KILLS]: "the M249 [+] Juggernaut",
    "8xscope": "Eagle Eye (8x scope)",
};

const nameOf = (type: string) => ARENA_NAMES[type] ?? defName(type);
const defName = (type: string) => (GameObjectDefs.typeToDefSafe(type) as { name?: string } | undefined)?.name ?? type;

/**
 * The arena menu (main menu → Arena Loadouts): the arena level, the three loadouts a
 * player picks from on every spawn in the arena modes (Domination...), and what's still
 * locked and how to get it (a level, or a weapon challenge).
 */
export class ArenaMenu {
    private backdrop = $("<div/>", { class: "arena-menu-backdrop" });
    private panel = $("<div/>", { class: "arena-menu" });
    private profile: ArenaProfileResponse | null = null;
    private slot = 0;
    private editing: ArenaSlot = "primary";

    constructor(private account: Account) {
        this.backdrop.append(this.panel).hide();
        this.backdrop.on("click", (e) => {
            if (e.target === this.backdrop[0]) this.close();
        });
        $(document.body).append(this.backdrop);
    }

    open() {
        this.backdrop.show();
        if (!this.account.loggedIn) {
            this.profile = null;
            this.render();
            return;
        }
        this.panel.html('<div class="arena-status">Loading…</div>');
        this.account.ajaxRequest("/api/user/arena", {}, (err, res: ArenaProfileResponse) => {
            this.profile = err ? null : res;
            this.render();
        });
    }

    close() {
        this.backdrop.hide();
    }

    private get loadout(): ArenaLoadout {
        return this.profile?.loadouts[this.slot] ?? ARENA_DEFAULT_LOADOUT;
    }

    private render() {
        this.panel.empty();
        const close = $("<div/>", { class: "arena-close", title: "Close", text: "×" }).on("click", () => this.close());
        this.panel.append($("<div/>", { class: "arena-head" }).append($("<h2/>", { text: "Arena Loadouts" }), close));
        if (!this.account.loggedIn) {
            this.panel.append(
                $("<div/>", {
                    class: "arena-status",
                    text: "Log in to unlock weapons and save your loadouts. Without an account you play the default loadout (M416, P30L, Frag, Takedown).",
                }),
            );
            return;
        }
        const p = this.profile;
        if (!p) {
            this.panel.append($("<div/>", { class: "arena-status", text: "Couldn't load your arena profile." }));
            return;
        }

        // level and XP
        const pct = p.needed ? Math.round((p.into / p.needed) * 100) : 100;
        this.panel.append(
            $("<div/>", { class: "arena-level" }).append(
                $("<div/>", { class: "arena-level-num", text: `Level ${p.level}` }),
                $("<div/>", { class: "arena-xp-bar" }).append($("<i/>").css("width", `${pct}%`)),
                $("<div/>", {
                    class: "arena-xp-text",
                    text: p.level >= ARENA_MAX_LEVEL ? "Max level" : `${p.into.toLocaleString()} / ${p.needed.toLocaleString()} XP`,
                }),
            ),
        );

        // the three loadouts
        const tabs = $("<div/>", { class: "arena-tabs" });
        for (let i = 0; i < ARENA_LOADOUT_SLOTS; i++) {
            tabs.append(
                $("<div/>", { class: `arena-tab${i === this.slot ? " arena-tab-active" : ""}`, text: `Loadout ${i + 1}` }).on("click", () => {
                    this.slot = i;
                    this.render();
                }),
            );
        }
        tabs.append(
            $("<div/>", { class: `arena-tab${this.slot === STREAK_TAB ? " arena-tab-active" : ""}`, text: "Killstreaks" }).on("click", () => {
                this.slot = STREAK_TAB;
                this.render();
            }),
        );
        this.panel.append(tabs);
        if (this.slot === STREAK_TAB) {
            this.panel.append(this.renderStreaks(p));
            return;
        }

        const slots = $("<div/>", { class: "arena-slots" });
        for (const slot of Object.keys(SLOT_LABELS) as ArenaSlot[]) {
            const type = this.loadout[slot];
            slots.append(
                $("<div/>", { class: `arena-slot${slot === this.editing ? " arena-slot-active" : ""}` })
                    .append(
                        $("<div/>", { class: "arena-slot-label", text: SLOT_LABELS[slot] }),
                        this.icon(type),
                        $("<div/>", { class: "arena-slot-name", text: nameOf(type) }),
                    )
                    .on("click", () => {
                        this.editing = slot;
                        this.render();
                    }),
            );
        }
        this.panel.append(slots, this.renderChoices(p));
    }

    private icon(type: string) {
        return $("<div/>", { class: "arena-icon" }).css("background-image", `url(${arenaIconOf(type)})`);
    }

    /** Everything for the slot being edited: unlocked ones to pick, locked ones with how to get them. */
    private renderChoices(p: ArenaProfileResponse) {
        const unlocked = new Set(p.unlocked);
        const items = arenaItems().filter((t) => arenaFitsSlot(t, this.editing, this.loadout.perk));
        const order = (t: string) => arenaUnlockLevel(t) ?? 100 + (ARENA_CHALLENGES[t]?.kills ?? 0) / 1000;
        items.sort((a, b) => order(a) - order(b));

        const wrap = $("<div/>", { class: "arena-choices" });
        const groups = new Map<string, string[]>();
        for (const t of items) {
            const group = this.editing === "primary" && GunDefs[t]
                ? (CATEGORY_LABELS[gunCategory(t)] ?? "Other")
                : this.editing === "pistol" && GunDefs[t]
                  ? pistolGroup(t)
                  : "";
            groups.set(group, [...(groups.get(group) ?? []), t]);
        }
        // the secondary slot: the pistols first, the main guns' categories after them
        const ordered = [...groups].sort(([a], [b]) => {
            if (this.editing !== "pistol") return 0;
            const ia = PISTOL_GROUPS.indexOf(a);
            const ib = PISTOL_GROUPS.indexOf(b);
            return (ia < 0 ? PISTOL_GROUPS.length : ia) - (ib < 0 ? PISTOL_GROUPS.length : ib);
        });
        for (const [group, list] of ordered) {
            if (group) wrap.append($("<div/>", { class: "arena-group", text: group }));
            const grid = $("<div/>", { class: "arena-grid" });
            for (const t of list) {
                // (the other gun slot holds it already: one gun once)
                const other = this.editing === "primary" ? this.loadout.pistol : this.editing === "pistol" ? this.loadout.primary : "";
                const taken = t === other;
                const open = unlocked.has(t) && !taken;
                const picked = this.loadout[this.editing] === t;
                const card = $("<div/>", { class: `arena-item${open ? "" : " arena-item-locked"}${picked ? " arena-item-picked" : ""}` }).append(
                    this.icon(t),
                    $("<div/>", { class: "arena-item-name", text: nameOf(t) }),
                    // a perk: what it does in the arena
                    ARENA_PERK_DEFS[t] ? $("<div/>", { class: "arena-item-desc", text: ARENA_PERK_DEFS[t].description }) : "",
                    open ? "" : $("<div/>", { class: "arena-item-req", text: taken ? "In your other slot" : this.requirement(t, p) }),
                );
                if (open && !picked) card.on("click", () => this.pick(t));
                grid.append(card);
            }
            wrap.append(grid);
        }
        return wrap;
    }

    /** "Level 12" or "150 kills with M416 (37/150)". */
    private requirement(type: string, p: ArenaProfileResponse): string {
        const level = arenaUnlockLevel(type);
        if (level) return `Level ${level}`;
        const ch = ARENA_CHALLENGES[type];
        if (!ch) return "Locked";
        const what = "weapon" in ch.with
            ? nameOf(ch.with.weapon)
            : ch.with.category === "throwable"
              ? "throwables"
              : (CATEGORY_LABELS[ch.with.category] ?? ch.with.category);
        return `${ch.kills} kills with ${what} (${Math.min(ch.kills, challengeProgress(ch, p.kills))}/${ch.kills})`;
    }

    /** The kill streak tab: every tier with its kills, the variants to pick, the airdrop's gun, Broken Arrow. */
    private renderStreaks(p: ArenaProfileResponse) {
        const unlocked = new Set(p.unlocked);
        const s = p.streaks ?? ARENA_DEFAULT_STREAKS;
        const wrap = $("<div/>", { class: "arena-choices arena-streaks" });
        const card = (type: string, picked: boolean, onPick?: () => void, label = nameOf(type)) => {
            const open = unlocked.has(type) || ARENA_AIRDROP_WEAPONS.includes(type);
            const desc = ARENA_STREAK_DESCRIPTIONS[type];
            const c = $("<div/>", { class: `arena-item${open ? "" : " arena-item-locked"}${picked ? " arena-item-picked" : ""}` }).append(
                this.icon(type),
                $("<div/>", { class: "arena-item-name", text: label }),
                desc ? $("<div/>", { class: "arena-item-desc", text: desc }) : "",
                open ? "" : $("<div/>", { class: "arena-item-req", text: this.requirement(type, p) }),
            );
            if (open && !picked && onPick) c.on("click", onPick);
            return c;
        };
        const offKinds = new Set(s.off ?? []);
        for (const tier of ARENA_STREAKS) {
            // "No Killstreak" picked: the tier gives nothing, the streak goes on to the next one
            const isOff = offKinds.has(tier.kind);
            const withoutOff = [...offKinds].filter((k) => k !== tier.kind);
            wrap.append($("<div/>", { class: "arena-group", text: `${tier.name} · ${tier.kills} kills in a row` }));
            const grid = $("<div/>", { class: "arena-grid" });
            const current = tier.kind === "airdrop" ? s.airdrop : tier.kind === "juggernaut" ? s.juggernaut : tier.options[0];
            for (const type of tier.options) {
                // picking one: that one (and the tier on again)
                const set = () => this.saveStreaks({
                    ...s,
                    ...(tier.kind === "airdrop" || tier.kind === "juggernaut" ? { [tier.kind]: type } : {}),
                    off: withoutOff,
                });
                const label = tier.kind === "juggernaut" ? `${nameOf(type)} Juggernaut` : undefined;
                grid.append(card(type, !isOff && current === type && unlocked.has(type), set, label));
            }
            // the last pick: none
            const none = $("<div/>", { class: `arena-item arena-item-none${isOff ? " arena-item-picked" : ""}` }).append(
                $("<div/>", { class: "arena-item-none-icon", text: "✕" }),
                $("<div/>", { class: "arena-item-name", text: "No Killstreak" }),
                $("<div/>", { class: "arena-item-desc", text: "Nothing at this streak - it goes on to the next one." }),
            );
            if (!isOff) none.on("click", () => this.saveStreaks({ ...s, off: [...withoutOff, tier.kind] }));
            grid.append(none);
            wrap.append(grid);
            if (isOff) continue;
            // the airdrop's gun - only for the flare (the supply flare brings armor)
            if (tier.kind === "airdrop" && s.airdrop !== "supply_flare_gun") {
                wrap.append($("<div/>", { class: "arena-group arena-subgroup", text: "What the airdrop brings" }));
                const guns = $("<div/>", { class: "arena-grid" });
                for (const gun of ARENA_AIRDROP_WEAPONS) {
                    guns.append(card(gun, s.airdropWeapon === gun, () => this.saveStreaks({ ...s, airdropWeapon: gun })));
                }
                wrap.append(guns);
            }
            if (tier.kind === "airstrike") {
                // Broken Arrow: on top of the perk slot, on / off
                const has = unlocked.has("broken_arrow");
                const toggle = $("<div/>", {
                    // (a switch: clickable on and off)
                    class: `arena-item arena-item-toggle${has ? "" : " arena-item-locked"}${s.brokenArrow ? " arena-item-picked" : ""}`,
                }).append(
                    this.icon("broken_arrow"),
                    $("<div/>", { class: "arena-item-name", text: `Broken Arrow: ${s.brokenArrow ? "on" : "off"}` }),
                    $("<div/>", { class: "arena-item-desc", text: has ? (ARENA_PERK_DEFS.broken_arrow?.description ?? "") : this.requirement("broken_arrow", p) }),
                );
                if (has) toggle.on("click", () => this.saveStreaks({ ...s, brokenArrow: !s.brokenArrow }));
                // next to the strobe
                grid.append(toggle);
            }
        }
        return wrap;
    }

    private saveStreaks(streaks: ArenaStreakSettings) {
        const p = this.profile;
        if (!p) return;
        p.streaks = streaks;
        this.render();
        const { eagleEye: _derived, ...body } = streaks;
        this.account.ajaxRequest("/api/user/arena/streaks", body, (err, res: { streaks: ArenaStreakSettings }) => {
            if (!err && res?.streaks && this.profile) {
                this.profile.streaks = res.streaks;
                this.render();
            }
        });
    }

    private pick(type: string) {
        const p = this.profile;
        if (!p) return;
        const loadout = { ...this.loadout, [this.editing]: type };
        // no Quickswitch any more: a main gun as secondary goes back to a pistol
        if (!arenaFitsSlot(loadout.pistol, "pistol", loadout.perk)) loadout.pistol = ARENA_DEFAULT_LOADOUT.pistol;
        p.loadouts[this.slot] = loadout;
        this.render();
        this.account.ajaxRequest("/api/user/arena/loadout", { slot: this.slot, loadout }, (err, res: { loadout: ArenaLoadout }) => {
            if (!err && res?.loadout && this.profile) {
                this.profile.loadouts[this.slot] = res.loadout;
                this.render();
            }
        });
    }
}

/**
 * The main menu's right column in multiplayer (instead of the battle pass): arena level
 * and XP, the next unlocks and the weapon challenges closest to done.
 */
export class ArenaProgressPanel {
    constructor(
        private account: Account,
        private root: JQuery<HTMLElement>,
        private openLoadouts: () => void,
    ) {}

    load() {
        if (!this.account.loggedIn) {
            // the login of a returning player is still on its way (main.ts loads again on "login")
            if (helpers.getCookie("app-data")) {
                this.root.empty().append(
                    $("<div/>", { class: "ap-name", text: "Arena Progress" }),
                    $("<div/>", { class: "ap-note", text: "Loading…" }),
                );
                return;
            }
            this.render(null);
            return;
        }
        this.account.ajaxRequest("/api/user/arena", {}, (err, res: ArenaProfileResponse) => this.render(err ? null : res));
    }

    private icon(type: string) {
        return $("<div/>", { class: "arena-icon" }).css("background-image", `url(${arenaIconOf(type)})`);
    }

    private render(p: ArenaProfileResponse | null) {
        const root = this.root.empty();
        root.append($("<div/>", { class: "ap-name", text: "Arena Progress" }));
        if (!p) {
            root.append(
                $("<div/>", {
                    class: "ap-note",
                    text: this.account.loggedIn
                        ? "Couldn't load your arena progress."
                        : "Log in to level up in the arena and unlock weapons. Guests play the starter loadouts.",
                }),
            );
            return;
        }

        // level, XP, and the next unlock in the circle - like the pass
        const pct = p.needed ? Math.round((p.into / p.needed) * 100) : 100;
        let next: { level: number; type: string } | undefined;
        for (let level = p.level + 1; level <= ARENA_MAX_LEVEL && !next; level++) {
            const t = ARENA_LEVEL_UNLOCKS[level]?.[0];
            if (t) next = { level, type: t };
        }
        const progress = $("<div/>", { class: "ap-progress" }).append(
            $("<div/>", { class: "ap-level", text: String(p.level) }),
            $("<div/>", { class: "ap-bar" }).append(
                $("<div/>", { class: "ap-bar-fill" }).css("width", `${pct}%`),
                $("<div/>", {
                    class: "ap-xp",
                    text: p.level >= ARENA_MAX_LEVEL ? "MAX" : `${p.into} / ${p.needed} XP`,
                }),
            ),
        );
        if (next) {
            progress.append(
                $("<div/>", { class: "ap-unlock", title: `${nameOf(next.type)} at level ${next.level}` }).append(
                    $("<div/>", { class: "ap-unlock-image" }).css("background-image", `url(${arenaIconOf(next.type)})`),
                    $("<div/>", { class: "ap-unlock-level", text: `${nameOf(next.type)} · Lv ${next.level}` }),
                ),
            );
        }
        root.append(progress);

        // the weapon challenges closest to done - always open (the pass's "How to earn XP" box)
        const unlocked = new Set(p.unlocked);
        const open = Object.entries(ARENA_CHALLENGES)
            .filter(([t]) => !unlocked.has(t))
            .map(([t, ch]) => ({ t, ch, done: Math.min(ch.kills, challengeProgress(ch, p.kills)) }))
            .sort((a, b) => b.done / b.ch.kills - a.done / a.ch.kills)
            .slice(0, 3);
        const box = $("<div/>", { class: "ap-challenges" }).append($("<div/>", { class: "ap-challenges-title", text: "Weapon challenges" }));
        if (!open.length) box.append($("<div/>", { class: "ap-challenge", text: "All done!" }));
        for (const { t, ch, done } of open) {
            box.append(
                $("<div/>", { class: "ap-challenge" }).append(
                    this.icon(t),
                    $("<div/>", { class: "ap-challenge-main" }).append(
                        $("<div/>", { class: "ap-challenge-name", text: `${nameOf(t)}  ${done}/${ch.kills}` }),
                        $("<div/>", { class: "ap-challenge-bar" }).append($("<i/>").css("width", `${(done / ch.kills) * 100}%`)),
                    ),
                ),
            );
        }
        root.append(box);
    }
}
