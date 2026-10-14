import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { eq, ilike, or } from "drizzle-orm";
import { Hono } from "hono";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { Config } from "../config";
import { logModerationAction } from "../utils/serverHelpers";
import { ServerLogger } from "../utils/logger";
import { server } from "./apiServer";
import { db } from "./db";
import { usersTable } from "./db/schema";
import { superAdminHtml } from "./superAdmin.html";

const logger = new ServerLogger("SuperAdmin");
const HOST = Config.superAdmin.adress || "127.0.0.1";
const LOGS_DIR = path.resolve("logs");

const userColumns = {
    id: usersTable.id,
    slug: usersTable.slug,
    username: usersTable.username,
    owner: usersTable.owner,
    admin: usersTable.admin,
    moderator: usersTable.moderator,
    banned: usersTable.banned,
    premiumUntil: usersTable.premiumUntil,
    userCreated: usersTable.userCreated,
};

function isLoopback(addr: string | undefined) {
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

const app = new Hono();

// Binding to 127.0.0.1 keeps the network out; these two checks keep the owner's own
// browser from being used against it: the Host check defeats DNS rebinding, and the
// custom header forces a CORS preflight (which is never answered) on any cross-site call.
app.use("*", async (c, next) => {
    const port = Config.superAdmin.port;
    const host = c.req.header("host") ?? "";
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (!allowedHosts.includes(host) || !isLoopback(getConnInfo(c).remote.address)) {
        return c.text("Forbidden", 403);
    }
    if (c.req.path.startsWith("/api/") && c.req.header("x-superadmin") !== "1") {
        return c.text("Forbidden", 403);
    }
    await next();
});

app.get("/", (c) => c.html(superAdminHtml));

// ---- Roles ----

app.get("/api/users", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const where = q
        ? or(
            ilike(usersTable.username, `%${q.replace(/[%_\\]/g, "\\$&")}%`),
            ilike(usersTable.slug, `%${q.replace(/[%_\\]/g, "\\$&")}%`),
            eq(usersTable.id, q),
        )
        : or(
            eq(usersTable.owner, true),
            eq(usersTable.admin, true),
            eq(usersTable.moderator, true),
        );
    const users = await db.select(userColumns).from(usersTable).where(where).limit(50);
    return c.json({ users });
});

const zRoles = z.object({
    owner: z.boolean().optional(),
    admin: z.boolean().optional(),
    moderator: z.boolean().optional(),
});

app.post("/api/users/:id/roles", async (c) => {
    const id = c.req.param("id");
    const parsed = zRoles.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !Object.keys(parsed.data).length) {
        return c.json({ error: "invalid body" }, 400);
    }
    const [user] = await db
        .update(usersTable)
        .set(parsed.data)
        .where(eq(usersTable.id, id))
        .returning(userColumns);
    if (!user) return c.json({ error: "user not found" }, 404);
    const changes = Object.entries(parsed.data).map(([k, v]) => `${k}=${v}`).join(", ");
    logger.warn(`Roles changed for ${user.username} (${user.id}): ${changes}`);
    logModerationAction("Super admin: roles changed", [
        { name: "User", value: `${user.username} (${user.slug})` },
        { name: "Changes", value: changes },
    ]);
    return c.json({ user });
});

const zPremium = z.object({ days: z.number().int().min(0).max(3650) });

app.post("/api/users/:id/premium", async (c) => {
    const id = c.req.param("id");
    const parsed = zPremium.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const [current] = await db
        .select({ premiumUntil: usersTable.premiumUntil })
        .from(usersTable)
        .where(eq(usersTable.id, id));
    if (!current) return c.json({ error: "user not found" }, 404);

    const { days } = parsed.data;
    let premiumUntil: Date | null = null;
    if (days > 0) {
        const base = Math.max(Date.now(), current.premiumUntil?.getTime() ?? 0);
        premiumUntil = new Date(base + days * 24 * 60 * 60 * 1000);
    }
    const [user] = await db
        .update(usersTable)
        .set({ premiumUntil })
        .where(eq(usersTable.id, id))
        .returning(userColumns);
    logger.warn(
        `Premium for ${user.username} (${user.id}): ${days ? `+${days}d` : "removed"}`,
    );
    logModerationAction("Super admin: premium changed", [
        { name: "User", value: `${user.username} (${user.slug})` },
        { name: "Change", value: days ? `+${days} days` : "removed" },
    ]);
    return c.json({ user });
});

