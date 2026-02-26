import type { ConversationStore } from "@/conversations/ConversationStore";
import type { EventContext } from "@/nostr/types";
import type { ToolExecutionContext } from "@/tools/types";

export interface CreateEventContextOptions {
    model?: string;
    /** Incremental LLM runtime in milliseconds since last event was published */
    llmRuntime?: number;
}

/**
 * Resolve the correct recipient pubkey for a completion event from the delegation chain.
 *
 * This function looks up the conversation's delegation chain and returns the immediate
 * delegator (second-to-last entry). This ensures completions route back up the delegation
 * stack even when RAL state is lost (e.g., daemon restart) and the triggeringEvent
 * is from a different source (e.g., user responding to an ask).
 *
 * Exception: when the chain origin's pubkey matches the triggering event's pubkey,
 * the caller is interacting directly (not via delegation). In this case the function
 * returns undefined so the caller falls back to triggeringEvent.pubkey, avoiding
 * mis-routing the completion to the intermediate delegator.
 *
 * The delegation chain is persisted in the ConversationStore, so it survives restarts.
 *
 * Architecture note: This function is in services/event-context/ (layer 3) because
 * it imports ConversationStore. AgentEventEncoder (layer 2, in nostr/) cannot import
 * ConversationStore directly - instead, it receives the pre-resolved pubkey via
 * EventContext.completionRecipientPubkey.
 *
 * @param conversationStore - The conversation store (may be undefined in MCP context)
 * @param triggeringEventPubkey - The pubkey of the event that triggered this RAL (optional)
 * @returns The immediate delegator's pubkey, or undefined when:
 *   - no delegation chain exists (or is too short)
 *   - the triggering event pubkey matches the chain origin (direct-interaction case)
 */
export function resolveCompletionRecipient(
    conversationStore: ConversationStore | undefined,
    triggeringEventPubkey?: string
): string | undefined {
    if (!conversationStore) {
        return undefined;
    }

    const delegationChain = conversationStore.metadata?.delegationChain;

    if (delegationChain && delegationChain.length >= 2) {
        // The delegation chain is ordered [origin, ..., delegator, current_agent]
        // We want the second-to-last entry (the immediate delegator)
        const immediateDelegator = delegationChain[delegationChain.length - 2];
        const origin = delegationChain[0];

        // If the chain origin directly triggered this RAL, the delegation is
        // already complete. Route back to them directly (return undefined so
        // the caller falls back to triggeringEvent.pubkey).
        // In ask-resume, the original trigger is RESTORED to the delegator's
        // message, so this condition is never true there.
        if (triggeringEventPubkey && triggeringEventPubkey === origin.pubkey) {
            return undefined;
        }

        return immediateDelegator.pubkey;
    }

    // No delegation chain or chain too short - caller should fall back to triggeringEvent.pubkey
    return undefined;
}

/**
 * Create EventContext for publishing events.
 * Handles missing conversation context gracefully (e.g., in MCP context).
 *
 * For completion events, this function pre-resolves the completion recipient pubkey
 * from the delegation chain stored in ConversationStore. This ensures completions
 * route back to the immediate delegator even when:
 * - RAL state is lost (e.g., daemon restart)
 * - The triggeringEvent is from a different source (e.g., user responding to an ask)
 *
 * When the chain origin directly triggers the RAL (direct-interaction case), the
 * resolved recipient is undefined and the completion routes to the triggering event's
 * pubkey instead (see resolveCompletionRecipient for details).
 */
export function createEventContext(
    context: ToolExecutionContext,
    options?: CreateEventContextOptions | string
): EventContext {
    // Support legacy call signature: createEventContext(context, model)
    const opts: CreateEventContextOptions = typeof options === "string"
        ? { model: options }
        : options ?? {};

    const conversation = context.getConversation?.();
    const rootEventId = conversation?.getRootEventId() ?? context.triggeringEvent?.id;

    // Resolve completion recipient from delegation chain (layer-3 operation)
    // This pre-resolves the pubkey so AgentEventEncoder (layer 2) doesn't need to import ConversationStore
    const completionRecipientPubkey = resolveCompletionRecipient(conversation, context.triggeringEvent?.pubkey);

    return {
        triggeringEvent: context.triggeringEvent,
        rootEvent: rootEventId ? { id: rootEventId } : {},
        conversationId: context.conversationId,
        model: opts.model ?? context.agent.llmConfig,
        ralNumber: context.ralNumber,
        llmRuntime: opts.llmRuntime,
        completionRecipientPubkey,
    };
}
