import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentInstance } from "@/agents/types/runtime";
import { getTenexBasePath } from "@/constants";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Arguments for the agent home directory fragment.
 */
interface AgentHomeDirectoryArgs {
    agent: AgentInstance;
}

/**
 * Get the short pubkey (first 8 characters) for an agent.
 */
function getShortPubkey(pubkey: string): string {
    return pubkey.slice(0, 8);
}

/**
 * Get the home directory path for an agent.
 */
export function getAgentHomeDirectory(agentPubkey: string): string {
    const shortPubkey = getShortPubkey(agentPubkey);
    return join(getTenexBasePath(), "home", shortPubkey);
}

/**
 * Ensure the agent's home directory exists, creating it if necessary.
 */
function ensureHomeDirectoryExists(homeDir: string): void {
    if (!existsSync(homeDir)) {
        mkdirSync(homeDir, { recursive: true });
    }
}

/**
 * Get a listing of files and directories in the home directory.
 * Returns a formatted string showing the directory contents.
 */
function getDirectoryListing(homeDir: string): string {
    if (!existsSync(homeDir)) {
        return "(empty - directory will be created on first use)";
    }

    try {
        const entries = readdirSync(homeDir);
        if (entries.length === 0) {
            return "(empty)";
        }

        const listing: string[] = [];
        for (const entry of entries.sort()) {
            const entryPath = join(homeDir, entry);
            try {
                const stats = statSync(entryPath);
                if (stats.isDirectory()) {
                    listing.push(`  ${entry}/`);
                } else {
                    listing.push(`  ${entry}`);
                }
            } catch {
                // If we can't stat an entry, just list it without decoration
                listing.push(`  ${entry}`);
            }
        }
        return listing.join("\n");
    } catch {
        return "(unable to read directory)";
    }
}

/**
 * Agent home directory fragment.
 * Provides agents with a personal workspace directory for notes, scripts, and other files.
 */
export const agentHomeDirectoryFragment: PromptFragment<AgentHomeDirectoryArgs> = {
    id: "agent-home-directory",
    priority: 2, // Right after agent-identity (priority 1)
    template: ({ agent }) => {
        const homeDir = getAgentHomeDirectory(agent.pubkey);

        // Ensure the home directory exists
        ensureHomeDirectoryExists(homeDir);

        // Get the directory listing
        const listing = getDirectoryListing(homeDir);

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

        return parts.join("\n");
    },
};

// Register the fragment
fragmentRegistry.register(agentHomeDirectoryFragment);
