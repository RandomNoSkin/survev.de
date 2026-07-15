import { and, eq, gte, sql } from "drizzle-orm";
import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import { PassDefs } from "../../../../shared/defs/gameObjects/passDefs";
import {
    BUNDLE_DISCOUNT,
    getItemCategory,
    getItemPrice,
    getShopWeight,
    SHARED_SHOP,
    type ShopCategory,
} from "../../../../shared/defs/shopConfig";
import { GameConfig } from "../../../../shared/gameConfig";
import type {
    BuyShopResponse,
    ShopOffer,
    ShopResponse,
} from "../../../../shared/types/user";
import { getGoldenFries } from "./goldenFries";
import { db } from "./index";
import {
    goldenFriesLedgerTable,
    itemsTable,
    shopPurchasesTable,
    usersTable,
} from "./schema";

//
// Pools
//

/** Every shoppable cosmetic (def.shop === true). Static; used in the bundle pool. */
const SHOP_POOL: string[] = Object.keys(GameObjectDefs).filter((type) => {
    const def = GameObjectDefs[type] as { shop?: boolean };
    return def?.shop === true && getItemCategory(type) !== null;
});

const BUNDLE_CATEGORIES: ShopCategory[] = ["outfit", "melee", "emote", "particle"];

/**
 * Cosmetics from passes whose season had already ended at `asOf`. Only these are
 * eligible for the shop, so current/future-season pass items stay exclusive to the
 * pass itself. `asOf` is the start of the current shop day, so the pool only changes
 * at the daily reset (never mid-day): a pass that ends during a day becomes shoppable
 * at the next server-midnight reset.
 */
function completedPassItems(asOf: number): string[] {
    const passes = GameConfig.serverSettings.passes;
    const items = new Set<string>();
    for (const [passType, passDef] of Object.entries(PassDefs)) {
        const cfg = passes[passType];
        if (!cfg || new Date(cfg.seasonEnd).getTime() >= asOf) continue; // not ended yet
        for (const it of passDef.items) {
            if (it.item && getItemCategory(it.item) !== null) items.add(it.item);
        }
    }
    return [...items];
}

/** Bundle category → pool of types (completed-pass items ∪ shop items in that category). */
function poolForCategory(category: ShopCategory, passItems: string[]): string[] {
    const set = new Set<string>();
    for (const type of [...SHOP_POOL, ...passItems]) {
        if (getItemCategory(type) === category && getItemPrice(type) > 0) set.add(type);
    }
    return [...set];
}

//
// Deterministic per-(user, day) RNG → stable offers that reset at the API server's
// local midnight (00:00 server time, not UTC).
//

