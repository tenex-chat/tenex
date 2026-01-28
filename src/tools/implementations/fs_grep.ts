import { exec } from "node:child_process";
import { promisify } from "node:util";
import { relative } from "node:path";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { isPathWithinDirectory, isWithinAgentHome } from "@/lib/agent-home";
import { tool } from "ai";
import { z } from "zod";

const execAsync = promisify(exec);

const grepSchema = z.object({
    pattern: z
        .string()
        .describe(
            "Regex pattern to search for in file contents (e.g., 'function\\s+\\w+', 'TODO', 'log.*Error')"
        ),
    path: z
        .string()
        .optional()
        .describe("Absolute path to file or directory to search. Defaults to working directory."),
    output_mode: z
        .enum(["files_with_matches", "content", "count"])
        .default("files_with_matches")
        .describe(
            "Output mode: 'files_with_matches' (file paths only), 'content' (matching lines with context), 'count' (match counts per file)"
        ),
    glob: z
        .string()
        .optional()
        .describe("Glob pattern to filter files (e.g., '*.ts', '**/*.tsx')"),
    type: z
        .string()
        .optional()
        .describe("File type filter for ripgrep (e.g., 'ts', 'py', 'rust', 'js')"),
    "-i": z
        .boolean()
        .optional()
        .describe("Case-insensitive search"),
    "-n": z
        .boolean()
        .default(true)
        .describe("Show line numbers (only with output_mode: 'content')"),
    "-A": z
        .number()
        .optional()
        .describe("Lines to show after each match (only with output_mode: 'content')"),
    "-B": z
        .number()
        .optional()
        .describe("Lines to show before each match (only with output_mode: 'content')"),
    "-C": z
        .number()
        .optional()
        .describe("Lines to show before and after each match (only with output_mode: 'content')"),
    multiline: z
        .boolean()
        .default(false)
        .describe("Enable multiline mode where patterns can span lines"),
    head_limit: z
        .number()
        .default(100)
        .describe("Limit output to first N entries. Use 0 for unlimited."),
    offset: z
        .number()
        .default(0)
        .describe("Skip first N entries before applying head_limit"),
    allowOutsideWorkingDirectory: z
        .boolean()
        .optional()
        .describe("Set to true to search outside the working directory. Required when path is not within the project."),
});

type GrepInput = z.infer<typeof grepSchema>;

async function isRipgrepAvailable(): Promise<boolean> {
    try {
        await execAsync("which rg", { timeout: 1000 });
        return true;
    } catch {
        return false;
    }
}

function buildRipgrepCommand(input: GrepInput, searchPath: string): string {
    const {
        pattern,
        output_mode,
        glob: globPattern,
        type: fileType,
        "-i": caseInsensitive,
        "-n": showLineNumbers,
        "-A": contextAfter,
        "-B": contextBefore,
        "-C": contextAround,
        multiline,
    } = input;

    const parts: string[] = ["rg"];

    // Output mode flags
    if (output_mode === "files_with_matches") {
        parts.push("-l");
    } else if (output_mode === "count") {
        parts.push("-c");
    }

    // Line numbers (default true for content mode)
    if (output_mode === "content" && showLineNumbers !== false) {
        parts.push("-n");
    }

    // Case insensitive
    if (caseInsensitive) {
        parts.push("-i");
    }

    // Multiline
    if (multiline) {
        parts.push("-U", "--multiline-dotall");
    }

    // Context lines (only for content mode)
    if (output_mode === "content") {
        if (contextAround != null && contextAround > 0) {
            parts.push("-C", `${contextAround}`);
        } else {
            if (contextBefore != null && contextBefore > 0) {
                parts.push("-B", `${contextBefore}`);
            }
            if (contextAfter != null && contextAfter > 0) {
                parts.push("-A", `${contextAfter}`);
            }
        }
    }

    // File type filter
    if (fileType) {
        parts.push("--type", fileType);
    }

    // Glob pattern filter
    if (globPattern) {
        parts.push("--glob", `'${globPattern}'`);
    }

    // Default exclusions
    parts.push("--glob", "'!node_modules'");
    parts.push("--glob", "'!.git'");
    parts.push("--glob", "'!dist'");
    parts.push("--glob", "'!build'");
    parts.push("--glob", "'!.next'");
    parts.push("--glob", "'!coverage'");

    // Pattern (escape for shell)
    parts.push(`'${pattern.replace(/'/g, "'\\''")}'`);

    // Search path
    parts.push(`'${searchPath}'`);

    return parts.join(" ");
}

