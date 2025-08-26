import type { AgentInstance } from "@/agents/types";
import { fragmentRegistry } from "@/prompts/core/FragmentRegistry";
import type { PromptFragment } from "@/prompts/core/types";
import type { Tool } from "@/tools/types";

/**
 * Tools fragment for specialist agents ONLY.
 * Combines agent tools and MCP tools into a single list.
 * 
 * Tool Assignment Guide:
 * - All agents automatically receive core tools: complete, lesson_get, lesson_learn, 
 *   delegate, read_path, reports_list, report_read
 * - Additional tools can be assigned based on agent responsibilities
 * - Use agents_write tool to configure agent tools
 * - MCP tools follow format: mcp__servername__toolname
 * - Agents can request specific MCP tools or get access to all if mcp=true
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
    sections.push(
      "You have access to the following tools for gathering information and completing tasks:\n"
    );

    // Add agent-specific tools
    if (hasAgentTools) {
      sections.push("### Core Tools\n");
      
      // Group tools by category for better organization
      const coreTools: Tool[] = [];
      const agentTools: Tool[] = [];
      const delegationTools: Tool[] = [];
      const reportTools: Tool[] = [];
      const otherTools: Tool[] = [];
      
      for (const tool of agent.tools) {
        if (["complete", "lesson_get", "lesson_learn", "read_path"].includes(tool.name)) {
          coreTools.push(tool);
        } else if (tool.name.startsWith("agents_")) {
          agentTools.push(tool);
        } else if (tool.name.includes("delegate")) {
          delegationTools.push(tool);
        } else if (tool.name.includes("report")) {
          reportTools.push(tool);
        } else {
          otherTools.push(tool);
        }
      }
      
      // Display core tools first
      if (coreTools.length > 0) {
        sections.push("#### Essential Tools (Available to All Agents)\n");
        for (const tool of coreTools) {
          sections.push(`**${tool.name}**`);
          sections.push(`${tool.description}`);
          if (tool.promptFragment) {
            sections.push(`\n${tool.promptFragment}`);
          }
          sections.push("");
        }
      }
      
      // Display delegation tools
      if (delegationTools.length > 0) {
        sections.push("#### Delegation Tools\n");
        for (const tool of delegationTools) {
          sections.push(`**${tool.name}**`);
          sections.push(`${tool.description}`);
          if (tool.promptFragment) {
            sections.push(`\n${tool.promptFragment}`);
          }
          sections.push("");
        }
      }
      
      // Display agent management tools
      if (agentTools.length > 0) {
        sections.push("#### Agent Management Tools\n");
        for (const tool of agentTools) {
          sections.push(`**${tool.name}**`);
          sections.push(`${tool.description}`);
          if (tool.promptFragment) {
            sections.push(`\n${tool.promptFragment}`);
          }
          sections.push("");
        }
      }
      
      // Display report tools
      if (reportTools.length > 0) {
        sections.push("#### Report Tools\n");
        for (const tool of reportTools) {
          sections.push(`**${tool.name}**`);
          sections.push(`${tool.description}`);
          if (tool.promptFragment) {
            sections.push(`\n${tool.promptFragment}`);
          }
          sections.push("");
        }
      }
      
      // Display other specialized tools
      if (otherTools.length > 0) {
        sections.push("#### Specialized Tools\n");
        for (const tool of otherTools) {
          sections.push(`**${tool.name}**`);
          sections.push(`${tool.description}`);
          if (tool.promptFragment) {
            sections.push(`\n${tool.promptFragment}`);
          }
          sections.push("");
        }
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
  },
};

// Register the fragment
fragmentRegistry.register(specialistToolsFragment);
