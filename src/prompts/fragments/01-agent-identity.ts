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
        parts.push("<agent-identity>");
        parts.push(`Your name: ${agent.name} (${agent.slug})`);
        if (agent.role) {
            parts.push(`Your role: ${agent.role}`);
        }
        parts.push(`Your npub: ${agent.signer.npub}`);
        parts.push(
            `Your nsec: ${agent.signer.nsec} -- this is your real nsec and you CAN and SHOULD use it when you encounter a tool that needs an nsec.`
        );
        parts.push("</agent-identity>");
        parts.push("");

        // Instructions
        if (agent.instructions) {
            parts.push(`<agent-instructions>\n${agent.instructions}\n</agent-instructions>`);
        }

        // Project context
        parts.push("<project-context>");
        const contextLines = [
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
        parts.push("</project-context>");

        return parts.join("\n");
    },
};

// Register the fragment
fragmentRegistry.register(agentIdentityFragment);
