import type { AgentInstance } from "@/agents/types";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Identity fragment for agents.
 */
interface AgentIdentityArgs {
    agent: AgentInstance;
    projectTitle: string;
    projectOwnerPubkey: string;
    /**
     * Actual worktree path where code execution happens.
     * This is displayed as "Absolute Path" in the system prompt.
     */
    workingDirectory?: string;
    /**
     * Current conversation ID as stored in the conversation system.
     */
    conversationId?: string;
}

export const agentIdentityFragment: PromptFragment<AgentIdentityArgs> = {
    id: "agent-identity",
    priority: 1,
    template: ({ agent, projectTitle, projectOwnerPubkey, workingDirectory, conversationId }) => {
        const parts: string[] = [];

        // Identity
        parts.push("# Your Identity\n");
        parts.push(`Your name: ${agent.name} (${agent.slug})`);
        parts.push(`Your npub: ${agent.signer.npub}`);
        parts.push("Your nsec is stored in your home directory's `.env` file as `NSEC`.");
        parts.push("");

        // Instructions
        if (agent.instructions) {
            parts.push(`## Your Instructions\n${agent.instructions}\n`);
        }

        // Project context
        const contextLines = [
            "## Project Context",
            `- Title: "${projectTitle}"`,
            `- Today's Date: ${new Date().toISOString().split("T")[0]}`,
        ];
        if (workingDirectory) {
            contextLines.push(`- Absolute Path: ${workingDirectory}`);
        }
        contextLines.push(`- User (Owner) pubkey: "${projectOwnerPubkey}"`);
        if (conversationId) {
            contextLines.push(`- Current Conversation ID: ${conversationId}`);
        }
        parts.push(contextLines.join("\n"));

        return parts.join("\n");
    },
};

// Register the fragment
fragmentRegistry.register(agentIdentityFragment);
