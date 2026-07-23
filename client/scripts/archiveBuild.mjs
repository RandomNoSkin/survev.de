/**
 * Archives client builds per protocol version so old replays stay watchable.
 *
 * Replays store the raw server->client byte stream, which only the client build of
 * the SAME protocol version can decode (msg layouts + game-type tables shift between
 * versions). This script keeps the last build of each protocol version and publishes
 * them under `dist/archive/<protocolVersion>/`, where nginx serves them statically
 * with no extra config. The moderation dashboard's "Watch" button opens
 * `/archive/<v>/?replay=...` whenever a recording's protocol differs from the
 * current one.
 *
 * Run AFTER every production build (vite wipes `dist/`, so the publish step must be
 * re-applied each deploy):
 *
 *     pnpm build && pnpm archive
 *
 * Layout:
 *   client/dist-archive/<v>/  permanent store (gitignored, survives builds)
 *   client/dist/archive/<v>/  published copy inside the served dist
 *
 * The store is pruned to the newest REPLAY_ARCHIVE_KEEP (default 6) versions —
 * recordings older than the retention window are deleted anyway, so ancient client
 * builds only waste disk.
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const clientRoot = path.resolve(__dirname, "..");
const distDir = path.join(clientRoot, "dist");
const storeDir = path.join(clientRoot, "dist-archive");
const KEEP = Math.max(1, Number(process.env.REPLAY_ARCHIVE_KEEP ?? 6));

// Current protocol version, read straight from the shared config source.
const gameConfigPath = path.resolve(clientRoot, "..", "shared", "gameConfig.ts");
const match = fs.readFileSync(gameConfigPath, "utf8").match(/protocolVersion:\s*(\d+)/);
if (!match) {
    console.error(`Could not find protocolVersion in ${gameConfigPath}`);
    process.exit(1);
}
const version = match[1];

if (!fs.existsSync(path.join(distDir, "index.html"))) {
    console.error(`No build found in ${distDir} — run "pnpm build" first.`);
    process.exit(1);
}

// 1. Store the fresh build as the (latest) build of the current protocol version.
//    Excludes dist/archive itself, in case the publish step already ran once.
const publishDir = path.join(distDir, "archive");
const target = path.join(storeDir, version);
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(storeDir, { recursive: true });
fs.cpSync(distDir, target, {
    recursive: true,
    filter: (src) => path.resolve(src) !== publishDir,
});
console.log(`Stored protocol ${version} build in ${path.relative(clientRoot, target)}`);

// 2. Prune the store to the newest KEEP versions.
const versions = fs
    .readdirSync(storeDir)
    .filter((d) => /^\d+$/.test(d))
    .sort((a, b) => Number(b) - Number(a));
for (const v of versions.slice(KEEP)) {
    fs.rmSync(path.join(storeDir, v), { recursive: true, force: true });
    console.log(`Pruned old archive ${v}`);
}

// 3. Publish every OLDER stored version into dist/archive/ (the current version is
//    served by dist/ itself — republishing it would just double the disk usage).
fs.rmSync(publishDir, { recursive: true, force: true });
const publish = versions.slice(0, KEEP).filter((v) => v !== version);
for (const v of publish) {
    fs.cpSync(path.join(storeDir, v), path.join(publishDir, v), { recursive: true });
}
console.log(
    publish.length
        ? `Published archived clients: ${publish.join(", ")} → dist/archive/`
        : "No older protocol builds stored yet — nothing to publish.",
);
