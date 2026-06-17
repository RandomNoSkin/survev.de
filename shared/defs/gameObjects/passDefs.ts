/** Golden Fries granted by a `golden_fries` pass reward when its `amount` is omitted.
 *  Shared so the client (tooltip preview) and server (actual grant) stay in sync. */
export const DEFAULT_PASS_GOLDEN_FRIES = 10;

export interface PassDef {
    readonly type: "pass";
    xp: number[];
    items: Array<{
        level: number;
        item: string;
        /** Only used for the `golden_fries` reward item: how many Golden Fries this
         *  level grants. Defaults to a server-side fallback when omitted. */
        amount?: number;
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
        items: [
            { level: 2,  item: "outfitWheat" },
            { level: 4,  item: "emote_sun" },
            { level: 5,  item: "heal_sun" },
            { level: 6,  item: "emote_beachball" },
            { level: 8,  item: "outfitSunrise" },
            { level: 10, item: "boost_drop" },
            { level: 12, item: "emote_flamingo" },
            { level: 14, item: "outfitWave" },
            { level: 15, item: "heal_wave" },
            { level: 16, item: "outfitAqua" },
            { level: 18, item: "emote_watermelon" },
            { level: 20, item: "outfitTide" },
            { level: 22, item: "outfitWaterElem" },
            { level: 24, item: "boost_flame" },
            { level: 25, item: "outfitRoyalFortune" },
            { level: 26, item: "emote_surfboard" },
            { level: 28, item: "outfitCobaltShell" },
            { level: 30, item: "outfitTropicalStorm" },
            { level: 32, item: "emote_palm" },
            { level: 34, item: "outfitVerde" },
            { level: 35, item: "huntsman_rugged" },
            { level: 36, item: "outfitBeachCamo" },
            { level: 38, item: "bowie_vintage" },
            { level: 40, item: "outfitKhaki" },
            //bonus pass
            { level: 50, item: "bowie_frontier" },
            { level: 75, item: "karambit_prismatic" },
            { level: 99, item: "outfitSpetsnaz" },
            // Golden Fries: a ramping payout across the bonus pass (not on every level),
            // on non-cosmetic levels so nothing doubles up. Sums to exactly 500 by lvl 99.
            { level: 45, item: "golden_fries", amount: 20 },
            { level: 55, item: "golden_fries", amount: 30 },
            { level: 60, item: "golden_fries", amount: 40 },
            { level: 65, item: "golden_fries", amount: 50 },
            { level: 70, item: "golden_fries", amount: 60 },
            { level: 80, item: "golden_fries", amount: 80 },
            { level: 85, item: "golden_fries", amount: 100 },
            { level: 90, item: "golden_fries", amount: 120 },
        ],
    },
    pass_survivr3: {
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
            //most to least: emotes, outfits, heal/boost, melee skins
        items: [
            { level: 2,  item: "" },
            { level: 4,  item: "" },
            { level: 5,  item: "" },
            { level: 6,  item: "" },
            { level: 8,  item: "" },
            { level: 10, item: "" },
            { level: 12, item: "" },
            { level: 14, item: "" },
            { level: 15, item: "" },
            { level: 16, item: "" },
            { level: 18, item: "" },
            { level: 20, item: "" },
            { level: 22, item: "" },
            { level: 24, item: "" },
            { level: 25, item: "" },
            { level: 26, item: "" },
            { level: 28, item: "" },
            { level: 30, item: "" },
            { level: 32, item: "" },
            { level: 34, item: "" },
            { level: 35, item: "" }, // lvl 35 melee
            { level: 36, item: "" },
            { level: 38, item: "" }, // lvl 38 melee
            { level: 40, item: "" }, // lvl 40 very rare outfit
            //bonus pass
            { level: 50, item: "" }, // lvl 50 very rare boost or heal partice (with black outline and shading)
            { level: 75, item: "" }, // lvl 75 very rare melee weapon
            { level: 99, item: "" }, // lvl 99 very very rare outfit
        ],
    },
};
