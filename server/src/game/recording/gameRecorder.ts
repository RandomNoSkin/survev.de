import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import { MapObjectDefs } from "../../../../shared/defs/mapObjectDefs";
import type { BuildingDef, ObstacleDef } from "../../../../shared/defs/mapObjectsTyping";
import { GameConfig } from "../../../../shared/gameConfig";
import {
    encodeFrameHeader,
    encodeReplayHeader,
    encodeTrackSample,
    encodeTracksHeader,
    type GameDamageEvent,
    type GameDamageFile,
    type GameMapFile,
    type GameMapShape,
    type GamePlayerStats,
    type ReplayMeta,
    type TrackEntry,
    type TracksMeta,
} from "../../../../shared/net/replay";
import { collider } from "../../../../shared/utils/collider";
import { mapHelpers } from "../../../../shared/utils/mapHelpers";
import { math } from "../../../../shared/utils/math";
import { Config } from "../../config";
import type { Game } from "../game";
import type { Player } from "../objects/player";

const MB = 1024 * 1024;

/** Filename of the per-game god-view track side-file. */
const TRACKS_FILE = "_tracks.svtrk.gz";
/** Filename of the per-game aggregated damage-events side-file. */
const DAMAGE_FILE = "_damage.json.gz";
/** Filename of the per-game structural map snapshot. */
const MAP_FILE = "_map.json.gz";
/** How often the god-view samples every player's state (ms). */
const TRACK_SAMPLE_INTERVAL_MS = 250;

/** Resolves a weapon/item key to its display name for the game-view damage log. */
function weaponName(type: string): string {
    if (!type) return "";
    const def = GameObjectDefs[type] as { name?: string } | undefined;
    return def?.name ?? type;
}

/**
 * Builds the per-object minimap shapes (world coords + colour) for a game's map, mirroring
 * the client's `Map.getMinimapRender` + draw transform so the game-view reads like the real
 * minimap. Returns shapes pre-sorted by draw order (zIdx).
 */
function buildMapShapes(map: Game["map"]): GameMapShape[] {
    const renders: {
        zIdx: number;
        obj: { pos: { x: number; y: number }; ori: number; scale: number };
        shapes: { collider: any; scale?: number; color?: number }[];
    }[] = [];

    for (const obj of map.msg.objects) {
        const def = MapObjectDefs[obj.type] as ObstacleDef | BuildingDef | undefined;
        if (!def) continue;
        const zIdx =
            def.type === "building"
                ? 750 + (def.zIdx || 0)
                : (def as ObstacleDef).img?.zIdx || 0;

        let shapes: { collider: any; scale?: number; color?: number }[] = [];
        const bDef = def as BuildingDef;
        if (bDef.map?.shapes !== undefined) {
            shapes = bDef.map.shapes as any;
        } else {
            let col: any = null;
            if (def.type === "obstacle") {
                col = (def as ObstacleDef).collision;
            } else if (
                bDef.ceiling?.zoomRegions?.length > 0 &&
                bDef.ceiling.zoomRegions[0].zoomIn
            ) {
                col = bDef.ceiling.zoomRegions[0].zoomIn;
            } else {
                col = mapHelpers.getBoundingCollider(obj.type);
            }
            if (col) {
                shapes = [
                    { collider: col, scale: def.map?.scale ?? 1, color: def.map?.color },
                ];
            }
        }
        renders.push({ zIdx, obj, shapes });
    }

    renders.sort((a, b) => a.zIdx - b.zIdx);

    const out: GameMapShape[] = [];
    const r1 = (v: number) => Math.round(v * 10) / 10;
    for (const render of renders) {
        for (const shape of render.shapes) {
            if (shape.color == null) continue; // not drawn on the minimap
            const col: any = collider.transform(
                shape.collider,
                render.obj.pos,
                math.oriToRad(render.obj.ori),
                render.obj.scale,
            );
            const sc = shape.scale ?? 1;
            if (col.type === collider.Type.Circle) {
                out.push({
                    t: 0,
                    x: r1(col.pos.x),
                    y: r1(col.pos.y),
                    r: r1(col.rad * sc),
                    c: shape.color,
                });
            } else if (col.type === collider.Type.Aabb) {
                const ax = ((col.max.x - col.min.x) / 2) * sc;
                const ay = ((col.max.y - col.min.y) / 2) * sc;
                const ox = (col.min.x + col.max.x) / 2;
                const oy = (col.min.y + col.max.y) / 2;
                out.push({
                    t: 1,
                    x: r1(ox - ax),
                    y: r1(oy - ay),
                    w: r1(ax * 2),
                    h: r1(ay * 2),
                    c: shape.color,
                });
            }
        }
    }
    return out;
}

