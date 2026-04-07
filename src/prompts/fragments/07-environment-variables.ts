import type { AgentInstance } from "@/agents/types/runtime";
import type { PromptFragment } from "../core/types";

interface EnvironmentVariablesArgs {
    agent: AgentInstance;
    projectBasePath?: string;
}

/**
 * Environment variables fragment.
 * Surfaces available env var names that agents can use in shell commands and file tool arguments.
 * Values are resolved at runtime by the shell — no need to inline them here.
 */
export const environmentVariablesFragment: PromptFragment<EnvironmentVariablesArgs> = {
    id: "environment-variables",
    priority: 7,
    template: async ({ projectBasePath }) => {
        const parts: string[] = [];
        parts.push("<environment-variables>");
        parts.push("These variables are available in shell commands and file tool path arguments.");
        parts.push("- $USER_HOME — the user's home directory");
        parts.push("- $AGENT_HOME — this agent's private home directory");
        parts.push("- $PUBKEY — this agent's hex pubkey");
        parts.push("- $NPUB — this agent's npub-encoded pubkey");
        if (projectBasePath) {
            parts.push("- $PROJECT_BASE — the current project's root directory");
        }
        parts.push("</environment-variables>");
        return parts.join("\n");
    },
};