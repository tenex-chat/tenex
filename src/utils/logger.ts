import fs from "fs";
import os from "os";
import path from "path";
import type { TenexConfig } from "@/services/config/types";
import chalk from "chalk";

const levels: Record<string, number> = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
};

// Helper to get current log level dynamically
function getCurrentLevel(): number {
    const LOG_LEVEL = process.env.LOG_LEVEL || "info";
    return levels[LOG_LEVEL] || levels.info;
}

// Helper to check if debug is enabled
function isDebugEnabled(): boolean {
    return process.env.DEBUG === "true";
}

// Color configuration for consistent output
const colors = {
    error: chalk.red,
    warn: chalk.yellow,
    info: chalk.blue,
    success: chalk.green,
    debug: chalk.gray,
};

const emojis = {
    error: "❌",
    warn: "⚠️",
    info: "ℹ️",
    success: "✅",
    debug: "🔍",
};

// File logging state
let logFilePath: string | null = null;

// Helper to format timestamp for file output
function formatTimestamp(): string {
    const now = new Date();
    return now.toISOString().replace("T", " ").split(".")[0];
}

// Helper to write to log file
function writeToFile(level: string, message: string, args: unknown[]): void {
    if (!logFilePath) return;

    const timestamp = formatTimestamp();
    const argsStr =
        args.length > 0
            ? " " +
              args
                  .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
                  .join(" ")
            : "";

    const logLine = `[${timestamp}] ${level.toUpperCase()}: ${message}${argsStr}\n`;

    fs.appendFileSync(logFilePath, logLine);
}

// Initialize daemon logging
function initDaemonLogging(config: TenexConfig): void {
    const defaultLogPath = path.join(os.homedir(), ".tenex", "daemon.log");
    logFilePath = config.logging?.logFile || defaultLogPath;

    // Ensure directory exists
    const logDir = path.dirname(logFilePath);
    fs.mkdirSync(logDir, { recursive: true });
}

// Main logger object
export const logger = {
    initDaemonLogging,

    error: (message: string, error?: unknown) => {
        if (getCurrentLevel() >= levels.error) {
            if (logFilePath) {
                writeToFile("error", message, error ? [error] : []);
            } else {
                console.error(colors.error(`${emojis.error} ${message}`), error || "");
            }
        }
    },

    warn: (message: string, ...args: unknown[]) => {
        if (getCurrentLevel() >= levels.warn) {
            if (logFilePath) {
                writeToFile("warn", message, args);
            } else {
                console.warn(colors.warn(`${emojis.warn} ${message}`), ...args);
            }
        }
    },

    warning: (message: string, ...args: unknown[]) => {
        logger.warn(message, ...args);
    },

    info: (message: string, ...args: unknown[]) => {
        if (getCurrentLevel() >= levels.info) {
            if (logFilePath) {
                writeToFile("info", message, args);
            } else {
                console.log(colors.info(`${emojis.info} ${message}`), ...args);
            }
        }
    },

    success: (message: string, ...args: unknown[]) => {
        if (getCurrentLevel() >= levels.info) {
            if (logFilePath) {
                writeToFile("success", message, args);
            } else {
                console.log(colors.success(`${emojis.success} ${message}`), ...args);
            }
        }
    },

    debug: (message: string, ...args: unknown[]) => {
        if (isDebugEnabled() && getCurrentLevel() >= levels.debug) {
            if (logFilePath) {
                writeToFile("debug", message, args);
            } else {
                console.log(colors.debug(`${emojis.debug} ${message}`), ...args);
            }
        }
    },
};