/** Absolute path to the recordings root, resolved against the server working dir. */
export function recordingsRoot(): string {
    return path.resolve(Config.recording.dir);
}

/** Strips a player name down to something safe to embed in a filename. */
function safeFileName(name: string): string {
    return (name || "player").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24);
}

/** One per-player gzip recording stream within a game. */
interface Track {
    player: Player;
    gzip: zlib.Gzip;
    filePath: string;
    fileName: string;
    lastFrameAt: number;
    rawBytes: number;
    stopped: boolean;
}

/** Summary of a recorded player POV, mirrored into the game's `meta.json`. */
interface RecordedPlayerMeta {
    playerId: number;
    playerName: string;
    file: string;
    bytes: number;
    kills: number;
    damageDealt: number;
    damageTaken: number;
    /** Seconds the player was alive when their recording stopped. */
    timeAlive: number;
}

/**
 * Records the exact server -> client byte stream per real player to gzipped
 * `.svrep.gz` files on the local disk. One instance per `Game`.
 *
 * Memory-safety (small/OOM-prone boxes): everything streams straight to disk via a
 * gzip transform — a whole match is never held in RAM. Bots/spectators are skipped,
 * tracks are capped in size and count, and a track is dropped (rather than buffering
 * unboundedly) if disk writes back up. See `Config.recording`.
 */
export class GameRecorder {
    private readonly tracks = new Map<number, Track>();
    private readonly recorded: RecordedPlayerMeta[] = [];
    private readonly enabled = Config.recording.enabled;
    private readonly startTs = Date.now();
    private dir = "";
    private dirReady = false;
    private stoppedAll = false;

    // God-view track side-file (all players' pos/health, server-authoritative).
    private tracksGzip?: zlib.Gzip;
    private tracksFilePath = "";
    private tracksBytes = 0;
    private tracksStopped = false;
    private lastSampleAt = 0;

    constructor(readonly game: Game) {}

    /** Records one outgoing buffer for a player. Cheap no-op when recording is off/skipped. */
    recordFrame(player: Player, buffer: Uint8Array): void {
        if (!this.enabled || this.stoppedAll) return;
        if (player.spectator) return; // observers, not match participants
        if (player.bot && !Config.recording.recordBots) return;

        let track = this.tracks.get(player.__id);
        if (!track) {
            if (this.tracks.size >= Config.recording.maxConcurrentTracks) return;
            track = this.openTrack(player);
            if (!track) return;
        }
        if (track.stopped) return;

        // Backpressure guard: if the gzip/disk pipeline is buffering too much, drop
        // this track rather than let the buffer grow into an OOM.
        if (track.gzip.writableLength > Config.recording.writeBackpressureBytes) {
            this.stopTrack(track, "backpressure");
            return;
        }
        // Per-track size cap.
        if (track.rawBytes >= Config.recording.maxGameMb * MB) {
            this.stopTrack(track, "size cap");
            return;
        }

        const now = Date.now();
        const dt = now - track.lastFrameAt;
        track.lastFrameAt = now;

        // getBuffer() returns a view onto a reused ArrayBuffer — copy before it goes
        // async into the gzip stream.
        const copy = buffer.slice();
        track.gzip.write(encodeFrameHeader(dt, copy.length));
        track.gzip.write(copy);
        track.rawBytes += copy.length + 8;
    }

    /** Stops recording a single player (called when they leave/disconnect). */
    stop(player: Player): void {
        const track = this.tracks.get(player.__id);
        if (track) this.stopTrack(track, "player left");
    }

    /** Stops every track and writes the game's `meta.json`. Called on game end. */
    stopAll(): void {
        if (this.stoppedAll) return;
        this.stoppedAll = true;
        for (const track of this.tracks.values()) {
            this.stopTrack(track, "game ended");
        }
        this.stopTracks("game ended");
        this.writeDamage();
        if (this.recorded.length) {
            this.writeMeta();
            void cleanupRetention();
        }
    }

