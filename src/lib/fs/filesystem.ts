import type { Stats } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";

/**
 * Unified file system utilities combining patterns from CLI and shared packages
 * Provides both sync and async operations with consistent error handling
 *
 * @module filesystem
 * @description
 * This module provides a comprehensive set of file system utilities with:
 * - Path resolution and expansion (home directory ~)
 * - Directory and file existence checks
 * - JSON file read/write operations
 * - Text file operations
 * - Directory listing and management
 * - File copying and deletion
 * - Consistent error handling across all operations
 */

// File operations
export async function readFile(filePath: string, encoding?: BufferEncoding): Promise<string>;
export async function readFile(filePath: string, encoding: null): Promise<Buffer>;
export async function readFile(
    filePath: string,
    encoding?: BufferEncoding | null
): Promise<string | Buffer> {
    return await fsPromises.readFile(filePath, encoding as BufferEncoding | null | undefined);
}

export function expandHome(filePath: string): string {
    if (filePath.startsWith("~")) {
        return path.join(os.homedir(), filePath.slice(1));
    }
    return filePath;
}

export function resolvePath(filePath: string): string {
    return path.resolve(expandHome(filePath));
}

// Directory operations
export async function ensureDirectory(dirPath: string): Promise<void> {
    try {
        await fsPromises.access(dirPath);
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            await fsPromises.mkdir(dirPath, { recursive: true });
        } else {
            throw err;
        }
    }
}

export async function directoryExists(dirPath: string): Promise<boolean> {
    try {
        const stat = await fsPromises.stat(dirPath);
        return stat.isDirectory();
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return false;
        }
        throw err;
    }
}

// Path existence check (works for both files and directories)
export async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fsPromises.access(filePath);
        return true;
    } catch {
        return false;
    }
}

// File operations
export async function fileExists(filePath: string): Promise<boolean> {
    try {
        const stat = await fsPromises.stat(filePath);
        return stat.isFile();
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return false;
        }
        throw err;
    }
}

// JSON operations with error handling
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
        const content = await fsPromises.readFile(resolvePath(filePath), "utf-8");
        return JSON.parse(content) as T;
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return null;
        }
        logger.error(`Failed to read JSON file ${filePath}: ${formatAnyError(err)}`);
        throw err;
    }
}

export async function writeJsonFile<T>(
    filePath: string,
    data: T,
    options?: { spaces?: number }
): Promise<void> {
    const resolvedPath = resolvePath(filePath);
    await ensureDirectory(path.dirname(resolvedPath));
    const spaces = options?.spaces ?? 2;
    await fsPromises.writeFile(resolvedPath, JSON.stringify(data, null, spaces));
}

// File stats
export async function getFileStats(filePath: string): Promise<Stats | null> {
    try {
        return await fsPromises.stat(resolvePath(filePath));
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return null;
        }
        throw err;
    }
}
