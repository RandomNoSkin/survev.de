import { GameConfig, type InventoryItem } from "../gameConfig";
import { GameObjectDefs } from "./gameObjectDefs";
import { type GunDef, GunDefs } from "./gameObjects/gunDefs";
import { MeleeDefs } from "./gameObjects/meleeDefs";
import { PerkDefs } from "./gameObjects/perkDefs";
import { _allowedMeleeSkins } from "./gameObjects/unlockDefs";

/**
 * Leader-configured loadout applied to every player when a private lobby's
 * "Custom Loadout" advanced setting is enabled, replacing the map's default items.
 */
export interface CustomLoadoutConfig {
    /** Player-given display name shown in the leader's loadout list and the per-player assignment dropdown. Falls back to "Custom Loadout"/"Custom Loadout 0N" when unset. */
    name?: string;
    /** [primary gun, secondary gun, melee, throwable]; "" = none/default for that slot */
    weapons: [string, string, string, string];
    /** "" | helmet01-04 */
    helmet: string;
    /** "" | chest01-04 */
    chest: string;
    /** backpack00-03 */
    backpack: string;
    /** 1xscope/2xscope/4xscope/8xscope/15xscope */
    scope: string;
    /** up to 3 perk type ids */
    perks: string[];
    /** grenade + heal counts */
    inventory: Partial<Record<InventoryItem, number>>;
    /** When true, every player gets the "Arena" perk (unlimited ammo) and unlimited adrenaline. Default false; auto-enabled when Custom Loadout is turned on for a map whose `gameMode.arenaMode` is true. */
    arenaMode: boolean;
    /** Only applies when `arenaMode` is false: grants unlimited adrenaline without the Arena perk. Default false. */
    unlimitedAdren: boolean;
    /** Only applies when `arenaMode` is false: grants the "Endless Ammo" perk. Default false. */
    unlimitedAmmo: boolean;
    /** Whether players can pick up items from the ground, overriding the map's `gameMode.pickup`. Default false; auto-set to match the map's `gameMode.arenaMode` when Custom Loadout is turned on. */
    allowPickup: boolean;
}

/** Max number of additional named loadouts ("Custom Loadout 01"-"07") a lobby leader can configure besides the base "Custom Loadout". */
export const MAX_EXTRA_CUSTOM_LOADOUTS = 7;

/** Max length of a player-given `CustomLoadoutConfig.name`. */
export const CUSTOM_LOADOUT_NAME_MAX_LEN = 16;

export const DEFAULT_CUSTOM_LOADOUT: CustomLoadoutConfig = {
    weapons: ["", "", "", ""],
    helmet: "",
    chest: "",
    backpack: "",
    scope: "1xscope",
    perks: [],
    inventory: {},
    arenaMode: false,
    unlimitedAdren: false,
    unlimitedAmmo: false,
    allowPickup: false,
};

export const CUSTOM_LOADOUT_GUNS = Object.keys(GunDefs).filter(
    (k) => GameObjectDefs[k]?.type === "gun",
);
export const CUSTOM_LOADOUT_MELEES = Object.keys(MeleeDefs).filter(
    (k) => GameObjectDefs[k]?.type === "melee" && !_allowedMeleeSkins.includes(k),
);
export const CUSTOM_LOADOUT_GRENADES = [
    "frag",
    "smoke",
    "mirv",
    "strobe",
    "snowball",
    "potato",
    "coconut",
] as const;
export const CUSTOM_LOADOUT_HELMETS = ["", "helmet01", "helmet02", "helmet03", "helmet04"];
export const CUSTOM_LOADOUT_CHESTS = ["", "chest01", "chest02", "chest03", "chest04"];
export const CUSTOM_LOADOUT_BACKPACKS = ["backpack00", "backpack01", "backpack02", "backpack03"];
export const CUSTOM_LOADOUT_SCOPES = ["1xscope", "2xscope", "4xscope", "8xscope", "15xscope"] as const;
export const CUSTOM_LOADOUT_HEALS = ["bandage", "healthkit", "soda", "painkiller"] as const;
export const CUSTOM_LOADOUT_AMMOS = [
    "9mm",
    "762mm",
    "556mm",
    "12gauge",
    "50AE",
    "308sub",
    "45acp",
    "flare",
] as const;
export const CUSTOM_LOADOUT_PERKS = Object.keys(PerkDefs).filter(
    (k) => GameObjectDefs[k]?.type === "perk",
);

const CUSTOM_LOADOUT_INVENTORY_ITEMS: readonly string[] = [
    ...CUSTOM_LOADOUT_GRENADES,
    ...CUSTOM_LOADOUT_HEALS,
    ...CUSTOM_LOADOUT_SCOPES,
    ...CUSTOM_LOADOUT_AMMOS,
];

