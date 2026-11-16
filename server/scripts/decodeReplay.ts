/**
 * Decodes a `.svrep.gz` per-player replay recording into a JSONL timeline of bullets
 * fired and player position/direction/weapon samples - for tuning bot behavior against
 * real match data at full tick resolution, not just the coarser ~4Hz god-view tracks
 * (`_tracks.svtrk.gz`, see `gameRecorder.ts`).
 *
 * Reuses the project's own shared net/protocol code directly (`UpdateMsg.deserialize`
 * and friends from `shared/net/net.ts`) instead of a hand-rolled wire-format parser, so
 * this stays correct as the protocol evolves rather than silently drifting out of sync
 * with it.
 *
 * Usage: pnpm exec tsx server/scripts/decodeReplay.ts <path-to>.svrep.gz [out.jsonl]
 *
 * Output lines, one JSON object each:
 * - {kind:"bullet", t, playerId, pos, dir, bulletType, lastShot} - one per bullet
 *   fired (a shotgun's pellets each get their own line, all at the same `t`).
 * - {kind:"player", t, id, pos, dir, full, activeWeapon?, actionType?, dead?} - a
 *   position/direction sample for any player visible in this replay's own POV;
 *   `full` marks a full resync (weapon/action/dead included), a plain position/
 *   direction update otherwise.
 * - {kind:"activePlayer", t, health, weapsDirty, curWeapIdx} - the *recording* player's
 *   own extended state (health, current weapon slot) whenever it changed.
 *
 * `t` is milliseconds since the recording started (matches the god-view tracks'
 * timeline, so the two can be cross-referenced by `t`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
    AliveCountsMsg,
    ArenaRolesMsg,
    AssistMsg,
    type BitStream,
    DisconnectMsg,
    DropItemMsg,
    EditMsg,
    EmoteMsg,
    GameOverMsg,
    InputMsg,
    JoinAsSpectatorMsg,
    JoinedMsg,
    JoinFeedMsg,
    JoinMsg,
    KillFeedMsg,
    KillMsg,
    MapMsg,
    MsgStream,
    MsgType,
    PerkModeRoleSelectMsg,
    PickupExtraMsg,
    PickupMsg,
    PlayerStatsMsg,
    RoleAnnouncementMsg,
    RoleSelectMsg,
    SpectateMsg,
    SpectatorAdvancedMsg,
    UpdateMsg,
    UpdatePassMsg,
} from "../../shared/net/net.ts";
import { ObjectType } from "../../shared/net/objectSerializeFns.ts";
import { parseReplay } from "../../shared/net/replay.ts";

/** Every message type that can appear in a recorded server->client stream, so an
 *  unexpected one (Kill, GameOver, JoinFeed, ...) sandwiched between Update messages in
 *  the same frame can still be correctly deserialized - and its bytes consumed - even
 *  though only Update's own fields are actually read below. Getting this dispatch table
 *  wrong desyncs the bit-stream position for everything after it in the frame, which is
 *  exactly what the per-frame try/catch below guards against. */
const dispatch: Record<number, new() => { deserialize: (s: BitStream, extra?: unknown) => void }> = {
    [MsgType.Join]: JoinMsg,
    [MsgType.Disconnect]: DisconnectMsg,
    [MsgType.Input]: InputMsg,
    [MsgType.Edit]: EditMsg,
    [MsgType.Joined]: JoinedMsg,
    [MsgType.Update]: UpdateMsg,
    [MsgType.Kill]: KillMsg,
    [MsgType.GameOver]: GameOverMsg,
    [MsgType.Pickup]: PickupMsg,
    [MsgType.Map]: MapMsg,
    [MsgType.Spectate]: SpectateMsg,
    [MsgType.DropItem]: DropItemMsg,
    [MsgType.Emote]: EmoteMsg,
    [MsgType.PlayerStats]: PlayerStatsMsg,
    [MsgType.RoleAnnouncement]: RoleAnnouncementMsg,
    [MsgType.UpdatePass]: UpdatePassMsg,
    [MsgType.AliveCounts]: AliveCountsMsg,
    [MsgType.PerkModeRoleSelect]: PerkModeRoleSelectMsg,
    [MsgType.RoleSelect]: RoleSelectMsg,
    [MsgType.ArenaRoles]: ArenaRolesMsg,
    [MsgType.JoinAsSpectator]: JoinAsSpectatorMsg,
    [MsgType.JoinFeed]: JoinFeedMsg,
    [MsgType.KillFeed]: KillFeedMsg,
    [MsgType.Assist]: AssistMsg,
    [MsgType.SpectatorAdvanced]: SpectatorAdvancedMsg,
    [MsgType.PickupExtra]: PickupExtraMsg,
};

const filePath = process.argv[2];
const outPath = process.argv[3] ?? "decoded.jsonl";
if (!filePath) {
    console.error("Usage: pnpm exec tsx server/scripts/decodeReplay.ts <path-to>.svrep.gz [out.jsonl]");
    process.exit(1);
}

