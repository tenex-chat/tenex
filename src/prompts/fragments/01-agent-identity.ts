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
}

export const agentIdentityFragment: PromptFragment<AgentIdentityArgs> = {
  id: "agent-identity",
  priority: 1,
  template: ({ agent, projectTitle, projectOwnerPubkey }) => {
    const parts: string[] = [];

    // Identity
    parts.push("# Your Identity\n");
    parts.push(`Your name: ${agent.name} (${agent.slug})`);
    if (agent.role) {
      parts.push(`Your role: ${agent.role}`);
    }
    parts.push(`Your npub: ${agent.signer.npub}`);
    parts.push(`Your nsec: ${agent.signer.nsec} -- this is your real nsec and you CAN and SHOULD use it when you encounter a tool that needs an nsec.`);
    parts.push("");

    // Instructions
    if (agent.instructions) {
      parts.push(`## Your Instructions\n${agent.instructions}\n`);
    }

    // Project context
    parts.push(
      [
        "## Project Context",
        `- Title: "${projectTitle}"`,
        `- Path: ${process.cwd()}`,
        `- User pubkey: "${projectOwnerPubkey}"`,
      ].join("\n")
    );

    return parts.join("\n");
  },
};

// Register the fragment
fragmentRegistry.register(agentIdentityFragment);
