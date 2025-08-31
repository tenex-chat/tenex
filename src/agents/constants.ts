import type { AgentInstance } from "./types";

// Agent slug constants
export const PROJECT_MANAGER_AGENT = "project-manager" as const;

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
 */
export function getDefaultToolsForAgent(agent: AgentInstance): string[] {
  // Special handling for project manager - different tool set
  if (agent.slug === PROJECT_MANAGER_AGENT) {
    // PM has delegate_phase instead of delegate
    return [
      "read_path",
      "lesson_learn",
      "claude_code",
      "delegate_external",
      "write_context_file",
      "shell",
      "discover_capabilities",
      "agents_hire",
      "agents_discover",
      "nostr_projects",
      "delegate_phase", // PM uses delegate_phase instead of delegate
    ];
  }

  // Base tools for all other agents
  const tools = [
    "read_path",
    "lesson_learn",
    "claude_code",
    "delegate_external", // All agents can delegate to external agents
    "delegate", // Non-PM agents use regular delegate
  ];

  return tools;
}
