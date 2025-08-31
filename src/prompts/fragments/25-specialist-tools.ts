import type { AgentInstance } from "@/agents/types";
import { fragmentRegistry } from "@/prompts/core/FragmentRegistry";
import type { PromptFragment } from "@/prompts/core/types";

/**
 * Tools fragment for specialist agents ONLY.
 * Combines agent tools and MCP tools into a single list.
 * 
 * Tool Assignment Guide:
 * - All agents automatically receive core tools: lesson_get, lesson_learn, 
 *   delegate, read_path, reports_list, report_read
 * - Additional tools can be assigned based on agent responsibilities
 * - Use agents_write tool to configure agent tools
 * - MCP tools follow format: mcp__servername__toolname
 * - Agents can request specific MCP tools or get access to all if mcp=true
 */
interface SpecialistToolsArgs {
  agent: AgentInstance;
  mcpTools?: any[];
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
      const coreTools: string[] = [];
      const agentTools: string[] = [];
      const delegationTools: string[] = [];
      const reportTools: string[] = [];
      const otherTools: string[] = [];
      
      // agent.tools is now an array of tool names (strings)
      for (const toolName of agent.tools) {
        if (typeof toolName !== 'string') continue;
        
        if (["lesson_get", "lesson_learn", "read_path"].includes(toolName)) {
          coreTools.push(toolName);
        } else if (toolName.startsWith("agents_")) {
          agentTools.push(toolName);
        } else if (toolName.includes("delegate")) {
          delegationTools.push(toolName);
        } else if (toolName.includes("report")) {
          reportTools.push(toolName);
        } else {
          otherTools.push(toolName);
        }
      }
      
      // Tool descriptions mapping
      const toolDescriptions: Record<string, string> = {
        // Core tools
        "lesson_get": "Retrieve lessons learned from previous work",
        "lesson_learn": "Record new lessons and insights for future reference",
        "read_path": "Read a file or directory from the filesystem",
        
        // Agent management tools
        "agents_discover": "Discover available agents and their capabilities",
        "agents_hire": "Hire a new agent for the project",
        "agents_list": "List all agents in the project",
        "agents_read": "Read detailed information about a specific agent",
        "agents_write": "Update agent configuration and tools",
        
        // Delegation tools
        "delegate": "Delegate tasks to other agents",
        "delegate_phase": "Delegate entire project phases to agents",
        "delegate_external": "Delegate to external project agents",
        
        // Report tools
        "report_write": "Write a report or document",
        "report_read": "Read an existing report",
        "reports_list": "List all available reports",
        "report_delete": "Delete a report",
        
        // Other tools
        "shell": "Execute shell commands",
        "write_context_file": "Write context files for the project",
        "generate_inventory": "Generate inventory of project structure",
        "discover_capabilities": "Discover MCP server capabilities",
        "nostr_projects": "Manage Nostr project configurations",
        "claude_code": "Use Claude Code for complex tasks",
        "create_project": "Create a new project",
      };
      
      // Display core tools first
      if (coreTools.length > 0) {
        sections.push("#### Essential Tools (Available to All Agents)\n");
        for (const toolName of coreTools) {
          const description = toolDescriptions[toolName] || "Tool for specialized tasks";
          sections.push(`**${toolName}**`);
          sections.push(`${description}`);
          sections.push("");
        }
      }
      
      // Display delegation tools
      if (delegationTools.length > 0) {
        sections.push("#### Delegation Tools\n");
        for (const toolName of delegationTools) {
          const description = toolDescriptions[toolName] || "Tool for delegation tasks";
          sections.push(`**${toolName}**`);
          sections.push(`${description}`);
          sections.push("");
        }
      }
      
      // Display agent management tools
      if (agentTools.length > 0) {
        sections.push("#### Agent Management Tools\n");
        for (const toolName of agentTools) {
          const description = toolDescriptions[toolName] || "Tool for agent management";
          sections.push(`**${toolName}**`);
          sections.push(`${description}`);
          sections.push("");
        }
      }
      
      // Display report tools
      if (reportTools.length > 0) {
        sections.push("#### Report Tools\n");
        for (const toolName of reportTools) {
          const description = toolDescriptions[toolName] || "Tool for report management";
          sections.push(`**${toolName}**`);
          sections.push(`${description}`);
          sections.push("");
        }
      }
      
      // Display other specialized tools
      if (otherTools.length > 0) {
        sections.push("#### Specialized Tools\n");
        for (const toolName of otherTools) {
          const description = toolDescriptions[toolName] || "Tool for specialized tasks";
          sections.push(`**${toolName}**`);
          sections.push(`${description}`);
          sections.push("");
        }
      }
    }

    // Add MCP tools if available
    if (hasMcpTools) {
      sections.push("### MCP Server Tools\n");
      sections.push("Additional tools are available from MCP servers:\n");

      // Group tools by server
      const toolsByServer = new Map<string, any[]>();
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
| Completion | Your work completes naturally when you finish responding |`);

    return sections.join("\n");
  },
};

// Register the fragment
fragmentRegistry.register(specialistToolsFragment);