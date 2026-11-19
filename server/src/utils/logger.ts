import { Logger } from "../../../shared/utils/logger.ts";
import { Config } from "../config.ts";
import { gameLogger } from "./betterLogger.ts";

/** How long the webhook fetch is allowed to hang before giving up. Discord itself is
 *  usually sub-second; this only guards against the whole connect taking the undici
 *  default of 10s per call when the endpoint is unreachable. */
const WEBHOOK_FETCH_TIMEOUT_MS = 5000;

/** After this many consecutive webhook failures, stop trying for `WEBHOOK_COOLDOWN_MS`
 *  instead of re-attempting (and re-timing-out) on every single subsequent error log.
 *  Without this, an outage reaching discord.com (seen in prod: ConnectTimeoutError to
 *  discord.com:443) turns every server error into another hung 10s fetch, piling up
 *  concurrently on the resource-constrained prod box for as long as the outage lasts. */
const WEBHOOK_FAILURE_THRESHOLD = 3;
const WEBHOOK_COOLDOWN_MS = 5 * 60 * 1000;

let consecutiveWebhookFailures = 0;
let webhookCircuitOpenUntil = 0;

export async function logErrorToWebhook(from: "server" | "client", ...messages: any[]) {
    const url = from === "server" ? Config.errorLoggingWebhook : Config.clientErrorLoggingWebhook;
    if (!url) return;

    if (Date.now() < webhookCircuitOpenUntil) return;

    try {
        const msg = messages
            .map((msg) => {
                if (msg instanceof Error) {
                    return `\`\`\`${msg.cause}\n${msg.stack}\`\`\``;
                }
                if (typeof msg === "object") {
                    return `\`\`\`json\n${JSON.stringify(msg, null, 2).replaceAll("`", "\\`")}\`\`\``;
                }
                return `${msg}`;
            })
            .join("\n");

        await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                embeds: [
                    {
                        color: 0xff0000,
                        title: `${from} error`,
                        timestamp: new Date().toISOString(),
                        description: msg,
                        footer: {
                            text: `Region: ${Config.gameServer.thisRegion}`,
                        },
                    },
                ],
            }),
            signal: AbortSignal.timeout(WEBHOOK_FETCH_TIMEOUT_MS),
        });
        consecutiveWebhookFailures = 0;
    } catch (err) {
        // dont use defaultLogger.error here to not log it recursively :)
        console.error("Failed to log error to webhook", err);

        consecutiveWebhookFailures++;
        if (consecutiveWebhookFailures >= WEBHOOK_FAILURE_THRESHOLD) {
            webhookCircuitOpenUntil = Date.now() + WEBHOOK_COOLDOWN_MS;
            consecutiveWebhookFailures = 0;
            console.error(
                `Webhook error logging disabled for ${WEBHOOK_COOLDOWN_MS / 1000}s after ${WEBHOOK_FAILURE_THRESHOLD} consecutive failures`,
            );
        }
    }
}

const logCfg = Config.logging;
export class ServerLogger extends Logger {
    constructor(prefix: string) {
        super(logCfg, prefix);
    }

    override error(...message: any[]): void {
        super.error(...message);

        gameLogger.error(`[${this.prefix}] ${this.formatMessage(message)}`);

        if (!this.config.errorLogs) return;
        logErrorToWebhook("server", ...message);
    }


    formatMessage(message: any[]): string {
    return message
        .map((m) => {
            if (m instanceof Error) {
                return m.stack ?? m.message;
            }
            if (typeof m === "object") {
                try {
                    return JSON.stringify(m);
                } catch {
                    return String(m);
                }
            }
            return String(m);
        })
        .join(" ");
}
}

export const defaultLogger = new ServerLogger("Generic");
