import { readFile, readdir, stat } from "node:fs/promises";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { formatAnyError } from "@/lib/error-formatter";
import { tool } from "ai";
import { z } from "zod";

const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;

const readPathSchema = z.object({
    path: z
        .string()
        .describe("The absolute path to the file or directory to read"),
    offset: z
        .number()
        .min(1)
        .optional()
        .describe("Line number to start reading from (1-based). If omitted, starts from line 1."),
    limit: z
        .number()
        .min(1)
        .optional()
        .describe(`Maximum number of lines to read. Defaults to ${DEFAULT_LINE_LIMIT}.`),
    allowOutsideWorkingDirectory: z
        .boolean()
        .optional()
        .describe("Set to true to read files outside the working directory. Required when path is not within the project."),
});

/**
 * Core implementation of the read_path functionality
 */
async function executeReadPath(
    path: string,
    workingDirectory: string,
    offset?: number,
    limit?: number,
    allowOutsideWorkingDirectory?: boolean,
): Promise<string> {
    if (!path.startsWith("/")) {
        throw new Error(`Path must be absolute, got: ${path}`);
    }

    // Check if path is outside working directory
    const normalizedPath = path.endsWith("/") ? path.slice(0, -1) : path;
    const normalizedWorkingDir = workingDirectory.endsWith("/") ? workingDirectory.slice(0, -1) : workingDirectory;
    const isOutside = !normalizedPath.startsWith(normalizedWorkingDir + "/") && normalizedPath !== normalizedWorkingDir;

    if (isOutside && !allowOutsideWorkingDirectory) {
        return `Path "${path}" is outside your working directory "${workingDirectory}". If this was intentional, retry with allowOutsideWorkingDirectory: true`;
    }

    const stats = await stat(path);

    if (stats.isDirectory()) {
        const files = await readdir(path);
        const fileList = files.map((file) => `  - ${file}`).join("\n");
        return `Directory listing for ${path}:\n${fileList}\n\nTo read a specific file, please specify the full path to the file.`;
    }

    const rawContent = await readFile(path, "utf-8");
    const lines = rawContent.split("\n");
    const totalLines = lines.length;

    // 1-based offset, default to line 1
    const startLine = offset ?? 1;
    const startIndex = startLine - 1;

    if (startIndex >= totalLines) {
        return `File has only ${totalLines} line(s), but offset ${offset} was requested.`;
    }

    // Apply limit (default to DEFAULT_LINE_LIMIT)
    const effectiveLimit = limit ?? DEFAULT_LINE_LIMIT;
    const endIndex = Math.min(startIndex + effectiveLimit, totalLines);
    const selectedLines = lines.slice(startIndex, endIndex);

    // Format with line numbers and truncate long lines
    const numberedLines = selectedLines
        .map((line, idx) => {
            const lineNum = startIndex + idx + 1;
            const truncatedLine = line.length > MAX_LINE_LENGTH
                ? line.slice(0, MAX_LINE_LENGTH) + "..."
                : line;
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

/**
 * Create an AI SDK tool for reading paths
 */
export function createFsReadTool(context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            `Read a file or directory from the filesystem. Returns file contents with line numbers for files, or directory listing for directories. By default reads up to ${DEFAULT_LINE_LIMIT} lines starting from line 1. Use offset (1-based) and limit to paginate large files. Lines longer than ${MAX_LINE_LENGTH} characters are truncated. Path must be absolute. Reading outside the working directory requires allowOutsideWorkingDirectory: true.`,

        inputSchema: readPathSchema,

        execute: async ({ path, offset, limit, allowOutsideWorkingDirectory }: { path: string; offset?: number; limit?: number; allowOutsideWorkingDirectory?: boolean }) => {
            try {
                return await executeReadPath(path, context.workingDirectory, offset, limit, allowOutsideWorkingDirectory);
            } catch (error: unknown) {
                throw new Error(`Failed to read ${path}: ${formatAnyError(error)}`);
            }
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: ({ path }: { path: string }) => {
            return `Reading ${path}`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
