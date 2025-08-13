import type { AgentInstance } from "@/agents/types";
import { fragmentRegistry } from "@/prompts/core/FragmentRegistry";
import type { PromptFragment } from "@/prompts/core/types";
import type { Tool } from "@/tools/types";

/**
 * Tools fragment for specialist agents ONLY.
 * Combines agent tools and MCP tools into a single list.
 * No conditionals, no isOrchestrator checks.
 */
interface SpecialistToolsArgs {
    agent: AgentInstance;
    mcpTools?: Tool[];
}

export const specialistToolsFragment: PromptFragment<SpecialistToolsArgs> = {
    id: "specialist-tools",
    priority: 25,
    template: ({ agent, mcpTools = [] }) => {
        const sections: string[] = [];
        
        // Combine all tools
        const hasAgentTools = agent.tools && agent.tools.length > 0;
        const hasMcpTools = mcpTools.length > 0;
        
        if (!hasAgentTools && !hasMcpTools) {
            return "";
        }

        sections.push("## Available Tools\n");
        sections.push("You have access to the following tools for gathering information and completing tasks:\n");

        // Add agent-specific tools
        if (hasAgentTools) {
            sections.push("### Core Tools\n");
            for (const tool of agent.tools) {
                sections.push(`**${tool.name}**`);
                sections.push(`${tool.description}`);
                
                // Add custom prompt fragment if available
                if (tool.promptFragment) {
                    sections.push(`\n${tool.promptFragment}`);
                }
                sections.push("");
            }
        }

        // Add MCP tools if available
        if (hasMcpTools) {
            sections.push("### MCP Server Tools\n");
            sections.push("Additional tools are available from MCP servers:\n");

            // Group tools by server
            const toolsByServer = new Map<string, Tool[]>();
            for (const tool of mcpTools) {
                const [serverName] = tool.name.split("/");
                if (!serverName) continue;

                if (!toolsByServer.has(serverName)) {
                    toolsByServer.set(serverName, []);
                }
                toolsByServer.get(serverName)?.push(tool);
            }

            for (const [serverName, serverTools] of toolsByServer) {
                sections.push(`**${serverName} server:**`);
                for (const tool of serverTools) {
                    sections.push(`- \`${tool.name}\`: ${tool.description}`);
                    
                    // Add parameter information if available
                    if (
                        tool.parameters &&
                        tool.parameters.shape.type === "object" &&
                        tool.parameters.shape.properties
                    ) {
                        const params = Object.entries(tool.parameters.shape.properties)
                            .map(([name, schema]) => `${name} (${schema.type})`)
                            .join(", ");
                        sections.push(`  Parameters: ${params}`);
                    }
                }
                sections.push("");
            }
            
            sections.push(`
#### MCP Tool Examples by Phase:
- **PLAN**: \`git-server/diff\` to review changes before architecting
- **EXECUTE**: \`filesystem/write_file\` for code generation
- **VERIFICATION**: \`git-server/status\` to check modified files
- **CHORES**: \`filesystem/create_directory\` for project structure

Call MCP tools with full namespace: \`server-name/tool-name\`
`);
        }

        // Add concise tool usage table
        sections.push(`### Tool Usage Rules
| Rule | Action |
|------|--------|
| Execution | One tool at a time, sequential only |
| Results | Wait for actual output, no assumptions |
| Syntax | Use function calls, not text descriptions |
| Completion | Use \`complete()\` when done (except CHAT/BRAINSTORM phases) |`);

        return sections.join("\n");
    }
};

// Register the fragment
fragmentRegistry.register(specialistToolsFragment);