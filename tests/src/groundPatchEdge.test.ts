import { expect, test } from "vitest";
import { RawMapObjectDefs } from "../../shared/defs/mapObjectDefs.ts";
import { TeamMode } from "../../shared/gameConfig.ts";
import * as net from "../../shared/net/net.ts";
import { collider } from "../../shared/utils/collider.ts";
import { v2 } from "../../shared/utils/v2.ts";
import { createGame } from "./gameTestHelpers.ts";

/** Buildings with a ground patch of the given shape. */
function buildingsWithPatch(type: number): string[] {
    return Object.entries(RawMapObjectDefs as Record<string, any>)
        .filter(([, def]) => def.type === "building" && def.mapGroundPatches?.some((p: any) => p.bound.type === type))
        .map(([name]) => name);
}

test("A building whose ground patch sticks out of the map doesn't crash map serialization", () => {
    const game = createGame(TeamMode.Solo, "main");
    const types = [buildingsWithPatch(collider.Type.Aabb)[0], buildingsWithPatch(collider.Type.Circle)[0]].filter(Boolean);
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
        // right at the corner: the patch reaches into negative coordinates
        game.map.genBuilding(type, v2.create(1, 1), 0, 0);
        game.map.genBuilding(type, v2.create(game.map.width - 1, game.map.height - 1), 0, 2);
    }

    // used to throw "writeFloat: value out of range" while building the map
    const stream = new net.MsgStream(new ArrayBuffer(1 << 21));
    expect(() => stream.serializeMsg(net.MsgType.Map, game.map.msg)).not.toThrow();
    for (const patch of game.map.msg.groundPatches) {
        const b = patch.bound as any;
        const pts = b.type === collider.Type.Circle ? [b.pos] : [b.min, b.max];
        for (const p of pts) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(game.map.width);
            expect(p.y).toBeLessThanOrEqual(game.map.height);
        }
    }
});

test("canSpawn rejects a circular ground patch over the map edge", () => {
    const game = createGame(TeamMode.Solo, "main");
    const type = buildingsWithPatch(collider.Type.Circle)[0];
    expect(type).toBeTruthy();
    expect(game.map.canSpawn(type, v2.create(1, 1), 0)).toBe(false);
});
