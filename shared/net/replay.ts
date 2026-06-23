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
