import type { ToolName } from "@/tools/types";
import type { AgentInstance } from "./types";

type AgentPhaseInfo = Pick<AgentInstance, "phases"> | { phases?: Record<string, string> };

/**
 * Core tools that ALL agents must have access to regardless of configuration.
 * These are fundamental capabilities that every agent needs.
 */
export const CORE_AGENT_TOOLS: ToolName[] = [
    "lesson_get", // All agents should access lessons
    "lesson_learn", // All agents should be able to learn
    "read_path", // All agents need file system access
    "codebase_search", // All agents need file system access
    "reports_list", // All agents should see available reports
    "report_read", // All agents should read reports
    // RAG tools for enhanced memory and knowledge management
    "rag_query", // All agents should be able to query RAG collections
    "rag_add_documents", // All agents should be able to add to RAG collections
    "rag_create_collection", // All agents should be able to create collections
    "rag_delete_collection", // All agents should be able to delete collections
    "rag_list_collections", // All agents should be able to list collections
] as const;

/**
 * Get all available tools for an agent based on their role
 * Note: Since PM is now dynamic (first agent in project), we can't determine
 * PM-specific tools here. Tool assignment should be done via agent definition events.
 */
export function getDefaultToolsForAgent(_agent: AgentPhaseInfo): ToolName[] {
    // Default tools for all agents
    // Specific tools should be configured via agent definition events
    // NOTE: delegate, delegate_external, and delegate_followup are NOT included here
    // They are added via getDelegateToolsForAgent based on PM status
    const tools: ToolName[] = [
        "read_path",
        "lesson_learn",
        "codebase_search",
        "shell",
        "discover_capabilities",
        "agents_hire",
        "agents_discover",
        "nostr_projects",
    ];

    return tools;
}

/**
 * Delegate tools that should be excluded from configuration and TenexProjectStatus events
 */
export const DELEGATE_TOOLS: ToolName[] = [
    "ask",
    "delegate",
    "delegate_external",
    "delegate_followup",
] as const;

/**
 * Phase management tools
 */
export const PHASE_MANAGEMENT_TOOLS: ToolName[] = ["phase_add", "phase_remove"];

/**
 * Get the correct delegate tools for an agent based on whether they have phases defined
 * This is the SINGLE source of truth for delegate tool assignment
 */
export function getDelegateToolsForAgent(
    agent: AgentPhaseInfo,
    requestedTools?: string[]
): ToolName[] {
    const tools: ToolName[] = [];

    // All agents get ask tool
    tools.push("ask");

    // All agents get the unified delegate tool
    tools.push("delegate");

    // Check if agent has phases defined
    const hasPhases = agent.phases && Object.keys(agent.phases).length > 0;

    // Check if phase tools were explicitly requested (allows bootstrapping phases)
    const phaseToolsRequested =
        requestedTools?.includes("phase_add") || requestedTools?.includes("phase_remove");

    if (hasPhases || phaseToolsRequested) {
        // Agents with phases (or explicitly requesting phase tools) get phase management tools
        tools.push("phase_add", "phase_remove");
    }

    // All agents get delegate_external and delegate_followup
    tools.push("delegate_external");
    tools.push("delegate_followup");

    return tools;
}