function backpackLevel(backpack: string): number {
    const match = backpack.match(/(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
}

/** Server-side sanitizer: drops/clamps anything that isn't a valid item or in range. */
export function validateCustomLoadout(input: Partial<CustomLoadoutConfig>): CustomLoadoutConfig {
    const weaponCategories = ["gun", "gun", "melee", "throwable"] as const;
    const weapons = [0, 1, 2, 3].map((i) => {
        const type = input.weapons?.[i] ?? "";
        if (!type) return "";
        if (i === 2) return CUSTOM_LOADOUT_MELEES.includes(type) ? type : "";
        return GameObjectDefs[type]?.type === weaponCategories[i] ? type : "";
    }) as [string, string, string, string];

    const helmet = CUSTOM_LOADOUT_HELMETS.includes(input.helmet ?? "") ? (input.helmet ?? "") : "";
    const chest = CUSTOM_LOADOUT_CHESTS.includes(input.chest ?? "") ? (input.chest ?? "") : "";
    const backpack = CUSTOM_LOADOUT_BACKPACKS.includes(input.backpack ?? "")
        ? (input.backpack as string)
        : "backpack00";
    const scope = (CUSTOM_LOADOUT_SCOPES as readonly string[]).includes(input.scope ?? "")
        ? (input.scope as string)
        : "1xscope";

    const perks = [...new Set(input.perks ?? [])]
        .filter((perk) => CUSTOM_LOADOUT_PERKS.includes(perk))
        .slice(0, 3);

    const level = backpackLevel(backpack);
    const inventory: Partial<Record<InventoryItem, number>> = {};
    for (const [item, amount] of Object.entries(input.inventory ?? {})) {
        if (!CUSTOM_LOADOUT_INVENTORY_ITEMS.includes(item)) continue;
        const max = GameConfig.bagSizes[item as InventoryItem][level];
        inventory[item as InventoryItem] = Math.max(0, Math.min(max, Math.floor(amount ?? 0)));
    }

    const arenaMode = input.arenaMode ?? false;
    const unlimitedAdren = input.unlimitedAdren ?? false;
    const unlimitedAmmo = input.unlimitedAmmo ?? false;
    const allowPickup = input.allowPickup ?? false;

    const name = (input.name ?? "").trim().slice(0, CUSTOM_LOADOUT_NAME_MAX_LEN) || undefined;

    return {
        name,
        weapons,
        helmet,
        chest,
        backpack,
        scope,
        perks,
        inventory,
        arenaMode,
        unlimitedAdren,
        unlimitedAmmo,
        allowPickup,
    };
}

/**
 * Perk type ids granted on top of a player's normal loadout based on the lobby's
 * Arena Mode settings: "arena" (unlimited ammo + adrenaline) when Arena Mode is on,
 * or "endless_ammo" when Arena Mode is off but Unlimited Ammo is on.
 */
export function getArenaModeExtraPerks(settings: Pick<CustomLoadoutConfig, "arenaMode" | "unlimitedAmmo">): string[] {
    if (settings.arenaMode) return ["arena"];
    if (settings.unlimitedAmmo) return ["endless_ammo"];
    return [];
}

/**
 * Builds an object shaped like `GameConfig.player.defaultItems` from a validated custom loadout,
 * for use as `defaultItems` when spawning players in lobbies with Custom Loadout enabled.
 */
export function buildDefaultItemsFromCustomLoadout(loadout: CustomLoadoutConfig) {
    const [primary, secondary, melee] = loadout.weapons;
    const throwable = CUSTOM_LOADOUT_GRENADES.find((g) => (loadout.inventory[g] ?? 0) > 0) ?? "";

    const perks = [...loadout.perks, ...getArenaModeExtraPerks(loadout)];

    // Every player always carries a 1x scope, and the equipped scope must be
    // in the inventory to be usable; both are enforced here regardless of
    // what the leader configured for "extra" scopes.
    const scopes = Object.fromEntries(
        CUSTOM_LOADOUT_SCOPES.map((scope) => [scope, loadout.inventory[scope] ?? 0]),
    );
    scopes["1xscope"] = 1;
    scopes[loadout.scope || "1xscope"] = 1;

    return {
        weapons: [
            { type: primary, ammo: primary ? (GunDefs[primary] as GunDef).maxClip : 0 },
            { type: secondary, ammo: secondary ? (GunDefs[secondary] as GunDef).maxClip : 0 },
            { type: melee || "fists", ammo: 0 },
            { type: throwable, ammo: throwable ? (loadout.inventory[throwable as InventoryItem] ?? 0) : 0 },
        ] as [
            { type: string; ammo: number },
            { type: string; ammo: number },
            { type: string; ammo: number },
            { type: string; ammo: number },
        ],
        outfit: "outfitBase",
        backpack: loadout.backpack || "backpack00",
        helmet: loadout.helmet,
        chest: loadout.chest,
        scope: loadout.scope || "1xscope",
        perks: perks.map((type) => ({ type })),
        inventory: {
            ...GameConfig.player.defaultItems.inventory,
            ...loadout.inventory,
            ...scopes,
        },
    };
}
