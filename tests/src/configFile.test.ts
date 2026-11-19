import { describe, expect, test } from "vitest";
import { cleanModes, writeConfigText } from "../../server/src/utils/configFile.ts";
import { GameMode, TeamMode } from "../../shared/gameConfig.ts";

describe("config editor (super admin)", () => {
    test("a mode list is checked entry by entry; arena modes keep their game mode and flag", () => {
        const { modes, error } = cleanModes([
            { mapName: "comp", teamMode: TeamMode.Squad, enabled: true, junk: 1 },
            { mapName: "domination", teamMode: TeamMode.Squad, gameMode: GameMode.Domination, arena: true, enabled: false },
        ]);
        expect(error).toBeUndefined();
        expect(modes).toStrictEqual([
            { mapName: "comp", teamMode: TeamMode.Squad, enabled: true },
            { mapName: "domination", teamMode: TeamMode.Squad, gameMode: GameMode.Domination, arena: true, enabled: false },
        ]);
        expect(cleanModes([{ mapName: "nope", teamMode: 1, enabled: true }]).error).toMatch(/unknown map/);
        expect(cleanModes([{ mapName: "comp", teamMode: 3, enabled: true }]).error).toMatch(/team mode/);
        expect(cleanModes([{ mapName: "comp", teamMode: 1, gameMode: 99, enabled: true }]).error).toMatch(/game mode/);
        expect(cleanModes([{ mapName: "comp", teamMode: 1, enabled: false }]).error).toMatch(/at least one/);
        expect(cleanModes([]).error).toBeDefined();
    });

    test("a config file that doesn't parse (or has a broken mode list) is refused - nothing written", async () => {
        expect((await writeConfigText("{ modes: [ ")).ok).toBe(false);
        expect((await writeConfigText("")).ok).toBe(false);
        expect((await writeConfigText("[1, 2]")).ok).toBe(false);
        const bad = await writeConfigText("{ \"modes\": [ { \"mapName\": \"nope\", \"teamMode\": 1, \"enabled\": true } ] }");
        expect(bad.ok).toBe(false);
        expect(bad.error).toMatch(/unknown map/);
    });
});
