import "./testHelpers.ts";
import { expect, test } from "vitest";
import { MapId } from "../../shared/gameConfig.ts";

// MapId values are persisted as raw integers in match_data/ip_logs (see
// server/src/api/db/schema.ts) and in old replays. Renumbering an existing entry silently
// reclassifies every historical row stored under the old value - this already happened once:
// the upstream merge in 6780659a re-typed this enum in a different order and swapped years
// of Comp/2v2 stats with each other. New maps must be appended at the end (before Custom
// stays last); this test pins the current mapping so a reorder fails CI instead of prod.
test("MapId values never change for existing entries", () => {
    expect(MapId).toMatchObject({
        Main: 0,
        Desert: 1,
        Woods: 2,
        Faction: 3,
        Potato: 4,
        Savannah: 5,
        Halloween: 6,
        Cobalt: 7,
        Birthday: 8,
        Beach: 9,
        TwoVsTwo: 10,
        FourVsFour: 11,
        Comp: 12,
        Scrims: 13,
        CompDuo: 14,
        CompSolo: 15,
        Local: 16,
        Custom: 17,
    });
});
