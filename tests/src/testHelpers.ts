import { expect } from "vitest";

import type { GameObjectDef } from "../../shared/defs/gameObjectDefs.ts";

import type { Player } from "../../server/src/game/objects/player.ts";
import type { MapObjectDef } from "../../shared/defs/mapObjectsTyping.ts";
import { Main } from "../../shared/defs/maps/baseDefs.ts";
import { GameObjectDefs, MapObjectDefs } from "../../shared/defs/register.ts";

interface GameTestHelpers<R = unknown> {
    toBeInRange: (value: { min: number; max: number }) => R;

    toBeValidMapObj: (type?: MapObjectDef["type"]) => R;
    toBeValidMapObjOrNone: (type?: MapObjectDef["type"]) => R;
    toBeValidGameObj: (type?: GameObjectDef["type"]) => R;
    toBeValidLoot: (type?: GameObjectDef["type"]) => R;
    toBeValidLootTier: (lootTable?: Record<string, unknown>) => R;

    toBeSamePlayer: (obj?: Player) => R;
}

declare module "vitest" {
    interface Assertion<T = any> extends GameTestHelpers<T> {}
    interface AsymmetricMatchersContaining extends GameTestHelpers {}
}

expect.extend({
    toBeInRange: (received: number, expected: { min: number; max: number }) => {
        if (received > expected.max || received < expected.min) {
            return {
                message: () => `Expected ${received} to be a in range [${expected.min}, ${expected.max}]`,
                pass: false,
            };
        }

        return { pass: true, message: () => "" };
    },

    toBeValidMapObj: (received, expected) => {
        if (!MapObjectDefs.typeExists(received)) {
            return {
                message: () => `Expected '${received}' to be a valid map object type`,
                pass: false,
            };
        }

        if (expected) {
            const def = MapObjectDefs.typeToDef(received);
            if (def.type !== expected) {
                return {
                    message: () => `Expected '${received}' to be a be of type ${expected}`,
                    pass: false,
                };
            }
        }

        return { pass: true, message: () => "" };
    },

    toBeValidMapObjOrNone: (received, expected) => {
        if (received && !MapObjectDefs.typeExists(received)) {
            return {
                message: () => `Expected '${received}' to be a valid map object type`,
                pass: false,
            };
        }

        if (received && expected) {
            const def = MapObjectDefs.typeToDef(received);
            if (def.type !== expected) {
                return {
                    message: () => `Expected '${received}' to be a be of type ${expected}`,
                    pass: false,
                };
            }
        }

        return { pass: true, message: () => "" };
    },

    toBeValidGameObj: (received, expected) => {
        if (!GameObjectDefs.typeExists(received)) {
            return {
                message: () => `Expected '${received}' to be a valid game object type`,
                pass: false,
            };
        }

        if (expected) {
            const def = GameObjectDefs.typeToDef(received);
            if (def.type !== expected) {
                return {
                    message: () => `Expected '${received}' to be a be of type ${expected}`,
                    pass: false,
                };
            }
        }

        return { pass: true, message: () => "" };
    },

    toBeValidLoot: (received, expected) => {
        const def = GameObjectDefs.typeToDefSafe(received);
        if (!def || !("lootImg" in def)) {
            return {
                message: () => `Expected '${received}' to be a valid loot type`,
                pass: false,
            };
        }

        if (expected) {
            const def = GameObjectDefs.typeToDef(received);
            if (def.type !== expected) {
                return {
                    message: () => `Expected '${received}' to be a be of type ${expected}`,
                    pass: false,
                };
            }
        }

        return { pass: true, message: () => "" };
    },

    toBeValidLootTier: (received, lootTable) => {
        // The game resolves loot tiers from the current map's own lootTable
        // (see server loot.ts: `this.game.map.mapDef.lootTable[tier]`), so a tier
        // is valid when it exists in that map's table. Callers with a map in scope
        // pass its lootTable; map-agnostic callers fall back to the base game's table.
        const table = (lootTable as Record<string, unknown>) ?? Main.lootTable;
        if (!(received in table)) {
            return {
                message: () => `Expected '${received}' to be a valid loot table`,
                pass: false,
            };
        }

        return { pass: true, message: () => "" };
    },

    toBeSamePlayer: (received: Player | undefined, expected: Player) => {
        if (!received) {
            return {
                message: () => `Expected a player instance, received '${expected}'`,
                pass: false,
            };
        }
        if (received.__id !== expected.__id) {
            return {
                message: () => `Expected player '${received.name}' to be '${expected.name}'`,
                pass: false,
            };
        }

        return { pass: true, message: () => "" };
    },
});
