import { formatAnyError } from "@/utils/error-formatter";
import chalk from "chalk";
import { logInfo, logError, logDebug } from "@/utils/logger";

/**
 * Debug output utilities for consistent formatting
 */

export function debugLog(message: string, ...args: unknown[]): void {
    if (process.env.DEBUG || process.env.TENEX_DEBUG) {
        logDebug(message, "general", "debug", ...args);
    } else {
        console.log(message, ...args);
    }
}

export function debugError(message: string, error?: unknown): void {
    const errorMessage = formatAnyError(error);
    if (process.env.DEBUG || process.env.TENEX_DEBUG) {
        logError(`${message}: ${errorMessage}`, "general");
    } else {
        console.error(chalk.red(message), errorMessage);
    }
}

export function debugInfo(message: string): void {
    if (process.env.DEBUG || process.env.TENEX_DEBUG) {
        logInfo(message, "general");
    } else {
        console.log(chalk.cyan(message));
    }
}

export function debugSection(title: string, content?: string): void {
    const separator = "=".repeat(title.length + 8);
    debugInfo(`\n=== ${title} ===`);
    if (content) {
        debugLog(content);
    }
    debugInfo(`${separator}\n`);
}

export function debugPrompt(prompt: string): void {
    if (process.env.DEBUG || process.env.TENEX_DEBUG) {
        logDebug(prompt, "general", "debug");
    } else {
        process.stdout.write(chalk.blue(prompt));
    }
}