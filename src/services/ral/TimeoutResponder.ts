import { generateObject } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { z } from "zod";
import { RALRegistry } from "./RALRegistry";
import type { AgentInstance } from "@/agents/types";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { logger } from "@/utils/logger";

const tracer = trace.getTracer("tenex.busy-responder");

const BusyResponseSchema = z.object({
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

/**
 * Generates immediate acknowledgments when messages arrive during active/paused execution.
 * Renamed from TimeoutResponder - no longer uses timeouts, responds immediately.
 */
export class TimeoutResponder {
  private static instance: TimeoutResponder;

  private constructor() {}

  static getInstance(): TimeoutResponder {
    if (!TimeoutResponder.instance) {
      TimeoutResponder.instance = new TimeoutResponder();
    }
    return TimeoutResponder.instance;
  }

  /**
   * Process a message immediately - generates acknowledgment and queues context for resumption.
   * This runs async (fire-and-forget) so it doesn't block the main flow.
   */
  processImmediately(
    agentPubkey: string,
    event: NDKEvent,
    agent: AgentInstance,
    publisher: AgentPublisher
  ): void {
    // Fire and forget - don't await
    this.generateResponse(agentPubkey, event, agent, publisher).catch((error) => {
      logger.error("[TimeoutResponder] Failed to generate busy response", {
        error,
        agentPubkey: agentPubkey.substring(0, 8),
        eventId: event.id?.substring(0, 8),
      });
    });
  }

  /**
   * @deprecated Use processImmediately instead. Kept for backwards compatibility.
   */
  schedule(
    agentPubkey: string,
    event: NDKEvent,
    agent: AgentInstance,
    publisher: AgentPublisher,
    _timeoutMs: number = 5000
  ): void {
    // No more scheduling - process immediately
    this.processImmediately(agentPubkey, event, agent, publisher);
  }

  /**
   * @deprecated No longer needed - responses are immediate
   */
  cancel(_agentPubkey: string, _eventId: string): void {
    // No-op - no more timeouts to cancel
  }

  private async generateResponse(
    agentPubkey: string,
    event: NDKEvent,
    agent: AgentInstance,
    publisher: AgentPublisher
  ): Promise<void> {
    const span = tracer.startSpan("tenex.busy_responder.generate", {
      attributes: {
        "agent.pubkey": agentPubkey,
        "agent.slug": agent.slug,
        "event.id": event.id || "",
        "event.content_length": event.content?.length || 0,
      },
    });

    try {
      const registry = RALRegistry.getInstance();

      // Check if RAL already picked up the message
      if (!registry.eventStillQueued(agentPubkey, event.id!)) {
        span.addEvent("event_already_processed");
        span.setStatus({ code: SpanStatusCode.OK });
        logger.debug("[TimeoutResponder] Event already picked up, skipping", {
          eventId: event.id?.substring(0, 8),
        });
        return;
      }

      const state = registry.getStateByAgent(agentPubkey);
      if (!state) {
        span.addEvent("no_ral_state");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      span.setAttributes({
        "ral.id": state.id,
        "ral.status": state.status,
        "ral.pending_delegations": state.pendingDelegations.length,
      });

      logger.info("[TimeoutResponder] Generating busy response", {
        agentPubkey: agentPubkey.substring(0, 8),
        eventId: event.id?.substring(0, 8),
        ralStatus: state.status,
      });

      span.addEvent("generating_response");

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
        schema: BusyResponseSchema,
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

      span.addEvent("response_generated", {
        "response.stop_current_step": response.object.stop_current_step,
        "response.user_message_length": response.object.message_for_user.length,
        "response.system_message_length": response.object.system_message_for_active_ral.length,
      });

      // Check again - RAL might have picked it up while we were generating
      if (!registry.eventStillQueued(agentPubkey, event.id!)) {
        span.addEvent("event_picked_up_during_generation");
        span.setStatus({ code: SpanStatusCode.OK });
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

      span.addEvent("acknowledgment_published");

      // Swap queued user message -> system message
      registry.swapQueuedEvent(
        agentPubkey,
        event.id!,
        response.object.system_message_for_active_ral
      );

      span.addEvent("event_swapped_to_system_message");

      // Abort current tool if requested
      if (response.object.stop_current_step) {
        registry.abortCurrentTool(agentPubkey);
        span.addEvent("tool_aborted");
      }

      span.setStatus({ code: SpanStatusCode.OK });
      logger.info("[TimeoutResponder] Sent busy response", {
        agentPubkey: agentPubkey.substring(0, 8),
        stopCurrentStep: response.object.stop_current_step,
      });
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      logger.error("[TimeoutResponder] Failed to generate response", {
        error,
        agentPubkey: agentPubkey.substring(0, 8),
      });
      throw error;
    } finally {
      span.end();
    }
  }
}
