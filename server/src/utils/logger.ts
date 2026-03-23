import { Logger } from "../../../shared/utils/logger";
import { Config } from "../config";
import { logErrorToWebhook } from "./serverHelpers";
import { gameLogger } from "./betterLogger";

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
