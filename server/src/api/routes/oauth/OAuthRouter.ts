import { Hono } from "hono";
import type { Context } from "../../index.ts";
import { AppsRouter } from "./apps.ts";
import { AuthorizeRouter } from "./authorize.ts";
import { DeviceRouter } from "./device.ts";
import { GrantsRouter } from "./grants.ts";
import { TokenRouter } from "./token.ts";

export const OAuthRouter = new Hono<Context>();

OAuthRouter.route("/apps", AppsRouter);
OAuthRouter.route("/authorize", AuthorizeRouter);
OAuthRouter.route("/device", DeviceRouter);
OAuthRouter.route("/token", TokenRouter);
OAuthRouter.route("/grants", GrantsRouter);
