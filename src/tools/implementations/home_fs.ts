/**
 * Home-scoped filesystem tools for restricted agents.
 *
 * These tools provide filesystem access ONLY within the agent's home directory.
 * They are auto-injected for agents that don't have fs_* tools configured.
 *
 * Security: All paths are validated via resolveHomeScopedPath() which:
 * - Resolves symlinks to prevent escape attacks
 * - Validates path traversal (../) attempts
 * - Supports both relative and absolute path inputs
 */

import { exec } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { promisify } from "node:util";
import {
    getAgentHomeDirectory,
    HomeScopeViolationError,
    resolveHomeScopedPath,
} from "@/lib/agent-home";
import { formatAnyError } from "@/lib/error-formatter";
import {
    createExpectedError,
    getFsErrorDescription,
    isExpectedFsError,
} from "@/tools/utils";
import { tool } from "ai";
import { z } from "zod";
import type { AISdkTool, ToolExecutionContext } from "../types";

const execAsync = promisify(exec);

// Constants
const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_GREP_CONTENT_SIZE = 50_000; // 50KB threshold

// ============================================================================
// home_fs_read
// ============================================================================

const homeReadSchema = z.object({
    path: z
        .string()
        .describe(
            "Path to the file or directory to read. Can be relative (to your home) or absolute (must be within your home). Example: 'notes.txt' or '+REMINDERS.md'"
        ),
    description: z
        .string()
        .min(1)
        .describe("REQUIRED: Brief description of why you're reading this file (5-10 words)."),
    offset: z
        .number()
        .min(1)
        .optional()
        .describe("Line number to start reading from (1-based). Defaults to line 1."),
    limit: z
        .number()
        .min(1)
        .optional()
        .describe(`Maximum number of lines to read. Defaults to ${DEFAULT_LINE_LIMIT}.`),
});

async function executeHomeRead(
    path: string,
    agentPubkey: string,
    offset?: number,
    limit?: number
): Promise<string> {
    // Resolve and validate path is within home
    const resolvedPath = resolveHomeScopedPath(path, agentPubkey);

    const stats = await stat(resolvedPath);

    if (stats.isDirectory()) {
        const files = await readdir(resolvedPath);
        const fileList = files.map((file) => `  - ${file}`).join("\n");
        return `Directory listing for ${path}:\n${fileList}\n\nTo read a specific file, specify the filename.`;
    }

    const rawContent = await readFile(resolvedPath, "utf-8");
    const lines = rawContent.split("\n");
    const totalLines = lines.length;

    // 1-based offset, default to line 1
    const startLine = offset ?? 1;
    const startIndex = startLine - 1;

    if (startIndex >= totalLines) {
        return `File has only ${totalLines} line(s), but offset ${offset} was requested.`;
    }

    // Apply limit
    const effectiveLimit = limit ?? DEFAULT_LINE_LIMIT;
    const endIndex = Math.min(startIndex + effectiveLimit, totalLines);
    const selectedLines = lines.slice(startIndex, endIndex);

    // Format with line numbers and truncate long lines
    const numberedLines = selectedLines
        .map((line, idx) => {
            const lineNum = startIndex + idx + 1;
            const truncatedLine =
                line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "..." : line;
            return `${lineNum.toString().padStart(6)}\t${truncatedLine}`;
        })
        .join("\n");

    // Add info about truncation if we didn't read the whole file
    const remainingLines = totalLines - endIndex;
    if (remainingLines > 0) {
        return `${numberedLines}\n\n[Showing lines ${startLine}-${endIndex} of ${totalLines}. ${remainingLines} more lines available. Use offset=${endIndex + 1} to continue.]`;
    }

    return numberedLines;
}

export function createHomeFsReadTool(context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            `Read a file or directory from your home directory. This tool ONLY operates within your home directory. You cannot access files outside your home. ` +
            `Returns file contents with line numbers (up to ${DEFAULT_LINE_LIMIT} lines). Use offset (1-based) and limit to paginate large files. ` +
            `Paths can be relative (resolved against your home) or absolute (must be within your home).`,

        inputSchema: homeReadSchema,

        execute: async ({
            path,
            description: _description,
            offset,
            limit,
        }: {
            path: string;
            description: string;
            offset?: number;
            limit?: number;
        }) => {
            try {
                return await executeHomeRead(path, context.agent.pubkey, offset, limit);
            } catch (error: unknown) {
                // Home scope violations return friendly error message
                if (error instanceof HomeScopeViolationError) {
                    return createExpectedError(error.message);
                }

                // Expected FS errors (file not found, permission denied, etc.)
                if (isExpectedFsError(error)) {
                    const code = (error as NodeJS.ErrnoException).code;
                    const description = getFsErrorDescription(code);
                    return createExpectedError(`${description}: ${path}`);
                }

                throw new Error(`Failed to read ${path}: ${formatAnyError(error)}`, {
                    cause: error,
                });
            }
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ path, description }: { path: string; description: string }) => {
            return `Reading ${path} (${description})`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}

