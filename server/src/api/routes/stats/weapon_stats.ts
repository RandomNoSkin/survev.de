import { Hono } from "hono";
import { type WeaponStatsResponse, zWeaponStatsRequest } from "../../../../../shared/types/stats.ts";
import { databaseEnabledMiddleware, rateLimitMiddleware, validateParams } from "../../auth/middleware.ts";
import { weaponStatsSqlQuery } from "../../db/weaponStats.ts";
import type { Context } from "../../index.ts";

export const weaponStatsRouter = new Hono<Context>();

weaponStatsRouter.post(
    "/",
    databaseEnabledMiddleware,
    rateLimitMiddleware(40, 60 * 1000),
    validateParams(zWeaponStatsRequest),
    async (c) => {
        const { from, to, mapIdFilter, teamModeFilter } = c.req.valid("json");

        const data = await weaponStatsSqlQuery(from, to, mapIdFilter, teamModeFilter);

        return c.json<WeaponStatsResponse>(data, 200);
    },
);
