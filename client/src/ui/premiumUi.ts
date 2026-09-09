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
    ];
}

/** The Shop's "Premium" tab: shows current status and lets the player buy/extend it. */
export class PremiumUi {
    body = $("#shop-premium");
    buying = false;

    constructor(
        public account: Account,
        public localization: Localization,
    ) {}

    /** Called by ShopUi when the Premium tab becomes visible. */
    activate() {
        this.render();
    }

    /** Called by ShopUi when leaving the Premium tab / closing the shop. */
    deactivate() {}

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

        const btn = $(
            '<div class="premium-buy-btn">' +
                `<span>${active ? "Extend by 2 months" : "Buy Premium — 2 months"}</span>` +
                '<div class="premium-buy-price">' +
                '<div class="shop-fries-icon"></div>' +
                `<span>${PREMIUM_COST_FRIES}</span>` +
                "</div>" +
                "</div>",
        );
        btn.on("click", () => this.buy(btn));
        card.append(btn);

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
    }

    private buy(btn: JQuery<HTMLElement>) {
        if (this.buying) return;
        this.buying = true;
        const label = btn.find("span").first();
        btn.addClass("shop-buy-disabled");
        label.text("…");
        this.account.buyPremium((err, res?: BuyPremiumResponse) => {
            this.buying = false;
            if (err || !res || !res.success) {
                label.text(res?.error === "insufficient_funds" ? "Too poor" : "Error");
                setTimeout(() => this.render(), 900);
                return;
            }
            this.render();
        });
    }
}
