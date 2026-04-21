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
        parts.push("- $USER_HOME, $AGENT_HOME, $PUBKEY, $NPUB");
        if (projectBasePath) {
            parts.push("- $PROJECT_BASE, $PROJECT_ID");
        } else {
            parts.push("- $PROJECT_ID");
        }
        parts.push("- $TENEX_BASE_DIR — TENEX data directory (agents, projects, teams, built-in skills)");

        parts.push("");
        parts.push("Your nsec and other secrets are in $AGENT_HOME/.env (auto-loaded in shell sessions).");
        parts.push("</environment-variables>");
        return parts.join("\n");
    },
};