    /**
     * Collects the final per-player stats (roster + end-stats + shots/hits) and the
     * aggregated damage log into one `_damage.json.gz` side-file for the stats game-view.
     * Gathered at game end from the live Player objects (so the roster is complete — fixes
     * the empty-lobby roster). Damage times are recording-relative (align with the tracks).
     */
    private writeDamage(): void {
        if (!this.enabled || !this.dirReady) return;
        try {
            const rankById = new Map<number, number>();
            try {
                for (const {
                    player,
                    rank,
                } of this.game.modeManager.getPlayersSortedByRank()) {
                    rankById.set(player.__id, rank);
                }
            } catch {
                /* rank is best-effort */
            }

            const players: GamePlayerStats[] = [];
            const events: GameDamageEvent[] = [];
            for (const p of this.game.playerBarn.players) {
                if (p.spectator) continue;
                if (p.bot && !Config.recording.recordBots) continue;
                players.push({
                    id: p.__id,
                    name: p.name,
                    teamId: p.teamId,
                    groupId: p.groupId,
                    kills: p.kills,
                    damageDealt: Math.round(p.damageDealt),
                    damageTaken: Math.round(p.damageTaken),
                    timeAlive: Math.round(p.timeAlive),
                    rank: rankById.get(p.__id) ?? 0,
                    shots: p.shotsFired,
                    hits: p.bulletHits,
                });
                for (const h of p.damageHistory) {
                    events.push({
                        victimId: p.__id,
                        victimName: p.name,
                        sourceId: h.sourceId,
                        sourceName: h.name,
                        amount: Math.round(h.amount),
                        t: Math.max(0, h.realTime - this.startTs),
                        weapon: weaponName(h.weapon),
                    });
                }
            }
            if (!players.length && !events.length) return;
            events.sort((a, b) => a.t - b.t);
            const payload: GameDamageFile = { gameId: this.game.id, players, events };
            const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
            fs.writeFileSync(path.join(this.dir, DAMAGE_FILE), gz);
        } catch (err) {
            this.game.logger.warn("Failed to write damage file:", err);
        }
    }

    /** Captures a minimap-style snapshot of the (static) map for the game-view. */
    private writeMap(): void {
        if (!this.enabled || !this.dirReady) return;
        try {
            const map = this.game.map;
            const c = map.mapDef.biome.colors;
            const pt = (p: { x: number; y: number }): [number, number] => [p.x, p.y];
            const payload: GameMapFile = {
                width: map.width,
                height: map.height,
                colors: {
                    grass: c.grass,
                    water: c.water,
                    beach: c.beach,
                    riverbank: c.riverbank,
                },
                shore: map.terrain.shore.map(pt),
                grass: map.terrain.grass.map(pt),
                rivers: map.riverDescs.map((r) => ({
                    points: r.points.map(pt),
                    width: r.width,
                })),
                shapes: buildMapShapes(map),
                places: map.msg.places.map((p) => ({
                    name: p.name,
                    x: p.pos.x,
                    y: p.pos.y,
                })),
            };
            // Async gzip so a large obstacle list doesn't stall the game tick.
            const filePath = path.join(this.dir, MAP_FILE);
            zlib.gzip(Buffer.from(JSON.stringify(payload)), (err, gz) => {
                if (err) return;
                fs.writeFile(filePath, gz, () => {});
            });
        } catch (err) {
            this.game.logger.warn("Failed to write map file:", err);
        }
    }

