import type { AgentInstance } from "@/agents/types";
import { shortenConversationId, shortenPubkey } from "@/utils/conversation-id";
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
        const identityLines: string[] = [];
        identityLines.push(`Your name: ${agent.slug}`);
        identityLines.push(`Your npub: ${agent.signer.npub}`);
        identityLines.push("Your nsec is stored in your home directory's `.env` file as `NSEC`.");
        parts.push(`<agent-identity>\n${identityLines.join("\n")}\n</agent-identity>`);

        // Instructions
        if (agent.instructions) {
            parts.push(`<agent-instructions>\n${agent.instructions}\n</agent-instructions>`);
        }

        // Project context
        const contextLines = [
            `- Title: "${projectTitle}"`,
            `- Today's Date: ${new Date().toISOString().split("T")[0]}`,
        ];
        if (workingDirectory) {
            contextLines.push(`- Absolute Path: ${workingDirectory}`);
        }
        contextLines.push(`- User (Owner) pubkey: "${shortenPubkey(projectOwnerPubkey)}"`);
        if (conversationId) {
            contextLines.push(`- Current Conversation ID: ${shortenConversationId(conversationId)}`);
        }
        parts.push(`<project-context>\n${contextLines.join("\n")}\n</project-context>`);

        return parts.join("\n");
    },
};

// Register the fragment
fragmentRegistry.register(agentIdentityFragment);
