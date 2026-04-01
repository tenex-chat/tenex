import { readdirSync } from "node:fs";
import type { AgentInstance } from "@/agents/types/runtime";
import {
    ensureAgentHomeDirectory,
    getAgentHomeDirectory,
    getAgentHomeInjectedFiles,
    getAgentProjectInjectedFiles,
    getAgentProjectMemoryDirectory,
} from "@/lib/agent-home";

// Re-export for convenience (used by tests)
export { getAgentHomeDirectory } from "@/lib/agent-home";
import { logger } from "@/utils/logger";
import type { PromptFragment } from "../core/types";

/**
 * Maximum number of entries to show in the home directory listing.
 * Keeps the visible listing aligned with a short non-recursive `ls` output.
 */
const MAX_LISTING_ENTRIES = 20;

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
}

/**
 * Build the home directory listing with proper error handling.
 * Creates the directory if it doesn't exist and returns a formatted listing.
 */
interface HomeListing {
    content: string;
    truncated: boolean;
}

function buildHomeListing(homeDir: string, agentPubkey: string): HomeListing {
    // Try to create the directory using the shared helper
    if (!ensureAgentHomeDirectory(agentPubkey)) {
        return { content: "(home directory unavailable)", truncated: false };
    }

    // Try to list the directory contents
    try {
        const entries = readdirSync(homeDir, { withFileTypes: true })
            .filter((entry) => !entry.name.startsWith("."))
            .sort((a, b) => a.name.localeCompare(b.name));

        if (entries.length === 0) {
            return { content: "(empty)", truncated: false };
        }

        const displayEntries = entries.slice(0, MAX_LISTING_ENTRIES);
        const lines = displayEntries.map((entry) => entry.name);

        return {
            content: lines.join("\n"),
            truncated: entries.length > MAX_LISTING_ENTRIES,
        };
    } catch (error) {
        logger.warn("Failed to list agent home dir:", error);
        return { content: "(unable to read directory)", truncated: false };
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
    template: async ({ agent, projectDTag }) => {
        const homeDir = getAgentHomeDirectory(agent.pubkey);
        const listing = buildHomeListing(homeDir, agent.pubkey);
        const injectedFiles = getAgentHomeInjectedFiles(agent.pubkey);
        const projectInjectedFiles = projectDTag
            ? getAgentProjectInjectedFiles(agent.pubkey, projectDTag)
            : [];
        const projectMemoryDir = projectDTag
            ? getAgentProjectMemoryDirectory(agent.pubkey, projectDTag)
            : undefined;

        const parts: string[] = [];

        parts.push("<home-directory>");
        parts.push(`You have a personal home directory at: \`${homeDir}\`. This is *your* space to use as you see fit. The contents of this directory are persistent and private to you.`);
        parts.push("");
        parts.push("**Current contents:**");
        parts.push("```");
        parts.push(listing.content);
        parts.push("```");
        if (listing.truncated) {
            parts.push(
                "Note: You have too many files in your home directory root. Tidy them up into directories."
            );
        }
        parts.push("");
        parts.push(
            "Feel free to use this space for notes, helper scripts, temporary files, or any personal workspace needs. " +
                "Use descriptive names for your files so you can easily find them later."
        );
        parts.push("");
        parts.push(
            "**Shell env files:** Shell sessions automatically load environment variables from `.env` files with precedence `agent > project > global`. Your nsec is in your home directory's `.env` file as `NSEC`. `.env` contents are NOT injected into your prompt. Reference them in shell commands with normal shell expansion such as `$NSEC` or `$OPENAI_API_KEY`."
        );
        parts.push("");
        parts.push(
            "**Note on ~:** The shell `~` expands to the user's real home directory (via `$HOME`), NOT your agent home. " +
                "To access your agent home directory in shell commands, use `$TENEX_AGENT_HOME`."
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
                "Those `+` files are injected separately from your home-root memory files."
            );
        }
        // Inject +prefixed file contents
        if (injectedFiles.length > 0) {
            parts.push("");
            parts.push("### Injected Home Files\n");

            for (const file of injectedFiles) {
                parts.push(`**${file.filename}:**`);
                if (file.truncated) {
                    parts.push("*(truncated to 1500 characters)*");
                }
                parts.push("```");
                parts.push(file.content);
                parts.push("```");
                parts.push("");
            }
        }

        if (projectInjectedFiles.length > 0) {
            parts.push("");
            parts.push("### Injected Project Files\n");

            for (const file of projectInjectedFiles) {
                parts.push(`**${file.filename}:**`);
                if (file.truncated) {
                    parts.push("*(truncated to 1500 characters)*");
                }
                parts.push("```");
                parts.push(file.content);
                parts.push("```");
                parts.push("");
            }
        }

        parts.push("</home-directory>");
        return parts.join("\n");
    },
};