// ============================================================================
// home_fs_write
// ============================================================================

const homeWriteSchema = z.object({
    path: z
        .string()
        .describe(
            "Path to the file to write. Can be relative (to your home) or absolute (must be within your home). Parent directories are created automatically."
        ),
    content: z.string().describe("The content to write to the file."),
});

async function executeHomeWrite(
    path: string,
    content: string,
    agentPubkey: string
): Promise<string> {
    // Resolve and validate path is within home
    const resolvedPath = resolveHomeScopedPath(path, agentPubkey);

    // Create parent directories if they don't exist
    const parentDir = dirname(resolvedPath);
    await mkdir(parentDir, { recursive: true });

    // Write the file
    await writeFile(resolvedPath, content, "utf-8");

    return `Successfully wrote ${content.length} bytes to ${path}`;
}

export function createHomeFsWriteTool(context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Write content to a file in your home directory. This tool ONLY operates within your home directory. You cannot write files outside your home. " +
            "Creates parent directories automatically if they don't exist. Overwrites existing files. " +
            "Paths can be relative (resolved against your home) or absolute (must be within your home).",

        inputSchema: homeWriteSchema,

        execute: async ({ path, content }: { path: string; content: string }) => {
            try {
                return await executeHomeWrite(path, content, context.agent.pubkey);
            } catch (error: unknown) {
                // Home scope violations return friendly error message
                if (error instanceof HomeScopeViolationError) {
                    return createExpectedError(error.message);
                }

                // Expected FS errors
                if (isExpectedFsError(error)) {
                    const code = (error as NodeJS.ErrnoException).code;
                    const description = getFsErrorDescription(code);
                    return createExpectedError(`${description}: ${path}`);
                }

                throw new Error(`Failed to write ${path}: ${formatAnyError(error)}`, {
                    cause: error,
                });
            }
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ path }: { path: string }) => {
            return `Writing ${path}`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}

// ============================================================================
// home_fs_grep
// ============================================================================

const homeGrepSchema = z.object({
    pattern: z
        .string()
        .describe("Regex pattern to search for in file contents (e.g., 'TODO', 'function\\s+\\w+')."),
    path: z
        .string()
        .optional()
        .describe(
            "Path within your home to search. Can be relative or absolute (must be within home). Defaults to your entire home directory."
        ),
    output_mode: z
        .enum(["files_with_matches", "content", "count"])
        .default("files_with_matches")
        .describe(
            "Output mode: 'files_with_matches' (file paths only), 'content' (matching lines), 'count' (match counts per file)."
        ),
    "-i": z.boolean().optional().describe("Case-insensitive search."),
    head_limit: z
        .number()
        .default(100)
        .describe("Limit output to first N entries. Use 0 for unlimited."),
});

type HomeGrepInput = z.infer<typeof homeGrepSchema>;

async function isRipgrepAvailable(): Promise<boolean> {
    try {
        await execAsync("which rg", { timeout: 1000 });
        return true;
    } catch {
        return false;
    }
}

function buildHomeGrepCommand(
    input: HomeGrepInput,
    searchPath: string,
    useRipgrep: boolean
): string {
    const { pattern, output_mode, "-i": caseInsensitive } = input;

    const parts: string[] = [];

    if (useRipgrep) {
        parts.push("rg");
        if (output_mode === "files_with_matches") {
            parts.push("-l");
        } else if (output_mode === "count") {
            parts.push("-c");
        } else {
            parts.push("-n"); // Line numbers for content mode
        }
        if (caseInsensitive) {
            parts.push("-i");
        }
    } else {
        parts.push("grep", "-r", "-E");
        if (output_mode === "files_with_matches") {
            parts.push("-l");
        } else if (output_mode === "count") {
            parts.push("-c");
        } else {
            parts.push("-n"); // Line numbers for content mode
        }
        if (caseInsensitive) {
            parts.push("-i");
        }
        parts.push("--binary-files=without-match");
    }

    // Pattern (escape for shell)
    parts.push(`'${pattern.replace(/'/g, "'\\''")}'`);

    // Search path
    parts.push(`'${searchPath}'`);

    return parts.join(" ");
}

