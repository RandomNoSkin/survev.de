import hjson from "hjson";
import fs from "node:fs/promises";
import { configFilePath, saveConfig } from "../../../config";
import type { ConfigType } from "../../../configType";
import { MapDefs } from "../../../shared/defs/mapDefs";
import { GameMode, TeamMode } from "../../../shared/gameConfig";
import { Config, serverConfigPath } from "../config";

/**
 * This process's survev-config.hjson, edited from the super admin dashboard: the mode
 * list live (applied right away, saved to the file), the whole file as text (checked,
 * the old one kept as .bak - it applies on the next restart).
 */

export type ModeEntry = ConfigType["modes"][number];

/** Size cap for a config file sent in (a real one is a few KB). */
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_MODES = 32;

export function configPath(): string {
    return configFilePath(serverConfigPath);
}

/** The file as it is on disk (comments and all) and what runs right now. */
export async function readConfigFile() {
    const file = configPath();
    const text = await fs.readFile(file, "utf8").catch(() => "");
    return {
        path: file,
        text,
        modes: Config.modes,
        maps: Object.keys(MapDefs).sort(),
        // the GameMode enum as name / value pairs (the editor's dropdown)
        gameModes: Object.entries(GameMode)
            .filter(([, v]) => typeof v === "number")
            .map(([name, value]) => ({ name, value: value as number })),
    };
}

/** A mode list from the dashboard - checked entry by entry; undefined: not valid. */
export function cleanModes(input: unknown): { modes?: ModeEntry[]; error?: string } {
    if (!Array.isArray(input) || !input.length || input.length > MAX_MODES) return { error: "modes: 1 to 32 entries" };
    const teamModes = [TeamMode.Solo, TeamMode.Duo, TeamMode.Squad];
    const gameModes = Object.values(GameMode).filter((v) => typeof v === "number") as number[];
    const out: ModeEntry[] = [];
    for (const [i, m] of input.entries()) {
        if (!m || typeof m !== "object") return { error: `mode ${i}: not an object` };
        const { mapName, teamMode, gameMode, arena, enabled } = m as Record<string, unknown>;
        if (typeof mapName !== "string" || !(mapName in MapDefs)) return { error: `mode ${i}: unknown map "${mapName}"` };
        if (!teamModes.includes(teamMode as TeamMode)) return { error: `mode ${i}: team mode must be 1, 2 or 4` };
        if (gameMode !== undefined && !gameModes.includes(gameMode as number)) return { error: `mode ${i}: unknown game mode` };
        const entry: ModeEntry = {
            mapName: mapName as ModeEntry["mapName"],
            teamMode: teamMode as TeamMode,
            enabled: enabled === true,
        };
        if (gameMode !== undefined && gameMode !== GameMode.Standard) entry.gameMode = gameMode as GameMode;
        if (arena === true) entry.arena = true;
        out.push(entry);
    }
    if (!out.some((m) => m.enabled)) return { error: "at least one mode must stay enabled" };
    return { modes: out };
}

/** The mode list: live for new games / the API's next refresh, and into the file. */
export function applyModes(modes: ModeEntry[]): void {
    Config.modes = modes;
    saveConfig(serverConfigPath, { modes });
}

/**
 * The whole file from the dashboard: must parse (hjson) to an object - the old one
 * is kept as survev-config.hjson.bak. Applies on the next restart.
 */
export async function writeConfigText(text: unknown): Promise<{ ok: boolean; error?: string; backup?: string }> {
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: "empty config" };
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) return { ok: false, error: "config too big" };
    let parsed: unknown;
    try {
        parsed = hjson.parse(text);
    } catch (err) {
        return { ok: false, error: `not valid hjson: ${(err as Error).message}` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "the config must be an object" };
    const modes = (parsed as { modes?: unknown }).modes;
    if (modes !== undefined) {
        const check = cleanModes(modes);
        if (check.error) return { ok: false, error: check.error };
    }
    const file = configPath();
    const backup = `${file}.bak`;
    await fs.copyFile(file, backup).catch(() => {});
    await fs.writeFile(file, text, "utf8");
    return { ok: true, backup };
}