    /**
     * Records one god-view sample (every player's pos/health) at a throttled rate.
     * Cheap no-op when recording is off. Called from the game loop; the server has
     * full visibility, so this captures players regardless of any POV's view culling.
     */
    sampleTracks(): void {
        if (!this.enabled || this.stoppedAll || this.tracksStopped) return;
        const now = Date.now();
        if (now - this.lastSampleAt < TRACK_SAMPLE_INTERVAL_MS) return;
        this.lastSampleAt = now;

        // Collect entries BEFORE lazily opening the file: the header's player roster
        // is written once at open, and opening on the game's first (still empty) tick
        // froze an empty roster into it — which broke enemy/teammate classification
        // (green names, no ESP lines) in the replay viewer.
        const entries: TrackEntry[] = [];
        for (const player of this.game.playerBarn.players) {
            if (player.spectator) continue;
            if (player.bot && !Config.recording.recordBots) continue;
            entries.push({
                id: player.__id,
                x: player.pos.x,
                y: player.pos.y,
                health: player.health,
                boost: player.boost,
                dead: player.dead,
                downed: player.downed,
            });
        }
        if (!entries.length) return;

        if (!this.tracksGzip && !this.openTracks()) return;

        const gzip = this.tracksGzip!;
        if (gzip.writableLength > Config.recording.writeBackpressureBytes) {
            this.stopTracks("backpressure");
            return;
        }
        if (this.tracksBytes >= Config.recording.maxGameMb * MB) {
            this.stopTracks("size cap");
            return;
        }

        const buf = encodeTrackSample(now - this.startTs, entries);
        gzip.write(buf);
        this.tracksBytes += buf.length;
    }

    private openTracks(): boolean {
        try {
            this.ensureDir();
            const filePath = path.join(this.dir, TRACKS_FILE);
            const gzip = zlib.createGzip();
            const fileStream = fs.createWriteStream(filePath);
            gzip.pipe(fileStream);

            const onErr = (err: unknown) => {
                this.game.logger.warn("Tracks write error:", err);
                this.stopTracks("write error");
            };
            gzip.on("error", onErr);
            fileStream.on("error", onErr);

            const meta: TracksMeta = {
                gameId: this.game.id,
                startTs: this.startTs,
                width: this.game.map.width,
                height: this.game.map.height,
                players: this.game.playerBarn.players
                    .filter(
                        (p) => !p.spectator && (!p.bot || Config.recording.recordBots),
                    )
                    .map((p) => ({
                        id: p.__id,
                        name: p.name,
                        teamId: p.teamId,
                        groupId: p.groupId,
                    })),
            };
            gzip.write(encodeTracksHeader(meta));

            this.tracksGzip = gzip;
            this.tracksFilePath = filePath;
            this.tracksBytes = 0;
            this.writeMap(); // capture the static map once, early (before obstacles break)
            return true;
        } catch (err) {
            this.game.logger.warn("Failed to start tracks recording:", err);
            this.tracksStopped = true;
            return false;
        }
    }

    private stopTracks(reason: string): void {
        if (this.tracksStopped) return;
        this.tracksStopped = true;
        if (this.tracksGzip) {
            try {
                this.tracksGzip.end();
            } catch {
                /* already closed */
            }
        }
        // No samples were written — remove the header-only file.
        if (this.tracksBytes <= 0 && this.tracksFilePath) {
            fs.rm(this.tracksFilePath, () => {});
        }
        if (reason !== "game ended") {
            this.game.logger.warn(`Tracks recording stopped (${reason})`);
        }
    }

    /** Lazily creates the per-game recording directory (shared by tracks + POV files). */
    private ensureDir(): void {
        if (this.dirReady) return;
        const day = new Date(this.startTs).toISOString().slice(0, 10);
        this.dir = path.join(recordingsRoot(), day, this.game.id);
        fs.mkdirSync(this.dir, { recursive: true });
        this.dirReady = true;
    }

    private openTrack(player: Player): Track | undefined {
        try {
            this.ensureDir();

            const fileName = `${player.__id}-${safeFileName(player.name)}.svrep.gz`;
            const filePath = path.join(this.dir, fileName);
            const gzip = zlib.createGzip();
            const fileStream = fs.createWriteStream(filePath);
            gzip.pipe(fileStream);

            const onErr = (err: unknown) => {
                this.game.logger.warn("Recording write error:", err);
                const t = this.tracks.get(player.__id);
                if (t) this.stopTrack(t, "write error");
            };
            gzip.on("error", onErr);
            fileStream.on("error", onErr);

            const meta: ReplayMeta = {
                gameId: this.game.id,
                playerId: player.__id,
                playerName: player.name,
                teamMode: this.game.teamMode,
                mapName: this.game.mapName,
                startTs: this.startTs,
                protocolVersion: GameConfig.protocolVersion,
            };
            gzip.write(encodeReplayHeader(meta));

            const track: Track = {
                player,
                gzip,
                filePath,
                fileName,
                lastFrameAt: Date.now(),
                rawBytes: 0,
                stopped: false,
            };
            this.tracks.set(player.__id, track);
            return track;
        } catch (err) {
            this.game.logger.warn("Failed to start recording track:", err);
            return undefined;
        }
    }

