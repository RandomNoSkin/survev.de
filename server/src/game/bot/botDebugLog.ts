/**
 * Temporary, dev-only diagnostic log for tuning movement/firing decisions from real
 * play - not part of the bot's actual behavior. One line per think tick per bot,
 * appended as JSONL to `bot-debug.jsonl` in the working directory. Gated on
 * `Config.bots.enabled` (dev-only already) so this never runs in production and never
 * needs its own config flag. Meant to be removed once the current tuning pass is done.
 */
import { appendFileSync } from "node:fs";
import { Config } from "../../config.ts";
import type { Player } from "../objects/player.ts";

const LOG_PATH = "bot-debug.jsonl";

export function logBotTick(bot: Player, info: Record<string, unknown>): void {
    // `process.env.VITEST` is set automatically by the test runner - several tests
    // flip `Config.bots.enabled` on directly to exercise bot code paths, which would
    // otherwise make every test run (including the 15-25x stress loops) spam this file.
    if (!Config.bots.enabled || process.env.VITEST) return;
    try {
        const line = JSON.stringify({ t: Math.round(bot.game.now), botId: bot.__id, ...info });
        appendFileSync(LOG_PATH, line + "\n");
    } catch {
        // best-effort debug logging only - never let this break the game
    }
}
