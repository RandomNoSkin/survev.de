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
    donatorSkin: string;
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
        donatorSkin: "outfitElf",
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
        donatorSkin: "karambit_fade",
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
            //most to least: goldenFries, emotes, outfits, deathEffects, heal/boost, melee skins
        items: [
            // Space/Cosmos theme. Golden Fries fill the free (non-cosmetic) levels:
            // ~2.5k across lvl 0-40 and ~2.5k across lvl 40-99 → the most frequent reward.
            // Cosmetic types strictly alternate (never two of the same type adjacent).
            { level: 2,  item: "emote_dove" },
            { level: 3,  item: "golden_fries", amount: 130 },
            { level: 4,  item: "outfitMeteor" },
            { level: 5,  item: "emote_saturn" },
            { level: 6,  item: "death_black_hole" },
            { level: 7,  item: "golden_fries", amount: 135 },
            { level: 8,  item: "emote_smh" },
            { level: 9,  item: "golden_fries", amount: 140 },
            { level: 10, item: "outfitNoir" },
            { level: 11, item: "golden_fries", amount: 145 },
            { level: 12, item: "emote_rocket" },
            { level: 13, item: "golden_fries", amount: 150 },
            { level: 14, item: "heal_nebula" },
            { level: 15, item: "emote_ufo" },
            { level: 16, item: "outfitSunset" },
            { level: 17, item: "golden_fries", amount: 155 },
            { level: 18, item: "emote_comet" },
            { level: 19, item: "golden_fries", amount: 165 },
            { level: 20, item: "boost_nova" },
            { level: 21, item: "golden_fries", amount: 170 },
            { level: 22, item: "emote_astrohelmet" },
            { level: 23, item: "golden_fries", amount: 175 },
            { level: 24, item: "outfitGalaxy" },
            { level: 25, item: "heal_stardust" },
            { level: 26, item: "outfitYinyang" },
            { level: 27, item: "golden_fries", amount: 180 },
            { level: 28, item: "emote_shootingstar" },
            { level: 29, item: "golden_fries", amount: 185 },
            { level: 30, item: "death_sparkle" },
            { level: 31, item: "golden_fries", amount: 190 },
            { level: 32, item: "outfitAstronaut" },
            { level: 33, item: "golden_fries", amount: 195 },
            { level: 34, item: "emote_blackhole" },
            { level: 35, item: "karambit_woodland" }, // lvl 35 melee
            { level: 36, item: "death_magic_spark" },
            { level: 37, item: "golden_fries", amount: 200 },
            { level: 38, item: "huntsman_burnished" }, // lvl 38 melee
            { level: 39, item: "golden_fries", amount: 205 },
            { level: 40, item: "outfitKingGalaxy" }, // lvl 40 very rare outfit
            //bonus pass
            { level: 42, item: "golden_fries", amount: 55 },
            { level: 44, item: "golden_fries", amount: 60 },
            { level: 46, item: "golden_fries", amount: 60 },
            { level: 48, item: "golden_fries", amount: 65 },
            { level: 50, item: "boost_cosmic" }, // lvl 50 very rare boost particle (new, black outline + shading)
            { level: 52, item: "golden_fries", amount: 65 },
            { level: 54, item: "golden_fries", amount: 70 },
            { level: 56, item: "golden_fries", amount: 70 },
            { level: 58, item: "golden_fries", amount: 75 },
            { level: 60, item: "golden_fries", amount: 75 },
            { level: 62, item: "golden_fries", amount: 80 },
            { level: 64, item: "golden_fries", amount: 80 },
            { level: 66, item: "golden_fries", amount: 85 },
            { level: 68, item: "golden_fries", amount: 85 },
            { level: 70, item: "golden_fries", amount: 90 },
            { level: 72, item: "golden_fries", amount: 90 },
            { level: 74, item: "golden_fries", amount: 95 },
            { level: 75, item: "karambit_drowned" }, // lvl 75 very rare melee weapon
            { level: 76, item: "golden_fries", amount: 95 },
            { level: 78, item: "golden_fries", amount: 100 },
            { level: 80, item: "golden_fries", amount: 100 },
            { level: 82, item: "golden_fries", amount: 105 },
            { level: 84, item: "golden_fries", amount: 105 },
            { level: 86, item: "golden_fries", amount: 110 },
            { level: 88, item: "golden_fries", amount: 110 },
            { level: 90, item: "golden_fries", amount: 115 },
            { level: 92, item: "golden_fries", amount: 115 },
            { level: 94, item: "golden_fries", amount: 120 },
            { level: 96, item: "golden_fries", amount: 120 },
            { level: 98, item: "golden_fries", amount: 130 },
            { level: 99, item: "outfitDisasteroid" }, // lvl 99 very very rare outfit
        ],
        donatorSkin: "outfitVillageNinja",
    },
};
