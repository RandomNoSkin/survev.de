import { Rarity } from "../../gameConfig";
import { type DeepPartial, util } from "../../utils/util";

export interface OutfitDef {
    readonly type: "outfit";
    name: string;
    skinImg: {
        baseTint: number;
        baseSprite: string;
        handTint: number;
        handSprite: string;
        footTint: number;
        footSprite: string;
        backpackTint: number;
        backpackSprite: string;
        // Optional skin accessory rendered as an extra layer on the body
        // (e.g. snowman buttons, astronaut visor). Ported from resurviv.
        frontSprite?: string;
        frontSpritePos?: { x: number; y: number };
        aboveHand?: boolean;
    };
    lootImg: {
        sprite: string;
        tint: number;
        border: string;
        borderTint: number;
        scale: number;
    };
    sound: {
        pickup: string;
    };
    baseType?: string;
    noDropOnDeath?: boolean;
    rarity?: number;
    /** When true, this item can appear in the Golden Fries daily shop. */
    shop?: boolean;
    lore?: string;
    noDrop?: boolean;
    obstacleType?: string;
    baseScale?: number;
    ghillie?: boolean;
}

function defineOutfitSkin(baseType: string, params: DeepPartial<OutfitDef>): OutfitDef {
    return util.mergeDeep({}, BaseDefs[baseType], params);
}
const BaseDefs: Record<string, OutfitDef> = {
    outfitBase: {
        name: "Basic Outfit",
        type: "outfit",
        skinImg: {
            baseTint: 0xf8c574,
            baseSprite: "player-base-01.img",
            handTint: 0xf8c574,
            handSprite: "player-hands-01.img",
            footTint: 0xf8c574,
            footSprite: "player-feet-01.img",
            backpackTint: 0x816537,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xffffff,
            border: "loot-circle-outer-01.img",
            borderTint: 0,
            scale: 0.2,
        },
        sound: {
            pickup: "clothes_pickup_01",
        },
    },
};

