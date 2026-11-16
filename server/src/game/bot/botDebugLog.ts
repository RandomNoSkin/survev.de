/**
 * Temporary, dev-only diagnostic log for tuning movement/firing decisions from real
 * play - not part of the bot's actual behavior. One line per think tick per bot,
 * appended as JSONL to `bot-debug.jsonl` in the working directory. Gated on
 * `Config.bots.enabled` (dev-only already) so this never runs in production and never
 * needs its own config flag. Meant to be removed once the current tuning pass is done.
 *
 * Lines are buffered and written asynchronously about once a second - a synchronous
 * write per think tick blocked the game loop and tripped the bot watchdog
 * (see BotBarn.sampleTickCost). A file over MAX_LOG_BYTES is moved to
 * `bot-debug.old.jsonl` (replacing the previous one) before the next write.
 */
import { appendFileSync, promises as fs } from "node:fs";
import { Config } from "../../config.ts";
import type { Player } from "../objects/player.ts";

const LOG_PATH = "bot-debug.jsonl";
const OLD_LOG_PATH = "bot-debug.old.jsonl";
const MAX_LOG_BYTES = 50 * 1024 * 1024;
const FLUSH_MS = 1000;
/** flush early past this many lines, so a long stall doesn't pile up memory */
const MAX_BUFFERED_LINES = 5000;

let buffer: string[] = [];
let flushTimer: NodeJS.Timeout | undefined;
let flushing = false;
let exitHooked = false;

async function flush(): Promise<void> {
    flushTimer = undefined;
    if (flushing || !buffer.length) return;
    flushing = true;
    const lines = buffer;
    buffer = [];
    try {
        const stat = await fs.stat(LOG_PATH).catch(() => undefined);
        if (stat && stat.size > MAX_LOG_BYTES) await fs.rename(LOG_PATH, OLD_LOG_PATH);
        await fs.appendFile(LOG_PATH, lines.join("\n") + "\n");
    } catch {
        // best-effort debug logging only - never let this break the game
    } finally {
        flushing = false;
        if (buffer.length) scheduleFlush();
    }
}

function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => void flush(), FLUSH_MS);
    flushTimer.unref();
}

export function logBotTick(bot: Player, info: Record<string, unknown>): void {
    // `process.env.VITEST` is set automatically by the test runner - several tests
    // flip `Config.bots.enabled` on directly to exercise bot code paths, which would
    // otherwise make every test run (including the 15-25x stress loops) spam this file.
    if (!Config.bots.enabled || process.env.VITEST) return;
    try {
        buffer.push(JSON.stringify({ t: Math.round(bot.game.now), botId: bot.__id, ...info }));
    } catch {
        return;
    }
    if (!exitHooked) {
        exitHooked = true;
        // whatever is still buffered when the server stops
        process.once("exit", () => {
            if (!buffer.length) return;
            try {
                appendFileSync(LOG_PATH, buffer.join("\n") + "\n");
            } catch {}
        });
    }
    if (buffer.length >= MAX_BUFFERED_LINES) {
        if (flushTimer) clearTimeout(flushTimer);
        void flush();
    } else {
        scheduleFlush();
    }
}
