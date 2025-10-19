import { formatAnyError } from "@/utils/error-formatter";
import { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import chalk from "chalk";
import { AgentExecutor } from "../agents/execution/AgentExecutor";
import { ConversationCoordinator } from "../conversations";
import { NDKEventMetadata } from "../events/NDKEventMetadata";
import { getProjectContext } from "../services";
import { DelegationRegistry } from "../services/DelegationRegistry";
import { logger } from "../utils/logger";
import { handleNewConversation } from "./newConversation";
import { handleProjectEvent } from "./project";
import { handleChatMessage } from "./reply";
import { llmOpsRegistry } from "../services/LLMOperationsRegistry";
import { BrainstormService } from "../services/BrainstormService";


const IGNORED_EVENT_KINDS = [
  NDKKind.Metadata,
  NDKKind.Contacts,
  NDKKind.TenexProjectStatus,
  NDKKind.TenexStreamingResponse,
  NDKKind.TenexAgentTypingStart,
  NDKKind.TenexAgentTypingStop,
  NDKKind.TenexOperationsStatus,
];

export class EventHandler {
  private agentExecutor!: AgentExecutor;
  private isUpdatingProject = false;

  constructor(
    private projectPath: string,
    private conversationCoordinator: ConversationCoordinator,
  ) {}

  async initialize(): Promise<void> {
    // Initialize DelegationRegistry singleton first
    await DelegationRegistry.initialize();

    // Initialize components directly
    this.agentExecutor = new AgentExecutor();
  }

  getConversationCoordinator(): ConversationCoordinator {
    return this.conversationCoordinator;
  }

  async handleEvent(event: NDKEvent): Promise<void> {
    // Ignore ephemeral status and typing indicator events
    if (IGNORED_EVENT_KINDS.includes(event.kind)) return;

    // Try to get agent slug if the event is from an agent
    let fromIdentifier = event.pubkey;
    let forIdentifiers = "without any recipient";
    
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

      // Add the delegation response to conversation history for context
      const { ConversationResolver } = await import("@/conversations/services/ConversationResolver");
      const resolver = new ConversationResolver(this.conversationCoordinator);
      const result = await resolver.resolveConversationForEvent(event);

      if (result.conversation) {
        await this.conversationCoordinator.addEvent(result.conversation.id, event);
        logger.debug(`Added delegation response to conversation history: ${result.conversation.id.substring(0, 8)}`);
      } else {
        logger.warn(`Could not find conversation for delegation response: ${event.id?.substring(0, 8)}`);
      }

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
        // Check if this is a brainstorm event before regular handling
        if (this.isBrainstormEvent(event)) {
          await this.handleBrainstormEvent(event);
        } else {
          await handleNewConversation(event, {
            conversationCoordinator: this.conversationCoordinator,
            agentExecutor: this.agentExecutor,
            projectPath: this.projectPath,
          });
        }
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

      case NDKKind.TenexAgentConfigUpdate:
        await this.handleAgentConfigUpdate(event);
        break;

      case 513: // NDKEventMetadata
        await this.handleMetadataEvent(event);
        break;
      
      case NDKKind.TenexStopCommand: // Stop LLM operations
        await this.handleStopEvent(event);
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
      const agent = projectContext.getAgentByPubkey(agentPubkey);

      if (!agent) {
        logger.warn("Agent not found for config change", {
          agentPubkey,
          availableAgents: projectContext.getAgentSlugs(),
        });
        return;
      }

      // Get the agent registry from ProjectContext (single source of truth)
      const agentRegistry = projectContext.agentRegistry;

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
        // Since AgentRegistry is the single source of truth, this will update both
        // the in-memory instance and persist to disk
        const updated = await agentRegistry.updateAgentLLMConfig(agentPubkey, newModel);

        if (updated) {
          logger.info("Updated and persisted model configuration for agent", {
            agentName: agent.slug,
            agentPubkey: agent.pubkey,
            newModel,
          });
        } else {
          logger.warn("Failed to update model configuration", {
            agentName: agent.slug,
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
        // Since ProjectContext now uses AgentRegistry directly, this update
        // will immediately be reflected in all agent accesses
        const updated = await agentRegistry.updateAgentTools(agentPubkey, newToolNames);

        if (updated) {
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

  private async handleStopEvent(event: NDKEvent): Promise<void> {
    const eTags = event.getMatchingTags("e");
    
    if (eTags.length === 0) {
      logger.warn("[EventHandler] Stop event received with no e-tags", {
        eventId: event.id?.substring(0, 8)
      });
      return;
    }
    
    let totalStopped = 0;
    
    for (const [_, eventId] of eTags) {
      const stopped = llmOpsRegistry.stopByEventId(eventId);
      if (stopped > 0) {
        logger.info(`[EventHandler] Stopped ${stopped} operations for event ${eventId.substring(0, 8)}`);
        totalStopped += stopped;
      }
    }
    
    if (totalStopped === 0) {
      logger.info("[EventHandler] No active operations to stop");
    } else {
      logger.info(`[EventHandler] Total operations stopped: ${totalStopped}`, {
        activeRemaining: llmOpsRegistry.getActiveOperationsCount()
      });
    }
  }

  private handleDefaultEvent(event: NDKEvent): void {
    if (event.content) {
      logger.info(
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
    logger.info("EventHandler cleanup completed");
  }

  /**
   * Check if an event is a brainstorm event
   */
  private isBrainstormEvent(event: NDKEvent): boolean {
    if (event.kind !== NDKKind.Thread) return false;
    
    const modeTags = event.tags.filter(tag => tag[0] === "mode" && tag[1] === "brainstorm");
    return modeTags.length > 0;
  }

  /**
   * Handle a brainstorm event
   */
  private async handleBrainstormEvent(event: NDKEvent): Promise<void> {
    try {
      logger.info("Handling brainstorm event", {
        eventId: event.id?.substring(0, 8),
        content: event.content?.substring(0, 50)
      });

      const projectCtx = getProjectContext();
      const brainstormService = new BrainstormService(projectCtx);
      await brainstormService.start(event);
    } catch (error) {
      logger.error("Failed to handle brainstorm event", {
        eventId: event.id,
        error: formatAnyError(error)
      });
    }
  }
}
