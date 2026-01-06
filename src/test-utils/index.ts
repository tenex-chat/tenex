/**
 * Test utilities for TENEX backend
 *
 * This module provides comprehensive testing utilities including:
 * - Mock LLM service for deterministic E2E testing
 * - Mock factories for common objects
 * - Test environment helpers
 */

export * from "./conversational-logger";
export * from "./mock-factories";
export * from "./mock-llm";

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
