/**
 * Test utilities for TENEX backend
 *
 * This module provides comprehensive testing utilities including:
 * - Mock LLM service for deterministic E2E testing
 * - Mock factories for common objects
 * - Test environment helpers
 * - Assertion utilities
 */

export * from "./conversational-logger";
export * from "./e2e-conversational-setup";
export * from "./mock-factories";
export * from "./mock-llm";
export * from "./mock-setup";

import { expect, mock } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * Create a temporary directory for testing
 */
export async function createTempDir(prefix = "tenex-test-"): Promise<string> {
    const tempPath = path.join(tmpdir(), prefix + Math.random().toString(36).substr(2, 9));
    await fs.mkdir(tempPath, { recursive: true });
    return tempPath;
}

/**
 * Clean up a temporary directory
 */
export async function cleanupTempDir(dirPath: string): Promise<void> {
    try {
        await fs.rm(dirPath, { recursive: true, force: true });
    } catch {
        // Ignore errors during cleanup
    }
}

/**
 * Reset all mocks and singletons
 */
export function resetAllMocks(): void {
    mock.restore();

    // Reset singletons
    const modules = [
        "@/services/mcp/MCPService",
        "@/services/ConfigService",
        "@/services/ProjectContext",
    ];

    for (const module of modules) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const mod = require(module);
            if (mod.instance) {
                mod.instance = undefined;
            }
            if (mod.getInstance?.cache) {
                mod.getInstance.cache = undefined;
            }
        } catch {
            // Module might not be loaded
        }
    }
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
    condition: () => boolean | Promise<boolean>,
    timeout = 5000,
    interval = 100
): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
        if (await condition()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * Mock file system operations
 */
export function mockFileSystem(files: Map<string, string>): Map<string, string> {
    mock.module("@/lib/fs", () => ({
        fileExists: mock((path: string) => files.has(path)),
        readFile: mock((path: string) => {
            const content = files.get(path);
            if (!content) throw new Error(`File not found: ${path}`);
            return content;
        }),
        writeFile: mock((path: string, content: string) => {
            files.set(path, content);
        }),
        ensureDirectory: mock(() => {}),
        writeJsonFile: mock((path: string, data: unknown) => {
            files.set(path, JSON.stringify(data, null, 2));
        }),
    }));

    return files;
}

/**
 * Capture console output during tests
 */
export class ConsoleCapture {
    private logs: string[] = [];
    private errors: string[] = [];
    private originalLog: typeof console.log = console.log;
    private originalError: typeof console.error = console.error;

    start(): void {
        this.originalLog = console.log;
        this.originalError = console.error;

        console.log = (...args: unknown[]) => {
            this.logs.push(args.map(String).join(" "));
        };

        console.error = (...args: unknown[]) => {
            this.errors.push(args.map(String).join(" "));
        };
    }

    stop(): void {
        console.log = this.originalLog;
        console.error = this.originalError;
    }

    getLogs(): string[] {
        return this.logs;
    }

    getErrors(): string[] {
        return this.errors;
    }

    clear(): void {
        this.logs = [];
        this.errors = [];
    }
}

/**
 * Custom assertions
 */
export const assertions = {
    /**
     * Assert that an async function throws an error
     */
    async toThrowAsync(
        fn: () => Promise<unknown>,
        expectedError?: string | RegExp | Error
    ): Promise<void> {
        try {
            await fn();
            throw new Error("Expected function to throw, but it didn't");
        } catch (error) {
            if (expectedError) {
                if (typeof expectedError === "string") {
                    expect((error as Error).message).toContain(expectedError);
                } else if (expectedError instanceof RegExp) {
                    expect((error as Error).message).toMatch(expectedError);
                } else {
                    expect(error).toBe(expectedError);
                }
            }
        }
    },

    /**
     * Assert that an array contains an object matching partial properties
     */
    toContainObjectMatching<T>(array: T[], partial: Partial<T>): void {
        const found = array.some((item) => {
            return Object.entries(partial).every(([key, value]) => {
                return (item as Record<string, unknown>)[key] === value;
            });
        });

        if (!found) {
            throw new Error(`Array does not contain object matching ${JSON.stringify(partial)}`);
        }
    },
};