function serverDay(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`; // YYYY-MM-DD in the server's local timezone
}

/** Epoch ms of the start (00:00 server-local) of a "YYYY-MM-DD" shop day. */
function startOfServerDay(day: string): number {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
}

/** Epoch ms of the next server-local midnight — when the daily shop rolls over. */
function nextServerMidnight(): number {
    const now = new Date();
    return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        0,
        0,
    ).getTime();
}

function hashSeed(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Weighted random pick from a list of item types: rarer items are less likely to be
 * chosen (weight from getShopWeight). Deterministic given the seeded `rng`.
 */
function pick(rng: () => number, types: string[]): string | undefined {
    if (types.length === 0) return undefined;
    let total = 0;
    for (const t of types) total += getShopWeight(t);
    let r = rng() * total;
    for (const t of types) {
        r -= getShopWeight(t);
        if (r < 0) return t;
    }
    return types[types.length - 1]; // float-rounding safety net
}

function toItem(type: string) {
    return { type, price: getItemPrice(type) };
}

/** Builds today's two offers for a user (deterministic; `purchased` filled later). */
function generateDailyOffers(userId: string, day: string): ShopOffer[] {
    // SHARED_SHOP → seed by day only, so every player sees the same offers today.
    const seedKey = SHARED_SHOP ? day : `${userId}:${day}`;
    const rng = mulberry32(hashSeed(seedKey));
    const offers: ShopOffer[] = [];
    const passItems = completedPassItems(startOfServerDay(day));

    // Slot 0 — single random completed-pass cosmetic.
    const single = pick(rng, [...passItems, ...SHOP_POOL]);
    if (single) {
        const item = toItem(single);
        offers.push({ slot: 0, items: [item], price: item.price, purchased: false });
    }

    // Slot 1 — bundle: one item per category (skin/melee/emote/particle).
    const bundleItems = BUNDLE_CATEGORIES.map((cat) =>
        pick(rng, poolForCategory(cat, [...passItems, ...SHOP_POOL])),
    )
        .filter((t): t is string => !!t)
        .map(toItem);
    if (bundleItems.length > 0) {
        const sum = bundleItems.reduce((acc, it) => acc + it.price, 0);
        offers.push({
            slot: 1,
            items: bundleItems,
            price: Math.round(sum * BUNDLE_DISCOUNT),
            purchased: false,
        });
    }

    return offers;
}

/**
 * The cosmetic types a given (user, day, slot) shop offer grants. Deterministic, so
 * the moderation revert can identify which item instances a shop purchase created
 * (they carry `source: "shop:<day>"`). Empty if the slot has no offer.
 */
export function shopOfferItemTypes(userId: string, day: string, slot: number): string[] {
    const offer = generateDailyOffers(userId, day).find((o) => o.slot === slot);
    return offer ? offer.items.map((it) => it.type) : [];
}

/** Today's shop for a user: offers (with `purchased` flags) + current balance. */
export async function getShopForUser(userId: string): Promise<ShopResponse> {
    const day = serverDay();
    const offers = generateDailyOffers(userId, day);

    const [purchased, balance] = await Promise.all([
        db
            .select({ slot: shopPurchasesTable.slot })
            .from(shopPurchasesTable)
            .where(
                and(eq(shopPurchasesTable.userId, userId), eq(shopPurchasesTable.day, day)),
            ),
        getGoldenFries(userId),
    ]);
    const boughtSlots = new Set(purchased.map((p) => p.slot));
    for (const offer of offers) offer.purchased = boughtSlots.has(offer.slot);

    return { success: true, day, resetTime: nextServerMidnight(), balance, offers };
}

class ShopError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

/**
 * Buys a daily shop offer: regenerates the offer server-side (never trusts the
 * client), then atomically records the purchase, deducts Golden Fries (+ledger),
 * and adds the item instance(s) with source `shop:<day>`. Idempotent per slot/day.
 */
export async function buyShopOffer(
    userId: string,
    slot: number,
): Promise<BuyShopResponse> {
    const day = serverDay();
    const offer = generateDailyOffers(userId, day).find((o) => o.slot === slot);
    if (!offer || offer.items.length === 0) {
        return { success: false, error: "invalid_slot", balance: await getGoldenFries(userId) };
    }

    try {
        const balance = await db.transaction(async (tx) => {
            // Reject double-buy: PK (userId, day, slot) makes this insert the lock.
            const [purchase] = await tx
                .insert(shopPurchasesTable)
                .values({ userId, day, slot })
                .onConflictDoNothing()
                .returning({ slot: shopPurchasesTable.slot });
            if (!purchase) throw new ShopError("already_purchased");

            // Deduct fries only if the balance covers it (atomic guard).
            const [bal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} - ${offer.price}` })
                .where(
                    and(eq(usersTable.id, userId), gte(usersTable.goldenFries, offer.price)),
                )
                .returning({ balance: usersTable.goldenFries });
            if (!bal) throw new ShopError("insufficient_funds");

            await tx.insert(goldenFriesLedgerTable).values({
                userId,
                amount: -offer.price,
                reason: `shop:${day}:${slot}`,
                balanceAfter: bal.balance,
            });

            const now = Date.now();
            await tx.insert(itemsTable).values(
                offer.items.map((it) => ({
                    userId,
                    type: it.type,
                    source: `shop:${day}`,
                    timeAcquired: now,
                })),
            );

            return bal.balance;
        });

        return { success: true, balance };
    } catch (err) {
        const error = err instanceof ShopError ? err.code : "error";
        return { success: false, error, balance: await getGoldenFries(userId) };
    }
}
