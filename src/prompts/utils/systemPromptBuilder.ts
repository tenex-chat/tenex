import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";

// Import fragment registration manifest
import "@/prompts/fragments"; // This auto-registers all fragments

export interface BuildSystemPromptOptions {
  // Required data
  agent: AgentInstance;
  project: NDKProject;

  // Optional runtime data
  availableAgents?: AgentInstance[];
  conversation?: Conversation;
  agentLessons?: Map<string, NDKAgentLesson[]>;
  triggeringEvent?: NDKEvent;
  isProjectManager?: boolean; // Indicates if this agent is the PM
  projectManagerPubkey?: string; // Pubkey of the project manager
}

export interface BuildStandalonePromptOptions {
  // Required data
  agent: AgentInstance;

  // Optional runtime data
  availableAgents?: AgentInstance[];
  conversation?: Conversation;
  agentLessons?: Map<string, NDKAgentLesson[]>;
  triggeringEvent?: NDKEvent;
  projectManagerPubkey?: string; // Pubkey of the project manager
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
    conversation?: Conversation,
    agentLessons?: Map<string, NDKAgentLesson[]>,
): void {
    // Add referenced article context if present
    if (conversation?.metadata?.referencedArticle) {
        builder.add("referenced-article", conversation.metadata.referencedArticle);
    }

    // Add retrieved lessons
    builder.add("retrieved-lessons", {
        agent,
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
    availableAgents: AgentInstance[],
    projectManagerPubkey?: string
): void {
    // Add available agents for delegations
    builder.add("available-agents", {
        agents: availableAgents,
        currentAgent: agent,
        projectManagerPubkey,
    });
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

  // Add agent phases awareness if agent has phases defined
  systemPromptBuilder.add("agent-phases", { agent });

  // Add core agent fragments using shared composition
  addCoreAgentFragments(
    systemPromptBuilder,
    agent,
    conversation,
    agentLessons,
  );

  // Add agent-specific fragments
  addAgentFragments(
    systemPromptBuilder,
    agent,
    availableAgents,
    options.projectManagerPubkey
  );

  return systemPromptBuilder.build();
}

/**
 * Builds PROJECT.md content as a separate message
 */
function buildProjectMdContent(options: BuildSystemPromptOptions): string | null {
  const content = PromptBuilder.buildFragment("project-md", {
    projectPath: process.cwd(),
    currentAgent: options.agent,
  });
  return content.trim() ? content : null;
}

/**
 * Builds project inventory content as a separate message
 */
// Temporarily disabled - will be restored later
// function buildProjectInventoryContent(): string | null {
//   const builder = new PromptBuilder();
//   builder.add("project-inventory-context", {});
//   const content = builder.build();
//   return content.trim() ? content : null;
// }

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

  // Add core agent fragments using shared composition
  addCoreAgentFragments(
    systemPromptBuilder,
    agent,
    conversation,
    agentLessons,
  );

  // Add agent-specific fragments only if multiple agents available
  if (availableAgents.length > 1) {
    addAgentFragments(
      systemPromptBuilder,
      agent,
      availableAgents,
      options.projectManagerPubkey
    );
  }

  return systemPromptBuilder.build();
}
