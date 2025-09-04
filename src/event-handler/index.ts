import { formatAnyError } from "@/utils/error-formatter";
import { NDKEvent, NDKKind, NDKProject } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import { AgentExecutor } from "../agents/execution/AgentExecutor";
import { ConversationCoordinator } from "../conversations";
import { NDKEventMetadata } from "../events/NDKEventMetadata";
import { EVENT_KINDS } from "../llm/types";
import { getProjectContext } from "../services";
import { DelegationRegistry } from "../services/DelegationRegistry";
import { logger } from "../utils/logger";
import { handleNewConversation } from "./newConversation";
import { handleProjectEvent } from "./project";
import { handleChatMessage } from "./reply";

const logInfo = logger.info.bind(logger);

const IGNORED_EVENT_KINDS = [
  NDKKind.Metadata,
  EVENT_KINDS.PROJECT_STATUS as NDKKind,
  EVENT_KINDS.STREAMING_RESPONSE as NDKKind,
  EVENT_KINDS.TYPING_INDICATOR as NDKKind,
  EVENT_KINDS.TYPING_INDICATOR_STOP as NDKKind,
];

export class EventHandler {
  private conversationCoordinator!: ConversationCoordinator;
  private agentExecutor!: AgentExecutor;
  private isUpdatingProject = false;

  constructor(
    private projectPath: string,
  ) {}

  async initialize(): Promise<void> {
    // Initialize DelegationRegistry singleton first
    await DelegationRegistry.initialize();

    // Initialize components directly
    this.conversationCoordinator = new ConversationCoordinator(
      this.projectPath,
      undefined // default persistence
    );
    this.agentExecutor = new AgentExecutor(this.conversationCoordinator);

    // Initialize components
    await this.conversationCoordinator.initialize();
  }

  getConversationCoordinator(): ConversationCoordinator {
    return this.conversationCoordinator;
  }

  async handleEvent(event: NDKEvent): Promise<void> {
    // Ignore kind 24010 (project status), 24111 (typing indicator), and 24112 (typing stop) events
    if (IGNORED_EVENT_KINDS.includes(event.kind)) return;

    // Debug: Check if event has proper NDKEvent methods
    if (typeof event.getMatchingTags !== 'function') {
      logger.error("Event is missing getMatchingTags method!", {
        eventId: event.id,
        eventKind: event.kind,
        hasGetMatchingTags: typeof event.getMatchingTags,
        hasEncode: typeof event.encode,
        eventConstructor: event.constructor?.name,
        eventPrototype: Object.getPrototypeOf(event)?.constructor?.name,
        eventKeys: Object.keys(event),
        isNDKEvent: event instanceof NDKEvent,
      });
      // Don't mask the issue - let it fail so we can trace it
    }

    // Try to get agent slug if the event is from an agent
    let fromIdentifier = event.pubkey;
    let forIdentifiers: string = "without any recipient";
    
    try {
      const projectCtx = getProjectContext();
      const agent = projectCtx.getAgentByPubkey(event.pubkey);
      if (agent) {
        fromIdentifier = agent.slug;
      }
      
      // Process p-tags to show agent slugs where possible
      let pTags: string[][] = [];
      try {
        pTags = event.getMatchingTags("p");
      } catch (err) {
        logger.error("Failed to get p-tags - event is not a proper NDKEvent!", {
          error: err,
          eventType: typeof event,
          eventConstructor: event?.constructor?.name,
          eventPrototype: Object.getPrototypeOf(event)?.constructor?.name,
          hasGetMatchingTags: typeof event?.getMatchingTags,
          eventKeys: Object.keys(event || {}),
          event: JSON.stringify(event, null, 2)
        });
        throw err;
      }
      if (pTags.length > 0) {
        const recipients = pTags.map((t) => {
          const pubkey = t[1];
          const recipientAgent = projectCtx.getAgentByPubkey(pubkey);
          return recipientAgent ? recipientAgent.slug : pubkey.substring(0, 8);
        });
        forIdentifiers = recipients.join(", ");
      }
    } catch {
      // Project context might not be available, continue with pubkey
      let pTags: string[][] = [];
      try {
        pTags = event.getMatchingTags("p");
      } catch (err) {
        logger.error("Failed to get p-tags (fallback) - event is not a proper NDKEvent!", {
          error: err,
          eventType: typeof event,
          eventConstructor: event?.constructor?.name,
          eventPrototype: Object.getPrototypeOf(event)?.constructor?.name,
          hasGetMatchingTags: typeof event?.getMatchingTags,
          eventKeys: Object.keys(event || {}),
          event: JSON.stringify(event, null, 2)
        });
        throw err;
      }
      if (pTags.length > 0) {
        forIdentifiers = pTags.map((t) => t[1].substring(0, 8)).join(", ");
      }
    }

    logger.info(
      `event handler, kind: ${event.kind} from ${fromIdentifier} for (${forIdentifiers}) (${event.encode()})`
    );

    // Check if this is a delegation response BEFORE routing
    const delegationRegistry = DelegationRegistry.getInstance();
    if (delegationRegistry.isDelegationResponse(event)) {
      await delegationRegistry.handleDelegationResponse(event);
      return; // Done - this was a delegation response
    }

    switch (event.kind) {
      case NDKKind.GenericReply: // kind 1111
        await handleChatMessage(event, {
          conversationCoordinator: this.conversationCoordinator,
          agentExecutor: this.agentExecutor,
        });
        break;

      case NDKKind.Thread: // kind 11
        await handleNewConversation(event, {
          conversationCoordinator: this.conversationCoordinator,
          agentExecutor: this.agentExecutor,
        });
        break;

      case NDKProject.kind: // kind 31933
        if (this.isUpdatingProject) {
          logger.warn("Project update already in progress, skipping event", {
            eventId: event.id,
          });
          return;
        }

        this.isUpdatingProject = true;
        try {
          await handleProjectEvent(event, this.projectPath);
        } finally {
          this.isUpdatingProject = false;
        }
        break;

      case EVENT_KINDS.AGENT_CONFIG_UPDATE:
        await this.handleAgentConfigUpdate(event);
        break;

      case 513: // NDKEventMetadata
        await this.handleMetadataEvent(event);
        break;

      default:
        this.handleDefaultEvent(event);
    }
  }

