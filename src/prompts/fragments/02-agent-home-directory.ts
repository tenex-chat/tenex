import { homedir } from "node:os";
import { readdirSync } from "node:fs";
import type { AgentInstance } from "@/agents/types/runtime";
import {
    ensureAgentHomeDirectory,
    getAgentHomeDirectory,
    getAgentHomeInjectedFiles,
    getAgentProjectMemoryDirectory,
} from "@/lib/agent-home";

// Re-export for convenience (used by tests)
export { getAgentHomeDirectory } from "@/lib/agent-home";
import { logger } from "@/utils/logger";
import type { PromptFragment } from "../core/types";

export function clearAgentHomePromptCache(): void {
    // Agent home prompt data must reflect +file updates immediately between turns.
    // Keep the helper as a no-op so existing tests can keep calling it.
}

/**
 * Arguments for the agent home directory fragment.
 */
interface AgentHomeDirectoryArgs {
    agent: AgentInstance;
    projectDTag?: string;
    projectBasePath?: string;
}

/**
 * Count the files in the home directory with proper error handling.
 * Creates the directory if it doesn't exist and returns a count summary.
 */
function countHomeFiles(homeDir: string, agentPubkey: string): string {
    // Try to create the directory using the shared helper
    if (!ensureAgentHomeDirectory(agentPubkey)) {
        return "(home directory unavailable)";
    }

    try {
        const entries = readdirSync(homeDir, { withFileTypes: true })
            .filter((entry) => !entry.name.startsWith("."));

        if (entries.length === 0) {
            return "(empty)";
        }

        const fileCount = entries.filter((e) => e.isFile()).length;
        const dirCount = entries.filter((e) => e.isDirectory()).length;
        const parts: string[] = [];
        if (fileCount > 0) parts.push(`${fileCount} file${fileCount !== 1 ? "s" : ""}`);
        if (dirCount > 0) parts.push(`${dirCount} director${dirCount !== 1 ? "ies" : "y"}`);

        return parts.join(", ");
    } catch (error) {
        logger.warn("Failed to list agent home dir:", error);
        return "(unable to read directory)";
    }
}

/**
 * Agent home directory fragment.
 * Provides agents with a personal workspace directory for notes, scripts, and other files.
 * Also auto-injects contents of files starting with '+' into the prompt.
 */
export const agentHomeDirectoryFragment: PromptFragment<AgentHomeDirectoryArgs> = {
    id: "agent-home-directory",
    priority: 2, // Right after agent-identity (priority 1)
    template: async ({ agent, projectDTag, projectBasePath }) => {
        const homeDir = getAgentHomeDirectory(agent.pubkey);
        const homeCount = countHomeFiles(homeDir, agent.pubkey);
        const injectedFiles = getAgentHomeInjectedFiles(agent.pubkey);
        const projectMemoryDir = projectDTag
            ? getAgentProjectMemoryDirectory(agent.pubkey, projectDTag)
            : undefined;

        const parts: string[] = [];

        parts.push("<home-directory>");
        parts.push(`You have a personal home directory at: \`${homeDir}\`. This is *your* space to use as you see fit. The contents of this directory are persistent and private to you.`);
        parts.push("");
        parts.push(`**Current contents:** ${homeCount}`);
        parts.push("");
        parts.push(
            "Use this space for notes, helper scripts, temporary files, or any personal workspace needs. " +
                "Use descriptive names for your files so you can easily find them later."
        );
        parts.push("");
        parts.push(
            "**Shell env files:** Shell sessions automatically load environment variables from `.env` files with precedence `agent > project > global`. Your nsec is in your home directory's `.env` file as `NSEC`. `.env` contents are NOT injected into your prompt. Reference them in shell commands with normal shell expansion such as `$NSEC` or `$OPENAI_API_KEY`."
        );
        parts.push("");
        parts.push(
            "**Note on ~:** The shell `~` expands to the user's real home directory (via `$HOME`), NOT your agent home. " +
                "To access your agent home directory in shell commands, use `$AGENT_HOME`."
        );
        parts.push("");
        parts.push(
            "**Auto-injected files:** Files starting with `+` (e.g., `+NOTES.md`) are automatically injected into your system prompt. " +
                "Use these for: critical reminders, preferences, or frequently-referenced notes."
        );
        if (projectMemoryDir) {
            parts.push("");
            parts.push(
                `**Project-specific memory:** For private persistent notes for this project, use \`${projectMemoryDir}/+<slug>.md\`. ` +
                "Those `+` files are injected in the project-context section."
            );
        }
        // Inject +prefixed file contents
        if (injectedFiles.length > 0) {
            parts.push("");
            parts.push("<memorized-files>");
            for (const file of injectedFiles) {
                const truncatedAttr = file.truncated ? ` truncated="true"` : "";
                parts.push(`  <file name="${file.filename}"${truncatedAttr}>${file.content}</file>`);
            }
            parts.push("</memorized-files>");
        }


        // Environment path variables — available in shell and fs_* tools
        parts.push("");
        parts.push("<environment-variables>");
        parts.push(`$USER_HOME = ${homedir()}`);
        parts.push(`$AGENT_HOME = ${homeDir}`);
        if (projectBasePath) {
            parts.push(`$PROJECT_BASE = ${projectBasePath}`);
        }
        parts.push("</environment-variables>");

        parts.push("</home-directory>");
        return parts.join("\n");
    },
};
