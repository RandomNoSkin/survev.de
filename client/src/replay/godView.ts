import type { ParsedTracks, TrackEntry } from "../../../shared/net/replay";
import { type Vec2, v2 } from "../../../shared/utils/v2";

/** One player's interpolated god-view state at the current replay time. */
export interface GodViewPlayer {
    id: number;
    pos: Vec2;
    health: number;
    boost: number;
    dead: boolean;
    downed: boolean;
    name: string;
    teamId: number;
    groupId: number;
}

/** Interpolated god-view snapshot for one replay frame (id -> player). */
export type GodViewSnapshot = Map<number, GodViewPlayer>;

interface PlayerMeta {
    name: string;
    teamId: number;
    groupId: number;
}

/**
 * Holds a game's god-view track samples (every player's server-authoritative
 * pos/health, recorded regardless of any POV's view culling) and produces an
 * interpolated snapshot for a given replay time. Lets the replay's advanced
 * spectator show all players even when they're outside the watched POV's view.
 */
export class ReplayGodView {
    private readonly startTs: number;
    private readonly samples: ParsedTracks["samples"];
    private readonly meta = new Map<number, PlayerMeta>();

    /** Latest interpolated snapshot (id -> player). Updated in-place by `update()`. */
    readonly current = new Map<number, GodViewPlayer>();

    constructor(parsed: ParsedTracks) {
        this.startTs = parsed.meta.startTs;
        // Samples arrive in write order (monotonic time), but sort defensively.
        this.samples = [...parsed.samples].sort((a, b) => a.tMs - b.tMs);
        for (const p of parsed.meta.players) {
            this.meta.set(p.id, { name: p.name, teamId: p.teamId, groupId: p.groupId });
        }
    }

    /** Index of the last sample with tMs <= rel (binary search; -1 if before the first). */
    private baseIndex(rel: number): number {
        let lo = 0;
        let hi = this.samples.length - 1;
        let idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.samples[mid].tMs <= rel) {
                idx = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return idx;
    }

    /** Rebuilds `current` for the given absolute (wall-clock ms) replay time. */
    update(absTimeMs: number): void {
        this.current.clear();
        if (!this.samples.length) return;

        const rel = absTimeMs - this.startTs;
        const baseIdx = Math.max(0, this.baseIndex(rel));
        const base = this.samples[baseIdx];
        const next = this.samples[baseIdx + 1];
        const span = next ? next.tMs - base.tMs : 0;
        const frac = span > 0 ? Math.max(0, Math.min(1, (rel - base.tMs) / span)) : 0;

        const nextById = next ? new Map(next.entries.map((e) => [e.id, e])) : null;

        for (const e of base.entries) {
            const m = this.meta.get(e.id);
            const n: TrackEntry | undefined = nextById?.get(e.id);
            const pos = n
                ? v2.create(e.x + (n.x - e.x) * frac, e.y + (n.y - e.y) * frac)
                : v2.create(e.x, e.y);
            this.current.set(e.id, {
                id: e.id,
                pos,
                health: e.health,
                boost: e.boost,
                dead: e.dead,
                downed: e.downed,
                name: m?.name ?? "",
                teamId: m?.teamId ?? -1,
                groupId: m?.groupId ?? -1,
            });
        }
    }
}