const raw = gunzipSync(readFileSync(filePath));
const { meta, frames } = parseReplay(new Uint8Array(raw));
console.error("meta:", JSON.stringify(meta));
console.error("frames:", frames.length);

const out: string[] = [];
let clockMs = 0;
let framesOk = 0;
let framesErr = 0;
const unknownTypeCounts: Record<number, number> = {};

for (const frame of frames) {
    clockMs += frame.dtMs;
    const msgStream = new MsgStream(frame.bytes);
    const stream = msgStream.getStream();
    try {
        while (true) {
            const type = msgStream.deserializeMsgType();
            if (type === MsgType.None) break;
            const Klass = dispatch[type];
            if (!Klass) {
                unknownTypeCounts[type] = (unknownTypeCounts[type] ?? 0) + 1;
                throw new Error(`unknown msg type ${type}, aborting frame`);
            }
            // `m_getTypeById` is accepted but never actually called by UpdateMsg's own
            // deserialize (the object-type-by-id lookup is disabled there, each
            // object's type is read directly from the stream instead) - a stub is fine.
            const inst = new Klass();
            inst.deserialize(stream, { m_getTypeById: () => 0 });
            stream.readAlignToNextByte();

            if (type !== MsgType.Update) continue;
            const upd = inst as InstanceType<typeof UpdateMsg>;

            for (const b of upd.bullets) {
                out.push(JSON.stringify({
                    kind: "bullet",
                    t: clockMs,
                    playerId: b.playerId,
                    // `pos` here is the bullet's spawn origin - a live in-flight
                    // bullet's travelling position is never sent over the wire, only
                    // where it started and its direction/type (the client simulates
                    // the flight path itself from those).
                    pos: { x: Math.round(b.pos.x), y: Math.round(b.pos.y) },
                    dir: { x: +b.dir.x.toFixed(3), y: +b.dir.y.toFixed(3) },
                    bulletType: b.bulletType,
                    lastShot: b.lastShot ?? null,
                }));
            }

            // Obstacles (walls, containers, crates, trees, rocks, ...) only ever arrive as full
            // objects, the first time the recorded player sees them: that is the real map geometry
            // for this match, including the exact type/orientation/scale a container had.
            // Map indicators (role icons on the minimap that every client sees, e.g. the "indicator" role).
            for (const ind of upd.mapIndicators) {
                out.push(JSON.stringify({
                    kind: "mapIndicator",
                    t: clockMs,
                    id: ind.id,
                    type: ind.type,
                    dead: ind.dead,
                    pos: { x: +ind.pos.x.toFixed(1), y: +ind.pos.y.toFixed(1) },
                }));
            }

            for (const p of upd.fullObjects) {
                if (p.__type !== ObjectType.Obstacle) continue;
                // biome-ignore lint: one-off script, union types don't narrow per object type here.
                const data = p as any;
                out.push(JSON.stringify({
                    kind: "obstacle",
                    t: clockMs,
                    id: p.__id,
                    type: data.type,
                    pos: { x: +data.pos.x.toFixed(2), y: +data.pos.y.toFixed(2) },
                    ori: data.ori,
                    scale: +(data.scale ?? 1).toFixed(3),
                    dead: data.dead ?? null,
                }));
            }

            for (const p of [...upd.fullObjects, ...upd.partObjects]) {
                if (p.__type !== ObjectType.Player) continue;
                // `deserializePart` always fills pos/dir regardless of full-vs-part;
                // the rest (activeWeapon/actionType/dead) only exists on a full
                // resync - `"activeWeapon" in p` is what `full` reports below.
                // biome-ignore lint: fullObjects/partObjects union types don't
                // narrow cleanly per-object-type here, and this is a one-off script.
                const data = p as any;
                out.push(JSON.stringify({
                    kind: "player",
                    t: clockMs,
                    id: p.__id,
                    pos: { x: Math.round(data.pos.x), y: Math.round(data.pos.y) },
                    dir: { x: +data.dir.x.toFixed(3), y: +data.dir.y.toFixed(3) },
                    full: "activeWeapon" in data,
                    activeWeapon: data.activeWeapon ?? null,
                    actionType: data.actionType ?? null,
                    dead: data.dead ?? null,
                }));
            }

            if (upd.activePlayerData) {
                const ap = upd.activePlayerData;
                if (ap.healthDirty || ap.weapsDirty) {
                    out.push(JSON.stringify({
                        kind: "activePlayer",
                        t: clockMs,
                        health: ap.healthDirty ? ap.health : null,
                        weapsDirty: ap.weapsDirty,
                        curWeapIdx: ap.weapsDirty ? ap.curWeapIdx : null,
                    }));
                }
            }
        }
        framesOk++;
    } catch {
        // desync or unsupported message type this frame - skip its remainder and
        // keep going rather than aborting the whole file over one bad frame.
        framesErr++;
    }
}

writeFileSync(outPath, out.join("\n") + "\n");
console.error("framesOk:", framesOk, "framesErr:", framesErr);
if (Object.keys(unknownTypeCounts).length) console.error("unknown types seen:", unknownTypeCounts);
console.error("output lines:", out.length, "->", outPath);