// ---- Server control + status ----

app.get("/api/status", async (c) => {
    const mem = process.memoryUsage();
    const api = {
        uptimeSec: Math.round(process.uptime()),
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        loadavg: os.loadavg(),
        cpus: os.cpus().length,
        totalmem: os.totalmem(),
        freemem: os.freemem(),
        hostname: os.hostname(),
    };
    const regions = await Promise.all(
        Object.entries(server.regions).map(async ([id, region]) => {
            const [status, games] = await Promise.all([
                region.getSystemStatus(),
                region.collectGameInfos(true),
            ]);
            return {
                id,
                verifiedOnly: region.verifiedOnly,
                status,
                games: Array.isArray(games?.data) ? games.data : [],
            };
        }),
    );
    return c.json({ api, regions });
});

function getRegion(id: string) {
    return Object.hasOwn(server.regions, id) ? server.regions[id] : undefined;
}

app.post("/api/regions/:id/max_games", async (c) => {
    const region = getRegion(c.req.param("id"));
    if (!region) return c.json({ error: "unknown region" }, 404);
    const body = await c.req.json().catch(() => null);
    const ok = await region.setMaxGames(Number(body?.maxGames));
    if (ok) logger.warn(`maxGames for ${region.id} set to ${body?.maxGames}`);
    return c.json({ ok });
});

app.post("/api/regions/:id/verified", async (c) => {
    const region = getRegion(c.req.param("id"));
    if (!region) return c.json({ error: "unknown region" }, 404);
    const body = await c.req.json().catch(() => null);
    await region.setServerVerified(!!body?.state);
    return c.json({ ok: true });
});

app.post("/api/regions/:id/games/:gameId/stop", async (c) => {
    const region = getRegion(c.req.param("id"));
    if (!region) return c.json({ error: "unknown region" }, 404);
    const gameId = c.req.param("gameId");
    const ok = await region.sendDashboardGameCmd(gameId, { action: "stop" });
    if (ok) logger.warn(`Game ${gameId} on ${region.id} stopped via super admin`);
    return c.json({ ok });
});

// ---- Logs ----

async function listLogFiles() {
    const names = await fs.readdir(LOGS_DIR).catch(() => [] as string[]);
    const files = await Promise.all(
        names.map(async (name) => {
            const st = await fs.stat(path.join(LOGS_DIR, name)).catch(() => null);
            return st?.isFile() ? { name, size: st.size, mtime: st.mtimeMs } : null;
        }),
    );
    return files
        .filter((f): f is NonNullable<typeof f> => !!f)
        .sort((a, b) => b.mtime - a.mtime);
}

app.get("/api/logs", async (c) => c.json({ files: await listLogFiles() }));

app.get("/api/logs/:name", async (c) => {
    const name = c.req.param("name");
    const file = (await listLogFiles()).find((f) => f.name === name);
    if (!file) return c.json({ error: "not found" }, 404);
    const bytes = Math.min(Math.max(Number(c.req.query("bytes")) || 65536, 1024), 1048576);
    const start = Math.max(0, file.size - bytes);
    const handle = await fs.open(path.join(LOGS_DIR, file.name), "r");
    try {
        const buf = Buffer.alloc(file.size - start);
        await handle.read(buf, 0, buf.length, start);
        return c.json({ name: file.name, size: file.size, truncated: start > 0, text: buf.toString("utf8") });
    } finally {
        await handle.close();
    }
});

export function startSuperAdmin() {
    if (!Config.superAdmin.enabled) return;
    const s = serve({ fetch: app.fetch, hostname: HOST, port: Config.superAdmin.port });
    s.on("error", (err) => logger.error("Super admin server failed:", err));
    logger.info(`Super admin page on http://${HOST}:${Config.superAdmin.port} (local only)`);
}
