import { Rarity } from "../../gameConfig";

/**
 * Keys for the loadout crates. They are ordinary inventory items (one row per key), so
 * the market, auctions, offers, buy orders and gifts work for them unchanged; a key is
 * used up when it opens a crate. A key opens every crate up to its own `tier`.
 */
export interface CrateKeyDef {
    readonly type: "crate_key";
    name: string;
    rarity: Rarity;
    /** 1 = Wooden, 2 = Soviet, 3 = Airdrop. */
    tier: number;
    /** Fixed shop value in Golden Fries (pricing anchor for the market). */
    value: number;
    texture: string;
    lore?: string;
}

export const CrateKeyDefs: Record<string, CrateKeyDef> = {
    key_wooden: {
        type: "crate_key",
        name: "Wooden Key",
        rarity: Rarity.Common,
        tier: 1,
        value: 400,
        texture: "loot-key-wooden.img",
        lore: "Opens Wooden crates.",
    },
    key_soviet: {
        type: "crate_key",
        name: "Soviet Key",
        rarity: Rarity.Rare,
        tier: 2,
        value: 800,
        texture: "loot-key-soviet.img",
        lore: "Opens Soviet and Wooden crates.",
    },
    key_airdrop: {
        type: "crate_key",
        name: "Airdrop Key",
        rarity: Rarity.Mythic,
        tier: 3,
        value: 1300,
        texture: "loot-key-airdrop.img",
        lore: "Opens every crate.",
    },
};
