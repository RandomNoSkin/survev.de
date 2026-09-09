import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type MatchHistoryResponse, zMatchHistoryRequest } from "../../../../../shared/types/stats.ts";
import { util } from "../../../../../shared/utils/util.ts";
import { databaseEnabledMiddleware, rateLimitMiddleware, validateParams } from "../../auth/middleware.ts";
import { db } from "../../db/index.ts";
import { matchHistoryQuery } from "../../db/matchHistory.ts";
import { usersTable } from "../../db/schema.ts";
import type { Context } from "../../index.ts";

export const matchHistoryRouter = new Hono<Context>();

matchHistoryRouter.post(
    "/",
    databaseEnabledMiddleware,
    rateLimitMiddleware(40, 60 * 1000),
    validateParams(zMatchHistoryRequest),
    async (c) => {
        const { slug, offset, teamModeFilter } = c.req.valid("json");

        const result = await db.query.usersTable.findFirst({
            where: eq(usersTable.slug, slug),
            columns: {
                id: true,
            },
        });

        if (result?.id == undefined) {
            return c.json({}, 200);
        }

        const { id: userId } = result;
        const data = await matchHistoryQuery({
            userId,
            teamModeFilter,
            from: new Date(Date.now() - util.daysToMs(7)),
            to: new Date(),
            offset,
            limit: 10,
        });

        return c.json<MatchHistoryResponse>(data);
    },
);
