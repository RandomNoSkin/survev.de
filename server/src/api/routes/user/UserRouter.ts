import { and, eq, gte, inArray, ne, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { UnlockDefs } from "../../../../../shared/defs/gameObjects/unlockDefs";
import {
    type GetPassResponse,
    type LoadoutResponse,
    type ProfileResponse,
    type RefreshQuestResponse,
    type SetPassUnlockResponse,
    type UsernameResponse,
    zGetPassRequest,
    zLoadoutRequest,
    zRefreshQuestRequest,
    zSetItemStatusRequest,
    zSetPassUnlockRequest,
    zUsernameRequest,
} from "../../../../../shared/types/user";
import loadout from "../../../../../shared/utils/loadout";
import { apiPrivateRouter, validateUserName } from "../../../utils/serverHelpers";
import { server } from "../../apiServer";
import {
    authMiddleware,
    databaseEnabledMiddleware,
    rateLimitMiddleware,
    validateParams,
} from "../../auth/middleware";
import { db } from "../../db";
import { itemsTable, matchDataTable, usersTable } from "../../db/schema";
import type { Context } from "../../index";
import {
    getTimeUntilNextUsernameChange,
    logoutUser,
    sanitizeSlug,
} from "./auth/authUtils";
import { PassDefs } from "../../../../../shared/defs/gameObjects/passDefs";
import { ExperienceConverter, GameConfig } from "../../../../../shared/gameConfig";
import { QuestDefs } from "../../../../../shared/defs/gameObjects/questDefs";

export const UserRouter = new Hono<Context>();

UserRouter.use(databaseEnabledMiddleware);
UserRouter.use(rateLimitMiddleware(40, 60 * 1000));
UserRouter.use(authMiddleware);

UserRouter.post("/profile", async (c) => {
    const user = c.get("user")!;

    const {
        loadout,
        slug,
        linked,
        username,
        usernameSet,
        lastUsernameChangeTime,
        banned,
        banReason,
    } = user;

    if (banned) {
        const session = c.get("session")!;
        await logoutUser(c, session.id);

        return c.json<ProfileResponse>({
            banned: true,
            reason: banReason,
        });
    }

    const timeUntilNextChange = getTimeUntilNextUsernameChange(lastUsernameChangeTime);

    const defaultUnlockItems = UnlockDefs["unlock_default"].unlocks;

    const items = await db
        .select({
            type: itemsTable.type,
            timeAcquired: itemsTable.timeAcquired,
            source: itemsTable.source,
            status: itemsTable.status,
        })
        .from(itemsTable)
        .where(
            and(
                eq(itemsTable.userId, user.id),
                notInArray(itemsTable.type, defaultUnlockItems),
            ),
        );

    return c.json<ProfileResponse>(
        {
            success: true,
            profile: {
                slug,
                linked,
                username,
                usernameSet,
                usernameChangeTime: timeUntilNextChange,
            },
            loadout,
            items: items,
        },
        200,
    );
});

UserRouter.post(
    "/username",
    validateParams(zUsernameRequest, { result: "invalid" } satisfies UsernameResponse),
    async (c) => {
        const user = c.get("user")!;
        const { username } = c.req.valid("json");
        const timeUntilNextChange = getTimeUntilNextUsernameChange(
            user.lastUsernameChangeTime,
        );

        if (timeUntilNextChange > 0) {
            return c.json<UsernameResponse>({ result: "change_time_not_expired" }, 200);
        }

        const { validName, originalWasInvalid } = validateUserName(username);

        if (originalWasInvalid) {
            return c.json<UsernameResponse>({ result: "invalid" }, 200);
        }

        const slug = sanitizeSlug(validName);

        const slugTaken = await db.query.usersTable.findFirst({
            where: and(eq(usersTable.slug, slug), ne(usersTable.id, user.id)),
            columns: {
                id: true,
            },
        });

        if (slugTaken) {
            return c.json<UsernameResponse>({ result: "taken" }, 200);
        }

        try {
            await db
                .update(usersTable)
                .set({
                    username: validName,
                    slug: slug,
                    usernameSet: true,
                    lastUsernameChangeTime: new Date(),
                })
                .where(eq(usersTable.id, user.id));
        } catch (err) {
            server.logger.error("/api/username: Error updating username", err);
            return c.json<UsernameResponse>({ result: "failed" }, 500);
        }

        return c.json<UsernameResponse>({ result: "success" }, 200);
    },
);

UserRouter.post("/loadout", validateParams(zLoadoutRequest), async (c) => {
    const user = c.get("user")!;
    const { loadout: userLoadout } = c.req.valid("json");

    const items = await db
        .select({
            type: itemsTable.type,
            timeAcquired: itemsTable.timeAcquired,
            source: itemsTable.source,
            status: itemsTable.status,
        })
        .from(itemsTable)
        .where(eq(itemsTable.userId, user.id));

    const validatedLoadout = loadout.validateWithAvailableItems(userLoadout, items);

    await db
        .update(usersTable)
        .set({ loadout: validatedLoadout })
        .where(eq(usersTable.id, user.id));

    return c.json<LoadoutResponse>(
        {
            loadout: validatedLoadout,
        },
        200,
    );
});

UserRouter.post("/logout", async (c) => {
    const session = c.get("session")!;

    await logoutUser(c, session.id);

    return c.json({}, 200);
});

UserRouter.post("/delete", async (c) => {
    const user = c.get("user")!;
    const session = c.get("session")!;

    // logout out the user
    await logoutUser(c, session.id);

    // delete the account
    await db.delete(usersTable).where(eq(usersTable.id, user.id));

    // remove reference to the user from match data
    await db
        .update(matchDataTable)
        .set({ userId: null })
        .where(eq(matchDataTable.userId, user.id));

    return c.json({}, 200);
});

UserRouter.post("/set_item_status", validateParams(zSetItemStatusRequest), async (c) => {
    const user = c.get("user")!;
    const { itemTypes, status } = c.req.valid("json");

    await db
        .update(itemsTable)
        .set({
            status: status,
        })
        .where(and(eq(itemsTable.userId, user.id), inArray(itemsTable.type, itemTypes)));

    return c.json({}, 200);
});

UserRouter.post("/reset_stats", async (c) => {
    const user = c.get("user")!;

    await db
        .update(matchDataTable)
        .set({ userId: null })
        .where(eq(matchDataTable.userId, user.id));

    return c.json({}, 200);
});

//
// NOT IMPLEMENTED
//
UserRouter.post("/set_pass_unlock", validateParams(zSetPassUnlockRequest), (c) => {
    return c.json<SetPassUnlockResponse>({ success: true }, 200);
});

UserRouter.post("/get_pass", validateParams(zGetPassRequest), async (c) => {
    const user = c.get("user")!;
    const passType = GameConfig.serverSettings.currentPass;
    const seasonStart = new Date(GameConfig.serverSettings.seasonStart);

    await apiPrivateRouter.check_for_unlocks.$post({
        json: {
            userId: user.id,
        },
    });
    console.log("checked for unlocks");

    const stats = await db
        .select({
            gameId: matchDataTable.gameId,
            kills: sql<number>`max(${matchDataTable.kills})`,
            timeAlive: sql<number>`max(${matchDataTable.timeAlive})`,
            rank: sql<number>`min(${matchDataTable.rank})`,
            entryCount: sql<number>`count(*)`,
        })
        .from(matchDataTable)
        .where(
            and(
                eq(matchDataTable.userId, user.id),
                gte(matchDataTable.createdAt, seasonStart),
            ),
        )
        .groupBy(matchDataTable.gameId)
        .having(sql`count(*) = 1`);

    const totalKills = stats.reduce((acc, curr) => acc + curr.kills, 0);
    const totalTimeAlive = stats.reduce((acc, curr) => acc + curr.timeAlive, 0);
    const totalWins = stats.reduce((acc, curr) => acc + (curr.rank === 1 ? 1 : 0), 0);

    const totalXp =
        totalKills * ExperienceConverter.kill +
        totalWins * ExperienceConverter.win +
        totalTimeAlive * ExperienceConverter.timeSurvived;

    const { level, xp } = getPassLevelAndXp(passType, totalXp);

    const pass = {
        type: passType,
        level,
        xp,
        totalXp,
        newItems: false,
    };

    const quests = Object.keys(QuestDefs).map((questType, idx) => {
    const questDef = QuestDefs[questType];

            return {
            idx,
            type: questType,
            timeAcquired: Date.now(),
            progress: 0,
            target: questDef.target,
            complete: false,
            rerolled: false,
            timeToRefresh: 0,
        };
    });

    return c.json<GetPassResponse>(
        {
            success: true,
            pass,
            quests,
            questPriv: "",
        },
        200,
    );
});

UserRouter.post("/refresh_quest", validateParams(zRefreshQuestRequest), (c) => {
    return c.json<RefreshQuestResponse>({ success: true }, 200);
});


const PASS_MAX_LEVEL = GameConfig.serverSettings.passMaxLevel;

function getPassLevelXp(passType: string, level: number) {
    const passDef = PassDefs[passType];
    const levelIdx = level - 1;

    if (levelIdx < passDef.xp.length) {
        return passDef.xp[levelIdx];
    }

    // aktuell gleiches Verhalten wie dein bestehendes passUtil
    return passDef.xp[passDef.xp.length - 1];
}

function getPassLevelAndXp(passType: string, passXp: number) {
    let xp = passXp;
    let level = 1;

    while (level < PASS_MAX_LEVEL) {
        const levelXp = getPassLevelXp(passType, level);

        if (xp < levelXp) {
            break;
        }

        xp -= levelXp;
        level++;
    }

    return {
        level,
        xp,
        nextLevelXp: getPassLevelXp(passType, level),
    };
}