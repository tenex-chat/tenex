import { readdirSync } from "node:fs";
import type { AgentInstance } from "@/agents/types/runtime";
import {
    ensureAgentHomeDirectory,
    getAgentHomeDirectory,
    getAgentHomeInjectedFiles,
} from "@/lib/agent-home";

// Re-export for convenience (used by tests)
export { getAgentHomeDirectory } from "@/lib/agent-home";
import { logger } from "@/utils/logger";
import type { PromptFragment } from "../core/types";

/**
 * Maximum number of entries to show in the home directory listing.
 * Prevents prompt bloat if an agent has many files.
 */
const MAX_LISTING_ENTRIES = 50;

/**
 * Arguments for the agent home directory fragment.
 */
interface AgentHomeDirectoryArgs {
    agent: AgentInstance;
}

/**
 * Build the home directory listing with proper error handling.
 * Creates the directory if it doesn't exist and returns a formatted listing.
 */
function buildHomeListing(homeDir: string, agentPubkey: string): string {
    // Try to create the directory using the shared helper
    if (!ensureAgentHomeDirectory(agentPubkey)) {
        return "(home directory unavailable)";
    }

    // Try to list the directory contents
    try {
        const entries = readdirSync(homeDir, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name)
        );

        if (entries.length === 0) {
            return "(empty)";
        }

        const totalCount = entries.length;
        const displayEntries = entries.slice(0, MAX_LISTING_ENTRIES);
        const lines = displayEntries.map((entry) => `  ${entry.name}${entry.isDirectory() ? "/" : ""}`);

        if (totalCount > MAX_LISTING_ENTRIES) {
            lines.push(`  ...and ${totalCount - MAX_LISTING_ENTRIES} more`);
        }

        return lines.join("\n");
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
    template: ({ agent }) => {
        const homeDir = getAgentHomeDirectory(agent.pubkey);
        const listing = buildHomeListing(homeDir, agent.pubkey);
        const injectedFiles = getAgentHomeInjectedFiles(agent.pubkey);

        const parts: string[] = [];

        parts.push("## Your Home Directory\n");
        parts.push(`You have a personal home directory at: \`${homeDir}\``);
        parts.push("");
        parts.push("**Current contents:**");
        parts.push("```");
        parts.push(listing);
        parts.push("```");
        parts.push("");
        parts.push(
            "Feel free to use this space for notes, helper scripts, temporary files, or any personal workspace needs. " +
                "Use descriptive names for your files so you can easily find them later."
        );
        parts.push("");
        parts.push(
            "**Auto-injected files:** Files starting with `+` (e.g., `+NOTES.md`) are automatically injected into your system prompt. " +
                "Use these for: critical reminders, preferences, or frequently-referenced notes."
        );

        // Inject +prefixed file contents
        if (injectedFiles.length > 0) {
            parts.push("");
            parts.push("### Injected File Contents\n");

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

        return parts.join("\n");
    },
};
