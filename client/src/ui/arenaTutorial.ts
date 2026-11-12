import $ from "jquery";
import { ARENA_STREAKS } from "../../../shared/defs/modes/arenaStreakDefs";
import { DOMINATION_SCORE_LIMIT, DOMINATION_TIME_LIMIT_S } from "../../../shared/defs/modes/dominationDefs";
import { GUN_GAME_TIME_LIMIT_S } from "../../../shared/defs/modes/gunGameDefs";
import { arenaIconOf } from "./arenaMenu";

/** The arena modes that play with the arena loadouts (and kill streaks, arena XP). */
export const ARENA_LOADOUT_MAPS = ["domination"];

/** The arena modes the tour knows (its pages show only for the ones playable now). */
type TutorialMode = "gungame" | "domination";

/** What the tour adapts to: the arena modes playable right now (mapNames). */
export interface TutorialContext {
    modes: Set<string>;
    /** a mode with the arena loadouts is on (loadouts, kill streaks, arena XP) */
    loadouts: boolean;
}

/** One page: a title, a picture (built from the game's own icons), a few lines. */
interface TutorialPage {
    id: string;
    /** shown only while this mode is playable (none: always) */
    mode?: TutorialMode;
    /** shown only while a mode with the arena loadouts is playable */
    loadouts?: boolean;
    title: string;
    picture: (ctx: TutorialContext) => JQuery<HTMLElement>;
    lines: (ctx: TutorialContext) => string[];
}

const minutes = (s: number) => Math.round(s / 60);

/** An item's icon as a picture tile, with a caption below. */
function tile(type: string, caption?: string, extraClass = "") {
    const t = $("<div/>", { class: `at-tile ${extraClass}` }).append(
        $("<div/>", { class: "at-tile-icon" }).css("background-image", `url(${arenaIconOf(type)})`),
    );
    if (caption) t.append($("<div/>", { class: "at-tile-caption", text: caption }));
    return t;
}

const arrow = () => $("<div/>", { class: "at-arrow", text: "→" });

/** The intro: what the multiplayer client is - respawns, and (with a loadout mode on)
 *  the loadout, levels, kill streaks; else the guns handed out. */
function introPicture(ctx: TutorialContext) {
    const feature = (icon: JQuery<HTMLElement>, name: string) =>
        $("<div/>", { class: "at-feature" }).append(icon, $("<div/>", { class: "at-feature-name", text: name }));
    const respawn = feature($("<div/>", { class: "at-feature-big", text: "\u21bb" }), "Respawn in seconds");
    if (!ctx.loadouts) {
        return $("<div/>", { class: "at-pic at-pic-row" }).append(
            respawn,
            feature($("<div/>", { class: "at-feature-icons" }).append(tile("mp5"), tile("ak47"), tile("mosin")), "The guns are handed out"),
            feature($("<div/>", { class: "at-feature-big", text: "\u2694" }), "Pure aim, no looting"),
        );
    }
    return $("<div/>", { class: "at-pic at-pic-row" }).append(
        feature($("<div/>", { class: "at-feature-icons" }).append(tile("hk416"), tile("p30l"), tile("frag")), "Your loadout"),
        respawn,
        feature($("<div/>", { class: "at-feature-big at-level", text: "LVL" }), "Level up & unlock"),
        feature($("<div/>", { class: "at-feature-icons" }).append(tile("flare_gun"), tile("strobe")), "Kill streaks"),
    );
}

/** Gun Game: a ladder of guns, every kill the next one, the knife last. */
function gunGamePicture() {
    const steps = ["mp5", "ak47", "m870", "mosin", "deagle"];
    const row = $("<div/>", { class: "at-pic at-ladder" });
    steps.forEach((type, i) => {
        row.append(tile(type, `${i + 1}`));
        row.append(arrow());
    });
    row.append($("<div/>", { class: "at-ladder-dots", text: "…" }), arrow(), tile("machete", "Win", "at-tile-win"));
    return row;
}

