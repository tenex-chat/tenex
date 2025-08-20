import { claudeCode } from "@/tools/implementations/claude_code";
import { completeTool } from "../tools/implementations/complete";
import { delegateTool } from "../tools/implementations/delegate";
import { lessonLearnTool } from "../tools/implementations/learn";
import { readPathTool } from "../tools/implementations/readPath";
import type { AgentInstance } from "./types";

// Agent slug constants
export const PROJECT_MANAGER_AGENT = "project-manager" as const;

/**
 * Get all available tools for an agent based on their role
 * All agents now have access to delegate for peer-to-peer collaboration
 */
export function getDefaultToolsForAgent(agent: AgentInstance): string[] {
  // Special handling for project manager - different tool set
  if (agent.slug === PROJECT_MANAGER_AGENT) {
    // PM has delegate_phase instead of delegate
    return [
      readPathTool.name,
      lessonLearnTool.name,
      claudeCode.name,
      completeTool.name,
      "write_context_file",
      "shell",
      "discover_capabilities",
      "agents_hire",
      "agents_discover",
      "nostr_projects",
      "delegate_phase", // PM uses delegate_phase instead of delegate
    ];
  }

  // Special handling for human-resources agent - gets agent management tools
  if (agent.slug === "human-resources") {
    return [
      readPathTool.name,
      lessonLearnTool.name,
      claudeCode.name,
      completeTool.name,
      delegateTool.name,
      "agents_list",
      "agents_discover",
      "agents_hire",
      "agents_read",
      "agents_write",
    ];
  }

  // Base tools for all other agents
  const tools = [
    readPathTool.name,
    lessonLearnTool.name,
    // analyze.name,
    claudeCode.name,
    completeTool.name, // All agents can complete tasks
    delegateTool.name, // Non-PM agents use regular delegate
  ];

  // Give agents with matching slugs access to read and write their own definitions
  // This allows agents to self-modify and introspect
  const agentSelfManagementSlugs = ["human-resources", "self-improving-agent", "meta-agent"];
  if (agentSelfManagementSlugs.includes(agent.slug)) {
    tools.push("agents_read", "agents_write");
  }

  return tools;
}
