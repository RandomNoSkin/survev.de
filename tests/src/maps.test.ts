import "./testHelpers.ts";
import fs from "node:fs";
import Path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { Atlases } from "../../client/atlas-builder/atlasDefs.ts";
import { AtlasManager, imageFolder } from "../../client/atlas-builder/atlasBuilder.ts";
import { type MapDef, type MapDefKey, MapDefs } from "../../shared/defs/mapDefs.ts";
import { GameMap } from "../../server/src/game/map.ts";
import { GameConfig } from "../../shared/gameConfig.ts";
import { Constants } from "../../shared/net/net.ts";
import { generateJaggedAabbPoints } from "../../shared/utils/terrainGen.ts";
import { getAllAtlasSprites, getAllMapSprites } from "./spriteHelpers.ts";

const maps = Object.keys(MapDefs);

describe("Atlas rebuild detection", () => {
    test("renaming a sprite file changes the atlas hash even when the bytes are identical", () => {
        const originalLoadout = Atlases.loadout;
        const manager = new AtlasManager();

        try {
            const realExists = fs.existsSync.bind(fs);
            const realRead = fs.readFileSync.bind(fs);

            vi.spyOn(fs, "existsSync").mockImplementation(() => true);
            vi.spyOn(fs, "readFileSync").mockImplementation(() => Buffer.from("same-content"));

            Atlases.loadout = {
                compress: false,
                images: [
                    "player/player-base-outfitTwilight.svg",
                    "player/player-base-outfitRuin.svg",
                ],
            };
            const twilightHash = manager.hashAtlas("loadout");

            Atlases.loadout = {
                compress: false,
                images: [
                    "player/player-base-outfitRuin.svg",
                    "player/player-base-outfitTwilight.svg",
                ],
            };
            const ruinHash = manager.hashAtlas("loadout");

            expect(twilightHash).not.toBe(ruinHash);
            expect(fs.existsSync).toHaveBeenCalled();
            expect(fs.readFileSync).toHaveBeenCalled();

            vi.restoreAllMocks();
            fs.existsSync = realExists;
            fs.readFileSync = realRead;
        } finally {
            Atlases.loadout = originalLoadout;
            vi.restoreAllMocks();
        }
    });
});

describe("Ground patch generation", () => {
    test("keeps AABB edges jagged instead of collapsing to a flat side", () => {
        const points = generateJaggedAabbPoints(
            {
                min: { x: 0, y: 0 },
                max: { x: 10, y: 18 },
            },
            0,
            0,
            0.7,
            () => 0.5,
        );

        expect(points.length).toBeGreaterThan(4);
        expect(points[1].x).not.toBe(points[0].x);
        expect(points[1].y).not.toBe(points[0].y);
    });
});

