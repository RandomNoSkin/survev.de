/**
 * Replay container format — shared between the server recorder (writer) and the
 * client replay player (reader).
 *
 * A replay is a per-player recording of the exact server -> client byte stream:
 * every `Uint8Array` the server passed to `Player.sendData()` is stored verbatim
 * together with the time (in ms) since the previous frame. Replaying simply feeds
 * those buffers back into the normal client decoder (`Game.m_handleIncomingBuffer`),
 * so the whole existing serialization + render pipeline is reused unchanged.
 *
 * Determinism note: the server simulation is NOT deterministic (variable timestep +
 * unseeded RNG for spawns/loot), so input-only replays would desync. Recording the
 * already-serialized snapshot stream sidesteps this entirely.
 *
 * On-disk layout (BEFORE gzip — the file is then gzip-compressed as a whole):
 *
 *   magic      "SVRP"            (4 bytes, ASCII)
 *   version    uint8
 *   headerLen  uint32 LE
 *   header     JSON UTF-8        (ReplayMeta)
 *   frames     repeated:
 *                dtMs    uint32 LE   ms since previous frame
 *                byteLen uint32 LE   length of the payload
 *                bytes   byteLen     the raw MsgStream buffer the client received
 *
 * This module deliberately uses only `DataView` / `TextEncoder` / `TextDecoder`
 * (no node `fs`/`zlib`) so it can be imported by the browser client too. gzip is
 * applied by the writer (node `zlib`) and undone by the reader (`DecompressionStream`).
 */

export const REPLAY_MAGIC = "SVRP";
export const REPLAY_VERSION = 1;

/** Frame prefix size: dtMs (u32) + byteLen (u32). */
export const REPLAY_FRAME_HEADER_BYTES = 8;

