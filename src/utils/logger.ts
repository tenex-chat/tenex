import fs from "node:fs";
import path from "node:path";
import { resolvePath } from "@/lib/fs";
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
let warnLogFilePath: string | null = null;
const WARN_LOG_MAX_SIZE = 100 * 1024 * 1024; // 100MB

export function resetLogger(): void {
    logFilePath = null;
    warnLogFilePath = null;
}

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
            ? ` ${args
                  .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
                  .join(" ")}`
            : "";

    const logLine = `[${timestamp}] ${level.toUpperCase()}: ${message}${argsStr}\n`;

    fs.appendFileSync(logFilePath, logLine);
}

/**
 * Structured entry written to warn.log for operator troubleshooting.
 */
export interface WarnLogEntry {
    timestamp: string;
    level: "warn" | "error";
    component: string;
    message: string;
    context?: Record<string, unknown>;
    error?: string;
    stack?: string;
}

/**
 * Rotate warn.log when it exceeds WARN_LOG_MAX_SIZE.
 * Renames current file to warn.log.1, discarding any previous .1.
 */
function rotateWarnLogIfNeeded(): void {
    if (!warnLogFilePath) return;
    try {
        const stat = fs.statSync(warnLogFilePath);
        if (stat.size >= WARN_LOG_MAX_SIZE) {
            const rotatedPath = `${warnLogFilePath}.1`;
            try {
                fs.unlinkSync(rotatedPath);
            } catch {
                // .1 doesn't exist, fine
            }
            fs.renameSync(warnLogFilePath, rotatedPath);
        }
    } catch {
        // File doesn't exist yet, no rotation needed
    }
}

/**
 * Write a structured JSON entry to warn.log.
 * Only writes if warn.log transport has been initialized.
 */
function writeToWarnLog(entry: WarnLogEntry): void {
    if (!warnLogFilePath) return;
    try {
        rotateWarnLogIfNeeded();
        fs.appendFileSync(warnLogFilePath, `${JSON.stringify(entry)}\n`);
    } catch {
        // Swallow — we can't let warn.log failures crash the system
    }
}

// Initialize daemon logging
async function initDaemonLogging(): Promise<void> {
    // Lazy-load config to avoid circular dependency
    const { config } = await import("@/services/ConfigService");

    const tenexConfig = config.getConfig();
    const defaultLogPath = path.join(config.getConfigPath("daemon"), "daemon.log");
    logFilePath = resolvePath(tenexConfig.logging?.logFile || defaultLogPath);

    // Ensure directory exists
    const logDir = path.dirname(logFilePath);
    fs.mkdirSync(logDir, { recursive: true });

    // Initialize warn.log in the same directory
    warnLogFilePath = path.join(logDir, "warn.log");
}

// Main logger object
export const logger = {
    initDaemonLogging,
    writeToWarnLog,

    /**
     * Check if a specific log level is enabled
     * Useful for conditional expensive operations (e.g., stack traces)
     */
    isLevelEnabled: (level: "error" | "warn" | "info" | "debug"): boolean => {
        if (level === "debug") {
            return isDebugEnabled() && getCurrentLevel() >= levels.debug;
        }
        return getCurrentLevel() >= levels[level];
    },

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