    private stopTrack(track: Track, reason: string): void {
        if (track.stopped) return;
        track.stopped = true;
        try {
            track.gzip.end();
        } catch {
            /* already closed */
        }
        if (track.rawBytes > 0) {
            const p = track.player;
            this.recorded.push({
                playerId: p.__id,
                playerName: p.name,
                file: track.fileName,
                bytes: track.rawBytes,
                kills: p.kills,
                damageDealt: Math.round(p.damageDealt),
                damageTaken: Math.round(p.damageTaken),
                timeAlive: Math.round(p.timeAlive),
            });
        } else {
            // Nothing was written — remove the empty file.
            fs.rm(track.filePath, () => {});
        }
        if (reason !== "game ended" && reason !== "player left") {
            this.game.logger.warn(
                `Recording track stopped (${reason}) for ${track.player.name}`,
            );
        }
    }

    private writeMeta(): void {
        try {
            const meta = {
                gameId: this.game.id,
                teamMode: this.game.teamMode,
                mapName: this.game.mapName,
                startTs: this.startTs,
                durationMs: Date.now() - this.startTs,
                protocolVersion: GameConfig.protocolVersion,
                players: this.recorded,
                // Whether a god-view track side-file (_tracks.svtrk.gz) was written.
                tracks: this.tracksBytes > 0,
            };
            fs.writeFileSync(path.join(this.dir, "meta.json"), JSON.stringify(meta));
        } catch (err) {
            this.game.logger.warn("Failed to write recording meta:", err);
        }
    }
}

// ─── Disk read side (used by the game-server HTTP layer) ────────────────────────

export interface GameRecordingInfo {
    gameId: string;
    teamMode: number;
    mapName: string;
    startTs: number;
    durationMs: number;
    protocolVersion: number;
    players: RecordedPlayerMeta[];
    /** True if a god-view track side-file was recorded for this game. */
    tracks?: boolean;
}

/** Lists all recorded games on this host (newest first), read from their `meta.json`. */
export async function listRecordings(): Promise<GameRecordingInfo[]> {
    const root = recordingsRoot();
    const out: GameRecordingInfo[] = [];
    let days: string[];
    try {
        days = await fs.promises.readdir(root);
    } catch {
        return out; // dir doesn't exist yet
    }
    for (const day of days) {
        const dayDir = path.join(root, day);
        let games: string[];
        try {
            games = await fs.promises.readdir(dayDir);
        } catch {
            continue;
        }
        for (const gameId of games) {
            try {
                const raw = await fs.promises.readFile(
                    path.join(dayDir, gameId, "meta.json"),
                    "utf8",
                );
                out.push(JSON.parse(raw) as GameRecordingInfo);
            } catch {
                /* incomplete/aborted game dir — skip */
            }
        }
    }
    out.sort((a, b) => b.startTs - a.startTs);
    return out;
}

/** Reads a single per-player `.svrep.gz` file. Returns the gzip bytes, or null if not found. */
export async function readRecordingFile(
    gameId: string,
    playerId: number,
): Promise<Buffer | null> {
    const root = recordingsRoot();
    let days: string[];
    try {
        days = await fs.promises.readdir(root);
    } catch {
        return null;
    }
    for (const day of days) {
        const gameDir = path.join(root, day, gameId);
        let files: string[];
        try {
            files = await fs.promises.readdir(gameDir);
        } catch {
            continue;
        }
        const prefix = `${playerId}-`;
        const match = files.find((f) => f.startsWith(prefix) && f.endsWith(".svrep.gz"));
        if (match) {
            try {
                return await fs.promises.readFile(path.join(gameDir, match));
            } catch {
                return null;
            }
        }
    }
    return null;
}

