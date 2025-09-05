import type { AgentInstance } from "./types";


/**
 * Core tools that ALL agents must have access to regardless of configuration.
 * These are fundamental capabilities that every agent needs.
 */
export const CORE_AGENT_TOOLS = [
  "lesson_get",    // All agents should access lessons
  "lesson_learn",  // All agents should be able to learn
  "read_path",     // All agents need file system access
  "reports_list",  // All agents should see available reports
  "report_read",   // All agents should read reports
  // NOTE: delegate tools are NOT core - they're added dynamically in AgentExecutor based on PM status
] as const;

/**
 * Get all available tools for an agent based on their role
 * Note: Since PM is now dynamic (first agent in project), we can't determine
 * PM-specific tools here. Tool assignment should be done via agent definition events.
 */
export function getDefaultToolsForAgent(_agent: AgentInstance): string[] {
  // Default tools for all agents
  // Specific tools should be configured via agent definition events
  // NOTE: delegate, delegate_phase, delegate_external, and delegate_followup are NOT included here
  // They are added via getDelegateToolsForAgent based on PM status
  const tools = [
    "read_path",
    "lesson_learn", 
    "claude_code",
    "write_context_file",
    "shell",
    "discover_capabilities",
    "agents_hire",
    "agents_discover",
    "nostr_projects",
  ];

  return tools;
}

/**
 * Delegate tools that should be excluded from configuration and kind 24010 events
 */
export const DELEGATE_TOOLS = ['delegate', 'delegate_phase', 'delegate_external', 'delegate_followup'] as const;

/**
 * Get the correct delegate tools for an agent based on PM status
 * This is the SINGLE source of truth for delegate tool assignment
 */
export function getDelegateToolsForAgent(isPM: boolean): string[] {
  const tools: string[] = [];
  
  if (isPM) {
    // PM gets delegate_phase (NOT delegate)
    tools.push('delegate_phase');
  } else {
    // Non-PM agents get delegate (NOT delegate_phase)
    tools.push('delegate');
  }
  
  // All agents get delegate_external and delegate_followup
  tools.push('delegate_external');
  tools.push('delegate_followup');
  
  return tools;
}