describe.for(maps)("Map %s", (map) => {
    const mapDef: MapDef = MapDefs[map as MapDefKey];

    describe("Loot Tables", () => {
        test.for(Object.entries(mapDef.lootTable))("Loot table $0", ([
            tableId,
            table,
        ]) => {
            const itemsSet = new Set();
            for (const item of table) {
                // Key on the full entry: same-name entries with different counts are a
                // valid weighted-quantity pattern (the game picks one entry by weight),
                // so only flag exact-duplicate entries (real copy-paste mistakes).
                itemsSet.add(`${item.name}:${item.count}:${item.weight}`);
                if (item.name.startsWith("tier_")) {
                    expect(item.name).toBeValidLootTier(mapDef.lootTable);
                } else if (item.name !== "") {
                    expect(item.name).toBeValidLoot();
                }
            }
            expect(itemsSet.size, "Loot table must not have duplicated items").toBe(
                table.length,
            );

            expect(tableId).toBeValidLootTier(mapDef.lootTable);
        });
    });

    describe("Airdrop Crates", () => {
        test.for(mapDef.gameConfig.planes.crates)("Crate %$", (crate) => {
            expect(crate.name).toBeValidMapObj();
        });
    });

    describe("Airdrop Images", () => {
        // if the map defines any SupplyDrop plane timing, it should provide a supplyImg
        test("supply chute defined when supply drops exist", () => {
            const timings = mapDef.gameConfig.planes.timings || [];
            const hasSupply = timings.some(
                (t) => t.options?.type === GameConfig.Plane.SupplyDrop,
            );
            if (hasSupply) {
                expect(mapDef.biome.airdrop.supplyImg).toBeDefined();
            }
        });
    });

    if (mapDef.gameConfig.unlocks) {
        describe("Unlocks", () => {
            test.for(mapDef.gameConfig.unlocks!.timings)("Unlock %$", (unlock) => {
                expect(unlock.type).toBeValidMapObj();
            });
        });
    }

    describe("Map Gen", () => {
        const mapGen = mapDef.mapGen;

        test("Map Size", () => {
            const map = mapGen.map;

            const widthSmall = map.baseWidth * map.scale.small + map.extension;
            const heightSmall = map.baseHeight * map.scale.small + map.extension;

            const widthLarge = map.baseWidth * map.scale.large + map.extension;
            const heightLarge = map.baseHeight * map.scale.large + map.extension;

            expect(widthSmall).toBeLessThanOrEqual(Constants.MaxPosition);
            expect(heightSmall).toBeLessThanOrEqual(Constants.MaxPosition);
            expect(widthLarge).toBeLessThanOrEqual(Constants.MaxPosition);
            expect(heightLarge).toBeLessThanOrEqual(Constants.MaxPosition);
        });

        test("Bridge Types", () => {
            expect(mapGen.bridgeTypes.medium).toBeValidMapObjOrNone();
            expect(mapGen.bridgeTypes.large).toBeValidMapObjOrNone();
            expect(mapGen.bridgeTypes.xlarge).toBeValidMapObjOrNone();
        });

        test.for(mapGen.customSpawnRules.placeSpawns)("Place Spawn %$", (spawn) => {
            expect(spawn).toBeValidMapObj();
        });

        test.for(mapGen.customSpawnRules.locationSpawns)("Location Spawn %$", (spawn) => {
            expect(spawn.type).toBeValidMapObj();
        });

        test.for(Object.entries(mapGen.densitySpawns[0]))("Density Spawn $0", ([key]) => {
            expect(key).toBeValidMapObj();
        });

        test.for(Object.entries(mapGen.fixedSpawns[0]))("Fixed Spawn $0", ([key]) => {
            expect(key).toBeValidMapObj();
        });

        test.for(
            mapGen.randomSpawns.map((p) => p.spawns).flat(),
        )("Random Spawn %0", (spawn) => {
            expect(spawn).toBeValidMapObj();
        });

        test.for(Object.entries(mapGen.spawnReplacements[0]))("Spawn Replacement $0", ([
            key,
        ]) => {
            expect(key).toBeValidMapObj();
        });

        test("Weighted replacements stop when they resolve to the same type", () => {
            const mapLike = {
                mapDef: {
                    mapGen: {
                        spawnReplacements: [{
                            club_complex_01: [
                                { type: "club_complex_01", weight: 0.4 },
                                { type: "reserve_structure_01", weight: 0.6 },
                            ],
                        }],
                    },
                },
            } as any;

            const randomSpy = vi.spyOn(Math, "random")
                .mockReturnValueOnce(0.1)
                .mockReturnValueOnce(0.9);

            try {
                const resolvedType = GameMap.prototype.resolveSpawnType.call(
                    mapLike,
                    "club_complex_01",
                );
                expect(resolvedType).toBe("club_complex_01");
            } finally {
                randomSpy.mockRestore();
            }
        });

        test("Place-spawn rules include all replacement variants", () => {
            const mapLike = {
                mapDef: {
                    mapGen: {
                        spawnReplacements: [{
                            club_complex_01: [
                                { type: "club_complex_01", weight: 0.4 },
                                { type: "reserve_structure_01", weight: 0.6 },
                            ],
                        }],
                    },
                },
            } as any;

            const variants = GameMap.prototype.getSpawnReplacementTypes.call(
                mapLike,
                "club_complex_01",
            );

            expect(variants).toEqual(["club_complex_01", "reserve_structure_01"]);
        });

        test.for(mapGen.importantSpawns)("Important Spawn $0", (spawn) => {
            expect(spawn).toBeValidMapObj();
        });
    });

    describe("No duplicated sprites", () => {
        const sprites = new Set<string>();

        test.for(mapDef.assets.atlases)("Atlas $0", (atlas) => {
            const atlasDef = Atlases[atlas];
            for (const sprite of atlasDef.images) {
                expect(sprites.has(sprite), `Duplicated sprite ${sprite}`).toBeFalsy();

                sprites.add(sprite);
            }
        });
    });

    test("Map has no missing sprites", () => {
        const atlasSprites = getAllAtlasSprites(map as MapDefKey);
        const mapSprites = getAllMapSprites(map as MapDefKey);

        const diff = mapSprites.difference(atlasSprites);

        expect(
            diff.size,
            `Map ${map} is missing ${[...diff].join(", ")} sprites on its atlases`,
        ).toBe(0);
    });
});
