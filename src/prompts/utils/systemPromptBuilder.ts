import type { AgentInstance } from "@/agents/types";
import type { Phase, Conversation } from "@/conversations/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";
import { isVoiceMode } from "@/prompts/fragments/20-voice-mode";

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
  triggeringEvent?: NDKEvent;
  isProjectManager?: boolean; // Indicates if this agent is the PM
}

export interface BuildStandalonePromptOptions {
  // Required data
  agent: AgentInstance;
  phase: Phase;

  // Optional runtime data
  availableAgents?: AgentInstance[];
  conversation?: Conversation;
  agentLessons?: Map<string, NDKAgentLesson[]>;
  triggeringEvent?: NDKEvent;
}

export interface SystemMessage {
  message: ModelMessage;
  metadata?: {
    description?: string;
  };
}

/**
 * Add core agent fragments that are common to both project and standalone modes
 */
function addCoreAgentFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    phase: Phase,
    conversation?: Conversation,
    agentLessons?: Map<string, NDKAgentLesson[]>,
    triggeringEvent?: NDKEvent
): void {
    // Add voice mode instructions if applicable
    builder.add("voice-mode", { isVoiceMode: isVoiceMode(triggeringEvent) });

    // Add referenced article context if present
    if (conversation?.metadata?.referencedArticle) {
        builder.add("referenced-article", conversation.metadata.referencedArticle);
    }

    // Add retrieved lessons
    builder.add("retrieved-lessons", {
        agent,
        phase,
        conversation,
        agentLessons: agentLessons || new Map(),
    });
}

/**
 * Add agent-specific fragments
 */
function addAgentFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    availableAgents: AgentInstance[]
): void {
    // Add available agents for delegations
    builder.add("available-agents", {
        agents: availableAgents,
        currentAgent: agent,
    });
}

/**
 * Add delegated task context if applicable
 */
function addDelegatedTaskContext(
    builder: PromptBuilder,
    triggeringEvent?: NDKEvent
): void {
    // Check if this is a delegated task (NDKTask kind 1934)
    const isDelegatedTask = triggeringEvent?.kind === 1934;
    if (isDelegatedTask) {
        builder.add("delegated-task-context", {
            taskDescription: triggeringEvent?.content || "Complete the assigned task",
        });
    }
}

/**
 * Export phase instruction building for use by other modules
 */
export function buildPhaseInstructions(phase: Phase, conversation?: Conversation): string {
  // If the conversation has custom phase instructions, use those
  if (conversation?.phaseInstructions) {
    return `=== CURRENT PHASE: ${phase.toUpperCase()} ===

${conversation.phaseInstructions}`;
  }
  
  // Otherwise, fall back to standard phase instructions
  const builder = new PromptBuilder()
      .add("phase-context", {
          phase,
          phaseMetadata: conversation?.metadata,
          conversation,
      });

  return builder.build();
}

/**
 * Export phase transition formatting for use by other modules
 */
export function formatPhaseTransitionMessage(
  lastSeenPhase: Phase,
  currentPhase: Phase,
  phaseInstructions: string
): string {
  return `=== PHASE TRANSITION ===

You were last active in the ${lastSeenPhase.toUpperCase()} phase.
The conversation has now moved to the ${currentPhase.toUpperCase()} phase.

${phaseInstructions}

Please adjust your behavior according to the new phase requirements.`;
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

  // Add PROJECT.md as separate cacheable message for project manager
  if (options.isProjectManager) {
    const projectMdContent = buildProjectMdContent(options);
    if (projectMdContent) {
      messages.push({
        message: { role: "system", content: projectMdContent },
        metadata: {
          description: "PROJECT.md content",
        },
      });
    }
  }

  // Add project inventory as separate cacheable message for all agents
  // XXX TEMPORARILY DISABLED! RESTORE ASAP!
  // const inventoryContent = buildProjectInventoryContent();
  // if (inventoryContent) {
  //   messages.push({
  //     message: { role: "system", content: inventoryContent },
  //     metadata: {
  //       description: "Project inventory",
  //     },
  //   });
  // }

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
    triggeringEvent,
  } = options;

  const systemPromptBuilder = new PromptBuilder();

  // Add agent identity
  systemPromptBuilder.add("agent-identity", {
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

  // Add agent-specific fragments
  addAgentFragments(
    systemPromptBuilder,
    agent,
    availableAgents
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
function buildProjectInventoryContent(): string | null {
  const builder = new PromptBuilder();
  builder.add("project-inventory-context", {});
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
    triggeringEvent,
  } = options;

  const systemPromptBuilder = new PromptBuilder();

  // For standalone agents, use a simplified identity without project references
  systemPromptBuilder.add("agent-identity", {
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

  // Add agent-specific fragments only if multiple agents available
  if (availableAgents.length > 1) {
    addAgentFragments(
      systemPromptBuilder,
      agent,
      availableAgents
    );
  }

  return systemPromptBuilder.build();
}
