import { delegateExternalTool } from "@/tools/implementations/delegate_external";
import { claudeCode } from "@/tools/implementations/claude_code";
import { delegateTool } from "../tools/implementations/delegate";
import { lessonLearnTool } from "../tools/implementations/learn";
import { readPathTool } from "../tools/implementations/readPath";
import type { AgentInstance } from "./types";


/**
 * Core tools that ALL agents must have access to regardless of configuration.
 * These are fundamental capabilities that every agent needs.
 */
export const CORE_AGENT_TOOLS = [
  "lesson_get",    // All agents should access lessons
  "lesson_learn",  // All agents should be able to learn
  "delegate",      // All agents should be able to delegate
  "read_path",     // All agents need file system access
  "reports_list",  // All agents should see available reports
  "report_read",   // All agents should read reports
] as const;

/**
 * Get all available tools for an agent based on their role
 * Note: Since PM is now dynamic (first agent in project), we can't determine
 * PM-specific tools here. Tool assignment should be done via agent definition events.
 */
export function getDefaultToolsForAgent(_agent: AgentInstance): string[] {
  // Default tools for all agents
  // Specific tools should be configured via agent definition events
  const tools = [
    readPathTool.name,
    lessonLearnTool.name,
    claudeCode.name,
    delegateExternalTool.name, // All agents can delegate to external agents
    delegateTool.name, // Regular delegate for all agents
    "write_context_file",
    "shell",
    "discover_capabilities",
    "agents_hire",
    "agents_discover",
    "nostr_projects",
    "delegate_phase", // Available to all agents
  ];

  return tools;
}
