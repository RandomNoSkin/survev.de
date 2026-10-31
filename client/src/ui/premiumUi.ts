import $ from "jquery";
import { PassDefs } from "../../../shared/defs/gameObjects/passDefs";
import { GameConfig } from "../../../shared/gameConfig";
import type { BuyPremiumResponse } from "../../../shared/types/user";
import type { Account } from "../account";
import type { Localization } from "./localization";

const PREMIUM_COST_FRIES = 3000;
const PREMIUM_BONUS_PASS_LEVELS = 20;
const KOFI_URL = "https://ko-fi.com/survevde";

/** Mirrors the server's `xpForLevels()` (server/src/api/db/premium.ts) so the exact XP
 *  amount can be shown here without a round trip — both read from the same shared
 *  PassDefs. */
function xpForLevels(passType: string, levels: number): number {
    const passDef = PassDefs[passType as keyof typeof PassDefs];
    let total = 0;
    for (let lvl = 1; lvl < levels; lvl++) {
        const levelIdx = lvl - 1;
        total +=
            levelIdx < passDef.xp.length
                ? passDef.xp[levelIdx]
                : passDef.xp[passDef.xp.length - 1];
    }
    return total;
}

function premiumBenefits(): { icon: string; text: string }[] {
    const bonusXp = xpForLevels(GameConfig.serverSettings.currentPass, PREMIUM_BONUS_PASS_LEVELS);
    return [
        { icon: "✦", text: "Golden <b>[PREM]</b> tag everywhere your name is shown!" },
        { icon: "▶", text: "Full replay access to every game you've played (your own POV)" },
        {
            icon: "⚡",
            text: `Instant boost of <b>${bonusXp.toLocaleString()} XP</b> (${PREMIUM_BONUS_PASS_LEVELS} Battle Pass levels' worth), every time you buy or extend`,
        },
        { icon: "🎁", text: "Two Premium-only cosmetic offers unlocked in the Deals tab" },
        { icon: "🗺", text: "<b>Custom maps</b> in your private lobbies: size, buildings, loot pools, zone, airdrops and more" },
        { icon: "🔫", text: "<b>Custom weapon stats</b> in your private lobbies: damage, fire rate, magazine, reload..." },
        { icon: "📊", text: "<b>Detailed stats</b> on your profile, visible to everyone: weapon stats, accuracy, K/D, placement, modes and maps, by day, week, month, year or season" },
    ];
}

/** The Shop's "Premium" tab: shows current status and lets the player buy/extend it. */
export class PremiumUi {
    body = $("#shop-premium");
    buying = false;
    /** Set right after a purchase: shown instead of the buy button, so it's obvious it
     *  went through and nobody buys twice by accident. */
    private justBought: { until: number; xp: number } | null = null;
    /** The "you already have Premium - extend?" step is showing. */
    private confirming = false;

    constructor(
        public account: Account,
        public localization: Localization,
    ) {}

    /** Called by ShopUi when the Premium tab becomes visible. */
    activate() {
        this.render();
    }

    /** Called by ShopUi when leaving the Premium tab / closing the shop. */
    deactivate() {
        this.justBought = null;
        this.confirming = false;
    }

    private isActive(): boolean {
        const until = this.account.profile.premiumUntil;
        return until != null && until > Date.now();
    }

