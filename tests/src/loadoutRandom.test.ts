import { expect, test } from "vitest";
import { UnlockDefs } from "../../shared/defs/gameObjects/unlockDefs.ts";
import { GameObjectDefs } from "../../shared/defs/register.ts";
import { type Loadout, loadout } from "../../shared/utils/loadout.ts";

const outfits = GameObjectDefs.getAllTypes().filter((t) => GameObjectDefs.typeToDefSafe(t)?.type === "outfit").slice(0, 5);
const emotes = GameObjectDefs.getAllTypes().filter((t) => GameObjectDefs.typeToDefSafe(t)?.type === "emote").slice(0, 10);
const owned = [...outfits, ...emotes, ...UnlockDefs.unlock_default.unlocks];

test("random is kept through validation (unknown categories dropped)", () => {
    const l = loadout.validate({ ...loadout.defaultLoadout(), random: ["outfit", "outfit", "nonsense", "emote"] } as Loadout);
    expect(l.random).toStrictEqual(["outfit", "emote"]);
    // older saved loadouts without the field still validate
    expect(loadout.validate({} as Loadout).random).toStrictEqual([]);
});

test("randomize picks owned items of the right kind, and a different one when it can", () => {
    const base = { ...loadout.defaultLoadout(), outfit: outfits[0] };
    for (let i = 0; i < 30; i++) {
        const r = loadout.randomize(base, owned, ["outfit"]);
        expect(owned).toContain(r.outfit);
        expect(GameObjectDefs.typeToDefSafe(r.outfit)?.type).toBe("outfit");
        expect(r.outfit).not.toBe(outfits[0]);
        // other categories untouched
        expect(r.melee).toBe(base.melee);
    }
});

test("randomize with no slots uses the loadout's own random list; the emote wheel gets 6 different emotes", () => {
    const base = { ...loadout.defaultLoadout(), random: ["emote"] };
    const r = loadout.randomize(base, owned);
    expect(new Set(r.emotes).size).toBe(6);
    for (const e of r.emotes) expect(GameObjectDefs.typeToDefSafe(e)?.type).toBe("emote");
    expect(r.outfit).toBe(base.outfit);
});

test("nothing owned for a category: it stays as it is", () => {
    const base = loadout.defaultLoadout();
    expect(loadout.randomize(base, [], ["outfit", "melee"])).toStrictEqual(base);
});

test("skipped items are never picked; if everything is skipped it stays", () => {
    const base = { ...loadout.defaultLoadout(), outfit: outfits[0], randomExclude: [outfits[1], outfits[2]] };
    for (let i = 0; i < 40; i++) {
        const r = loadout.randomize(base, outfits, ["outfit"]);
        expect([outfits[1], outfits[2]]).not.toContain(r.outfit);
    }
    const all = { ...base, randomExclude: [...outfits] };
    expect(loadout.randomize(all, outfits, ["outfit"]).outfit).toBe(outfits[0]);
    // unknown types are dropped by validation
    expect(loadout.validate({ ...base, randomExclude: ["notAThing", outfits[1]] } as Loadout).randomExclude).toStrictEqual([outfits[1]]);
});