/** Metadata stored in the replay header + surfaced in the dashboard list (meta.json mirrors this). */
export interface ReplayMeta {
    gameId: string;
    playerId: number;
    playerName: string;
    teamMode: number;
    mapName: string;
    /** Unix ms when recording started (first frame). */
    startTs: number;
    /** Protocol version the recording was made with — replays are tied to it. */
    protocolVersion: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encodes the container header (magic + version + length-prefixed JSON meta).
 * Written once at the start of each per-player file.
 */
export function encodeReplayHeader(meta: ReplayMeta): Uint8Array {
    const magicBytes = textEncoder.encode(REPLAY_MAGIC);
    const jsonBytes = textEncoder.encode(JSON.stringify(meta));

    const out = new Uint8Array(magicBytes.length + 1 + 4 + jsonBytes.length);
    const view = new DataView(out.buffer);

    let offset = 0;
    out.set(magicBytes, offset);
    offset += magicBytes.length;
    view.setUint8(offset, REPLAY_VERSION);
    offset += 1;
    view.setUint32(offset, jsonBytes.length, true);
    offset += 4;
    out.set(jsonBytes, offset);

    return out;
}

/**
 * Encodes a single frame's 8-byte prefix (dtMs + byteLen).
 * The writer appends this followed by the raw payload bytes, avoiding a copy of
 * the (potentially large) payload.
 */
export function encodeFrameHeader(dtMs: number, byteLen: number): Uint8Array {
    const out = new Uint8Array(REPLAY_FRAME_HEADER_BYTES);
    const view = new DataView(out.buffer);
    view.setUint32(0, Math.max(0, Math.min(dtMs, 0xffffffff)) >>> 0, true);
    view.setUint32(4, byteLen >>> 0, true);
    return out;
}

export interface ReplayFrame {
    /** ms since the previous frame. */
    dtMs: number;
    /** The raw buffer the client received (a single `MsgStream` worth of messages). */
    bytes: Uint8Array;
}

export interface ParsedReplay {
    meta: ReplayMeta;
    frames: ReplayFrame[];
    /** Total replay duration in ms (sum of all frame dts). */
    durationMs: number;
}

/**
 * Parses a fully-decompressed replay container into its meta + frames.
 * Used by the client after gunzipping the fetched `.svrep.gz` payload.
 */
export function parseReplay(buf: Uint8Array): ParsedReplay {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let offset = 0;

    const magic = textDecoder.decode(buf.subarray(offset, offset + REPLAY_MAGIC.length));
    offset += REPLAY_MAGIC.length;
    if (magic !== REPLAY_MAGIC) {
        throw new Error(`Invalid replay file (bad magic "${magic}")`);
    }

    const version = view.getUint8(offset);
    offset += 1;
    if (version !== REPLAY_VERSION) {
        throw new Error(
            `Unsupported replay version ${version} (expected ${REPLAY_VERSION})`,
        );
    }

    const headerLen = view.getUint32(offset, true);
    offset += 4;
    const meta = JSON.parse(
        textDecoder.decode(buf.subarray(offset, offset + headerLen)),
    ) as ReplayMeta;
    offset += headerLen;

    const frames: ReplayFrame[] = [];
    let durationMs = 0;
    while (offset + REPLAY_FRAME_HEADER_BYTES <= buf.byteLength) {
        const dtMs = view.getUint32(offset, true);
        const byteLen = view.getUint32(offset + 4, true);
        offset += REPLAY_FRAME_HEADER_BYTES;
        if (offset + byteLen > buf.byteLength) break; // truncated/aborted recording — stop cleanly
        frames.push({ dtMs, bytes: buf.subarray(offset, offset + byteLen) });
        durationMs += dtMs;
        offset += byteLen;
    }

    return { meta, frames, durationMs };
}

// ─── God-view "tracks" format (SVTK) ────────────────────────────────────────────
//
// A single per-game side-file recorded on the server (which has full visibility of
// every player, unlike the per-player POV streams which are culled to what each
// client could see). It stores a low-rate sampling of EVERY player's position /
// health so the replay's advanced spectator can show all players regardless of POV.
//
// On-disk layout (BEFORE gzip):
//   magic      "SVTK"            (4 bytes, ASCII)
//   version    uint8
//   headerLen  uint32 LE
//   header     JSON UTF-8        (TracksMeta — static per-player name/team table)
//   samples    repeated:
//                tMs    uint32 LE   ms since recording start
//                count  uint16 LE   number of player entries in this sample
//                entries repeated (count times):
//                  id     uint16 LE
//                  x      float32 LE   world position
//                  y      float32 LE
//                  health uint8        0..100
//                  boost  uint8        0..100 (adrenaline)
//                  flags  uint8        bit0 = dead, bit1 = downed

export const TRACKS_MAGIC = "SVTK";
export const TRACKS_VERSION = 1;

/** Bytes per player entry in a sample: id(2) + x(4) + y(4) + health(1) + boost(1) + flags(1). */
const TRACK_ENTRY_BYTES = 13;
/** Bytes per sample prefix: tMs(4) + count(2). */
const TRACK_SAMPLE_HEADER_BYTES = 6;

const TRACK_FLAG_DEAD = 1;
const TRACK_FLAG_DOWNED = 2;

/** Static per-game info for the god-view track file (mirrors the playing roster). */
export interface TracksMeta {
    gameId: string;
    /** Unix ms when recording started — same time base as the per-player files. */
    startTs: number;
    players: { id: number; name: string; teamId: number; groupId: number }[];
    /** Map dimensions (world units), for scaling movement paths in the game view. */
    width?: number;
    height?: number;
}

/** One aggregated damage event (mirrors a player's runtime `damageHistory` entry). */
export interface GameDamageEvent {
    /** Victim player id. */
    victimId: number;
    victimName: string;
    /** Source player id, or 0 for non-player sources (gas, etc.). */
    sourceId: number;
    sourceName: string;
    amount: number;
    /** Ms since recording start — aligned with the god-view track timeline. */
    t: number;
    /** Weapon/item display name that caused the damage. */
    weapon: string;
}

/** Final per-player stats captured at game end (for the game-view end-stats table). */
export interface GamePlayerStats {
    id: number;
    name: string;
    teamId: number;
    groupId: number;
    kills: number;
    damageDealt: number;
    damageTaken: number;
    /** Seconds survived. */
    timeAlive: number;
    rank: number;
    /** Bullets fired + bullet hits, for accuracy. */
    shots: number;
    hits: number;
}

/** Contents of the per-game `_damage.json.gz` side-file (roster + end-stats + damage log). */
export interface GameDamageFile {
    gameId: string;
    players: GamePlayerStats[];
    events: GameDamageEvent[];
}

/** A single minimap shape (world coords): circle (t=0) or axis-aligned rect (t=1), `c` = 0xRRGGBB. */
export type GameMapShape =
    | { t: 0; x: number; y: number; r: number; c: number }
    | { t: 1; x: number; y: number; w: number; h: number; c: number };

/**
 * Top-down map snapshot for the game-view, mirroring the in-game minimap: biome colours,
 * terrain outlines, rivers, and the per-object minimap shapes (from each def's `map`
 * colour/scale) so it reads like the real minimap (no textures).
 */
export interface GameMapFile {
    width: number;
    height: number;
    /** Biome colours (0xRRGGBB) from the map def. */
    colors: { grass: number; water: number; beach: number; riverbank: number };
    /** Island shore outline (water lies outside it). */
    shore: [number, number][];
    /** Grass outline (beach lies between shore and grass). */
    grass: [number, number][];
    rivers: { points: [number, number][]; width: number }[];
    /** Per-object minimap shapes, pre-sorted by draw order (zIdx). */
    shapes: GameMapShape[];
    /** Named places (e.g. "Sweatbath") at world positions. */
    places: { name: string; x: number; y: number }[];
}

/** Combined JSON the public `/api/game_view/meta` endpoint returns. */
export interface GameViewMeta {
    players: GamePlayerStats[];
    events: GameDamageEvent[];
    map: GameMapFile | null;
}

/** One player's state in a single god-view sample. */
export interface TrackEntry {
    id: number;
    x: number;
    y: number;
    health: number;
    boost: number;
    dead: boolean;
    downed: boolean;
}

export interface TrackSample {
    tMs: number;
    entries: TrackEntry[];
}

export interface ParsedTracks {
    meta: TracksMeta;
    samples: TrackSample[];
}

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v))) & 0xff;

