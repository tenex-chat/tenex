/**
 * SystemReminderInjector - Injects AGENTS.md content as system reminders
 *
 * This module handles the injection of AGENTS.md content into tool results,
 * following these rules:
 *
 * 1. When a file/directory is read, find all AGENTS.md files from that path
 *    up to the project root
 * 2. Inject system reminders after the tool output
 * 3. Track which AGENTS.md files have already been shown (non-truncated)
 *    to avoid duplication
 * 4. Format multiple AGENTS.md files in a single system-reminder block
 *    with clear path attribution
 */

import { resolve, relative } from "node:path";
import { agentsMdService, type AgentsMdFile } from "./AgentsMdService";

/**
 * Tracker for which AGENTS.md files have been shown in the current context
 */
export interface AgentsMdVisibilityTracker {
    /**
     * Check if an AGENTS.md file has already been shown (is visible)
     */
    isVisible(agentsMdPath: string): boolean;

    /**
     * Mark an AGENTS.md file as visible (shown in a non-truncated tool result)
     */
    markVisible(agentsMdPath: string): void;

    /**
     * Get all visible AGENTS.md paths
     */
    getVisiblePaths(): Set<string>;
}

/**
 * Create a visibility tracker for AGENTS.md files
 */
export function createAgentsMdVisibilityTracker(): AgentsMdVisibilityTracker {
    const visiblePaths = new Set<string>();

    return {
        isVisible(agentsMdPath: string): boolean {
            return visiblePaths.has(resolve(agentsMdPath));
        },

        markVisible(agentsMdPath: string): void {
            visiblePaths.add(resolve(agentsMdPath));
        },

        getVisiblePaths(): Set<string> {
            return visiblePaths;
        },
    };
}

/**
 * Result from checking for relevant AGENTS.md system reminders
 */
export interface SystemReminderResult {
    /** Whether any new system reminders need to be injected */
    hasReminders: boolean;
    /** The formatted system reminder content (empty if no reminders) */
    content: string;
    /** The AGENTS.md files that were included */
    includedFiles: AgentsMdFile[];
}

/**
 * Format AGENTS.md files into a system reminder block.
 *
 * The format groups multiple files with clear path attribution:
 * ```
 * <system-reminder>
 * # AGENTS.md from /path/to/directory
 *
 * [content of AGENTS.md]
 *
 * # AGENTS.md from /parent/directory
 *
 * [content of parent AGENTS.md]
 * </system-reminder>
 * ```
 */
export function formatSystemReminder(
    files: AgentsMdFile[],
    projectRoot: string
): string {
    if (files.length === 0) {
        return "";
    }

    const sections = files.map((file) => {
        const relativePath = relative(projectRoot, file.directory);
        const displayPath = relativePath || "(project root)";
        return `# AGENTS.md from ${displayPath}\n\n${file.content.trim()}`;
    });

    return `\n<system-reminder>\n${sections.join("\n\n")}\n</system-reminder>`;
}

/**
 * Get system reminders for a file read operation.
 *
 * This function:
 * 1. Finds all AGENTS.md files from the target path up to project root
 * 2. Filters out already-visible files (using the tracker)
 * 3. Marks newly-found files as visible
 * 4. Returns formatted system reminder content
 *
 * @param targetPath - The file/directory path being read
 * @param projectRoot - The project root directory
 * @param tracker - Visibility tracker for deduplication
 * @param isTruncated - Whether the tool result is truncated (don't mark as visible if so)
 * @returns System reminder result with content and metadata
 */
export async function getSystemRemindersForPath(
    targetPath: string,
    projectRoot: string,
    tracker: AgentsMdVisibilityTracker,
    isTruncated: boolean = false
): Promise<SystemReminderResult> {
    const absoluteProjectRoot = resolve(projectRoot);

    // Find all AGENTS.md files from the target path up to project root
    const allFiles = await agentsMdService.findAgentsMdFiles(targetPath, absoluteProjectRoot);

    // Filter out already-visible files
    const newFiles = allFiles.filter((file) => !tracker.isVisible(file.path));

    if (newFiles.length === 0) {
        return {
            hasReminders: false,
            content: "",
            includedFiles: [],
        };
    }

    // Only mark as visible if the tool result is NOT truncated
    // (truncated results aren't really "visible" to the model)
    if (!isTruncated) {
        for (const file of newFiles) {
            tracker.markVisible(file.path);
        }
    }

    const content = formatSystemReminder(newFiles, absoluteProjectRoot);

    return {
        hasReminders: true,
        content,
        includedFiles: newFiles,
    };
}

/**
 * Check if a tool name is one that reads files/directories
 * and should trigger AGENTS.md system reminder injection.
 */
export function shouldInjectForTool(toolName: string): boolean {
    // Tools that read files/directories
    const fileReadTools = [
        "fs_read",
        "Read",              // Claude Code's Read tool
        "mcp__filesystem__read_file",
        "mcp__filesystem__read_directory",
        "mcp__filesystem__list_directory",
        "mcp__filesystem__get_file_info",
    ];

    // Check for exact match or pattern match
    return fileReadTools.includes(toolName) ||
           toolName.startsWith("mcp__") && toolName.includes("read");
}

/**
 * Extract the path from a tool's input arguments.
 * Different tools use different parameter names for the path.
 */
export function extractPathFromToolInput(input: unknown): string | null {
    if (!input || typeof input !== "object") {
        return null;
    }

    const inputObj = input as Record<string, unknown>;

    // fs_read and similar tools use 'path'
    if ("path" in inputObj && typeof inputObj.path === "string") {
        return inputObj.path;
    }

    // Some tools use 'file_path'
    if ("file_path" in inputObj && typeof inputObj.file_path === "string") {
        return inputObj.file_path;
    }

    // Some tools use 'directory'
    if ("directory" in inputObj && typeof inputObj.directory === "string") {
        return inputObj.directory;
    }

    return null;
}

/**
 * Append system reminder content to a tool result output.
 *
 * @param output - The original tool result output
 * @param reminderContent - The system reminder content to append
 * @returns The modified output with system reminder appended
 */
export function appendSystemReminderToOutput(
    output: unknown,
    reminderContent: string
): unknown {
    if (typeof output === "string") {
        return output + reminderContent;
    }

    if (output && typeof output === "object" && "value" in output) {
        const existingOutput = output as { type?: string; value: unknown };
        const valueStr = typeof existingOutput.value === "string"
            ? existingOutput.value
            : JSON.stringify(existingOutput.value);

        return {
            ...existingOutput,
            value: valueStr + reminderContent,
        };
    }

    // For other formats, try to stringify and append
    const outputStr = typeof output === "string" ? output : JSON.stringify(output);
    return outputStr + reminderContent;
}