/** Domination: two sides, the three zones - one held, one being taken, one the enemy's. */
function dominationPicture() {
    const own = "#3a8dff";
    const enemy = "#ff4b4b";
    const neutral = "#c8c8c8";
    const zone = (x: number, y: number, name: string, color: string, ring?: { color: string; part: number }) => {
        const r = 26;
        const c = 2 * Math.PI * (r - 5);
        const progress = ring
            ? `<circle cx="${x}" cy="${y}" r="${r - 5}" fill="none" stroke="${ring.color}" stroke-width="5"
                 stroke-dasharray="${c * ring.part} ${c}" transform="rotate(-90 ${x} ${y})"/>`
            : "";
        return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="3"/>
            ${progress}
            <text x="${x}" y="${y + 9}" text-anchor="middle" font-size="26" font-weight="bold" fill="${color}">${name}</text>`;
    };
    const dot = (x: number, y: number, color: string) =>
        `<circle cx="${x}" cy="${y}" r="5" fill="${color}" stroke="#000" stroke-opacity="0.4" stroke-width="1.5"/>`;
    const svg = `<svg viewBox="0 0 420 170" class="at-dom-map" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="420" height="170" rx="10" fill="#5b7f3a"/>
        <rect x="0" y="0" width="60" height="170" rx="10" fill="${own}" fill-opacity="0.18"/>
        <rect x="360" y="0" width="60" height="170" rx="10" fill="${enemy}" fill-opacity="0.18"/>
        <text x="30" y="160" text-anchor="middle" font-size="12" font-weight="bold" fill="${own}">YOU</text>
        <text x="390" y="160" text-anchor="middle" font-size="12" font-weight="bold" fill="${enemy}">ENEMY</text>
        ${zone(110, 85, "A", own)}
        ${zone(210, 45, "B", neutral, { color: own, part: 0.6 })}
        ${zone(310, 85, "C", enemy)}
        ${dot(104, 92, own)}${dot(118, 78, own)}
        ${dot(203, 52, own)}${dot(216, 40, own)}
        ${dot(305, 92, enemy)}${dot(318, 80, enemy)}
        ${dot(30, 60, own)}${dot(390, 110, enemy)}
    </svg>`;
    return $("<div/>", { class: "at-pic at-pic-dom" }).append(
        $(svg),
        $("<div/>", { class: "at-dom-score" }).append(
            $("<span/>", { class: "at-dom-own", text: "182" }),
            $("<span/>", { class: "at-dom-limit", text: `first to ${DOMINATION_SCORE_LIMIT}` }),
            $("<span/>", { class: "at-dom-enemy", text: "141" }),
        ),
    );
}

/** Loadouts and kill streaks: the four picks, the streak tiers. */
function loadoutPicture() {
    const loadout = $("<div/>", { class: "at-feature" }).append(
        $("<div/>", { class: "at-feature-icons" }).append(
            tile("hk416", "Main"),
            tile("p30l", "Pistol"),
            tile("frag", "Throwable"),
            tile("takedown", "Perk"),
        ),
        $("<div/>", { class: "at-feature-name", text: "3 loadouts, switch when you die" }),
    );
    const streaks = $("<div/>", { class: "at-feature" }).append(
        $("<div/>", { class: "at-feature-icons" }).append(
            ...ARENA_STREAKS.map((t) => tile(t.options[0], `${t.kills} kills`)),
        ),
        $("<div/>", { class: "at-feature-name", text: "Kills in a row earn a bonus" }),
    );
    return $("<div/>", { class: "at-pic at-pic-col" }).append(loadout, streaks);
}

const PAGES: TutorialPage[] = [
    {
        id: "intro",
        title: "Welcome to Multiplayer",
        picture: introPicture,
        lines: (ctx) =>
            ctx.loadouts
                ? [
                    "Fast matches where you respawn - no looting, no circle.",
                    "You spawn with your own loadout and full adrenaline. Dead players drop their guns, pick them up for your slots.",
                    "Every match gives arena XP: level up to unlock guns and perks, or unlock them with weapon challenges.",
                ]
                : [
                    "Fast matches where you respawn - no looting, no circle.",
                    "Everyone gets their guns from the mode itself - the one with the best aim wins.",
                ],
    },
    {
        id: "gungame",
        mode: "gungame",
        title: "Gun Game",
        picture: gunGamePicture,
        lines: () => [
            "Everyone for themselves. Every kill gives you the next gun of the ladder.",
            "The last step is a melee weapon - the first one to get a melee kill with it wins.",
            `The match starts after a short warmup and lasts up to ${minutes(GUN_GAME_TIME_LIMIT_S)} minutes.`,
        ],
    },
    {
        id: "domination",
        mode: "domination",
        title: "Domination",
        picture: dominationPicture,
        lines: () => [
            "6 vs 6. Three zones - A, B and C. Stand in a zone to capture it (an enemy zone is neutralized first).",
            "Every zone your team holds gives points - more teammates in it, more points. Enemies in it stop that.",
            `First team to ${DOMINATION_SCORE_LIMIT} points wins (or the leader after ${minutes(DOMINATION_TIME_LIMIT_S)} minutes). Knocked teammates can be revived.`,
        ],
    },
    {
        id: "loadouts",
        loadouts: true,
        title: "Loadouts & Kill Streaks",
        picture: loadoutPicture,
        lines: () => [
            "Build up to 3 loadouts in Arena Loadouts - a main gun, a pistol, a throwable and a perk.",
            "Kills in a row without dying earn kill streaks: airdrops, Eagle Eye, the Juggernaut, air strikes. Press the kill streak key (5) to use one.",
            "Pick which kill streaks you want in the Killstreaks tab - or none at all.",
        ],
    },
];

/** The context for the arena modes playable right now (their mapNames). */
export function tutorialContext(modes: string[]): TutorialContext {
    const set = new Set(modes);
    return { modes: set, loadouts: ARENA_LOADOUT_MAPS.some((m) => set.has(m)) };
}

/** The pages for what's playable now (their ids). */
export function tutorialPages(ctx: TutorialContext): string[] {
    return PAGES.filter((p) => (!p.mode || ctx.modes.has(p.mode)) && (!p.loadouts || ctx.loadouts)).map((p) => p.id);
}

/**
 * A short tour of the multiplayer (arena) client - shown the first time someone
 * switches the main menu to it, and from the "How it works" link any time.
 */
export class ArenaTutorial {
    private backdrop = $("<div/>", { class: "arena-menu-backdrop at-backdrop" });
    private panel = $("<div/>", { class: "arena-menu at-panel" });
    private page = 0;
    private pages: TutorialPage[] = [];
    private ctx: TutorialContext = tutorialContext([]);

    constructor(private onOpenLoadouts: () => void) {
        // (no way around it: no close button, no click outside - through to the end)
        this.backdrop.append(this.panel).hide();
        $(document.body).append(this.backdrop);
    }

    /** Opens the tour with these pages (see tutorialPages) for what's playable. */
    open(ctx: TutorialContext, pageIds: string[]) {
        this.ctx = ctx;
        this.pages = PAGES.filter((p) => pageIds.includes(p.id));
        if (!this.pages.length) return;
        this.page = 0;
        this.render();
        this.backdrop.show();
    }

    close() {
        this.backdrop.hide();
    }

    private go(page: number) {
        this.page = Math.max(0, Math.min(this.pages.length - 1, page));
        this.render();
    }

    private render() {
        const p = this.pages[this.page];
        const last = this.page === this.pages.length - 1;
        this.panel.empty();
        this.panel.append(
            $("<div/>", { class: "arena-head" }).append(
                $("<h2/>", { text: p.title }),
                this.pages.length > 1 ? $("<span/>", { class: "at-step", text: `${this.page + 1} / ${this.pages.length}` }) : "",
            ),
            p.picture(this.ctx),
            $("<ul/>", { class: "at-lines" }).append(p.lines(this.ctx).map((l) => $("<li/>", { text: l }))),
        );
        const dots = $("<div/>", { class: "at-dots" });
        if (this.pages.length > 1) this.pages.forEach((_, i) => {
            dots.append($("<span/>", { class: `at-dot${i === this.page ? " at-dot-on" : ""}` }).on("click", () => this.go(i)));
        });
        const back = $("<a/>", { class: "btn-darken menu-option at-btn at-btn-back", text: "Back" }).on("click", () => this.go(this.page - 1));
        const next = last
            ? $("<a/>", { class: "btn-green btn-darken menu-option at-btn", text: "Let's play" }).on("click", () => this.close())
            : $("<a/>", { class: "btn-green btn-darken menu-option at-btn", text: "Next" }).on("click", () => this.go(this.page + 1));
        this.panel.append(
            $("<div/>", { class: "at-nav" }).append(
                this.page > 0 ? back : $("<span/>", { class: "at-btn-spacer" }),
                dots,
                next,
            ),
        );
        // the end: straight on to the loadouts, if they want
        if (last && this.ctx.loadouts) {
            this.panel.append(
                $("<a/>", { class: "at-skip", text: "Set up my loadouts first" }).on("click", () => {
                    this.close();
                    this.onOpenLoadouts();
                }),
            );
        }
    }
}