/** Encodes the tracks container header (written once at the start of the file). */
export function encodeTracksHeader(meta: TracksMeta): Uint8Array {
    const magicBytes = textEncoder.encode(TRACKS_MAGIC);
    const jsonBytes = textEncoder.encode(JSON.stringify(meta));

    const out = new Uint8Array(magicBytes.length + 1 + 4 + jsonBytes.length);
    const view = new DataView(out.buffer);

    let offset = 0;
    out.set(magicBytes, offset);
    offset += magicBytes.length;
    view.setUint8(offset, TRACKS_VERSION);
    offset += 1;
    view.setUint32(offset, jsonBytes.length, true);
    offset += 4;
    out.set(jsonBytes, offset);

    return out;
}

/** Encodes a single god-view sample (timestamp + every player's state). */
export function encodeTrackSample(tMs: number, entries: TrackEntry[]): Uint8Array {
    const count = Math.min(entries.length, 0xffff);
    const out = new Uint8Array(TRACK_SAMPLE_HEADER_BYTES + count * TRACK_ENTRY_BYTES);
    const view = new DataView(out.buffer);

    let offset = 0;
    view.setUint32(offset, Math.max(0, Math.min(tMs, 0xffffffff)) >>> 0, true);
    offset += 4;
    view.setUint16(offset, count, true);
    offset += 2;

    for (let i = 0; i < count; i++) {
        const e = entries[i];
        view.setUint16(offset, e.id & 0xffff, true);
        offset += 2;
        view.setFloat32(offset, e.x, true);
        offset += 4;
        view.setFloat32(offset, e.y, true);
        offset += 4;
        view.setUint8(offset, clampByte(e.health));
        offset += 1;
        view.setUint8(offset, clampByte(e.boost));
        offset += 1;
        view.setUint8(
            offset,
            (e.dead ? TRACK_FLAG_DEAD : 0) | (e.downed ? TRACK_FLAG_DOWNED : 0),
        );
        offset += 1;
    }

    return out;
}

/** Parses a fully-decompressed tracks container into its meta + samples. */
export function parseTracks(buf: Uint8Array): ParsedTracks {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let offset = 0;

    const magic = textDecoder.decode(buf.subarray(offset, offset + TRACKS_MAGIC.length));
    offset += TRACKS_MAGIC.length;
    if (magic !== TRACKS_MAGIC) {
        throw new Error(`Invalid tracks file (bad magic "${magic}")`);
    }

    const version = view.getUint8(offset);
    offset += 1;
    if (version !== TRACKS_VERSION) {
        throw new Error(
            `Unsupported tracks version ${version} (expected ${TRACKS_VERSION})`,
        );
    }

    const headerLen = view.getUint32(offset, true);
    offset += 4;
    const meta = JSON.parse(
        textDecoder.decode(buf.subarray(offset, offset + headerLen)),
    ) as TracksMeta;
    offset += headerLen;

    const samples: TrackSample[] = [];
    while (offset + TRACK_SAMPLE_HEADER_BYTES <= buf.byteLength) {
        const tMs = view.getUint32(offset, true);
        const count = view.getUint16(offset + 4, true);
        offset += TRACK_SAMPLE_HEADER_BYTES;
        if (offset + count * TRACK_ENTRY_BYTES > buf.byteLength) break; // truncated — stop cleanly
        const entries: TrackEntry[] = [];
        for (let i = 0; i < count; i++) {
            const id = view.getUint16(offset, true);
            const x = view.getFloat32(offset + 2, true);
            const y = view.getFloat32(offset + 6, true);
            const health = view.getUint8(offset + 10);
            const boost = view.getUint8(offset + 11);
            const flags = view.getUint8(offset + 12);
            offset += TRACK_ENTRY_BYTES;
            entries.push({
                id,
                x,
                y,
                health,
                boost,
                dead: (flags & TRACK_FLAG_DEAD) !== 0,
                downed: (flags & TRACK_FLAG_DOWNED) !== 0,
            });
        }
        samples.push({ tMs, entries });
    }

    return { meta, samples };
}
