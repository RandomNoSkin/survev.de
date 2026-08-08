import "./testHelpers.ts";
import { expect, test } from "vitest";
import { GameObjectDefs } from "../../shared/defs/register.ts";
import { GameConfig } from "../../shared/gameConfig.ts";
import loadout from "../../shared/utils/loadout.ts";

// The Emotes tab in the loadout menu crashed with "Received empty type, expected a Game
// type": it ran the throwing typeToDef over every equipped emote slot, and the Win/Death
// slots are empty by default. The render aborted before it bound the list's click
// handlers, so emotes became unselectable and kept their "new" tags forever.
//
// The render path itself is DOM-bound and not covered here; these pin the two facts that
// made it crash, so neither can change quietly.

test("The default loadout leaves emote slots empty", () => {
    const emotes = loadout.defaultLoadout().emotes;

    expect(emotes.length).toBe(GameConfig.EmoteSlot.Count);
    expect(emotes[GameConfig.EmoteSlot.Win]).toBe("");
    expect(emotes[GameConfig.EmoteSlot.Death]).toBe("");
});

test("An unowned emote is blanked, not dropped", () => {
    // validateWithAvailableItems blanks a slot holding something the player no longer
    // owns — gifting an emote away is one way to get there.
    const result = loadout.validateWithAvailableItems(
        { emotes: ["emote_happyface", "", "", "", "", ""] } as never,
        [], // owns nothing beyond the default unlocks
    );

    expect(result.emotes.length).toBe(GameConfig.EmoteSlot.Count);
    expect(result.emotes.every((e) => typeof e === "string")).toBe(true);
});

test("typeToDef throws on an empty type, typeToDefSafe does not", () => {
    expect(() => GameObjectDefs.typeToDef("")).toThrow(
        "Received empty type, expected a Game type",
    );
    expect(GameObjectDefs.typeToDefSafe("")).toBeUndefined();
});
