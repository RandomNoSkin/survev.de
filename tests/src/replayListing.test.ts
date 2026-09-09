import "./testHelpers.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Config } from "../../server/src/config.ts";
import { listRecordings } from "../../server/src/game/recording/gameRecorder.ts";

// The Replays tab used to read every meta.json on the host before it could render, which
// is what made it take forever. listRecordings now walks days newest-first and stops at
// the limit instead of scanning the whole archive.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "survev-recordings-"));
const originalDir = Config.recording.dir;

/** Writes `count` fake recordings into one YYYY-MM-DD day dir. */
function seedDay(day: string, count: number, baseTs: number) {
    const dayDir = path.join(root, day);
    fs.mkdirSync(dayDir, { recursive: true });
    for (let i = 0; i < count; i++) {
        const gameId = `${day}-game-${i}`;
        fs.mkdirSync(path.join(dayDir, gameId));
        fs.writeFileSync(
            path.join(dayDir, gameId, "meta.json"),
            JSON.stringify({ gameId, startTs: baseTs + i, players: [] }),
        );
    }
}

beforeAll(() => {
    Config.recording.dir = root;
    seedDay("2026-01-01", 5, 1_000);
    seedDay("2026-01-02", 5, 2_000);
    seedDay("2026-01-03", 5, 3_000);
    // An aborted game leaves a dir with no meta.json — it must be skipped, not thrown on.
    fs.mkdirSync(path.join(root, "2026-01-03", "incomplete"));
});

afterAll(() => {
    Config.recording.dir = originalDir;
    fs.rmSync(root, { recursive: true, force: true });
});

test("Lists every recording newest first without a limit", async () => {
    const recs = await listRecordings();

    expect(recs.length).toBe(15);
    const timestamps = recs.map((r) => r.startTs);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
    expect(recs[0].startTs).toBe(3_004);
});

test("A limit returns the newest recordings only", async () => {
    const recs = await listRecordings(4);

    expect(recs.length).toBe(4);
    // Newest day is 2026-01-03, so only its games may appear.
    expect(recs.every((r) => r.gameId.startsWith("2026-01-03"))).toBe(true);
    expect(recs[0].startTs).toBe(3_004);
});

test("A limit spanning days keeps the order across them", async () => {
    const recs = await listRecordings(7);

    expect(recs.length).toBe(7);
    expect(recs[0].startTs).toBe(3_004);
    // 5 from the newest day, then the top 2 of the day before.
    expect(recs[6].startTs).toBe(2_003);
});

test("Missing recordings dir yields an empty list", async () => {
    Config.recording.dir = path.join(root, "does-not-exist");
    await expect(listRecordings()).resolves.toEqual([]);
    Config.recording.dir = root;
});
