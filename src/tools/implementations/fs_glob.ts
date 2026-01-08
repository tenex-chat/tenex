import { glob } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { relative } from "node:path";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { tool } from "ai";
import { z } from "zod";

const globSchema = z.object({
    pattern: z
        .string()
        .describe("Glob pattern to match files (e.g., '**/*.ts', 'src/**/*.tsx', '*.json')"),
    path: z
        .string()
        .optional()
        .describe(
            "Absolute path to directory to search in. Defaults to working directory. " +
            "IMPORTANT: Omit this field to use the default. DO NOT pass 'undefined' or 'null'."
        ),
    head_limit: z
        .number()
        .default(100)
        .describe("Limit output to first N files. Use 0 for unlimited."),
    offset: z
        .number()
        .default(0)
        .describe("Skip first N files before applying head_limit"),
    allowOutsideWorkingDirectory: z
        .boolean()
        .optional()
        .describe("Set to true to glob outside the working directory. Required when path is not within the project."),
});

type GlobInput = z.infer<typeof globSchema>;

interface FileWithMtime {
    path: string;
    mtime: number;
}

const DEFAULT_EXCLUDES = [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/coverage/**",
    "**/.worktrees/**",
];

function applyPagination<T>(items: T[], offset: number, limit: number): T[] {
    const offsetItems = offset > 0 ? items.slice(offset) : items;
    return limit > 0 ? offsetItems.slice(0, limit) : offsetItems;
}

async function executeGlob(
    input: GlobInput,
    workingDirectory: string,
): Promise<string> {
    const { pattern, path: inputPath, head_limit, offset, allowOutsideWorkingDirectory } = input;

    // If path is provided, validate it's absolute
    if (inputPath && !inputPath.startsWith("/")) {
        return `Path must be absolute, got: ${inputPath}`;
    }

    // Determine search directory
    const searchDir = inputPath ?? workingDirectory;

    // Check if path is outside working directory
    const normalizedPath = searchDir.endsWith("/") ? searchDir.slice(0, -1) : searchDir;
    const normalizedWorkingDir = workingDirectory.endsWith("/") ? workingDirectory.slice(0, -1) : workingDirectory;
    const isOutside = !normalizedPath.startsWith(normalizedWorkingDir + "/") && normalizedPath !== normalizedWorkingDir;

    if (isOutside && !allowOutsideWorkingDirectory) {
        return `Path "${searchDir}" is outside your working directory "${workingDirectory}". If this was intentional, retry with allowOutsideWorkingDirectory: true`;
    }

    // Collect files with modification times
    const filesWithMtime: FileWithMtime[] = [];

    try {
        // Use Node.js built-in glob (Node 20+)
        const matches = glob(pattern, {
            cwd: searchDir,
            exclude: (name) => DEFAULT_EXCLUDES.some((exclude) => {
                // Simple glob matching for excludes
                if (exclude.includes("**")) {
                    const pattern = exclude.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
                    return new RegExp(pattern).test(name);
                }
                return name.includes(exclude.replace(/\*/g, ""));
            }),
        });

        for await (const match of matches) {
            try {
                const fullPath = `${searchDir}/${match}`;
                const stats = await stat(fullPath);
                if (stats.isFile()) {
                    filesWithMtime.push({
                        path: relative(workingDirectory, fullPath),
                        mtime: stats.mtimeMs,
                    });
                }
            } catch {
                // Skip files we can't stat
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Glob error: ${message}`;
    }

    if (filesWithMtime.length === 0) {
        return `No files found matching pattern: ${pattern}`;
    }

    // Sort by modification time (most recent first)
    filesWithMtime.sort((a, b) => b.mtime - a.mtime);

    // Apply pagination
    const paginatedFiles = applyPagination(filesWithMtime, offset, head_limit);
    const truncated = paginatedFiles.length < filesWithMtime.length;
    const result = paginatedFiles.map((f) => f.path).join("\n");

    if (truncated) {
        return `${result}\n\n[Truncated: showing ${paginatedFiles.length} of ${filesWithMtime.length} files]`;
    }

    return result;
}

export function createFsGlobTool(context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Fast file pattern matching tool that works with any codebase size. " +
            "Supports glob patterns like '**/*.ts' or 'src/**/*.tsx'. " +
            "Returns matching file paths sorted by modification time (most recent first). " +
            "Results limited to 100 files by default (use head_limit to adjust, 0 for unlimited). " +
            "Path must be absolute. Globbing outside the working directory requires allowOutsideWorkingDirectory: true.",

        inputSchema: globSchema,

        execute: async (input: GlobInput) => {
            return await executeGlob(input, context.workingDirectory);
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: (input: GlobInput) => {
            const pathInfo = input.path ? ` in ${input.path}` : "";
            return `Finding files matching '${input.pattern}'${pathInfo}`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
