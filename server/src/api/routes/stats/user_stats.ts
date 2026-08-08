import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type UserStatsResponse, zUserStatsRequest } from "../../../../../shared/types/stats.ts";
import { databaseEnabledMiddleware, rateLimitMiddleware, validateParams } from "../../auth/middleware.ts";
import { db } from "../../db/index.ts";
import { usersTable } from "../../db/schema.ts";
import { emptyUserStats, userStatsSqlQuery } from "../../db/stats.ts";
import type { Context } from "../../index.ts";

export const UserStatsRouter = new Hono<Context>();

UserStatsRouter.post(
    "/",
    databaseEnabledMiddleware,
    rateLimitMiddleware(40, 60 * 1000),
    validateParams(zUserStatsRequest),
    async (c) => {
        const { interval, mapIdFilter, slug } = c.req.valid("json");

        const result = await db.query.usersTable.findFirst({
            where: eq(usersTable.slug, slug),
            columns: {
                id: true,
                banned: true,
            },
        });

        if (!result) {
            return c.json(emptyUserStats, 200);
        }

        const { id: userId } = result;

        const data = await userStatsSqlQuery(userId, mapIdFilter, interval);

        return c.json<UserStatsResponse>(data, 200);
    },
);
