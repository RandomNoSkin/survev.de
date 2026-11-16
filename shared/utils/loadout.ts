import { z } from "zod";

import { UnlockDefs } from "../defs/gameObjects/unlockDefs.ts";
import { GameObjectDefs } from "../defs/register.ts";
import { GameConfig } from "../gameConfig.ts";
import { deepEqual } from "./deepEqual.js";

export type Item = {
    /** Inventory instance id (absent for virtual default-unlock items). */
    id?: number;
    type: string;
    timeAcquired: number;
    source: string;
    status?: ItemStatus;
    ackd?: ItemStatus.Ackd;
    /** Ownership history (slugs), present for traded items. */
    previousOwners?: string[];
    /** Lifetime match stats accrued by this instance while equipped. */
    games?: number;
    wins?: number;
    kills?: number;
    damage?: number;
    /** Golden Fries the current owner paid to acquire this instance (null = unknown). */
    pricePaid?: number | null;
};

export const loadoutSchema = z.object({
    outfit: z.string(),
    melee: z.string(),
    heal: z.string(),
    boost: z.string(),
    // Newer field: default it so loadouts saved before death effects existed (which
    // have no `death_effect` key) still pass schema validation — otherwise the game
    // server rejects the join until the player re-saves their loadout (skin change).
    death_effect: z.string().default("death_basic"),
    player_icon: z.string(),
    crosshair: z.object({
        type: z.string(),
        color: z.number(),
        size: z.string(),
        stroke: z.string(),
    }),
    emotes: z.array(z.string()).length(6),
    /** Loadout categories (see RANDOM_SLOTS) the game server picks at random from the
     *  player's items before every match. */
    random: z.array(z.string()).max(12).default([]),
    /** Cosmetic types never picked at random ("Random" button or every game). */
    randomExclude: z.array(z.string()).max(1000).default([]),
});

/** Randomizable loadout category → the object type its cosmetics have. The keys are the
 *  loadout menu's category names (`emote` = the whole emote wheel). */
export const RANDOM_SLOTS: Record<string, string> = {
    outfit: "outfit",
    melee: "melee",
    emote: "emote",
    heal: "heal_effect",
    boost: "boost_effect",
    death_effect: "death_effect",
    crosshair: "crosshair",
    player_icon: "emote",
};

export type Loadout = z.infer<typeof loadoutSchema>;
export type Crosshair = Loadout["crosshair"];

export enum ItemStatus {
    New,
    Confirmed,
    Ackd,
}

