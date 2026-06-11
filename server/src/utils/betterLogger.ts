import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

const SPLAT = Symbol.for("splat");

/**
 * Shared log format. The previous printf only emitted `message`, so any
 * `logger.error("text", err)` call silently dropped the `err` (and its stack) —
 * that is why game-process crashes left no usable trace. This appends every extra
 * argument, expanding Errors to their full stack.
 */
function buildFormat() {
    return winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf((info) => {
            const { timestamp, level, message } = info as {
                timestamp: string;
                level: string;
                message: unknown;
            };

            const splat = (info as Record<symbol, unknown>)[SPLAT] as unknown[] | undefined;
            let extra = "";
            if (splat && splat.length) {
                extra =
                    " " +
                    splat
                        .map((arg) =>
                            arg instanceof Error
                                ? (arg.stack ?? arg.message)
                                : typeof arg === "object"
                                  ? JSON.stringify(arg)
                                  : String(arg),
                        )
                        .join(" ");
            }

            return `[${timestamp}] [${level.toUpperCase()}] ${message}${extra}`;
        }),
    );
}

export const chatLogger = winston.createLogger({
    level: "info",
    format: buildFormat(),
    transports: [
        new DailyRotateFile({
            filename: "logs/chat-%DATE%.log",
            datePattern: "YYYY-MM-DD",
            level: "info",
            maxSize: "10m",
            maxFiles: "14d", // logs der letzten 14 Tage
        }),
    ],
});

export const errorLogger = winston.createLogger({
    level: "error",
    format: buildFormat(),
    transports: [
        new DailyRotateFile({
            filename: "logs/error-%DATE%.log",
            datePattern: "YYYY-MM-DD",
            level: "info",
            maxSize: "10m",
            maxFiles: "14d", // logs der letzten 14 Tage
        }),
    ],
});

export const gameLogger = winston.createLogger({
    level: "info",
    format: buildFormat(),
    transports: [
        new DailyRotateFile({
            filename: "logs/game-%DATE%.log",
            datePattern: "YYYY-MM-DD",
            level: "info",
            maxSize: "10m",
            maxFiles: "14d", // logs der letzten 14 Tage
        }),
    ],
});

export const apiLogger = winston.createLogger({
    level: "info",
    format: buildFormat(),
    transports: [
        new winston.transports.File({ filename: "logs/api.log",
            maxsize: 5*1024*1024,
            maxFiles: 5, }),
    ],
});
