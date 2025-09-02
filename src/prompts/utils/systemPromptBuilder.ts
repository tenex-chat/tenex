import type { AgentInstance } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { ProjectContext } from "@/services/ProjectContext";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { 
    addCoreAgentFragments, 
    addSpecialistFragments, 
    addDelegatedTaskContext,
    buildPhaseInstructions as buildPhaseInstructionsFromCompositions,
    formatPhaseTransitionMessage as formatPhaseTransitionFromCompositions
} from "./fragmentCompositions";

// Import fragment registration manifest
import "@/prompts/fragments"; // This auto-registers all fragments

export interface BuildSystemPromptOptions {
  // Required data
  agent: AgentInstance;
  phase: Phase;
  project: NDKProject;

  // Optional runtime data
  availableAgents?: AgentInstance[];
  conversation?: Conversation;
  agentLessons?: Map<string, NDKAgentLesson[]>;
  mcpTools?: any[];
  triggeringEvent?: NDKEvent;
  projectContext?: ProjectContext; // For PM detection
}

export interface BuildStandalonePromptOptions {
  // Required data
  agent: AgentInstance;
  phase: Phase;

  // Optional runtime data
  availableAgents?: AgentInstance[];
  conversation?: Conversation;
  agentLessons?: Map<string, NDKAgentLesson[]>;
  mcpTools?: any[];
  triggeringEvent?: NDKEvent;
}

export interface SystemMessage {
  message: ModelMessage;
  metadata?: {
    cacheable?: boolean;
    cacheKey?: string;
    description?: string;
  };
}

/**
 * Export phase instruction building for use by other modules
 */
export function buildPhaseInstructions(phase: Phase, conversation?: Conversation): string {
  return buildPhaseInstructionsFromCompositions(phase, conversation);
}

/**
 * Export phase transition formatting for use by other modules
 */
export function formatPhaseTransitionMessage(
  lastSeenPhase: Phase,
  currentPhase: Phase,
  phaseInstructions: string
): string {
  return formatPhaseTransitionFromCompositions(lastSeenPhase, currentPhase, phaseInstructions);
}

/**
 * Builds the system prompt messages for an agent, returning an array of messages
 * with optional caching metadata.
 * This is the single source of truth for system prompt generation.
 */
export function buildSystemPromptMessages(options: BuildSystemPromptOptions): SystemMessage[] {
  const messages: SystemMessage[] = [];

  // Build the main system prompt
  const mainPrompt = buildMainSystemPrompt(options);
  messages.push({
    message: { role: "system", content: mainPrompt },
    metadata: {
      description: "Main system prompt",
    },
  });

  // Add PROJECT.md as separate cacheable message for project manager (determined dynamically)
  // Check if this agent is the PM by comparing pubkeys
  const projectContext = options.projectContext;
  if (projectContext && options.agent.pubkey === projectContext.getProjectManager().pubkey) {
    const projectMdContent = buildProjectMdContent(options);
    if (projectMdContent) {
      messages.push({
        message: { role: "system", content: projectMdContent },
        metadata: {
          cacheable: true,
          cacheKey: `project-md-${options.project.id}`,
          description: "PROJECT.md content",
        },
      });
    }
  }

  // Add project inventory as separate cacheable message for all agents
  const inventoryContent = buildProjectInventoryContent(options);
  if (inventoryContent) {
    messages.push({
      message: { role: "system", content: inventoryContent },
      metadata: {
        cacheable: true,
        cacheKey: `project-inventory-${options.project.id}-${options.phase}`,
        description: "Project inventory",
      },
    });
  }

  return messages;
}

/**
 * Builds the main system prompt content (without PROJECT.md and inventory)
 */
function buildMainSystemPrompt(options: BuildSystemPromptOptions): string {
  const {
    agent,
    phase,
    project,
    availableAgents = [],
    conversation,
    agentLessons,
    mcpTools = [],
    triggeringEvent,
  } = options;

  const systemPromptBuilder = new PromptBuilder();

  // Add specialist identity
  systemPromptBuilder.add("specialist-identity", {
    agent,
    projectTitle: project.tagValue("title") || "Unknown Project",
    projectOwnerPubkey: project.pubkey,
  });

  // Add delegated task context if applicable
  addDelegatedTaskContext(systemPromptBuilder, triggeringEvent);

  // Add core agent fragments using shared composition
  addCoreAgentFragments(
    systemPromptBuilder,
    agent,
    phase,
    conversation,
    agentLessons,
    triggeringEvent
  );

  // Add specialist-specific fragments
  addSpecialistFragments(
    systemPromptBuilder,
    agent,
    availableAgents,
    mcpTools
  );

  return systemPromptBuilder.build();
}

/**
 * Builds PROJECT.md content as a separate message
 */
function buildProjectMdContent(options: BuildSystemPromptOptions): string | null {
  const builder = new PromptBuilder();
  builder.add("project-md", {
    projectPath: process.cwd(),
    currentAgent: options.agent,
  });
  const content = builder.build();
  return content.trim() ? content : null;
}

/**
 * Builds project inventory content as a separate message
 */
function buildProjectInventoryContent(options: BuildSystemPromptOptions): string | null {
  const builder = new PromptBuilder();
  builder.add("project-inventory-context", {
    phase: options.phase,
  });
  const content = builder.build();
  return content.trim() ? content : null;
}

/**
 * Builds system prompt messages for standalone agents (without project context).
 * Includes most fragments except project-specific ones.
 */
export function buildStandaloneSystemPromptMessages(
  options: BuildStandalonePromptOptions
): SystemMessage[] {
  const messages: SystemMessage[] = [];

  // Build the main system prompt
  const mainPrompt = buildStandaloneMainPrompt(options);
  messages.push({
    message: { role: "system", content: mainPrompt },
    metadata: {
      description: "Main standalone system prompt",
    },
  });

  return messages;
}

/**
 * Builds the main system prompt for standalone agents
 */
function buildStandaloneMainPrompt(options: BuildStandalonePromptOptions): string {
  const {
    agent,
    phase,
    availableAgents = [],
    conversation,
    agentLessons,
    mcpTools = [],
    triggeringEvent,
  } = options;

  const systemPromptBuilder = new PromptBuilder();

  // For standalone agents, use a simplified identity without project references
  systemPromptBuilder.add("specialist-identity", {
    agent,
    projectTitle: "Standalone Mode",
    projectOwnerPubkey: agent.pubkey, // Use agent's own pubkey as owner
  });

  // Add delegated task context if applicable
  addDelegatedTaskContext(systemPromptBuilder, triggeringEvent);

  // Add core agent fragments using shared composition
  addCoreAgentFragments(
    systemPromptBuilder,
    agent,
    phase,
    conversation,
    agentLessons,
    triggeringEvent
  );

  // Add specialist-specific fragments only if multiple agents available
  if (availableAgents.length > 1) {
    addSpecialistFragments(
      systemPromptBuilder,
      agent,
      availableAgents,
      mcpTools
    );
  } else {
    // Just add tools for single agent mode
    systemPromptBuilder.add("specialist-tools", {
      agent,
      mcpTools,
    });
    systemPromptBuilder.add("specialist-completion-guidance", {});
  }

  return systemPromptBuilder.build();
}