export const loadout = {
    ItemStatus,
    validate: (userLoadout: Loadout): Loadout => {
        const getGameType = (type: string, gameType: string, defaultValue: string) => {
            const def = GameObjectDefs.typeToDefSafe(gameType);
            if (def && def.type == type) {
                return gameType;
            }
            return defaultValue;
        };
        const getFloat = (flt: string, defaultValue: number) => {
            const val = parseFloat(flt);
            if (Number.isNaN(val)) {
                return defaultValue;
            }
            return val;
        };
        const mergedLoadout = {
            crosshair: {
                type: "",
                color: 0xffffff,
                size: 1,
                stroke: 0,
            },
            emotes: [],
            ...userLoadout as Partial<Loadout>,
        } as Loadout;
        const validatedLoadout: Loadout = {
            outfit: getGameType("outfit", mergedLoadout.outfit, "outfitBase"),
            melee: getGameType("melee", mergedLoadout.melee, "fists"),
            heal: getGameType("heal_effect", mergedLoadout.heal, "heal_basic"),
            boost: getGameType("boost_effect", mergedLoadout.boost, "boost_basic"),
            death_effect: getGameType(
                "death_effect",
                mergedLoadout.death_effect,
                "death_basic",
            ),
            player_icon: getGameType("emote", mergedLoadout.player_icon, ""),
            crosshair: {
                type: getGameType(
                    "crosshair",
                    mergedLoadout.crosshair.type,
                    "crosshair_default",
                ),
                color: parseInt(mergedLoadout.crosshair.color as unknown as string)
                    || 0xffffff,
                size: getFloat(mergedLoadout.crosshair.size, 1).toFixed(2),
                stroke: getFloat(mergedLoadout.crosshair.stroke, 0).toFixed(2),
            },
            emotes: [] as string[],
            random: [...new Set((mergedLoadout.random ?? []).filter((k) => k in RANDOM_SLOTS))],
            randomExclude: [...new Set((mergedLoadout.randomExclude ?? []).filter((t) => !!GameObjectDefs.typeToDefSafe(t)))],
        };

        const defaultEmotes = GameConfig.defaultEmoteLoadout.slice();
        for (let i = 0; i < GameConfig.EmoteSlot.Count; i++) {
            const inputEmote = i < mergedLoadout.emotes.length ? mergedLoadout.emotes[i] : "";
            validatedLoadout.emotes.push(
                getGameType("emote", inputEmote, defaultEmotes[i]),
            );
        }
        return validatedLoadout;
    },
    validateWithAvailableItems: (userLoadout: Loadout, userItems: { type: string }[]): Loadout => {
        const unlockedItems = new Set([
            ...(userItems?.map((item) => item.type) || []),
            ...UnlockDefs.unlock_default.unlocks,
        ]);
        const checkTypeExists = (type: string) => {
            if (type && unlockedItems.has(type)) {
                return type;
            }
            return "";
        };
        const newLoadout = {
            crosshair: {
                type: "",
                color: 0xffffff,
                size: 1,
                stroke: 0,
            },
            emotes: [],
            ...userLoadout as Partial<Loadout>,
        } as Loadout;
        const itemsToCheck = [
            "outfit",
            "melee",
            "heal",
            "boost",
            "death_effect",
            "player_icon",
        ] as const;

        itemsToCheck.forEach((item) => {
            newLoadout[item] = checkTypeExists(newLoadout[item]);
        });

        newLoadout.crosshair.type = checkTypeExists(newLoadout.crosshair.type);

        newLoadout.emotes = newLoadout.emotes.map((emote) => checkTypeExists(emote));

        return loadout.validate(newLoadout);
    },
    defaultLoadout: () => loadout.validate({} as Loadout),
    /**
     * Picks random cosmetics from `availableTypes` (owned + default unlocks) for the
     * categories in `slots` (default: the loadout's own `random` list). Avoids the one
     * already equipped when there's a choice, so "random" always visibly changes. Types in
     * the loadout's `randomExclude` are never picked.
     */
    randomize: (userLoadout: Loadout, availableTypes: Iterable<string>, slots?: string[], rand = Math.random): Loadout => {
        const out = loadout.validate(userLoadout);
        const excluded = new Set(out.randomExclude);
        const types = [...new Set(availableTypes)].filter((t) => !excluded.has(t));
        const poolOf = (gameType: string) => types.filter((t) => GameObjectDefs.typeToDefSafe(t)?.type === gameType);
        const pick = (pool: string[], current: string) => {
            const choices = pool.length > 1 ? pool.filter((t) => t !== current) : pool;
            return choices[Math.floor(rand() * choices.length)];
        };
        for (const slot of slots ?? out.random) {
            const gameType = RANDOM_SLOTS[slot];
            if (!gameType) continue;
            const pool = poolOf(gameType);
            if (!pool.length) continue;
            if (slot === "emote") {
                // a fresh wheel: up to 6 different emotes, shuffled
                const shuffled = [...pool].sort(() => rand() - 0.5);
                out.emotes = out.emotes.map((e, i) => shuffled[i] ?? e);
            } else if (slot === "crosshair") {
                out.crosshair = { ...out.crosshair, type: pick(pool, out.crosshair.type) };
            } else {
                const key = slot as "outfit" | "melee" | "heal" | "boost" | "death_effect" | "player_icon";
                out[key] = pick(pool, out[key]);
            }
        }
        return loadout.validate(out);
    },
    modified: (a: Loadout, b: Loadout) => !deepEqual(a, b),
    getUserAvailableItems: (heroItems: Item[]) => {
        const items: typeof heroItems = [];
        // Add default items
        const unlockDefaultDef = GameObjectDefs.typeToDef("unlock_default", "unlock");
        for (let i = 0; i < unlockDefaultDef.unlocks.length; i++) {
            const unlock = unlockDefaultDef.unlocks[i];
            items.push({
                type: unlock,
                source: "unlock_default",
                timeAcquired: 0,
                status: loadout.ItemStatus.Ackd,
            });
        }
        for (let i = 0; i < heroItems.length; i++) {
            items.push(heroItems[i]);
        }
        // Duplicates are intentionally kept (each owned copy is listed separately).
        // Only drop items whose type no longer exists as a game object (e.g. a cosmetic
        // renamed/removed in the defs but still owned in the DB) — those can't render
        // and would crash the unguarded def lookups in the loadout menu.
        return items.filter((item) => !!GameObjectDefs.typeToDefSafe(item.type));
    },
};
export default loadout;
