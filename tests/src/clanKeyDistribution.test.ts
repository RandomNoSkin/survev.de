import { expect, test } from "vitest";
import { CLAN_REWARD_MIN_GAMES_EACH, suggestKeyDistribution } from "../../shared/utils/clan.ts";

const BEST_FIRST = ["key_airdrop", "key_soviet", "key_wooden"];

function byPlayer(gifts: ReturnType<typeof suggestKeyDistribution>) {
    const out: Record<string, Record<string, number>> = {};
    for (const g of gifts) (out[g.slug] ??= {})[g.keyType] = g.amount;
    return out;
}

test("best win rate first, best keys first, round and round", () => {
    const players = [
        { slug: "a", games: 20, wins: 4 }, // 20%
        { slug: "b", games: 10, wins: 5 }, // 50%
        { slug: "c", games: 8, wins: 2 }, // 25%
    ];
    const gifts = suggestKeyDistribution(players, { key_airdrop: 2, key_soviet: 3, key_wooden: 2 }, BEST_FIRST);
    // order b (50%), c (25%), a (20%): airdrop b, airdrop c, soviet a, soviet b, soviet c, wooden a, wooden b
    expect(byPlayer(gifts)).toStrictEqual({
        b: { key_airdrop: 1, key_soviet: 1, key_wooden: 1 },
        c: { key_airdrop: 1, key_soviet: 1 },
        a: { key_soviet: 1, key_wooden: 1 },
    });
    expect(gifts.reduce((n, g) => n + g.amount, 0)).toBe(7);
});

test(`players under ${CLAN_REWARD_MIN_GAMES_EACH} games get nothing, a win rate tie goes to more games`, () => {
    const players = [
        { slug: "lucky", games: CLAN_REWARD_MIN_GAMES_EACH - 1, wins: 4 },
        { slug: "few", games: 10, wins: 5 },
        { slug: "many", games: 20, wins: 10 },
    ];
    const gifts = byPlayer(suggestKeyDistribution(players, { key_airdrop: 1, key_wooden: 2 }, BEST_FIRST));
    expect(gifts.lucky).toBeUndefined();
    expect(gifts.many).toStrictEqual({ key_airdrop: 1, key_wooden: 1 });
    expect(gifts.few).toStrictEqual({ key_wooden: 1 });
});

test("nobody with enough games: no suggestion", () => {
    expect(suggestKeyDistribution([{ slug: "a", games: 2, wins: 2 }], { key_wooden: 3 }, BEST_FIRST)).toStrictEqual([]);
});