    private render() {
        this.body.empty();
        const until = this.account.profile.premiumUntil;
        const active = this.isActive();

        const card = $('<div class="premium-card"></div>');

        card.append('<div class="premium-crown"></div>');
        card.append('<div class="premium-badge">PREMIUM</div>');

        card.append(
            `<div class="premium-status${active ? " premium-status-active" : ""}">` +
                (active
                    ? `Active until ${new Date(until!).toLocaleDateString()}`
                    : "Not active")
                + "</div>",
        );

        const list = $('<ul class="premium-benefits"></ul>');
        for (const b of premiumBenefits()) {
            list.append(
                `<li class="premium-benefit">` +
                    `<span class="premium-benefit-icon">${b.icon}</span>` +
                    `<span>${b.text}</span>` +
                    `</li>`,
            );
        }
        card.append(list);

        if (this.justBought) {
            // it went through: say so, loudly, instead of offering the button again
            const done = $(
                '<div class="premium-done">' +
                    '<div class="premium-done-title">✓ Premium is active!</div>' +
                    `<div>Until <b>${new Date(this.justBought.until).toLocaleDateString()}</b> · +${this.justBought.xp.toLocaleString()} XP added to your pass</div>` +
                    "</div>",
            );
            const ok = $('<div class="premium-done-ok">Got it</div>').on("click", () => {
                this.justBought = null;
                this.render();
            });
            done.append(ok);
            card.append(done);
        } else if (this.confirming && active) {
            // already Premium: make sure they really want to pay again
            const extendedTo = new Date(until!);
            extendedTo.setMonth(extendedTo.getMonth() + 2);
            const box = $(
                '<div class="premium-confirm">' +
                    `<div>You already have Premium until <b>${new Date(until!).toLocaleDateString()}</b>.</div>` +
                    `<div>Buy again for <b>${PREMIUM_COST_FRIES}</b> Golden Fries to extend it to about <b>${extendedTo.toLocaleDateString()}</b>?</div>` +
                    "</div>",
            );
            const row = $('<div class="premium-confirm-row"></div>');
            const yes = $('<div class="premium-buy-btn premium-confirm-yes"><span>Yes, extend</span></div>');
            const no = $('<div class="premium-confirm-no">Cancel</div>');
            yes.on("click", () => this.buy(yes));
            no.on("click", () => {
                this.confirming = false;
                this.render();
            });
            row.append(no, yes);
            box.append(row);
            card.append(box);
        } else {
            const btn = $(
                '<div class="premium-buy-btn">' +
                    `<span>${active ? "Extend by 2 months" : "Buy Premium — 2 months"}</span>` +
                    '<div class="premium-buy-price">' +
                    '<div class="shop-fries-icon"></div>' +
                    `<span>${PREMIUM_COST_FRIES}</span>` +
                    "</div>" +
                    "</div>",
            );
            btn.on("click", () => {
                if (active) {
                    this.confirming = true;
                    this.render();
                } else {
                    this.buy(btn);
                }
            });
            card.append(btn);
        }

        card.append(
            '<div class="premium-note">Buying while already active extends your ' +
                "remaining time by 2 months instead of resetting it.</div>",
        );

        card.append('<div class="premium-divider">or</div>');
        card.append(
            `<a class="premium-kofi-btn" href="${KOFI_URL}" target="_blank" rel="noopener">` +
                '<div class="premium-kofi-icon"></div>' +
                "<span>Support us on Ko-fi</span>" +
                "</a>",
        );
        card.append(
            '<div class="premium-note">Donors also receive a Premium account — ' +
                "just reach out after your donation.</div>",
        );

        this.body.append(card);
        // the result / the question sits below the benefits list - bring it into view
        const focus = card.find(".premium-done, .premium-confirm")[0];
        if (focus) requestAnimationFrame(() => focus.scrollIntoView({ block: "center", behavior: "smooth" }));
    }

    private buy(btn: JQuery<HTMLElement>) {
        if (this.buying) return;
        this.buying = true;
        const label = btn.find("span").first();
        btn.addClass("shop-buy-disabled");
        label.text("…");
        this.account.buyPremium((err, res?: BuyPremiumResponse) => {
            this.buying = false;
            this.confirming = false;
            if (err || !res || !res.success) {
                label.text(res?.error === "insufficient_funds" ? "Not enough Golden Fries" : "Something went wrong - try again");
                setTimeout(() => this.render(), 1800);
                return;
            }
            // show the new state right away (the profile reload follows)
            if (res.premiumUntil) this.account.profile.premiumUntil = res.premiumUntil;
            this.account.profile.goldenFries = res.balance;
            $("#shop-balance-amount, #golden-fries-amount").text(res.balance);
            this.justBought = {
                until: res.premiumUntil ?? this.account.profile.premiumUntil ?? Date.now(),
                xp: xpForLevels(GameConfig.serverSettings.currentPass, PREMIUM_BONUS_PASS_LEVELS),
            };
            this.render();
        });
    }
}