function buildGrepCommand(input: GrepInput, searchPath: string): string {
    const {
        pattern,
        output_mode,
        glob: globPattern,
        "-i": caseInsensitive,
        "-n": showLineNumbers,
        "-A": contextAfter,
        "-B": contextBefore,
        "-C": contextAround,
    } = input;

    const parts: string[] = ["grep", "-r", "-E"];

    // Output mode flags
    if (output_mode === "files_with_matches") {
        parts.push("-l");
    } else if (output_mode === "count") {
        parts.push("-c");
    }

    // Line numbers (default true for content mode)
    if (output_mode === "content" && showLineNumbers !== false) {
        parts.push("-n");
    }

    // Case insensitive
    if (caseInsensitive) {
        parts.push("-i");
    }

    // Context lines (only for content mode)
    if (output_mode === "content") {
        if (contextAround != null && contextAround > 0) {
            parts.push("-C", `${contextAround}`);
        } else {
            if (contextBefore != null && contextBefore > 0) {
                parts.push("-B", `${contextBefore}`);
            }
            if (contextAfter != null && contextAfter > 0) {
                parts.push("-A", `${contextAfter}`);
            }
        }
    }

    // Glob pattern filter (grep uses --include)
    if (globPattern) {
        parts.push(`--include='${globPattern}'`);
    }

    // Default exclusions
    parts.push("--exclude-dir=node_modules");
    parts.push("--exclude-dir=.git");
    parts.push("--exclude-dir=dist");
    parts.push("--exclude-dir=build");
    parts.push("--exclude-dir=.next");
    parts.push("--exclude-dir=coverage");
    parts.push("--binary-files=without-match");

    // Pattern
    parts.push(`'${pattern.replace(/'/g, "'\\''")}'`);

    // Search path
    parts.push(`'${searchPath}'`);

    return parts.join(" ");
}

function applyPagination(lines: string[], offset: number, limit: number): string[] {
    const offsetLines = offset > 0 ? lines.slice(offset) : lines;
    return limit > 0 ? offsetLines.slice(0, limit) : offsetLines;
}

async function executeGrep(
    input: GrepInput,
    workingDirectory: string,
    agentPubkey: string,
): Promise<string> {
    const { pattern, path: inputPath, output_mode, head_limit, offset, allowOutsideWorkingDirectory } = input;

    if (!pattern) {
        return "Error: pattern is required";
    }

    // If path is provided, validate it's absolute
    if (inputPath && !inputPath.startsWith("/")) {
        return `Path must be absolute, got: ${inputPath}`;
    }

    // Determine search path
    const searchPath = inputPath ?? workingDirectory;

    // Check if path is within working directory (using secure path normalization)
    const isWithinWorkDir = isPathWithinDirectory(searchPath, workingDirectory);

    // Always allow access to agent's home directory without requiring allowOutsideWorkingDirectory
    const isInAgentHome = isWithinAgentHome(searchPath, agentPubkey);

    if (!isWithinWorkDir && !isInAgentHome && !allowOutsideWorkingDirectory) {
        return `Path "${searchPath}" is outside your working directory "${workingDirectory}". If this was intentional, retry with allowOutsideWorkingDirectory: true`;
    }

    const useRipgrep = await isRipgrepAvailable();
    const command = useRipgrep
        ? buildRipgrepCommand(input, searchPath)
        : buildGrepCommand(input, searchPath);

    try {
        const { stdout } = await execAsync(command, {
            cwd: workingDirectory,
            timeout: 30000,
            maxBuffer: 1024 * 1024 * 10, // 10MB
        });

        if (!stdout.trim()) {
            return `No matches found for pattern: ${pattern}`;
        }

        let lines = stdout.trim().split("\n").filter(Boolean);

        // Convert absolute paths to relative
        lines = lines.map((line) => {
            // Handle different output formats
            if (output_mode === "files_with_matches") {
                return relative(workingDirectory, line);
            } else if (output_mode === "count") {
                // Format: /path/to/file:count
                const colonIdx = line.lastIndexOf(":");
                if (colonIdx > 0) {
                    const filePath = line.substring(0, colonIdx);
                    const count = line.substring(colonIdx + 1);
                    return `${relative(workingDirectory, filePath)}:${count}`;
                }
            } else {
                // Content mode: /path/to/file:line:content
                const firstColon = line.indexOf(":");
                if (firstColon > 0) {
                    const filePath = line.substring(0, firstColon);
                    const rest = line.substring(firstColon);
                    return `${relative(workingDirectory, filePath)}${rest}`;
                }
            }
            return line;
        });

        // Apply pagination
        const paginatedLines = applyPagination(lines, offset, head_limit);

        const truncated = paginatedLines.length < lines.length;
        const result = paginatedLines.join("\n");

        if (truncated) {
            return `${result}\n\n[Truncated: showing ${paginatedLines.length} of ${lines.length} results]`;
        }

        return result;
    } catch (error) {
        // Exit code 1 from grep/rg means no matches - not an error
        if (error && typeof error === "object" && "code" in error && error.code === 1) {
            return `No matches found for pattern: ${pattern}`;
        }

        const message = error instanceof Error ? error.message : String(error);
        return `Grep error: ${message}`;
    }
}

export function createFsGrepTool(context: ToolExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Powerful content search tool built on ripgrep (with grep fallback). " +
            "Supports full regex syntax (e.g., 'log.*Error', 'function\\s+\\w+'). " +
            "Output modes: 'files_with_matches' (default, file paths only), 'content' (matching lines), 'count' (match counts). " +
            "Filter files with 'glob' parameter (e.g., '*.ts') or 'type' parameter (e.g., 'ts', 'py'). " +
            "Path must be absolute. Searching outside the working directory requires allowOutsideWorkingDirectory: true.",

        inputSchema: grepSchema,

        execute: async (input: GrepInput) => {
            return await executeGrep(input, context.workingDirectory, context.agent.pubkey);
        },
    });

    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: (input: GrepInput) => {
            const pathInfo = input.path ? ` in ${input.path}` : "";
            return `Searching for '${input.pattern}'${pathInfo}`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance as AISdkTool;
}
