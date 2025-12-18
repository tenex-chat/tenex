import { generateObject } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { z } from "zod";
import { RALRegistry } from "./RALRegistry";
import type { AgentInstance } from "@/agents/types";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { logger } from "@/utils/logger";

const TimeoutResponseSchema = z.object({
  message_for_user: z.string().describe(
    "Response to send to the user now, acknowledging their message"
  ),
  system_message_for_active_ral: z.string().describe(
    "Context note for your main execution to see when it resumes"
  ),
  stop_current_step: z.boolean().describe(
    "true to abort the current tool execution immediately, false to let it finish"
  ),
});

export class TimeoutResponder {
  private static instance: TimeoutResponder;
  private pendingTimeouts: Map<string, NodeJS.Timeout> = new Map();

  private constructor() {}

  static getInstance(): TimeoutResponder {
    if (!TimeoutResponder.instance) {
      TimeoutResponder.instance = new TimeoutResponder();
    }
    return TimeoutResponder.instance;
  }

  /**
   * Schedule a timeout response for a queued event
   */
  schedule(
    agentPubkey: string,
    event: NDKEvent,
    agent: AgentInstance,
    publisher: AgentPublisher,
    timeoutMs: number = 5000
  ): void {
    const key = `${agentPubkey}:${event.id}`;

    // Clear any existing timeout for this event
    const existing = this.pendingTimeouts.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(
      () => this.handleTimeout(agentPubkey, event, agent, publisher),
      timeoutMs
    );

    this.pendingTimeouts.set(key, timeout);

    logger.debug("[TimeoutResponder] Scheduled timeout", {
      agentPubkey: agentPubkey.substring(0, 8),
      eventId: event.id?.substring(0, 8),
      timeoutMs,
    });
  }

  /**
   * Cancel a pending timeout (called when RAL picks up the event)
   */
  cancel(agentPubkey: string, eventId: string): void {
    const key = `${agentPubkey}:${eventId}`;
    const timeout = this.pendingTimeouts.get(key);
    if (timeout) {
      clearTimeout(timeout);
      this.pendingTimeouts.delete(key);
    }
  }

  private async handleTimeout(
    agentPubkey: string,
    event: NDKEvent,
    agent: AgentInstance,
    publisher: AgentPublisher
  ): Promise<void> {
    const registry = RALRegistry.getInstance();

    // Check if RAL already picked up the message
    if (!registry.eventStillQueued(agentPubkey, event.id!)) {
      logger.debug("[TimeoutResponder] Event already picked up, skipping", {
        eventId: event.id?.substring(0, 8),
      });
      return;
    }

    const state = registry.getStateByAgent(agentPubkey);
    if (!state) return;

    logger.info("[TimeoutResponder] Generating timeout response", {
      agentPubkey: agentPubkey.substring(0, 8),
      eventId: event.id?.substring(0, 8),
    });

    try {
      // Get model from agent's LLM service
      const llmService = agent.createLLMService({});
      const model = llmService.getModel();

      const summary = registry.getStateSummary(agentPubkey);

      // Build system prompt from agent properties
      const systemPromptParts: string[] = [];
      if (agent.role) {
        systemPromptParts.push(`Role: ${agent.role}`);
      }
      if (agent.description) {
        systemPromptParts.push(`Description: ${agent.description}`);
      }
      if (agent.customInstructions) {
        systemPromptParts.push(`\nInstructions:\n${agent.customInstructions}`);
      }
      const systemPrompt = systemPromptParts.join("\n\n");

      const response = await generateObject({
        model,
        schema: TimeoutResponseSchema,
        system: systemPrompt,
        messages: [
          ...state.messages,
          {
            role: "system" as const,
            content: `
EXECUTION CONTEXT:
You are mid-execution and cannot immediately process new messages.
${summary}

A user message just arrived but you're busy. Generate:
1. A brief acknowledgment for the user
2. A context note for when you resume
3. Whether to abort current work (true) or let it finish (false)
            `.trim(),
          },
          {
            role: "user" as const,
            content: event.content,
          },
        ],
      });

      // Check again - RAL might have picked it up while we were generating
      if (!registry.eventStillQueued(agentPubkey, event.id!)) {
        logger.debug("[TimeoutResponder] Event picked up during generation", {
          eventId: event.id?.substring(0, 8),
        });
        return;
      }

      // Publish acknowledgment to user
      await publisher.conversation(
        { content: response.object.message_for_user },
        {
          triggeringEvent: event,
          rootEvent: event,
          conversationId: event.id!,
        }
      );

      // Swap queued user message -> system message
      registry.swapQueuedEvent(
        agentPubkey,
        event.id!,
        response.object.system_message_for_active_ral
      );

      // Abort current tool if requested
      if (response.object.stop_current_step) {
        registry.abortCurrentTool(agentPubkey);
      }

      logger.info("[TimeoutResponder] Sent timeout response", {
        agentPubkey: agentPubkey.substring(0, 8),
        stopCurrentStep: response.object.stop_current_step,
      });
    } catch (error) {
      logger.error("[TimeoutResponder] Failed to generate response", {
        error,
        agentPubkey: agentPubkey.substring(0, 8),
      });
    } finally {
      this.pendingTimeouts.delete(`${agentPubkey}:${event.id}`);
    }
  }
}
