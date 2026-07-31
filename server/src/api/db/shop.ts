import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import { PassDefs } from "../../../../shared/defs/gameObjects/passDefs";
import {
    BUNDLE_DEATH_EFFECT_CHANCE,
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
const SHOP_POOL: string[] = GameObjectDefs.getAllTypes().filter((type) => {
    const def = GameObjectDefs.typeToDefSafe(type) as { shop?: boolean };
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

//
// Weekly rotation. A shop week runs Monday 00:00 → Sunday 23:59:59 (server-local), so it
// rolls at a midnight the daily rotation rolls at too.
//

/** Slots 2 and 3 belong to the weekly rotation; 0 and 1 to the daily one. The slot id is
 *  what decides which period a purchase is keyed by, so these ids must stay stable. */
export function isWeeklySlot(slot: number): boolean {
    return slot === 2 || slot === 3;
}

/** Epoch ms of the Monday 00:00 (server-local) starting the week that contains `t`. */
function startOfServerWeek(t: number): number {
    const d = new Date(t);
    const daysSinceMonday = (d.getDay() + 6) % 7; // getDay(): 0=Sun … 6=Sat
    return new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate() - daysSinceMonday,
    ).getTime();
}

/**
 * Key of the current shop week: "w" + the date of its Monday, e.g. "w2026-07-13". The
 * prefix keeps week keys from ever colliding with day keys — both share the purchases
 * table, the ledger reason (`shop:<key>:<slot>`) and the item source (`shop:<key>`).
 */
function serverWeek(): string {
    const d = new Date(startOfServerWeek(Date.now()));
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `w${d.getFullYear()}-${m}-${day}`;
}

/** Epoch ms of the start (Monday 00:00 server-local) of a "wYYYY-MM-DD" shop week. */
function startOfWeekKey(week: string): number {
    return startOfServerDay(week.replace(/^w/, ""));
}

/** Epoch ms when the weekly shop rolls: the midnight right after Sunday 23:59:59. Steps
 *  by calendar days rather than 7×24h so a DST switch can't shift the reset by an hour. */
function nextWeekReset(): number {
    const d = new Date(startOfServerWeek(Date.now()));
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
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

/**
 * Builds one period's two offers (a single cosmetic + a four-item bundle) from a seeded
 * `rng`. Shared by the daily and the weekly rotation, which differ only in seed, pool and
 * slot ids.
 *
 * The order of `rng` draws is load-bearing: `shopOfferItemTypes` replays the generators for
 * a PAST period to work out which items a purchase granted (moderation revert). Existing
 * draws must keep their position in the stream — anything new is appended at the end,
 * never spliced in between.
 */
function buildOffers(
    rng: () => number,
    pool: string[],
    singleSlot: number,
    bundleSlot: number,
): ShopOffer[] {
    const offers: ShopOffer[] = [];

    // A single random cosmetic.
    const single = pick(rng, pool);
    if (single) {
        const item = toItem(single);
        offers.push({ slot: singleSlot, items: [item], price: item.price, purchased: false });
    }

    // Bundle: one item per category (skin/melee/emote/particle).
    const bundleTypes = BUNDLE_CATEGORIES.map((cat) =>
        pick(rng, poolForCategory(cat, pool)),
    ).filter((t): t is string => !!t);

    // A death effect may take the place of one of those four, keeping the bundle at four
    // items. Dormant while no ended pass holds a death effect — which is also what keeps
    // pre-existing days resolving exactly as they did before the swap existed.
    const deathPool = poolForCategory("death_effect", pool);
    if (bundleTypes.length && deathPool.length && rng() < BUNDLE_DEATH_EFFECT_CHANCE) {
        const death = pick(rng, deathPool);
        if (death) bundleTypes[Math.floor(rng() * bundleTypes.length)] = death;
    }

    if (bundleTypes.length > 0) {
        const bundleItems = bundleTypes.map(toItem);
        const sum = bundleItems.reduce((acc, it) => acc + it.price, 0);
        offers.push({
            slot: bundleSlot,
            items: bundleItems,
            price: Math.round(sum * BUNDLE_DISCOUNT),
            purchased: false,
        });
    }

    return offers;
}

/** Today's offers for a user — slot 0 single, slot 1 bundle (`purchased` filled later). */
export function generateDailyOffers(userId: string, day: string): ShopOffer[] {
    // SHARED_SHOP → seed by day only, so every player sees the same offers today.
    const seedKey = SHARED_SHOP ? day : `${userId}:${day}`;
    const rng = mulberry32(hashSeed(seedKey));
    const pool = [...completedPassItems(startOfServerDay(day)), ...SHOP_POOL];
    return buildOffers(rng, pool, 0, 1);
}

/**
 * This week's offers for a user — slot 2 single, slot 3 bundle. Same shape as the daily
 * rotation but seeded by the week key, so it holds still from Monday 00:00 until the
 * Sunday-23:59:59 reset. The pass pool is frozen at the start of the week, mirroring how
 * the daily pool never shifts mid-day.
 */
export function generateWeeklyOffers(userId: string, week: string): ShopOffer[] {
    const seedKey = SHARED_SHOP ? week : `${userId}:${week}`;
    const rng = mulberry32(hashSeed(seedKey));
    const pool = [...completedPassItems(startOfWeekKey(week)), ...SHOP_POOL];
    return buildOffers(rng, pool, 2, 3);
}

/**
 * The cosmetic types a given (user, period key, slot) shop offer grants. Deterministic, so
 * the moderation revert can identify which item instances a shop purchase created (they
 * carry `source: "shop:<key>"`). The slot decides whether `key` is a day or a week key.
 * Empty if the slot has no offer.
 */
export function shopOfferItemTypes(userId: string, key: string, slot: number): string[] {
    const offers = isWeeklySlot(slot)
        ? generateWeeklyOffers(userId, key)
        : generateDailyOffers(userId, key);
    const offer = offers.find((o) => o.slot === slot);
    return offer ? offer.items.map((it) => it.type) : [];
}

/** The shop for a user: today's + this week's offers (with `purchased` flags) + balance. */
export async function getShopForUser(userId: string): Promise<ShopResponse> {
    const day = serverDay();
    const week = serverWeek();
    const offers = [
        ...generateDailyOffers(userId, day),
        ...generateWeeklyOffers(userId, week),
    ];

    const [purchased, balance] = await Promise.all([
        db
            .select({ day: shopPurchasesTable.day, slot: shopPurchasesTable.slot })
            .from(shopPurchasesTable)
            .where(
                and(
                    eq(shopPurchasesTable.userId, userId),
                    inArray(shopPurchasesTable.day, [day, week]),
                ),
            ),
        getGoldenFries(userId),
    ]);
    const bought = new Set(purchased.map((p) => `${p.day}:${p.slot}`));
    for (const offer of offers) {
        const key = isWeeklySlot(offer.slot) ? week : day;
        offer.purchased = bought.has(`${key}:${offer.slot}`);
    }

    return {
        success: true,
        day,
        week,
        resetTime: nextServerMidnight(),
        weeklyResetTime: nextWeekReset(),
        balance,
        offers,
    };
}

class ShopError extends Error {
    constructor(public code: string) {
        super(code);
    }
}

/**
 * Buys a shop offer: regenerates the offer server-side (never trusts the client), then
 * atomically records the purchase, deducts Golden Fries (+ledger), and adds the item
 * instance(s) with source `shop:<key>`. The slot picks the rotation — daily (slots 0/1,
 * keyed by the day) or weekly (slots 2/3, keyed by the week). Idempotent per key/slot.
 */
export async function buyShopOffer(
    userId: string,
    slot: number,
): Promise<BuyShopResponse> {
    const weekly = isWeeklySlot(slot);
    const key = weekly ? serverWeek() : serverDay();
    const offer = (
        weekly ? generateWeeklyOffers(userId, key) : generateDailyOffers(userId, key)
    ).find((o) => o.slot === slot);
    if (!offer || offer.items.length === 0) {
        return {
            success: false,
            error: "invalid_slot",
            balance: await getGoldenFries(userId),
        };
    }

    try {
        const balance = await db.transaction(async (tx) => {
            // Reject double-buy: PK (userId, day, slot) makes this insert the lock.
            const [purchase] = await tx
                .insert(shopPurchasesTable)
                .values({ userId, day: key, slot })
                .onConflictDoNothing()
                .returning({ slot: shopPurchasesTable.slot });
            if (!purchase) throw new ShopError("already_purchased");

            // Deduct fries only if the balance covers it (atomic guard).
            const [bal] = await tx
                .update(usersTable)
                .set({ goldenFries: sql`${usersTable.goldenFries} - ${offer.price}` })
                .where(
                    and(
                        eq(usersTable.id, userId),
                        gte(usersTable.goldenFries, offer.price),
                    ),
                )
                .returning({ balance: usersTable.goldenFries });
            if (!bal) throw new ShopError("insufficient_funds");

            await tx.insert(goldenFriesLedgerTable).values({
                userId,
                amount: -offer.price,
                reason: `shop:${key}:${slot}`,
                balanceAfter: bal.balance,
            });

            const now = Date.now();
            // Split the offer's actual (possibly bundle-discounted) price across its items
            // by relative shop value, so each instance records what was paid for it.
            const priceSum = offer.items.reduce((s, it) => s + it.price, 0) || 1;
            await tx.insert(itemsTable).values(
                offer.items.map((it) => ({
                    userId,
                    type: it.type,
                    source: `shop:${key}`,
                    timeAcquired: now,
                    pricePaid: Math.round((offer.price * it.price) / priceSum),
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
