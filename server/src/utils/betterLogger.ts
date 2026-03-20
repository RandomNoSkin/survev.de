import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

export const chatLogger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        })
    ),
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
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        })
    ),
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
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        })
    ),
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
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        })
    ),
    transports: [
        new winston.transports.File({ filename: "logs/api.log",
            maxsize: 5*1024*1024,
            maxFiles: 5, }),
    ],
});