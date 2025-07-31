import type { Agent } from "@/agents/types";
import { fragmentRegistry } from "@/prompts/core/FragmentRegistry";
import type { PromptFragment } from "@/prompts/core/types";

interface AgentToolsArgs {
    agent: Agent;
}

export const agentToolsFragment: PromptFragment<AgentToolsArgs> = {
    id: "agent-tools",
    priority: 25, // Before MCP tools
    template: (args: AgentToolsArgs) => {
        const { agent } = args;

        if (!agent.tools || agent.tools.length === 0) {
            return "";
        }

        const sections: string[] = [];

        // Add header
        sections.push("## Available Agent Tools\n");
        sections.push("You have access to the following tools:\n");

        // Process each tool
        for (const tool of agent.tools) {
            const toolSections: string[] = [];

            // Add tool name and description
            toolSections.push(`### ${tool.name}`);
            toolSections.push(`${tool.description}\n`);

            // Add custom prompt fragment if available
            if (tool.promptFragment) {
                toolSections.push(tool.promptFragment);
                toolSections.push("");
            }

            sections.push(toolSections.join("\n"));
        }

        return sections.join("\n");
    },
    validateArgs: (args: unknown): args is AgentToolsArgs => {
        return (
            typeof args === "object" &&
            args !== null &&
            "agent" in args &&
            typeof (args as any).agent === "object"
        );
    },
    expectedArgs: "{ agent: Agent }",
};

// Register the fragment
fragmentRegistry.register(agentToolsFragment);