/** Reads a game's god-view track side-file (`_tracks.svtrk.gz`). Null if not present. */
export async function readTracksFile(gameId: string): Promise<Buffer | null> {
    const root = recordingsRoot();
    let days: string[];
    try {
        days = await fs.promises.readdir(root);
    } catch {
        return null;
    }
    for (const day of days) {
        const file = path.join(root, day, gameId, TRACKS_FILE);
        try {
            return await fs.promises.readFile(file);
        } catch {
            /* not in this day dir — keep looking */
        }
    }
    return null;
}

/** Reads + gunzips a game's aggregated damage side-file. Null if not present. */
export async function readDamageFile(gameId: string): Promise<GameDamageFile | null> {
    const root = recordingsRoot();
    let days: string[];
    try {
        days = await fs.promises.readdir(root);
    } catch {
        return null;
    }
    for (const day of days) {
        const file = path.join(root, day, gameId, DAMAGE_FILE);
        try {
            const gz = await fs.promises.readFile(file);
            return JSON.parse(zlib.gunzipSync(gz).toString("utf8")) as GameDamageFile;
        } catch {
            /* not in this day dir — keep looking */
        }
    }
    return null;
}

/** Reads + gunzips a game's structural map snapshot. Null if not present. */
export async function readMapFile(gameId: string): Promise<GameMapFile | null> {
    const root = recordingsRoot();
    let days: string[];
    try {
        days = await fs.promises.readdir(root);
    } catch {
        return null;
    }
    for (const day of days) {
        const file = path.join(root, day, gameId, MAP_FILE);
        try {
            const gz = await fs.promises.readFile(file);
            return JSON.parse(zlib.gunzipSync(gz).toString("utf8")) as GameMapFile;
        } catch {
            /* not in this day dir — keep looking */
        }
    }
    return null;
}

// ─── Retention cleanup ──────────────────────────────────────────────────────────

let lastCleanup = 0;

/** Enforces age + total-size caps by deleting the oldest game dirs. Throttled. */
async function cleanupRetention(): Promise<void> {
    const now = Date.now();
    if (now - lastCleanup < 60_000) return; // at most once a minute
    lastCleanup = now;

    const root = recordingsRoot();
    const maxAgeMs = Config.recording.maxAgeDays * 24 * 60 * 60 * 1000;
    const maxTotalBytes = Config.recording.maxTotalGb * 1024 * MB;

    try {
        const entries: { dir: string; mtime: number; size: number }[] = [];
        const days = await fs.promises.readdir(root);
        for (const day of days) {
            const dayDir = path.join(root, day);
            let games: string[];
            try {
                games = await fs.promises.readdir(dayDir);
            } catch {
                continue;
            }
            for (const gameId of games) {
                const gameDir = path.join(dayDir, gameId);
                const size = await dirSize(gameDir);
                let mtime = 0;
                try {
                    mtime = (await fs.promises.stat(gameDir)).mtimeMs;
                } catch {
                    continue;
                }
                entries.push({ dir: gameDir, mtime, size });
            }
        }

        // 1. Age cap.
        for (const e of entries) {
            if (now - e.mtime > maxAgeMs) {
                await fs.promises.rm(e.dir, { recursive: true, force: true });
                e.size = -1; // mark removed
            }
        }

        // 2. Total-size cap — delete oldest until under budget.
        const remaining = entries
            .filter((e) => e.size >= 0)
            .sort((a, b) => a.mtime - b.mtime);
        let total = remaining.reduce((sum, e) => sum + e.size, 0);
        for (const e of remaining) {
            if (total <= maxTotalBytes) break;
            await fs.promises.rm(e.dir, { recursive: true, force: true });
            total -= e.size;
        }

        // Prune now-empty day dirs.
        for (const day of await fs.promises.readdir(root)) {
            const dayDir = path.join(root, day);
            try {
                if ((await fs.promises.readdir(dayDir)).length === 0) {
                    await fs.promises.rmdir(dayDir);
                }
            } catch {
                /* not empty / gone */
            }
        }
    } catch {
        /* root missing or transient FS error — ignore */
    }
}

async function dirSize(dir: string): Promise<number> {
    let total = 0;
    try {
        for (const file of await fs.promises.readdir(dir)) {
            try {
                total += (await fs.promises.stat(path.join(dir, file))).size;
            } catch {
                /* gone */
            }
        }
    } catch {
        /* gone */
    }
    return total;
}
