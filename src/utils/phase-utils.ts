import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "@/agents/execution/types";
import type { EventContext } from "@/nostr/AgentEventEncoder";
import { ThreadedConversationFormatter } from "@/conversations/formatters/ThreadedConversationFormatter";
import { logger } from "./logger";

export interface PhaseContext {
    phase?: string;
    phaseInstructions?: string;
}

/**
 * Extract phase context from triggering event if it contains delegate_phase tags
 */
export function extractPhaseContext(triggeringEvent: NDKEvent): PhaseContext | undefined {
    // Check if this is a phase delegation by looking for the tool tag
    const toolTag = triggeringEvent.tags.find(tag => tag[0] === "tool" && tag[1] === "delegate_phase");
    if (!toolTag) {
        return undefined;
    }

    // Extract phase name from phase tag
    const phaseTag = triggeringEvent.tags.find(tag => tag[0] === "phase");
    if (!phaseTag || !phaseTag[1]) {
        return undefined;
    }

    // Extract phase instructions from phase-instructions tag (optional)
    const phaseInstructionsTag = triggeringEvent.tags.find(tag => tag[0] === "phase-instructions");

    return {
        phase: phaseTag[1],
        phaseInstructions: phaseInstructionsTag?.[1]
    };
}

/**
 * Create EventContext for publishing events
 */
export function createEventContext(
    context: ExecutionContext,
    model?: string
): EventContext {
    const conversation = context.getConversation();
    // Extract phase directly from triggering event if it's a phase delegation
    const phaseContext = extractPhaseContext(context.triggeringEvent);

    return {
        triggeringEvent: context.triggeringEvent,
        rootEvent: conversation?.history[0] ?? context.triggeringEvent,
        conversationId: context.conversationId,
        model: model ?? context.agent.llmConfig,
        phase: phaseContext?.phase
    };
}

/**
 * Format a conversation as a compact string for phase validation.
 * Shows the conversation flow with agents, their messages, and tool executions.
 */
export async function formatConversationSnapshot(context: ExecutionContext): Promise<string> {
  const conversation = context.getConversation();

  if (!conversation) {
    logger.warn("[formatConversationSnapshot] No conversation found in context");
    return "<no conversation history>";
  }

  try {
    const formatter = new ThreadedConversationFormatter();

    // Build the thread tree from conversation history
    const threadTree = await formatter.buildThreadTree(conversation.history);

    if (threadTree.length === 0) {
      return "<empty conversation>";
    }

    // Format with compact options optimized for LLM consumption
    const formatted: string[] = [];

    for (const root of threadTree) {
      const threadString = formatter.formatThread(root, {
        includeTimestamps: false, // Don't need timestamps for phase validation
        timestampFormat: "time-only",
        includeToolCalls: true, // Important to see what tools were used
        treeStyle: "ascii", // Simple ASCII tree
        compactMode: true, // Single-line per message
        currentAgentPubkey: context.agent.pubkey // Mark current agent as "you"
      });
      formatted.push(threadString);
    }

    return formatted.join(`\n\n${"─".repeat(60)}\n\n`);
  } catch (error) {
    logger.error("[formatConversationSnapshot] Failed to format conversation", {
      error: error instanceof Error ? error.message : String(error)
    });
    return "<error formatting conversation>";
  }
}
