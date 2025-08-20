import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger";

/**
 * Write JSON data to a file with consistent formatting
 */
export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

/**
 * Read and parse JSON data from a file
 */
export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf-8");
  return JSON.parse(content) as T;
}

/**
 * Create directory recursively if it doesn't exist
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Handle persistence errors consistently
 */
export function handlePersistenceError(operation: string, error: unknown): void {
  logger.error(`Failed to ${operation}:`, error);
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
