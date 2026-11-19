import type { ClientRoomData, SavedPrivateLobbySettings } from "../../../shared/types/privateLobby";

/**
 * Shareable private-lobby settings codes, like the keybind codes: the leader copies
 * one, another leader pastes it to get the same lobby setup (mode, player limit,
 * loadouts, custom map, weapon stats, toggles). JSON -> deflate -> base64url, behind a
 * version prefix. Not a join code - that's the lobby's `#CODE`.
 */
export type LobbyShareSettings = SavedPrivateLobbySettings & Pick<ClientRoomData, "gameModeIdx" | "playerLimit">;

const PREFIX = "L1.";

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
    const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(out).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): Uint8Array {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

export async function encodeLobbySettings(settings: LobbyShareSettings): Promise<string> {
    const json = new TextEncoder().encode(JSON.stringify(settings));
    return PREFIX + toBase64Url(await pipe(json, new CompressionStream("deflate-raw")));
}

/** The settings in `code`, or undefined when it isn't a (readable) lobby code. */
export async function decodeLobbySettings(code: string): Promise<LobbyShareSettings | undefined> {
    const trimmed = code.trim();
    if (!trimmed.startsWith(PREFIX)) return undefined;
    try {
        const json = await pipe(fromBase64Url(trimmed.slice(PREFIX.length)), new DecompressionStream("deflate-raw"));
        const parsed = JSON.parse(new TextDecoder().decode(json));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}
