import * as fs from "node:fs";
import type { Stats } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatError } from "@/utils/errors";
import { logError } from "@/utils/logger";

/**
 * Unified file system utilities combining patterns from CLI and shared packages
 * Provides both sync and async operations with consistent error handling
 */

// Path utilities
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

export function ensureDirectorySync(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
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

export function directoryExistsSync(dirPath: string): boolean {
    try {
        const stat = fs.statSync(dirPath);
        return stat.isDirectory();
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return false;
        }
        throw err;
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

export function fileExistsSync(filePath: string): boolean {
    try {
        const stat = fs.statSync(filePath);
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
        logError(`Failed to read JSON file ${filePath}: ${formatError(err)}`);
        throw err;
    }
}

export function readJsonFileSync<T>(filePath: string): T | null {
    try {
        const content = fs.readFileSync(resolvePath(filePath), "utf-8");
        return JSON.parse(content) as T;
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return null;
        }
        logError(`Failed to read JSON file ${filePath}: ${formatError(err)}`);
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

export function writeJsonFileSync<T>(
    filePath: string,
    data: T,
    options?: { spaces?: number }
): void {
    const resolvedPath = resolvePath(filePath);
    ensureDirectorySync(path.dirname(resolvedPath));
    const spaces = options?.spaces ?? 2;
    fs.writeFileSync(resolvedPath, JSON.stringify(data, null, spaces));
}

// Text file operations
export async function readTextFile(filePath: string): Promise<string | null> {
    try {
        return await fsPromises.readFile(resolvePath(filePath), "utf-8");
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return null;
        }
        logError(`Failed to read text file ${filePath}: ${formatError(err)}`);
        throw err;
    }
}

export function readTextFileSync(filePath: string): string | null {
    try {
        return fs.readFileSync(resolvePath(filePath), "utf-8");
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return null;
        }
        logError(`Failed to read text file ${filePath}: ${formatError(err)}`);
        throw err;
    }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
    const resolvedPath = resolvePath(filePath);
    await ensureDirectory(path.dirname(resolvedPath));
    await fsPromises.writeFile(resolvedPath, content, "utf-8");
}

export function writeTextFileSync(filePath: string, content: string): void {
    const resolvedPath = resolvePath(filePath);
    ensureDirectorySync(path.dirname(resolvedPath));
    fs.writeFileSync(resolvedPath, content, "utf-8");
}

// Directory listing
export async function listDirectory(dirPath: string): Promise<string[]> {
    try {
        return await fsPromises.readdir(resolvePath(dirPath));
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return [];
        }
        throw err;
    }
}

export function listDirectorySync(dirPath: string): string[] {
    try {
        return fs.readdirSync(resolvePath(dirPath));
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return [];
        }
        throw err;
    }
}

// File copying
export async function copyFile(src: string, dest: string): Promise<void> {
    const resolvedDest = resolvePath(dest);
    await ensureDirectory(path.dirname(resolvedDest));
    await fsPromises.copyFile(resolvePath(src), resolvedDest);
}

export function copyFileSync(src: string, dest: string): void {
    const resolvedDest = resolvePath(dest);
    ensureDirectorySync(path.dirname(resolvedDest));
    fs.copyFileSync(resolvePath(src), resolvedDest);
}

// File deletion
export async function deleteFile(filePath: string): Promise<void> {
    try {
        await fsPromises.unlink(resolvePath(filePath));
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            // File doesn't exist, that's fine
            return;
        }
        throw err;
    }
}

export function deleteFileSync(filePath: string): void {
    try {
        fs.unlinkSync(resolvePath(filePath));
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            // File doesn't exist, that's fine
            return;
        }
        throw err;
    }
}

// Directory deletion
export async function deleteDirectory(
    dirPath: string,
    options?: { recursive?: boolean }
): Promise<void> {
    try {
        await fsPromises.rm(resolvePath(dirPath), { recursive: options?.recursive ?? true });
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            // Directory doesn't exist, that's fine
            return;
        }
        throw err;
    }
}

export function deleteDirectorySync(dirPath: string, options?: { recursive?: boolean }): void {
    try {
        fs.rmSync(resolvePath(dirPath), { recursive: options?.recursive ?? true });
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            // Directory doesn't exist, that's fine
            return;
        }
        throw err;
    }
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

export function getFileStatsSync(filePath: string): Stats | null {
    try {
        return fs.statSync(resolvePath(filePath));
    } catch (err: unknown) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return null;
        }
        throw err;
    }
}
