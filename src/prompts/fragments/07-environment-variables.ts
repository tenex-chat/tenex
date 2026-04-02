import { homedir } from "node:os";
import type { AgentInstance } from "@/agents/types/runtime";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import type { PromptFragment } from "../core/types";

interface EnvironmentVariablesArgs {
    agent: AgentInstance;
    projectBasePath?: string;
}

/**
 * Environment variables fragment.
 * Surfaces path variables that agents can use in shell commands and file tool arguments.
 */
export const environmentVariablesFragment: PromptFragment<EnvironmentVariablesArgs> = {
    id: "environment-variables",
    priority: 7,
    template: async ({ agent, projectBasePath }) => {
        const homeDir = getAgentHomeDirectory(agent.pubkey);

        const parts: string[] = [];
        parts.push("<environment-variables>");
        parts.push("These variables are available in shell commands and file tool path arguments.");
        parts.push(`$USER_HOME = ${homedir()}`);
        parts.push(`$AGENT_HOME = ${homeDir}`);
        if (projectBasePath) {
            parts.push(`$PROJECT_BASE = ${projectBasePath}`);
        }
        parts.push("</environment-variables>");
        return parts.join("\n");
    },
};