const SkinDefs: Record<string, OutfitDef> = {
    outfitBase: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Basic Outfit",
        rarity: Rarity.Stock,
        lore: "Pure and simple.",
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0xffffff,
        },
    }),
    outfitDemo: defineOutfitSkin("outfitBase", {
        noDrop: true,
        skinImg: {
            baseTint: 0xc76a67,
            baseSprite: "player-base-02.img",
            handTint: 0xb5504d,
            handSprite: "player-hands-02.img",
            footTint: 0xb5504d,
            footSprite: "player-feet-02.img",
            backpackTint: 0x9e3734,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xffffff,
        },
    }),
    outfitTank: defineOutfitSkin("outfitBase", {
        noDrop: true,
        skinImg: {
            baseTint: 0xeab963,
            baseSprite: "player-base-02.img",
            handTint: 0xd8a44b,
            handSprite: "player-hands-02.img",
            footTint: 0xd8a44b,
            footSprite: "player-feet-02.img",
            backpackTint: 0xbf8b2f,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xffffff,
        },
    }),
    outfitMedic: defineOutfitSkin("outfitBase", {
        noDrop: true,
        skinImg: {
            baseTint: 0xdc79dc,
            baseSprite: "player-base-02.img",
            handTint: 0xc454c4,
            handSprite: "player-hands-02.img",
            footTint: 0xc454c4,
            footSprite: "player-feet-02.img",
            backpackTint: 0xa937a9,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xffffff,
        },
    }),
    outfitScout: defineOutfitSkin("outfitBase", {
        noDrop: true,
        skinImg: {
            baseTint: 0xacd563,
            baseSprite: "player-base-02.img",
            handTint: 0x96c24a,
            handSprite: "player-hands-02.img",
            footTint: 0x96c24a,
            footSprite: "player-feet-02.img",
            backpackTint: 0x83b034,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xffffff,
        },
    }),
    outfitSniper: defineOutfitSkin("outfitBase", {
        noDrop: true,
        skinImg: {
            baseTint: 0x8dcedb,
            baseSprite: "player-base-02.img",
            handTint: 0x70bac9,
            handSprite: "player-hands-02.img",
            footTint: 0x70bac9,
            footSprite: "player-feet-02.img",
            backpackTint: 0x52a3b4,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xffffff,
        },
    }),
    outfitAssault: defineOutfitSkin("outfitBase", {
        noDrop: true,
        skinImg: {
            baseTint: 0xdacf59,
            baseSprite: "player-base-02.img",
            handTint: 0xc6bb40,
            handSprite: "player-hands-02.img",
            footTint: 0xc6bb40,
            footSprite: "player-feet-02.img",
            backpackTint: 0xa69c28,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xffffff,
        },
    }),
    outfitTurkey: defineOutfitSkin("outfitBase", {
        name: "Fowl Facade",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 0xf0cebb,
            baseSprite: "player-base-outfitTurkey.img",
            handTint: 0xa51300,
            handSprite: "player-hands-02.img",
            footTint: 0xa51300,
            footSprite: "player-feet-02.img",
            backpackTint: 0xa85526,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitTurkey.img",
            tint: 0xf0cebb,
        },
        rarity: Rarity.Rare,
        lore: "M1100 not included.",
    }),
    outfitDev: defineOutfitSkin("outfitBase", {
        name: "Developer Swag",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 0x348628,
            baseSprite: "player-base-outfitDC.img",
            handTint: 0x69da22,
            handSprite: "player-hands-02.img",
            footTint: 0x69da22,
            footSprite: "player-feet-02.img",
            backpackTint: 0x2c4b09,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitDev.img",
            tint: 0xffffff,
        },
        rarity: Rarity.Mythic,
        lore: "The limited edition print.",
    }),
    outfitGD: defineOutfitSkin("outfitBase", {
        name: "Game Designr",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 0xab3030,
            baseSprite: "player-base-outfitDC.img",
            handTint: 0xe35f5f,
            handSprite: "player-hands-02.img",
            footTint: 0xe35f5f,
            footSprite: "player-feet-02.img",
            backpackTint: 0x6e1010,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitGD.img",
            tint: 0xffffff,
        },
        rarity: Rarity.Epic,
        lore: "For those who knows.",
    }),
    outfitMod: defineOutfitSkin("outfitBase", {
        name: "Game Moderatr",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 0x3393db,
            baseSprite: "player-base-outfitDC.img",
            handTint: 0x93c7ee,
            handSprite: "player-hands-02.img",
            footTint: 0x93c7ee,
            footSprite: "player-feet-02.img",
            backpackTint: 0x175686,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitMod.img",
            tint: 0xffffff,
        },
        rarity: Rarity.Epic,
        lore: "For those who wield the power of the pan.",
    }),
    outfitWheat: defineOutfitSkin("outfitBase", {
        name: "Splintered Wheat",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitWheat.img",
            handTint: 0xf0dd92,
            handSprite: "player-hands-01.img",
            footTint: 0xf0dd92,
            footSprite: "player-feet-01.img",
            backpackTint: 0xcba81d,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitWheat.img",
            tint: 0xffffff,
        },
        rarity: Rarity.Common,
    }),
    outfitNoir: defineOutfitSkin("outfitBase", {
        name: "Neo Noir",
        skinImg: {
            baseTint: 0x1b1b1b,
            baseSprite: "player-base-02.img",
            handTint: 0xffffff,
            handSprite: "player-hands-02.img",
            footTint: 0xffffff,
            footSprite: "player-feet-02.img",
            backpackTint: 0x777777,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x1b1b1b,
        },
    }),
    outfitRedLeaderAged: defineOutfitSkin("outfitBase", {
        name: "Weathered Red",
        skinImg: {
            baseTint: 0x9a1818,
            baseSprite: "player-base-02.img",
            handTint: 0xff0000,
            handSprite: "player-hands-02.img",
            footTint: 0xff0000,
            footSprite: "player-feet-02.img",
            backpackTint: 0x530c0c,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x9a1818,
        },
    }),
    outfitBlueLeaderAged: defineOutfitSkin("outfitBase", {
        name: "Stifled Blue",
        skinImg: {
            baseTint: 0x173e99,
            baseSprite: "player-base-02.img",
            handTint: 0x4eff,
            handSprite: "player-hands-02.img",
            footTint: 0x4eff,
            footSprite: "player-feet-02.img",
            backpackTint: 794700,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x173e99,
        },
    }),
    outfitRedLeader: defineOutfitSkin("outfitBase", {
        name: "Red Leader",
        noDrop: true,
        skinImg: {
            baseTint: 0x9b0000,
            baseSprite: "player-base-02.img",
            handTint: 0xff0000,
            handSprite: "player-hands-02.img",
            footTint: 0xff0000,
            footSprite: "player-feet-02.img",
            backpackTint: 0x530000,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x840000,
        },
    }),
    outfitBlueLeader: defineOutfitSkin("outfitBase", {
        name: "Blue Leader",
        noDrop: true,
        skinImg: {
            baseTint: 0x2f9b,
            baseSprite: "player-base-02.img",
            handTint: 0x4eff,
            handSprite: "player-hands-02.img",
            footTint: 0x4eff,
            footSprite: "player-feet-02.img",
            backpackTint: 0x174c,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 13223,
        },
    }),
    outfitSpetsnaz: defineOutfitSkin("outfitBase", {
        name: "Siberian Assault",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitSpetsnaz.img",
            handTint: 0xe4e4e4,
            handSprite: "player-hands-01.img",
            footTint: 0xe4e4e4,
            footSprite: "player-feet-01.img",
            backpackTint: 0xd2d2d2,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitSpetsnaz.img",
            tint: 0xffffff,
        },
        rarity: Rarity.Rare,
    }),
    outfitWoodsCloak: defineOutfitSkin("outfitBase", {
        name: "Greencloak",
        skinImg: {
            baseTint: 0x2aff00,
            baseSprite: "player-base-02.img",
            handTint: 0xfeffaa,
            handSprite: "player-hands-02.img",
            footTint: 0xfeffaa,
            footSprite: "player-feet-02.img",
            backpackTint: 0xee9347,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x2aff00,
        },
    }),
    outfitElf: defineOutfitSkin("outfitBase", {
        name: "Tallow's Little Helper",
        skinImg: {
            baseTint: 0xc40000,
            baseSprite: "player-base-01.img",
            handTint: 0x16b900,
            handSprite: "player-hands-01.img",
            footTint: 0x16b900,
            footSprite: "player-feet-01.img",
            backpackTint: 0x59300,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x16b900,
        },
    }),
    outfitImperial: defineOutfitSkin("outfitBase", {
        name: "Imperial Seal",
        skinImg: {
            baseTint: 0xbc002d,
            baseSprite: "player-base-01.img",
            handTint: 0xffffff,
            handSprite: "player-hands-01.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xc0a73f,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xbc002d,
        },
    }),
    outfitLumber: defineOutfitSkin("outfitBase", {
        name: "Woodcutter's Wrap",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitLumber.img",
            handTint: 0x7e0308,
            handSprite: "player-hands-02.img",
            footTint: 0x7e0308,
            footSprite: "player-feet-02.img",
            backpackTint: 0x4a1313,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitLumber.img",
            tint: 0xffffff,
        },
    }),
    outfitVerde: defineOutfitSkin("outfitBase", {
        name: "Poncho Verde",
        skinImg: {
            baseTint: 0x1b400c,
            baseSprite: "player-base-02.img",
            handTint: 0xb5c58b,
            handSprite: "player-hands-02.img",
            footTint: 0xb5c58b,
            footSprite: "player-feet-02.img",
            backpackTint: 0xab7c29,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x1b400c,
        },
    }),
    outfitPineapple: defineOutfitSkin("outfitBase", {
        name: "Valiant Pineapple",
        skinImg: {
            baseTint: 0x990000,
            baseSprite: "player-base-02.img",
            handTint: 0x4c1111,
            handSprite: "player-hands-02.img",
            footTint: 0x4c1111,
            footSprite: "player-feet-02.img",
            backpackTint: 0xffcc00,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x990000,
        },
    }),
    outfitTarkhany: defineOutfitSkin("outfitBase", {
        name: "Tarkhany Regal",
        skinImg: {
            baseTint: 0x4b2e83,
            baseSprite: "player-base-02.img",
            handTint: 0xffb400,
            handSprite: "player-hands-02.img",
            footTint: 0xffb400,
            footSprite: "player-feet-02.img",
            backpackTint: 0x472060,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x4b2e83,
        },
    }),
    outfitWaterElem: defineOutfitSkin("outfitBase", {
        name: "Water Elemental",
        skinImg: {
            baseTint: 0x6cffe9,
            baseSprite: "player-base-02.img",
            handTint: 0xf4005c,
            handSprite: "player-hands-02.img",
            footTint: 0xf4005c,
            footSprite: "player-feet-02.img",
            backpackTint: 0x7f84,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 7143401,
        },
    }),
    outfitHeaven: defineOutfitSkin("outfitBase", {
        name: "Celestial Garb",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitHeaven.img",
            handTint: 0xd2004f,
            handSprite: "player-hands-02.img",
            footTint: 0xd2004f,
            footSprite: "player-feet-02.img",
            backpackTint: 0x8e97,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitHeaven.img",
            tint: 0xffffff,
        },
    }),
    outfitMeteor: defineOutfitSkin("outfitBase", {
        name: "Falling Star",
        skinImg: {
            baseTint: 0x950000,
            baseSprite: "player-base-02.img",
            handTint: 0xff7800,
            handSprite: "player-hands-02.img",
            footTint: 0xff7800,
            footSprite: "player-feet-02.img",
            backpackTint: 0x48231e,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x950000,
        },
    }),
    outfitIslander: defineOutfitSkin("outfitBase", {
        name: "Island Time",
        skinImg: {
            baseTint: 0xffc600,
            baseSprite: "player-base-01.img",
            handTint: 0x24600,
            handSprite: "player-hands-01.img",
            footTint: 0x24600,
            footSprite: "player-feet-01.img",
            backpackTint: 0x449700,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xffc600,
        },
    }),
    outfitAqua: defineOutfitSkin("outfitBase", {
        name: "Aquatic Avenger",
        skinImg: {
            baseTint: 0xbaa2,
            baseSprite: "player-base-01.img",
            handTint: 0xffde,
            handSprite: "player-hands-01.img",
            footTint: 0xffde,
            footSprite: "player-feet-01.img",
            backpackTint: 0x8302c,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xbaa2,
        },
    }),
    outfitCoral: defineOutfitSkin("outfitBase", {
        name: "Coral Guise",
        skinImg: {
            baseTint: 0xff5f67,
            baseSprite: "player-base-01.img",
            handTint: 0xff898f,
            handSprite: "player-hands-01.img",
            footTint: 0xff898f,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffecca,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xff5f67,
        },
    }),
    outfitKhaki: defineOutfitSkin("outfitBase", {
        name: "The Initiative",
        rarity: Rarity.Common,
        skinImg: {
            baseTint: 0xc3ae85,
            baseSprite: "player-base-02.img",
            handTint: 0x8f8064,
            handSprite: "player-hands-02.img",
            footTint: 0x8f8064,
            footSprite: "player-feet-02.img",
            backpackTint: 0x40392c,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xc3ae85,
        },
    }),
    outfitParma: defineOutfitSkin("outfitBase", {
        name: "PARMA Jumpsuit",
        noDropOnDeath: true,
        rarity: Rarity.Common,
        lore: "Next generation inversion.",
        skinImg: {
            baseTint: 0x857659,
            baseSprite: "player-base-01.img",
            handTint: 0xc3ae85,
            handSprite: "player-hands-01.img",
            footTint: 0xc3ae85,
            footSprite: "player-feet-01.img",
            backpackTint: 0x40392c,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitParma.img",
            tint: 0xffffff,
        },
    }),
    outfitParmaPrestige: defineOutfitSkin("outfitBase", {
        name: "The Core Jumpsuit",
        noDropOnDeath: true,
        rarity: Rarity.Rare,
        lore: "Special issue for staffers at Bunker 1.",
        skinImg: {
            baseTint: 0xe3c081,
            baseSprite: "player-base-outfitParmaPrestige.img",
            handTint: 0xa9936b,
            handSprite: "player-hands-02.img",
            footTint: 0xa9936b,
            footSprite: "player-feet-02.img",
            backpackTint: 0x655231,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitParmaPrestige.img",
            tint: 0xffffff,
        },
    }),
    outfitCasanova: defineOutfitSkin("outfitBase", {
        name: "Casanova Silks",
        skinImg: {
            baseTint: 0x42080c,
            baseSprite: "player-base-01.img",
            handTint: 0x740007,
            handSprite: "player-hands-01.img",
            footTint: 0x740007,
            footSprite: "player-feet-01.img",
            backpackTint: 0x101010,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x42080c,
        },
    }),
    outfitPrisoner: defineOutfitSkin("outfitBase", {
        name: "The New Black",
        skinImg: {
            baseTint: 0xff5c22,
            baseSprite: "player-base-01.img",
            handTint: 0xfc7523,
            handSprite: "player-hands-01.img",
            footTint: 0xfc7523,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffae00,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xff5c22,
        },
    }),
    outfitJester: defineOutfitSkin("outfitBase", {
        name: "Jester's Folly",
        skinImg: {
            baseTint: 0x770078,
            baseSprite: "player-base-01.img",
            handTint: 0x4b004c,
            handSprite: "player-hands-01.img",
            footTint: 0x4b004c,
            footSprite: "player-feet-01.img",
            backpackTint: 0xe4c00,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x770078,
        },
    }),
    outfitWoodland: defineOutfitSkin("outfitBase", {
        name: "Woodland Combat",
        rarity: Rarity.Common,
        lore: "Common component of PARMA survival caches.",
        skinImg: {
            baseTint: 0x2b332a,
            baseSprite: "player-base-01.img",
            handTint: 0x5a6c52,
            handSprite: "player-hands-01.img",
            footTint: 0x5a6c52,
            footSprite: "player-feet-01.img",
            backpackTint: 0x4d2600,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitWoodland.img",
            tint: 0xffffff,
        },
    }),
    outfitRoyalFortune: defineOutfitSkin("outfitBase", {
        name: "Royal Fortune",
        rarity: Rarity.Rare,
        skinImg: {
            baseTint: 0x7f2723,
            baseSprite: "player-base-01.img",
            handTint: 0xe8c22a,
            handSprite: "player-hands-01.img",
            footTint: 0xe8c22a,
            footSprite: "player-feet-01.img",
            backpackTint: 0x984f00,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitRoyalFortune.img",
            tint: 0xffffff,
        },
    }),
    outfitKeyLime: defineOutfitSkin("outfitBase", {
        name: "Key Lime",
        rarity: Rarity.Common,
        lore: "Not for eating.",
        skinImg: {
            baseTint: 0xc7ff3f,
            baseSprite: "player-base-01.img",
            handTint: 0xeeff5d,
            handSprite: "player-hands-01.img",
            footTint: 0xeeff5d,
            footSprite: "player-feet-01.img",
            backpackTint: 0xbc8737,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitKeyLime.img",
            tint: 0xffffff,
        },
    }),
    outfitCobaltShell: defineOutfitSkin("outfitBase", {
        name: "Cobalt Shell",
        rarity: Rarity.Common,
        lore: "It means bluish.",
        skinImg: {
            baseTint: 0x2b57,
            baseSprite: "player-base-01.img",
            handTint: 0x295e7c,
            handSprite: "player-hands-01.img",
            footTint: 0x295e7c,
            footSprite: "player-feet-01.img",
            backpackTint: 0x4a95,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitCobaltShell.img",
            tint: 0xffffff,
        },
    }),
    outfitFragtastic: defineOutfitSkin("outfitBase", {
        name: "Fragtastic",
        rarity: Rarity.Common,
        lore: "Pin not included. Maybe.",
        skinImg: {
            baseTint: 0x62591f,
            baseSprite: "player-base-01.img",
            handTint: 0x7f742a,
            handSprite: "player-hands-01.img",
            footTint: 0x7f742a,
            footSprite: "player-feet-01.img",
            backpackTint: 0x999999,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x938632,
        },
    }),
    outfitCarbonFiber: defineOutfitSkin("outfitBase", {
        name: "Carbon Fiber",
        // noDropOnDeath: true,
        rarity: Rarity.Uncommon,
        lore: "Military-grade, fine spun filament.",
        skinImg: {
            baseTint: 0x212121,
            baseSprite: "player-base-01.img",
            handTint: 0x1c1c1c,
            handSprite: "player-hands-01.img",
            footTint: 0x1c1c1c,
            footSprite: "player-feet-01.img",
            backpackTint: 0x363636,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitCarbonFiber.img",
            tint: 0xffffff,
        },
    }),
    outfitDarkGloves: defineOutfitSkin("outfitBase", {
        name: "The Professional",
        // noDropOnDeath: true,
        rarity: Rarity.Uncommon,
        lore: "True survivrs wear the dark gloves.",
        skinImg: {
            baseTint: 0xf8c574,
            baseSprite: "player-base-01.img",
            handTint: 0xbe7800,
            handSprite: "player-hands-01.img",
            footTint: 0xbe7800,
            footSprite: "player-feet-01.img",
            backpackTint: 0xa36700,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitDarkGloves.img",
            tint: 0xffffff,
        },
    }),
    outfitOldMan: defineOutfitSkin("outfitBase", {
        name: "The Old Man",
        // noDropOnDeath: true,
        rarity: Rarity.Mythic,
        lore: "True Uncs struggle to find the right hex color",
        skinImg: {
            baseTint: 0x3b3a3a,
            baseSprite: "player-base-01.img",
            handTint: 0x080b04,
            handSprite: "player-hands-01.img",
            footTint: 0xbe7800,
            footSprite: "player-feet-01.img",
            backpackTint: 0x080b04,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitDarkGloves.img",
            tint: 0x453706,
        },
    }),
    outfitDarkShirt: defineOutfitSkin("outfitBase", {
        name: "The Semi-Pro",
        noDropOnDeath: true,
        rarity: Rarity.Common,
        lore: "Some survivrs wear the dark shirt.",
        skinImg: {
            baseTint: 0xbe7800,
            baseSprite: "player-base-01.img",
            handTint: 0xf8c574,
            handSprite: "player-hands-01.img",
            footTint: 0xf8c574,
            footSprite: "player-feet-01.img",
            backpackTint: 0xe7ae53,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitDarkShirt.img",
            tint: 0xffffff,
        },
    }),
    outfitGhillie: defineOutfitSkin("outfitBase", {
        name: "Ghillie Suit",
        ghillie: true,
        skinImg: {
            baseTint: 0x83af50,
            baseSprite: "player-base-01.img",
            handTint: 0x83af50,
            handSprite: "player-hands-01.img",
            footTint: 0x83af50,
            footSprite: "player-feet-01.img",
            backpackTint: 0x663300,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x83af50,
        },
    }),
    outfitDesertCamo: defineOutfitSkin("outfitBase", {
        name: "Desert Camo",
        rarity: Rarity.Common,
        skinImg: {
            baseTint: 0xd19b4e,
            baseSprite: "player-base-01.img",
            handTint: 0xaa6d16,
            handSprite: "player-hands-01.img",
            footTint: 0xaa6d16,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffcb82,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitDesertCamo.img",
            tint: 0xffffff,
        },
    }),
    outfitCamo: defineOutfitSkin("outfitBase", {
        name: "Forest Camo",
        rarity: Rarity.Common,
        lore: "Be one with the trees.",
        skinImg: {
            baseTint: 0x999966,
            baseSprite: "player-base-01.img",
            handTint: 0x848457,
            handSprite: "player-hands-01.img",
            footTint: 0x848457,
            footSprite: "player-feet-01.img",
            backpackTint: 0x666633,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitCamo.img",
            tint: 0xffffff,
        },
    }),
    outfitRed: defineOutfitSkin("outfitBase", {
        name: "Target Practice",
        // noDropOnDeath: true,
        rarity: Rarity.Common,
        lore: "On the plus side, they won't see you bleed.",
        skinImg: {
            baseTint: 0xff0000,
            baseSprite: "player-base-01.img",
            handTint: 0xd40000,
            handSprite: "player-hands-01.img",
            footTint: 0xd40000,
            footSprite: "player-feet-01.img",
            backpackTint: 0xb70000,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitRed.img",
            tint: 0xffffff,
        },
    }),
    outfitWhite: defineOutfitSkin("outfitBase", {
        name: "Arctic Avenger",
        // noDropOnDeath: true,
        rarity: Rarity.Common,
        lore: "No business like snow business.",
        skinImg: {
            baseTint: 0xe3e3e3,
            baseSprite: "player-base-01.img",
            handTint: 0xeeeeee,
            handSprite: "player-hands-01.img",
            footTint: 0xeeeeee,
            footSprite: "player-feet-01.img",
            backpackTint: 0xdcdcdc,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitWhite.img",
            tint: 0xffffff,
        },
    }),
    outfitSnow: defineOutfitSkin("outfitBase", {
        name: "Snowed Over",
        rarity: Rarity.Uncommon,
        lore: "It's shirt weather!!",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitSnow.img",
            handTint: 0xffffff,
            handSprite: "player-hands-outfitSnow.img",
            footTint: 0xb2eaff,
            footSprite: "player-feet-01.img",
            backpackTint: 0x77c4dd,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitSnow.img",
            tint: 0xffffff,
        },
    }),
    outfitBlackIce: defineOutfitSkin("outfitBase", {
        name: "Black Ice",
        rarity: Rarity.Common,
        skinImg: {
            baseTint: 0x686d6e,
            baseSprite: "player-base-02.img",
            handTint: 0x414753,
            handSprite: "player-hands-01.img",
            footTint: 0x33333d,
            footSprite: "player-feet-01.img",
            backpackTint: 0x5e6473,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x5e6473,
        },
    }),
    outfitBeachCamo: defineOutfitSkin("outfitBase", {
        name: "Beach Shored",
        skinImg: {
            baseTint: 0xedca7e,
            baseSprite: "player-base-01.img",
            handTint: 0xfae5b6,
            handSprite: "player-hands-01.img",
            footTint: 0xfae5b6,
            footSprite: "player-feet-01.img",
            backpackTint: 0x7c995b,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xedca7e,
        },
    }),
    outfitCoconut: defineOutfitSkin("outfitBase", {
        name: "Coconut Frenzy",
        rarity: Rarity.Common,
        lore: "It's the coco fruit!",
        skinImg: {
            baseTint: 0x765836,
            baseSprite: "player-base-01.img",
            handTint: 0x362d22,
            handSprite: "player-hands-01.img",
            footTint: 0xe9edf6,
            footSprite: "player-feet-01.img",
            backpackTint: 0xe9edf6,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x765836,
        },
    }),
    outfitWave: defineOutfitSkin("outfitBase", {
        name: "Tidal Wave",
        rarity: Rarity.Common,
        lore: "Send them to Davy Jones' locker.",
        skinImg: {
            baseTint: 0x1198ec,
            baseSprite: "player-base-02.img",
            handTint: 0xfdf5f1,
            handSprite: "player-hands-02.img",
            footTint: 0xfdf5f1,
            footSprite: "player-feet-02.img",
            backpackTint: 0x2178ae,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitWave.img",
            tint: 0xffffff,
        },
    }),
    outfitParrotfish: defineOutfitSkin("outfitBase", {
        name: "Parrotfish",
        rarity: Rarity.Rare,
        lore: "Show off your scales around the island. Coral, beware!",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitParrotfish.img",
            handTint: 0x3ac6c6,
            handSprite: "player-hands-02.img",
            footTint: 0x306790,
            footSprite: "player-feet-02.img",
            backpackTint: 0x37aeab,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitParrotfish.img",
            tint: 0xffffff,
        },
    }),
    outfitSunrise: defineOutfitSkin("outfitBase", {
        name: "Sunrise Warrior",
        rarity: Rarity.Common,
        lore: "Rise and survive.",
        skinImg: {
            baseTint: 0xffb347,
            baseSprite: "player-base-01.img",
            handTint: 0xff8c00,
            handSprite: "player-hands-01.img",
            footTint: 0xff8c00,
            footSprite: "player-feet-01.img",
            backpackTint: 0xcc5500,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0xffb347,
        },
    }),
    outfitTide: defineOutfitSkin("outfitBase", {
        name: "High Tide",
        rarity: Rarity.Uncommon,
        lore: "Time and tide wait for no survivr.",
        skinImg: {
            baseTint: 0x2eeaca,
            baseSprite: "player-base-02.img",
            handTint: 0xffffff,
            handSprite: "player-hands-02.img",
            footTint: 0xffffff,
            footSprite: "player-feet-02.img",
            backpackTint: 0x1a8ea1,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x2eeaca,
        },
    }),
    outfitTropicalStorm: defineOutfitSkin("outfitBase", {
        name: "Tropical Fury",
        rarity: Rarity.Rare,
        lore: "When paradise turns hostile.",
        skinImg: {
            baseTint: 0x00ccaa,
            baseSprite: "player-base-02.img",
            handTint: 0xff6b35,
            handSprite: "player-hands-02.img",
            footTint: 0xff6b35,
            footSprite: "player-feet-02.img",
            backpackTint: 0x006655,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x00ccaa,
        },
    }),
    outfitOhNah: defineOutfitSkin("outfitBase", {
        name: "Oh Nah!",
        rarity: Rarity.Mythic,
        lore: "What a predicament!",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitOhNah.img",
            handTint: 0x404042,
            handSprite: "player-hands-02.img",
            footTint: 0x404042,
            footSprite: "player-feet-02.img",
            backpackTint: 0x404042,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitOhNah.img",
            tint: 0xffffff,
        },
    }),
    outfitMarblePink: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Marble Pink",
        rarity: Rarity.Common,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitMarblePink.img",
            handTint: 0xe8008a,
            handSprite: "player-hands-02.img",
            footTint: 0xe8008a,
            footSprite: "player-feet-02.img",
            backpackTint: 0x3d0030,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0x3d0030,
        },
    }),
    outfitMarblegreen: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Marble Green",
        rarity: Rarity.Common,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitMarbleGreen.img",
            handTint: 0x004422,
            handSprite: "player-hands-02.img",
            footTint: 0x004422,
            footSprite: "player-feet-02.img",
            backpackTint: 0x001a0a,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0x001a0a,
        },
    }),
    outfitMarblered: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Marble Red",
        rarity: Rarity.Common,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitMarbleRed.img",
            handTint: 0xff0000,
            handSprite: "player-hands-02.img",
            footTint: 0xff0000,
            footSprite: "player-feet-02.img",
            backpackTint: 0xcc0000,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0xcc0000,
        },
    }),
    outfitRuin: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Ruin",
        rarity: Rarity.Rare,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitRuin.img",
            handTint: 0xffffff,
            handSprite: "player-hands-Ruin.img",
            footTint: 0x111111,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-circle-base-Ruin.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0x111111,
        },
    }),
    outfitAuronV2: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "AuronV2",
        rarity: Rarity.Uncommon,
        lore: "The better version of a scraped skin",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitAuronV2.img",
            handTint: 0xddaa00,
            handSprite: "player-hands-02.img",
            footTint: 0x111111,
            footSprite: "player-feet-02.img",
            backpackTint: 0x111111,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0xddaa00,
        },
    }),
    outfitHorizon: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Horizon",
        rarity: Rarity.Uncommon,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitHorizon.img",
            handTint: 0x2a0a5a,
            handSprite: "player-hands-02.img",
            footTint: 0x2a0a5a,
            footSprite: "player-feet-02.img",
            backpackTint: 0x1a0a3a,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0x2a0a5a,
        },
    }),
    // karambit_dotexe is the knief for this skin 
    outfitDotexe: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: ".EXE",
        rarity: Rarity.Epic,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitDotexe.img",
            handTint: 0xffffff,
            handSprite: "player-hands-Dotexe.img",
            footTint: 0xffffff,
            footSprite: "player-hands-Dotexe.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-circle-base-Dotexe.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0x000000,
        },
    }),
    outfitSortablue: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Sorta Blue",
        rarity: Rarity.Common,
        lore: "Pure and simple.",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitSortablue.img",
            handTint: 0x2e3592,
            handSprite: "player-hands-02.img",
            footTint: 0x2e3592,
            footSprite: "player-feet-02.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-circle-base-Sortablue.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0x2e3592,
        },
    }),
    outfitSunset: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Sunset",
        rarity: Rarity.Uncommon,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitSunset.img",
            handTint: 0xbe89ab,
            handSprite: "player-hands-02.img",
            footTint: 0x628ac9,
            footSprite: "player-feet-02.img",
            backpackTint: 0x628ac9,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0xbe89ab,
        },
    }),
    outfitYinyang: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Yin & Yang",
        rarity: Rarity.Common,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfityinyang.img",
            handTint: 0xffffff,
            handSprite: "player-hands-01.img",
            footTint: 0x000000,
            footSprite: "player-feet-01.img",
            backpackTint: 0x000000,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0xffffff,
        },
    }),
    outfitGalaxy: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Galaxy",
        rarity: Rarity.Uncommon,
        lore: "Made by Cooly",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitGalaxy.img",
            handTint: 0xffffff,
            handSprite: "player-hands-02.img",
            footTint: 0xffffff,
            footSprite: "player-feet-02.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0xffffff,
        },
    }),
    outfitDiamond: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Diamond",
        rarity: Rarity.Mythic,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitDiamond.img",
            handTint: 0xffffff,
            handSprite: "player-hands-01.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xf8c137,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0xffffff,
        },
    }),
    outfitRosepetals: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Rosepetals",
        rarity: Rarity.Common,
        lore: "Pure and simple.",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitRosepetals.img",
            handTint: 0xe78e8b,
            handSprite: "player-hands-02.img",
            footTint: 0x7e4f4e,
            footSprite: "player-feet-02.img",
            backpackTint: 0x7e4f4e,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0xe78e8b,
        },
    }),
    outfitGreenwheat: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Greenwheat",
        rarity: Rarity.Common,
        lore: "Remake of the wheat skin but in green",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitGreenwheat.img",
            handTint: 0x72cc85,
            handSprite: "player-hands-01.img",
            footTint: 0x2a6e3a,
            footSprite: "player-feet-01.img",
            backpackTint: 0x2a6e3a,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0x72cc85,
        },
    }),
    outfitNordCode: defineOutfitSkin("outfitBase", {
        //philipp and g0dak special DO NOT USE FOR PASS
        name: "Nord Code",
        rarity: Rarity.Mythic,
        lore: "This duo never died.",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitNordCode.img",
            handTint: 0x7d7c7c,
            handSprite: "player-hands-02.img",
            footTint: 0x7d7c7c,
            footSprite: "player-feet-02.img",
            backpackTint: 0x672f0a,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitNordCode.img",
            tint: 0xffffff,
        },
    }),

    outfitDamascussteel: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Damascussteel",
        rarity: Rarity.Common,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitDamascussteel.img",
            handTint: 0x909090,
            handSprite: "player-hands-02.img",
            footTint: 0x606060,
            footSprite: "player-feet-02.img",
            backpackTint: 0x606060,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0x909090,
        },
    }),

    outfitPurplefade: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Purple Fade",
        rarity: Rarity.Uncommon,
        lore: "The old Twitch skin",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitPurplefade.img",
            handTint: 0x6441a4,
            handSprite: "player-hands-02.img",
            footTint: 0x6441a4,
            footSprite: "player-feet-02.img",
            backpackTint: 0x6441a4,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0x6441a4,
        },
    }),
    outfitPandora: defineOutfitSkin("outfitBase", {
        noDrop: true,
        name: "Pandora",
        rarity: Rarity.Common,
        skinImg: {
            baseTint: 0xbfcee4,
            baseSprite: "player-base-02.img",
            handTint: 0x006ed9,
            handSprite: "player-hands-02.img",
            footTint: 0x2357ab,
            footSprite: "player-feet-02.img",
            backpackTint: 0x2357ab,
            backpackSprite: "player-circle-base-02.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x929292,
        },
    }),

    outfitBlackpurple: defineOutfitSkin("outfitBase", {
        noDrop: true,
        name: "Black Purple",
        rarity: Rarity.Rare,
        skinImg: {
            baseTint: 0x121313,
            baseSprite: "player-base-01.img",
            handTint: 0x1c0333,
            handSprite: "player-hands-01.img",
            footTint: 0x1c0333,
            footSprite: "player-feet-01.img",
            backpackTint: 0x1c0333,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-01.img",
            tint: 0x1c0333,
        },
    }),
    outfitCrusader: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Crusader",
        rarity: Rarity.Uncommon,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitCrusader.img",
            handTint: 0x214724,
            handSprite: "player-hands-01.img",
            footTint: 0xba2b28,
            footSprite: "player-feet-01.img",
            backpackTint: 0xba2b28,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0xffffff,
        },
    }),
    outfitDiamondred: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Diamond Black/Red variant",
        rarity: Rarity.Mythic,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitDiamondred.img",
            handTint: 0x282828,
            handSprite: "player-hands-01.img",
            footTint: 0x282828,
            footSprite: "player-feet-01.img",
            backpackTint: 0x000000,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0x282828,
        },
    }),
    outfitPanorama: defineOutfitSkin("outfitBase", {
        noDropOnDeath: true,
        name: "Panorama",
        rarity: Rarity.Uncommon,
        skinImg: {
            baseTint: 0xa4a4f2,
            baseSprite: "player-base-01.img",
            handTint: 0xa4a4f2,
            handSprite: "player-hands-01.img",
            footTint: 0x8e8ee8,
            footSprite: "player-feet-01.img",
            backpackTint: 0x8e8ee8,
            backpackSprite: "player-circle-base-01.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitBase.img",
            tint: 0xa4a4f2,
        },
    }),
    // Obstacle costumes
    outfitBarrel: defineOutfitSkin("outfitBase", {
        name: "Barrel Costume",
        obstacleType: "barrel_01",
        baseScale: 0.8,
        lootImg: {
            tint: 0x393939,
        },
    }),
    outfitWoodBarrel: defineOutfitSkin("outfitBase", {
        name: "Wood Barrel Costume",
        obstacleType: "barrel_02",
        baseScale: 1,
        lootImg: {
            tint: 0xab6f22,
        },
    }),
    outfitStone: defineOutfitSkin("outfitBase", {
        name: "Stone Costume",
        obstacleType: "stone_01",
        baseScale: 0.9,
        lootImg: {
            tint: 0x717171,
        },
    }),
    outfitSpringTree: defineOutfitSkin("outfitBase", {
        name: "Tree Costume",
        obstacleType: "tree_07sp",
        baseScale: 1,
        lootImg: {
            tint: 0x462d12,
        },
    }),
    outfitHalloweenTree: defineOutfitSkin("outfitBase", {
        name: "Tree Costume",
        obstacleType: "tree_07",
        baseScale: 1,
        lootImg: {
            tint: 0x462d12,
        },
    }),
    outfitTreeSpooky: defineOutfitSkin("outfitBase", {
        name: "Spooky Tree Costume",
        obstacleType: "tree_05",
        baseScale: 1,
        lootImg: {
            tint: 0x1b1917,
        },
    }),
    outfitStump: defineOutfitSkin("outfitBase", {
        name: "Stump Costume",
        obstacleType: "tree_09",
        baseScale: 1,
        lootImg: {
            tint: 0x834400,
        },
    }),
    outfitBush: defineOutfitSkin("outfitBase", {
        name: "Bush Costume",
        obstacleType: "bush_01b",
        baseScale: 1,
        lootImg: {
            tint: 0x3b5b1f,
        },
    }),
    outfitLeafPile: defineOutfitSkin("outfitBase", {
        name: "Leaf Pile Costume",
        obstacleType: "bush_06b",
        baseScale: 1,
        lootImg: {
            tint: 0xff4d00,
        },
    }),
    outfitCrate: defineOutfitSkin("outfitBase", {
        name: "Crate Costume",
        obstacleType: "crate_01",
        baseScale: 1,
        lootImg: {
            tint: 0x663300,
        },
    }),
    outfitTable: defineOutfitSkin("outfitBase", {
        name: "Table Costume",
        obstacleType: "table_01",
        baseScale: 1,
        lootImg: {
            tint: 0x663300,
        },
    }),
    outfitSoviet: defineOutfitSkin("outfitBase", {
        name: "Soviet Costume",
        obstacleType: "crate_02",
        baseScale: 1,
        lootImg: {
            tint: 0x663300,
        },
    }),
    outfitAirdrop: defineOutfitSkin("outfitBase", {
        name: "Air Drop Costume",
        obstacleType: "crate_10",
        baseScale: 1,
        lootImg: {
            tint: 0x646464,
        },
    }),
    outfitOven: defineOutfitSkin("outfitBase", {
        name: "Oven Costume",
        obstacleType: "oven_01",
        baseScale: 1,
        lootImg: {
            tint: 0xe3e3e3,
        },
    }),
    outfitRefrigerator: defineOutfitSkin("outfitBase", {
        name: "Fridge Costume",
        obstacleType: "refrigerator_01b",
        baseScale: 1,
        lootImg: {
            tint: 0x76000b,
        },
    }),
    outfitVending: defineOutfitSkin("outfitBase", {
        name: "Vending Costume",
        obstacleType: "vending_01",
        baseScale: 1,
        lootImg: {
            tint: 0x2aad,
        },
    }),
    outfitPumpkin: defineOutfitSkin("outfitBase", {
        name: "Pumpkin Costume",
        obstacleType: "pumpkin_01",
        baseScale: 1,
        lootImg: {
            tint: 0xf27503,
        },
    }),
    outfitWoodpile: defineOutfitSkin("outfitBase", {
        name: "Woodpile Costume",
        obstacleType: "woodpile_01",
        baseScale: 1,
        lootImg: {
            tint: 0x904800,
        },
    }),
    outfitToilet: defineOutfitSkin("outfitBase", {
        name: "Toilet Costume",
        obstacleType: "toilet_02",
        baseScale: 1,
        lootImg: {
            tint: 0xffffff,
        },
    }),
    outfitBushRiver: defineOutfitSkin("outfitBase", {
        name: "River Bush Costume",
        obstacleType: "bush_04",
        baseScale: 1,
        lootImg: {
            tint: 0x517b2a,
        },
    }),
    outfitCrab: defineOutfitSkin("outfitBase", {
        name: "Crab Pot Costume",
        obstacleType: "crate_20",
        baseScale: 1,
        lootImg: {
            tint: 0xfd3018,
        },
    }),
    outfitStumpAxe: defineOutfitSkin("outfitBase", {
        name: "Stump Axe Costume",
        obstacleType: "tree_02h",
        baseScale: 1,
        lootImg: {
            tint: 0xa9621d,
        },
    }),

    // resurviv skin accessories (frontSprite)
    outfitSnowman: defineOutfitSkin("outfitBase", {
        name: "Snowman",
        noDropOnDeath: true,
        rarity: 4,
        lore: "",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-snowman.img",
            handTint: 0xc02727,
            handSprite: "player-hands-01.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xc02727,
            frontSpritePos: { x: 3, y: 0 },
            frontSprite: "player-accessory-snowman.img",
        },
        lootImg: {
            sprite: "loot-snowman-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitChewieCheese: defineOutfitSkin("outfitBase", {
        name: "Chewie Cheese",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 12266256,
            baseSprite: "player-base-01.img",
            handTint: 0xf8c574,
            handSprite: "player-hands-01.img",
            footTint: 0xf8c574,
            footSprite: "player-hands-01.img",
            backpackTint: 13644309,
            backpackSprite: "player-circle-base-01.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-base-chewie-cheese.img",
        },
        lootImg: {
            sprite: "loot-chewie-cheese-outfit.img",
            tint: 0xffffff,
        },
        rarity: 2,
    }),

    outfitFireball: defineOutfitSkin("outfitBase", {
        name: "Fireball",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 12266256,
            baseSprite: "player-base-01.img",
            handTint: 0xffffff,
            handSprite: "player-hands-outfitFireball.img",
            footTint: 0xffffff,
            footSprite: "player-hands-outfitFireball.img",
            backpackTint: 13644309,
            backpackSprite: "player-circle-base-01.img",
            frontSpritePos: { x: -4, y: 0 },
            frontSprite: "player-accessory-outfitFireball.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitFireball.img",
            tint: 0xffffff,
        },
        rarity: 5,
    }),

    outfitWolf: defineOutfitSkin("outfitBase", {
        name: "Wolf",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 6184542,
            baseSprite: "player-base-01.img",
            handTint: 9539985,
            handSprite: "player-hands-01.img",
            footTint: 9539985,
            footSprite: "player-hands-01.img",
            backpackTint: 5197647,
            backpackSprite: "player-circle-base-01.img",
            frontSpritePos: { x: -3, y: 0 },
            frontSprite: "player-accessory-outfitWolf.img",
            aboveHand: true,
        },
        lootImg: {
            sprite: "loot-shirt-outfitWolf.img",
            tint: 0xffffff,
        },
        rarity: 3,
        lore: "For those who hunt alone.",
    }),

    outfitPanda: defineOutfitSkin("outfitBase", {
        name: "Panda",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-01.img",
            handTint: 14408667,
            handSprite: "player-hands-01.img",
            footTint: 14408667,
            footSprite: "player-hands-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-circle-base-01.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-accessory-outfitPanda.img",
            aboveHand: true,
        },
        lootImg: {
            sprite: "loot-shirt-outfitPanda.img",
            tint: 0xffffff,
        },
        rarity: 3,
        lore: "",
    }),

    outfitGreenTeaRex: defineOutfitSkin("outfitBase", {
        name: "Green Tea Rex",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 16777215,
            baseSprite: "player-base-green-tea-rex.img",
            handTint: 0xffffff,
            handSprite: "player-hands-green-tea-rex.img",
            footTint: 0xffffff,
            footSprite: "player-hands-green-tea-rex.img",
            backpackTint: 13644309,
            backpackSprite: "player-circle-base-01.img",
            frontSpritePos: { x: 6, y: 0 },
            frontSprite: "player-accessory-green-tea-rex.img",
            aboveHand: true,
        },
        lootImg: {
            sprite: "loot-green-tea-rex-outfit.img",
            tint: 0xffffff,
        },
        rarity: 3,
    }),

    outfitDragonTails: defineOutfitSkin("outfitBase", {
        name: "Dragon Tails",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 13041664,
            baseSprite: "player-base-dragon-tails.img",
            handTint: 0xffffff,
            handSprite: "player-hands-dragon-tails.img",
            footTint: 0xffffff,
            footSprite: "player-hands-dragon-tails.img",
            backpackTint: 7667712,
            backpackSprite: "player-circle-base-02.img",
            frontSpritePos: { x: -5, y: 0 },
            frontSprite: "player-accessory-dragon-tails.img",
        },
        lootImg: {
            sprite: "loot-dragon-tails-outfit.img",
            tint: 0xffffff,
        },
        rarity: 3,
    }),

    outfitVillageNinja: defineOutfitSkin("outfitBase", {
        name: "Village Ninja",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 16777215,
            baseSprite: "player-base-village-ninja.img",
            handTint: 0xffffff,
            handSprite: "player-hands-village-ninja.img",
            footTint: 0xffffff,
            footSprite: "player-hands-dragon-tails.img",
            backpackTint: 16777215,
            backpackSprite: "player-back-village-ninja.img",
            frontSpritePos: { x: -2, y: 0 },
            frontSprite: "player-accessory-village-ninja.img",
            aboveHand: false,
        },
        lootImg: {
            sprite: "loot-village-ninja-outfit.img",
            tint: 16777215,
        },
        rarity: 3,
    }),

    outfitChromesis: defineOutfitSkin("outfitBase", {
        name: "Chromesis",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 16777215,
            baseSprite: "player-base-outfitChromesis.img",
            handTint: 0xffffff,
            handSprite: "player-hands-chrome.img",
            footTint: 0xffffff,
            footSprite: "player-hands-chrome.img",
            backpackTint: 9803157,
            backpackSprite: "player-circle-base-01.img",
            frontSpritePos: { x: -5, y: 0 },
            frontSprite: "outfit-chrome-accessory.img",
            aboveHand: false,
        },
        lootImg: {
            sprite: "loot-shirt-outfitChromesis.img",
            tint: 16777215,
        },
        rarity: 5,
    }),

    outfitDiamondRsrv: defineOutfitSkin("outfitBase", {
        name: "Diamond",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-diamond.img",
            handTint: 0xffffff,
            handSprite: "player-hand-diamond.img",
            footTint: 0xffffff,
            footSprite: "player-hand-diamond.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-diamond.img",
            frontSpritePos: { x: -5, y: 0 },
            frontSprite: "player-accessory-diamond.img",
            aboveHand: false,
        },
        lootImg: {
            sprite: "loot-shirt-outfitDiamond.img",
            tint: 0xffffff,
        },
        rarity: 5,
        lore: "",
    }),

    outfitMultiTusking: defineOutfitSkin("outfitBase", {
        name: "Multi Tusking",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 16777215,
            baseSprite: "player-base-multi-tusking.img",
            handTint: 0xffffff,
            handSprite: "player-hands-multi-tusking.img",
            footTint: 0xffffff,
            footSprite: "player-hands-multi-tusking.img",
            backpackTint: 9065728,
            backpackSprite: "player-circle-base-01.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-accessory-multi-tusking.img",
            aboveHand: true,
        },
        lootImg: {
            sprite: "loot-multi-tusking-outfit.img",
            tint: 16777215,
        },
        rarity: 3,
    }),

    outfitMaxAttack: defineOutfitSkin("outfitBase", {
        name: "Max Attack",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 16777215,
            baseSprite: "player-base-max-attack.img",
            handTint: 0xffffff,
            handSprite: "player-hands-max-attack.img",
            footTint: 0xffffff,
            footSprite: "player-hands-max-attack.img",
            backpackTint: 2359872,
            backpackSprite: "player-circle-base-01.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-accessory-max-attack.img",
            aboveHand: true,
        },
        lootImg: {
            sprite: "loot-max-attack-outfit.img",
            tint: 16777215,
        },
        rarity: 3,
    }),

    outfitLustrousPaladin: defineOutfitSkin("outfitBase", {
        name: "Lustrous Paladin",
        noDropOnDeath: true,
        skinImg: {
            baseTint: 16777215,
            baseSprite: "player-base-lustrous-paladin.img",
            handTint: 0xffffff,
            handSprite: "player-hands-lustrous-paladin.img",
            footTint: 0xffffff,
            footSprite: "player-hands-lustrous-paladin.img",
            backpackTint: 16768256,
            backpackSprite: "player-circle-base-01.img",
            frontSpritePos: { x: -1, y: 0 },
            frontSprite: "player-accessory-lustrous-paladin.img",
        },
        lootImg: {
            sprite: "loot-lustrous-paladin-outfit.img",
            tint: 16777215,
        },
        rarity: 3,
    }),

    outfitAstronaut: defineOutfitSkin("outfitBase", {
        name: "Astronaut",
        noDropOnDeath: true,

        rarity: 4,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-astronaut.img",
            handTint: 0xffffff,
            handSprite: "player-hands-astronaut.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-astronaut.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-accessory-outfitAstronaut.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitAstronaut.img",
            tint: 0xffffff,
        },
    }),

    outfitDiamondy: defineOutfitSkin("outfitBase", {
        name: "Diamondy",
        noDropOnDeath: true,

        rarity: 5,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-diamondy.img",
            handTint: 0xffffff,
            handSprite: "player-hands-diamondy.img",
            footTint: 0xf8c137,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-diamondy.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-accessory-outfitDiamondy.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitDiamondy.img",
            tint: 0xffffff,
        },
    }),

    outfitMecha: defineOutfitSkin("outfitBase", {
        name: "Mecha",
        noDropOnDeath: true,

        rarity: 5,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-mecha.img",
            handTint: 0xffffff,
            handSprite: "player-hands-outfitMecha.img",
            footTint: 0x5b7eda,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-mecha.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-accessory-outfitMecha.img",
        },
        lootImg: {
            sprite: "loot-shirt-outfitMecha.img",
            tint: 0xffffff,
        },
    }),

    outfitILavaYou: defineOutfitSkin("outfitBase", {
        name: "I Lava You",
        noDropOnDeath: true,

        rarity: 4,

        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-i-lava-you.img",
            handTint: 0xffffff,
            handSprite: "player-hands-i-lava-you.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-i-lava-you.img",
            frontSpritePos: { x: -2, y: 0 },
            frontSprite: "player-accessory-i-lava-you.img",
        },
        lootImg: {
            sprite: "loot-i-lava-you-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitIgris: defineOutfitSkin("outfitBase", {
        name: "Igris",
        noDropOnDeath: true,

        rarity: 4,

        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-igris.img",
            handTint: 0xffffff,
            handSprite: "player-hand-igris.img",
            footTint: 0xffffff,
            footSprite: "player-hand-igris.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-igris.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-accessory-igris.img",
        },
        lootImg: {
            sprite: "loot-outfit-igris.img",
            tint: 0xffffff,
        },
    }),

    outfitKingGalaxy: defineOutfitSkin("outfitBase", {
        name: "King Galaxy",
        noDropOnDeath: true,

        rarity: 4,
        lore: "Created by AMBUSH",

        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-king-galaxy.img",
            handTint: 0xffffff,
            handSprite: "player-hands-king-galaxy.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-king-galaxy.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-accessory-king-galaxy.img",
        },
        lootImg: {
            sprite: "loot-king-galaxy-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitJuleVerny: defineOutfitSkin("outfitBase", {
        name: "Jule Verny",
        noDropOnDeath: true,

        rarity: 5,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-jule-verny.img",
            handTint: 0xffffff,
            handSprite: "player-hands-jule-verny.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-jule-verny.img",
            frontSpritePos: { x: -6, y: 0 },
            frontSprite: "player-accessory-jule-verny.img",
        },
        lootImg: {
            sprite: "loot-jule-verny-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitGhoulFire: defineOutfitSkin("outfitBase", {
        name: "Blue Burns",
        noDropOnDeath: true,

        rarity: 5,
        lore: "Created by earldre",

        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-ghoul-fire.img",
            handTint: 0xffffff,
            handSprite: "player-hands-ghoul-fire.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-ghoul-fire.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-accessory-ghoul-fire.img",
        },
        lootImg: {
            sprite: "loot-ghoul-fire-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitAhoy: defineOutfitSkin("outfitBase", {
        name: "Ahoy",
        noDropOnDeath: true,

        rarity: 5,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-ahoy.img",
            handTint: 0xffffff,
            handSprite: "player-hands-ahoy.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-ahoy.img",
            frontSpritePos: { x: -9, y: 0 },
            frontSprite: "player-accessory-ahoy.img",
        },
        lootImg: {
            sprite: "loot-ahoy-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitBuckTeeth: defineOutfitSkin("outfitBase", {
        name: "Buck Teeth",
        noDropOnDeath: true,

        rarity: 4,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-buck-teeth.img",
            handTint: 0xffffff,
            handSprite: "player-hands-buck-teeth.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-buck-teeth.img",
            frontSpritePos: { x: 5, y: 0 },
            frontSprite: "player-accessory-buck-teeth.img",
        },
        lootImg: {
            sprite: "loot-buck-teeth-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitPoinsetee: defineOutfitSkin("outfitBase", {
        //blitz special DO NOT PUT IN THE PASS
        name: "Poinsetee",
        noDropOnDeath: true,

        rarity: 3,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-poinsetee.img",
            handTint: 0xffffff,
            handSprite: "player-hands-poinsetee.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-poinsetee.img",
            frontSpritePos: { x: -3, y: 0 },
            frontSprite: "player-accessory-poinsetee.img",
        },
        lootImg: {
            sprite: "loot-poinsetee-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitSnowyClaus: defineOutfitSkin("outfitBase", {
        name: "Snowy Claus",
        noDropOnDeath: true,

        rarity: 3,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-snowy-claus.img",
            handTint: 0xffffff,
            handSprite: "player-hands-snowy-claus.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-snowy-claus.img",
            frontSpritePos: { x: -1, y: 1.4 },
            frontSprite: "player-accessory-snowy-claus.img",
        },
        lootImg: {
            sprite: "loot-snowy-claus-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitCamoDeer: defineOutfitSkin("outfitBase", {
        name: "Camo Deer",
        noDropOnDeath: true,

        rarity: 4,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-camo-deer.img",
            handTint: 0xffffff,
            handSprite: "player-hands-camo-deer.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-camo-deer.img",
            frontSpritePos: { x: 5, y: 0 },
            frontSprite: "player-accessory-camo-deer.img",
        },
        lootImg: {
            sprite: "loot-camo-deer-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitDisasteroid: defineOutfitSkin("outfitBase", {
        name: "Disasteroid",
        noDropOnDeath: true,

        rarity: 5,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-disasteroid.img",
            handTint: 0xffffff,
            handSprite: "player-hands-disasteroid.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-disasteroid.img",
            frontSpritePos: { x: -10, y: -1.8 },
            frontSprite: "player-accessory-disasteroid.img",
        },
        lootImg: {
            sprite: "loot-disasteroid-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitIdDie4U: defineOutfitSkin("outfitBase", {
        name: "Id Die 4 U",
        noDropOnDeath: true,

        rarity: 5,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-id-die-4-u.img",
            handTint: 0xffffff,
            handSprite: "player-hands-id-die-4-u.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-id-die-4-u.img",
            frontSpritePos: { x: -5, y: 0 },
            frontSprite: "player-accessory-id-die-4-u.img",
        },
        lootImg: {
            sprite: "loot-id-die-4-u-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitMwow: defineOutfitSkin("outfitBase", {
        name: "MEOW",
        noDropOnDeath: true,
        rarity: 5,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-01.img",
            handTint: 0xffffff,
            handSprite: "player-hands-yin-yang.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-moosli.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-accessory-meow.img",
            aboveHand: true,
        },
        lootImg: {
            sprite: "loot-shirt-outfitMeow.img",
            tint: 0xffffff,
        },
    }),

    outfitNeckNapkin: defineOutfitSkin("outfitBase", {
        name: "Neck Napkin",
        noDropOnDeath: true,

        rarity: 1,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-neck-napkin.img",
            handTint: 0xffffff,
            handSprite: "player-hands-neck-napkin.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-neck-napkin.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-accessory-neck-napkin.img",
        },
        lootImg: {
            sprite: "loot-neck-napkin-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitTheySeeMeRolling: defineOutfitSkin("outfitBase", {
        name: "They See Me Rolling",
        noDropOnDeath: true,

        rarity: 2,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-they-see-me-rolling.img",
            handTint: 0xffffff,
            handSprite: "player-hands-they-see-me-rolling.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-they-see-me-rolling.img",
            frontSpritePos: { x: 0, y: 0 },
            frontSprite: "player-accessory-they-see-me-rolling.img",
        },
        lootImg: {
            sprite: "loot-they-see-me-rolling-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitGoodFeather: defineOutfitSkin("outfitBase", {
        name: "Good Feather",
        noDropOnDeath: true,

        rarity: 3,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-good-feather.img",
            handTint: 0xffffff,
            handSprite: "player-hands-good-feather.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-good-feather.img",
            frontSpritePos: { x: -8, y: 0 },
            frontSprite: "player-accessory-good-feather.img",
        },
        lootImg: {
            sprite: "loot-good-feather-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitNachoHat: defineOutfitSkin("outfitBase", {
        name: "Nacho Hat",
        noDropOnDeath: true,

        rarity: 3,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-nacho-hat.img",
            handTint: 0xffffff,
            handSprite: "player-hands-nacho-hat.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-nacho-hat.img",
            frontSpritePos: { x: -10, y: 0 },
            frontSprite: "player-accessory-nacho-hat.img",
        },
        lootImg: {
            sprite: "loot-nacho-hat-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitSuppaPoncho: defineOutfitSkin("outfitBase", {
        name: "Suppa Poncho",
        noDropOnDeath: true,

        rarity: 3,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-suppa-poncho.img",
            handTint: 0xffffff,
            handSprite: "player-hands-suppa-poncho.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-suppa-poncho.img",
            frontSpritePos: { x: -11, y: 0 },
            frontSprite: "player-accessory-suppa-poncho.img",
        },
        lootImg: {
            sprite: "loot-suppa-poncho-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitRanchDressing: defineOutfitSkin("outfitBase", {
        name: "Ranch Dressing",
        noDropOnDeath: true,

        rarity: 4,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-ranch-dressing.img",
            handTint: 0xffffff,
            handSprite: "player-hands-ranch-dressing.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-ranch-dressing.img",
            frontSpritePos: { x: -4.3, y: -2 },
            frontSprite: "player-accessory-ranch-dressing.img",
        },
        lootImg: {
            sprite: "loot-ranch-dressing-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitSirLoin: defineOutfitSkin("outfitBase", {
        name: "Sir Loin",
        noDropOnDeath: true,

        rarity: 5,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-sir-loin.img",
            handTint: 0xffffff,
            handSprite: "player-hands-sir-loin.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-sir-loin.img",
            frontSpritePos: { x: 3, y: 0 },
            frontSprite: "player-accessory-sir-loin.img",
        },
        lootImg: {
            sprite: "loot-sir-loin-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitMoosli: defineOutfitSkin("outfitBase", {
        name: "Moosli",
        noDropOnDeath: true,

        rarity: 5,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-moosli.img",
            handTint: 0xffffff,
            handSprite: "player-hands-moosli.img",
            footTint: 0xffffff,
            footSprite: "player-feet-01.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-moosli.img",
            frontSpritePos: { x: 3, y: 0 },
            frontSprite: "player-accessory-moosli.img",
        },
        lootImg: {
            sprite: "loot-moosli-outfit.img",
            tint: 0xffffff,
        },
    }),

    outfitTopOnePercent: defineOutfitSkin("outfitBase", {
        name: "Top 1%",
        noDropOnDeath: true,
        lore: "Season 1 clan winner",
        rarity: 5,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitSzn1stPlace.img",
            handTint: 0x1c1c1c,
            handSprite: "player-hands-01.img",
            footTint: 0x1c1c1c,
            footSprite: "player-feet-01.img",
            backpackTint: 0x1c1c1c,
            backpackSprite: "player-circle-base-01.img",
            frontSpritePos: { x: -7, y: 0 },
            frontSprite: "player-accessory-outfitSzn1stPlace.img",
        },
        lootImg: {
            sprite: "loot-Szn1stPlayers.img",
            tint: 0xffffff,
        },
    }),

    outfitTopTwoPercent: defineOutfitSkin("outfitBase", {
        name: "Top 2%",
        noDropOnDeath: true,
        lore: "Season 1 clan winner",
        rarity: 5,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitSzn1-2ndPlace.img",
            handTint: 0x1c1c1c,
            handSprite: "player-hands-01.img",
            footTint: 0x1c1c1c,
            footSprite: "player-feet-01.img",
            backpackTint: 0x1c1c1c,
            backpackSprite: "player-circle-base-01.img",
            frontSpritePos: { x: -7, y: 0 },
            frontSprite: "player-accessory-outfitSzn1-2ndPlace.img",
        },
        lootImg: {
            sprite: "loot-Szn1-2ndPlayers.img",
            tint: 0xffffff,
        },
    }),

    outfitTopThreePercent: defineOutfitSkin("outfitBase", {
        name: "Top 3%",
        noDropOnDeath: true,
        lore: "Season 1 clan winner",
        rarity: 5,
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitSzn1-3rdPlace.img",
            handTint: 0x1c1c1c,
            handSprite: "player-hands-01.img",
            footTint: 0x1c1c1c,
            footSprite: "player-feet-01.img",
            backpackTint: 0x1c1c1c,
            backpackSprite: "player-circle-base-01.img",
            frontSpritePos: { x: -7, y: 0 },
            frontSprite: "player-accessory-outfitSzn1-3rdPlace.img",
        },
        lootImg: {
            sprite: "loot-Szn1-3rdPlayers.img",
            tint: 0xffffff,
        },
    }),

    outfitReTag: defineOutfitSkin("outfitBase", {
        name: "RSRV",
        noDropOnDeath: true,
        rarity: 5,
        lore: "Resurviv discord tag user",
        skinImg: {
            baseTint: 0xffffff,
            baseSprite: "player-base-outfitvitamnD.img",
            handTint: 0xffffff,
            handSprite: "player-hands-starry-night.img",
            footTint: 0xffffff,
            footSprite: "player-hands-starry-night.img",
            backpackTint: 0xffffff,
            backpackSprite: "player-back-rsrv-tag.img",
            frontSpritePos: { x: -2, y: 0 },
            frontSprite: "player-accessory-rsrv-tag.img",
            aboveHand: false,
        },
        lootImg: {
            sprite: "loot-rsrv-tag.img",
            tint: 0xffffff,
        },
    }),
};

export const OutfitDefs = { ...BaseDefs, ...SkinDefs };
