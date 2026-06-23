import { createHmac, timingSafeEqual } from "node:crypto";
import { Config } from "../config";

/**
 * Short-lived, HMAC-signed tokens that grant access to a recorded game's replays.
 *
 * The moderation dashboard (admin-gated) mints a token for a specific region/game,
 * then opens the game client at `CLIENT_URL/?replay=<token>`. The client fetches the
 * POV list + each player's file from the public, token-gated `/api/replay*` endpoints
 * — so no admin cookie has to travel cross-origin to the client, access still expires
 * quickly, and the viewer can switch between every POV of that game with one token.
 * Mirrors the existing spectate-token flow.
 */
export interface ReplayTokenData {
    region: string;
    gameId: string;
    /** Expiry, unix ms. */
    exp: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;

function secret(): string {
    return Config.secrets.SURVEV_API_KEY;
}

function sign(body: string): string {
    return createHmac("sha256", secret()).update(body).digest("base64url");
}

export function signReplayToken(
    data: Omit<ReplayTokenData, "exp">,
    ttlMs = DEFAULT_TTL_MS,
): string {
    const payload: ReplayTokenData = { ...data, exp: Date.now() + ttlMs };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${sign(body)}`;
}

export function verifyReplayToken(token: string): ReplayTokenData | null {
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expected = sign(body);
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        return null;
    }

    try {
        const data = JSON.parse(
            Buffer.from(body, "base64url").toString(),
        ) as ReplayTokenData;
        if (
            typeof data.exp !== "number" ||
            data.exp < Date.now() ||
            typeof data.region !== "string" ||
            typeof data.gameId !== "string"
        ) {
            return null;
        }
        return data;
    } catch {
        return null;
    }
}
