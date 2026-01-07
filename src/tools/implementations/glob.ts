import { glob } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { relative } from "node:path";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { resolveAndValidatePath } from "../utils";
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
            "Directory to search in. Defaults to project root. " +
            "IMPORTANT: Omit this field to use the default. DO NOT pass 'undefined' or 'null'."
        ),
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

async function executeGlob(
    input: GlobInput,
    context: ToolExecutionContext
): Promise<string> {
    const { pattern, path: inputPath } = input;

    // Resolve search directory
    const searchDir = inputPath
        ? resolveAndValidatePath(inputPath, context.workingDirectory)
        : context.workingDirectory;

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
                        path: relative(context.workingDirectory, fullPath),
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

    // Return file paths, one per line
    return filesWithMtime.map((f) => f.path).join("\n");
}

export function createGlobTool(context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Fast file pattern matching tool that works with any codebase size. " +
            "Supports glob patterns like '**/*.ts' or 'src/**/*.tsx'. " +
            "Returns matching file paths sorted by modification time (most recent first). " +
            "Automatically excludes node_modules, .git, dist, build, .next, and coverage directories.",

        inputSchema: globSchema,

        execute: async (input: GlobInput) => {
            return await executeGlob(input, context);
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