function applyPagination(lines: string[], limit: number): string[] {
    return limit > 0 ? lines.slice(0, limit) : lines;
}

async function executeHomeGrep(input: HomeGrepInput, agentPubkey: string): Promise<string> {
    const { pattern, path: inputPath, output_mode, head_limit } = input;
    const homeDir = getAgentHomeDirectory(agentPubkey);

    if (!pattern) {
        return "Error: pattern is required";
    }

    // Determine and validate search path
    const searchPath = inputPath ? resolveHomeScopedPath(inputPath, agentPubkey) : homeDir;

    const useRipgrep = await isRipgrepAvailable();
    const command = buildHomeGrepCommand(input, searchPath, useRipgrep);

    try {
        const { stdout } = await execAsync(command, {
            cwd: homeDir,
            timeout: 30000,
            maxBuffer: 1024 * 1024 * 10, // 10MB
        });

        if (!stdout.trim()) {
            return `No matches found for pattern: ${pattern}`;
        }

        let lines = stdout.trim().split("\n").filter(Boolean);

        // Convert absolute paths to relative (to home)
        lines = lines.map((line) => {
            if (output_mode === "files_with_matches") {
                return relative(homeDir, line);
            } else if (output_mode === "count") {
                const colonIdx = line.lastIndexOf(":");
                if (colonIdx > 0) {
                    const filePath = line.substring(0, colonIdx);
                    const count = line.substring(colonIdx + 1);
                    return `${relative(homeDir, filePath)}:${count}`;
                }
            } else {
                // Content mode: /path/to/file:line:content
                const firstColon = line.indexOf(":");
                if (firstColon > 0) {
                    const filePath = line.substring(0, firstColon);
                    const rest = line.substring(firstColon);
                    return `${relative(homeDir, filePath)}${rest}`;
                }
            }
            return line;
        });

        // Apply pagination
        const paginatedLines = applyPagination(lines, head_limit);
        const result = paginatedLines.join("\n");

        // Check content size
        if (output_mode === "content" && Buffer.byteLength(result, "utf8") > MAX_GREP_CONTENT_SIZE) {
            // Fall back to files_with_matches
            const uniquePaths = new Set<string>();
            for (const line of lines) {
                const firstColon = line.indexOf(":");
                if (firstColon > 0) {
                    uniquePaths.add(line.substring(0, firstColon));
                }
            }
            const fileList = Array.from(uniquePaths).slice(0, head_limit).join("\n");
            return `Content output exceeded 50KB limit. Showing ${uniquePaths.size} matching files:\n\n${fileList}`;
        }

        const truncated = paginatedLines.length < lines.length;
        if (truncated) {
            return `${result}\n\n[Truncated: showing ${paginatedLines.length} of ${lines.length} results]`;
        }

        return result;
    } catch (error) {
        // Exit code 1 from grep/rg means no matches - not an error
        if (error && typeof error === "object" && "code" in error && error.code === 1) {
            return `No matches found for pattern: ${pattern}`;
        }
        throw error;
    }
}

export function createHomeFsGrepTool(context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Search for patterns in files within your home directory. This tool ONLY operates within your home directory. You cannot search files outside your home. " +
            "Uses ripgrep (with grep fallback). Supports regex patterns. " +
            "Output modes: 'files_with_matches' (default), 'content' (matching lines), 'count' (match counts).",

        inputSchema: homeGrepSchema,

        execute: async (input: HomeGrepInput) => {
            try {
                return await executeHomeGrep(input, context.agent.pubkey);
            } catch (error: unknown) {
                // Home scope violations return friendly error message
                if (error instanceof HomeScopeViolationError) {
                    return createExpectedError(error.message);
                }

                const message = error instanceof Error ? error.message : String(error);
                return `Search error: ${message}`;
            }
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: (input: HomeGrepInput) => {
            const pathInfo = input.path ? ` in ${input.path}` : " in home";
            return `Searching for '${input.pattern}'${pathInfo}`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
