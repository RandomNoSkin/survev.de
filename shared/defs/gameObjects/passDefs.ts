export interface PassDef {
    readonly type: "pass";
    xp: number[];
    items: Array<{
        level: number;
        item: string;
    }>;
}

export const PassDefs: Record<string, PassDef> = {
    pass_survivr1: {
        type: "pass",
        xp: [
            50, 50, 50, 50, 50, 50, 50, 50, 75, 75, 75, 75, 75, 75, 100, 100, 200, 250,
            300, 350, 400, 400, 400,
        ],
        items: [
            {
                level: 2,
                item: "outfitParma",
            },
            {
                level: 3,
                item: "heal_heart",
            },
            {
                level: 4,
                item: "emote_bandagedface",
            },
            {
                level: 5,
                item: "outfitWhite",
            },
            {
                level: 6,
                item: "boost_star",
            },
            {
                level: 7,
                item: "emote_ok",
            },
            {
                level: 8,
                item: "outfitRed",
            },
            {
                level: 9,
                item: "heal_moon",
            },
            {
                level: 10,
                item: "emote_pooface",
            },
            {
                level: 11,
                item: "knuckles_rusted",
            },
            {
                level: 12,
                item: "boost_naturalize",
            },
            {
                level: 13,
                item: "emote_ghost_base",
            },
            {
                level: 14,
                item: "outfitDarkGloves",
            },
            {
                level: 15,
                item: "heal_tomoe",
            },
            {
                level: 16,
                item: "emote_picassoface",
            },
            {
                level: 17,
                item: "outfitCarbonFiber",
            },
            {
                level: 18,
                item: "boost_shuriken",
            },
            {
                level: 19,
                item: "emote_rainbow",
            },
            {
                level: 20,
                item: "outfitParmaPrestige",
            },
            {
                level: 21,
                item: "knuckles_heroic",
            },
            {
                level: 30,
                item: "outfitTurkey",
            },
            {
                level: 50,
                item: "bayonet_rugged",
            },
            {
                level: 99,
                item: "bayonet_woodland",
            },
        ],
    },
    pass_survivr2: {
        type: "pass",
        xp: [
            10,10,10,10,10,
            25,25,25,25,25,
            40,40,40,40,40,
            55,55,55,55,55,
            70,70,70,70,70,
            85,85,85,85,85,
            100,100,100,100,100,
            115,115,115,115,115,
            //bonus pass
            130,130,130,130,130,
            130,130,130,130,130,
            145,145,145,145,145,
            145,145,145,145,145,
            160,160,160,160,160,
            160,160,160,160,160,
            175,175,175,175,175,
            175,175,175,175,175,
            190,190,190,190,190,
            190,190,190,190,190,
            205,205,205,205,205,
            205,205,205,205,
            ],
            //outfitWheat, outfitImperial, outfitWoodsCloak, outfitVerde, outfitPineapple, outfitSpetsnaz, outfitLumber
        items: [
            {
                level: 2,
                item: "outfitWheat",
            },
            {
                level: 4,
                item: "heal_heart",
            },
            {
                level: 5,
                item: "emote_bandagedface",
            },
            {
                level: 6,
                item: "outfitWhite",
            },
            {
                level: 8,
                item: "boost_star",
            },
            {
                level: 10,
                item: "emote_ok",
            },
            {
                level: 12,
                item: "outfitRed",
            },
            {
                level: 14,
                item: "heal_moon",
            },
            {
                level: 15,
                item: "emote_pooface",
            },
            {
                level: 16,
                item: "knuckles_rusted",
            },
            {
                level: 18,
                item: "boost_naturalize",
            },
            {
                level: 20,
                item: "emote_ghost_base",
            },
            {
                level: 22,
                item: "outfitDarkGloves",
            },
            {
                level: 24,
                item: "heal_tomoe",
            },
            {
                level: 25,
                item: "emote_picassoface",
            },
            {
                level: 26,
                item: "outfitCarbonFiber",
            },
            {
                level: 28,
                item: "boost_shuriken",
            },
            {
                level: 30,
                item: "emote_rainbow",
            },
            {
                level: 32,
                item: "outfitParmaPrestige",
            },
            {
                level: 34,
                item: "knuckles_heroic",
            },
            {
                level: 35,
                item: "outfitTurkey",
            },
            {
                level: 36,
                item: "bayonet_rugged",
            },
            {
                level: 38,
                item: "bayonet_woodland",
            },
            {
                level: 40,
                item: "bayonet_woodland",
            },
            //bonus pass
            {
                level: 50,
                item: "bayonet_woodland",
            },
            {
                level: 75,
                item: "bayonet_woodland",
            },
            {
                level: 99,
                item: "bayonet_woodland",
            },
        ],
    },
};
