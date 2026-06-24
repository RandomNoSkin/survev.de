import { Hono } from "hono";
import { gameViewRouter } from "./gameView";
import { leaderboardRouter } from "./leaderboard";
import { matchDataRouter } from "./match_data";
import { matchHistoryRouter } from "./match_history";
import { serverStatsRouter } from "./serverStats";
import { UserStatsRouter } from "./user_stats";

export const StatsRouter = new Hono();

StatsRouter.route("/user_stats", UserStatsRouter);
StatsRouter.route("/match_history", matchHistoryRouter);
StatsRouter.route("/match_data", matchDataRouter);
StatsRouter.route("/leaderboard", leaderboardRouter);
StatsRouter.route("/server_stats", serverStatsRouter);
StatsRouter.route("/game_view", gameViewRouter);
