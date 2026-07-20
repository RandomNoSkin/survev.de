import { Hono } from "hono";
import { gameViewRouter } from "./gameView.ts";
import { leaderboardRouter } from "./leaderboard.ts";
import { matchDataRouter } from "./match_data.ts";
import { matchHistoryRouter } from "./match_history.ts";
import { serverStatsRouter } from "./serverStats.ts";
import { UserLoadoutRouter } from "./user_loadout.ts";
import { UserStatsRouter } from "./user_stats.ts";

export const StatsRouter = new Hono();

StatsRouter.route("/user_stats", UserStatsRouter);
StatsRouter.route("/user_loadout", UserLoadoutRouter);
StatsRouter.route("/match_history", matchHistoryRouter);
StatsRouter.route("/match_data", matchDataRouter);
StatsRouter.route("/leaderboard", leaderboardRouter);
StatsRouter.route("/server_stats", serverStatsRouter);
StatsRouter.route("/game_view", gameViewRouter);
