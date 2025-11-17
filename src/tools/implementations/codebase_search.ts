import { exec } from "node:child_process";
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const execAsync = promisify(exec);

const codebaseSearchSchema = z.object({
    query: z
        .string()
        .describe(
            "The search query - can be file name (e.g., 'ChatHeader.tsx'), pattern (e.g., '*.tsx'), or content to grep (e.g., 'function ChatHeader')"
        ),
    searchType: z
        .enum(["filename", "content", "both"])
        .default("both")
        .describe(
            "Type of search: 'filename' for name matching, 'content' for text inside files, 'both' for combined"
        ),
    fileType: z.string().nullable().describe("Optional file extension filter (e.g., '.tsx')"),
    maxResults: z.number().nullable().default(50).describe("Maximum number of results to return"),
    includeSnippets: z
        .boolean()
        .nullable()
        .default(false)
        .describe("If true, include brief content snippets for content matches"),
});

type SearchResult = {
    path: string;
    type: "file" | "directory";
    match?: {
        line?: number;
        snippet?: string;
    };
};

/**
 * Core implementation of codebase search functionality
 */
async function executeCodebaseSearch(
    input: z.infer<typeof codebaseSearchSchema>,
    context: ExecutionContext
): Promise<string> {
    const {
        query,
        searchType = "both",
        fileType,
        maxResults = 50,
        includeSnippets = false,
    } = input;

    logger.info("Executing codebase search", {
        query,
        searchType,
        fileType,
        maxResults,
        includeSnippets,
        agent: context.agent.name,
    });

    const results: SearchResult[] = [];
    const projectPath = context.projectPath;

    try {
        // Search by filename if requested
        if (searchType === "filename" || searchType === "both") {
            await searchByFilename(query, projectPath, fileType, results, maxResults);
        }

        // Search by content if requested
        if (searchType === "content" || searchType === "both") {
            await searchByContent(
                query,
                projectPath,
                fileType,
                results,
                maxResults,
                includeSnippets
            );
        }

        // Limit results and remove duplicates
        const uniquePaths = new Set<string>();
        const finalResults: SearchResult[] = [];

        for (const result of results) {
            if (!uniquePaths.has(result.path)) {
                uniquePaths.add(result.path);
                finalResults.push(result);
                if (finalResults.length >= maxResults) break;
            }
        }

        // Format output
        if (finalResults.length === 0) {
            return `No results found for query: "${query}"`;
        }

        let output = `Found ${finalResults.length} results for "${query}":\n\n`;

        for (const result of finalResults) {
            output += `• ${result.path}`;
            if (result.type === "directory") {
                output += " (directory)";
            }
            if (result.match) {
                if (result.match.line) {
                    output += ` [line ${result.match.line}]`;
                }
                if (includeSnippets && result.match.snippet) {
                    output += `\n  ${result.match.snippet.trim()}`;
                }
            }
            output += "\n";
        }

        return output;
    } catch (error) {
        logger.error("Codebase search failed", { error, query });
        throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Search for files by filename pattern
 */
async function searchByFilename(
    query: string,
    projectPath: string,
    fileType: string | null,
    results: SearchResult[],
    maxResults: number
): Promise<void> {
    // Use find command for efficient file searching
    let findCommand = `find . -type f -name "*${query}*"`;

    // Add file type filter if specified
    if (fileType) {
        const ext = fileType.startsWith(".") ? fileType : `.${fileType}`;
        findCommand += ` -name "*${ext}"`;
    }

    // Exclude common directories
    findCommand += ' -not -path "*/node_modules/*"';
    findCommand += ' -not -path "*/.git/*"';
    findCommand += ' -not -path "*/dist/*"';
    findCommand += ' -not -path "*/build/*"';
    findCommand += ' -not -path "*/.next/*"';
    findCommand += ' -not -path "*/coverage/*"';
    findCommand += ` | head -${maxResults}`;

    try {
        const { stdout } = await execAsync(findCommand, {
            cwd: projectPath,
            timeout: 10000, // 10 second timeout
        });

        if (stdout) {
            const files = stdout.trim().split("\n").filter(Boolean);
            for (const file of files) {
                // Remove leading ./ if present
                const cleanPath = file.startsWith("./") ? file.slice(2) : file;
                results.push({
                    path: cleanPath,
                    type: "file",
                });
            }
        }
    } catch {
        // Fall back to recursive directory search if find command fails
        await recursiveFileSearch(projectPath, query, fileType, results, maxResults);
    }

    // Also search for directories
    try {
        const dirCommand = `find . -type d -name "*${query}*" -not -path "*/node_modules/*" -not -path "*/.git/*" | head -${maxResults}`;
        const { stdout } = await execAsync(dirCommand, {
            cwd: projectPath,
            timeout: 5000,
        });

        if (stdout) {
            const dirs = stdout.trim().split("\n").filter(Boolean);
            for (const dir of dirs) {
                const cleanPath = dir.startsWith("./") ? dir.slice(2) : dir;
                results.push({
                    path: cleanPath,
                    type: "directory",
                });
            }
        }
    } catch {
        // Ignore directory search errors
    }
}

/**
 * Fallback recursive file search
 */
async function recursiveFileSearch(
    dir: string,
    query: string,
    fileType: string | null,
    results: SearchResult[],
    maxResults: number,
    currentPath = ""
): Promise<void> {
    if (results.length >= maxResults) return;

    try {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            if (results.length >= maxResults) break;

            const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
            const fullPath = join(dir, entry.name);

            // Skip common ignored directories
            if (entry.isDirectory()) {
                const ignoreDirs = ["node_modules", ".git", "dist", "build", ".next", "coverage"];
                if (!ignoreDirs.includes(entry.name)) {
                    // Check if directory name matches
                    if (entry.name.toLowerCase().includes(query.toLowerCase())) {
                        results.push({
                            path: entryPath,
                            type: "directory",
                        });
                    }
                    // Recurse into directory
                    await recursiveFileSearch(
                        fullPath,
                        query,
                        fileType,
                        results,
                        maxResults,
                        entryPath
                    );
                }
            } else if (entry.isFile()) {
                // Check file type if filter is specified
                if (fileType) {
                    const ext = fileType.startsWith(".") ? fileType : `.${fileType}`;
                    if (extname(entry.name) !== ext) continue;
                }

                // Check if filename matches
                if (entry.name.toLowerCase().includes(query.toLowerCase())) {
                    results.push({
                        path: entryPath,
                        type: "file",
                    });
                }
            }
        }
    } catch (error) {
        // Skip directories we can't read
        logger.debug("Skipping directory", { dir, error });
    }
}

/**
 * Search for content within files using grep
 */
async function searchByContent(
    query: string,
    projectPath: string,
    fileType: string | null,
    results: SearchResult[],
    maxResults: number,
    includeSnippets: boolean
): Promise<void> {
    // Build grep command
    let grepCommand = `grep -rn "${query}" .`;

    // Add file type filter if specified
    if (fileType) {
        const ext = fileType.startsWith(".") ? fileType : `.${fileType}`;
        grepCommand += ` --include="*${ext}"`;
    }

    // Exclude common directories and binary files
    grepCommand += " --exclude-dir=node_modules";
    grepCommand += " --exclude-dir=.git";
    grepCommand += " --exclude-dir=dist";
    grepCommand += " --exclude-dir=build";
    grepCommand += " --exclude-dir=.next";
    grepCommand += " --exclude-dir=coverage";
    grepCommand += " --binary-files=without-match";
    grepCommand += ` | head -${maxResults * 2}`; // Get more results since we'll filter

    try {
        const { stdout } = await execAsync(grepCommand, {
            cwd: projectPath,
            timeout: 15000, // 15 second timeout
            maxBuffer: 1024 * 1024 * 10, // 10MB buffer
        });

        if (stdout) {
            const matches = stdout.trim().split("\n").filter(Boolean);

            for (const match of matches) {
                if (results.length >= maxResults) break;

                // Parse grep output format: "path:line:content"
                const colonIndex = match.indexOf(":");
                if (colonIndex === -1) continue;

                const path = match.substring(0, colonIndex);
                const afterPath = match.substring(colonIndex + 1);
                const secondColonIndex = afterPath.indexOf(":");

                if (secondColonIndex === -1) continue;

                const lineNumber = Number.parseInt(afterPath.substring(0, secondColonIndex));
                const content = afterPath.substring(secondColonIndex + 1);

                // Clean up the path
                const cleanPath = path.startsWith("./") ? path.slice(2) : path;

                results.push({
                    path: cleanPath,
                    type: "file",
                    match: {
                        line: lineNumber,
                        snippet: includeSnippets ? content : undefined,
                    },
                });
            }
        }
    } catch (error) {
        // Grep might fail if no matches found or other issues
        logger.debug("Grep search failed or no results", { error, query });
    }
}

/**
 * Create the codebase_search tool for AI SDK
 */
export function createCodebaseSearchTool(context: ExecutionContext): AISdkTool {
    const toolInstance = tool({
        description:
            "Searches the project codebase for files, directories, or content matching specified criteria. Supports searching by file name patterns, content keywords, or file types. Returns a list of matching paths with optional snippets. Paths are relative to project root. Safe and sandboxed to project directory.",

        inputSchema: codebaseSearchSchema,

        execute: async (input: z.infer<typeof codebaseSearchSchema>) => {
            try {
                return await executeCodebaseSearch(input, context);
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);

                // Check for context limit errors and provide graceful degradation
                if (
                    errorMsg.includes("maximum context length") ||
                    errorMsg.includes("tokens") ||
                    errorMsg.includes("quota")
                ) {
                    return {
                        type: "error-text",
                        text:
                            "Search failed: Context limit exceeded. Try:\n" +
                            "1. Narrowing your search query to be more specific\n" +
                            '2. Adding a file type filter (e.g., fileType: ".ts")\n' +
                            "3. Reducing maxResults to a smaller number",
                    };
                }

                throw new Error(`Codebase search failed: ${errorMsg}`);
            }
        },
    });

    // Add human-readable content generation
    Object.defineProperty(toolInstance, "getHumanReadableContent", {
        value: (input: z.infer<typeof codebaseSearchSchema>) => {
            const { query, searchType } = input;
            return `Searching codebase for "${query}" (${searchType})`;
        },
        enumerable: false,
        configurable: true,
    });

    return toolInstance;
}