  private async handleMetadataEvent(event: NDKEvent): Promise<void> {
    const metadata = NDKEventMetadata.from(event);
    const conversationId = metadata.conversationId;
    
    if (!conversationId) {
      logger.error("Metadata event missing conversation ID", event.inspect);
      return;
    }
    
    // Only update if we know this conversation
    if (this.conversationCoordinator.hasConversation(conversationId)) {
      const title = metadata.title;
      if (title) {
        this.conversationCoordinator.setTitle(conversationId, title);
        logger.info(`Updated conversation title: ${title} for ${conversationId.substring(0, 8)}`);
      }
    }
  }

  private async handleAgentConfigUpdate(event: NDKEvent): Promise<void> {
    try {
      // Extract the agent pubkey from the event tags
      const agentPubkey = event.tagValue("p");
      if (!agentPubkey) {
        logger.warn("AGENT_CONFIG_UPDATE event missing agent pubkey", {
          eventId: event.id,
        });
        return;
      }

      // Get the agent from the project context
      const projectContext = getProjectContext();
      const agent = Array.from(projectContext.agents.values()).find(
        (a) => a.pubkey === agentPubkey
      );

      if (!agent) {
        logger.warn("Agent not found for config change", {
          agentPubkey,
          availableAgents: Array.from(projectContext.agents.keys()),
        });
        return;
      }

      // Load the agent registry for persistent updates
      const { AgentRegistry } = await import("@/agents/AgentRegistry");
      const agentRegistry = new AgentRegistry(this.projectPath, false);
      await agentRegistry.loadFromProject();

      // Check for model configuration change
      const newModel = event.tagValue("model");
      if (newModel) {
        logger.info("Received agent config update request", {
          agentPubkey,
          newModel,
          eventId: event.id,
          from: event.pubkey,
        });

        // Update the agent's model configuration persistently
        const updated = await agentRegistry.updateAgentLLMConfig(agentPubkey, newModel);

        if (updated) {
          // Also update in memory for immediate effect
          agent.llmConfig = newModel;
          logger.info("Updated and persisted model configuration for agent", {
            agentName: agent.name,
            agentPubkey: agent.pubkey,
            newModel,
          });
        } else {
          // Fallback: at least update in memory for this session
          agent.llmConfig = newModel;
          logger.warn("Updated model configuration in memory only (persistence failed)", {
            agentName: agent.name,
            agentPubkey: agent.pubkey,
            newModel,
          });
        }
      }

      // Check for tools configuration change
      // Extract all tool tags - these represent the exhaustive list of tools the agent should have
      const toolTags = event.tags.filter((tag) => tag[0] === "tool");
      if (toolTags.length > 0) {
        // Extract tool names from tags (format: ["tool", "<tool-name>"])
        const newToolNames = toolTags.map((tag) => tag[1]).filter((name) => name);

        logger.debug("Received tools config change request", {
          agentPubkey,
          agentSlug: agent.slug,
          toolCount: newToolNames.length,
          eventId: event.id,
        });

        // Update the agent's tools persistently
        const updated = await agentRegistry.updateAgentTools(agentPubkey, newToolNames);

        if (updated) {
          // CRITICAL: Also update the agent in ProjectContext so the changes take effect immediately
          // The registry update only persists to disk and updates its own copy
          // We need to update the ProjectContext copy that's actually used for execution
          const { isValidToolName } = await import("@/tools/registry");
          const validToolNames = newToolNames.filter(isValidToolName);
          agent.tools = validToolNames;
          
          logger.info("Updated tools configuration", {
            agent: agent.slug,
            toolCount: newToolNames.length,
            newToolNames,
        });
        } else {
          logger.warn("Failed to update tools configuration", {
            agent: agent.slug,
            reason: "update returned false",
          });
        }
      }

      // If neither model nor tools were provided, log a warning
      if (!newModel && toolTags.length === 0) {
        logger.warn("AGENT_CONFIG_UPDATE event has neither model nor tool tags", {
          eventId: event.id,
          agentPubkey,
        });
      }
    } catch (error) {
      logger.error("Failed to handle config change", {
        eventId: event.id,
        error: formatAnyError(error),
      });
    }
  }

  private handleDefaultEvent(event: NDKEvent): void {
    if (event.content) {
      logInfo(
        chalk.white(
          `[handleDefaultEvent ${event.id.substring(0, 6)}] Receivend unhandled event kind ${event.kind}`
        ) +
          chalk.white(`[handleDefaultEvent ${event.id.substring(0, 6)}] Content: `) +
          chalk.gray(event.content.substring(0, 100) + (event.content.length > 100 ? "..." : ""))
      );
    }
  }

  async cleanup(): Promise<void> {
    // Save all conversations before shutting down
    await this.conversationCoordinator.cleanup();
    logInfo("EventHandler cleanup completed");
  }
}
