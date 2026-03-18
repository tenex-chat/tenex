import type { ConversationStore } from "@/conversations/ConversationStore";
import type { PrincipalRef } from "@/events/runtime/InboundEnvelope";
import type { EventContext } from "@/nostr/types";
import type { ToolExecutionContext } from "@/tools/types";

export interface CreateEventContextOptions {
    model?: string;
    /** Incremental LLM runtime in milliseconds since last event was published */
    llmRuntime?: number;
}

function fallbackPrincipalFromTriggeringEnvelope(
    envelope: ToolExecutionContext["triggeringEnvelope"]
): PrincipalRef {
    return {
        id: envelope.principal.id,
        transport: envelope.principal.transport,
        linkedPubkey: envelope.principal.linkedPubkey,
        displayName: envelope.principal.displayName,
        username: envelope.principal.username,
        kind: envelope.principal.kind,
    };
}

/**
 * Resolve the correct recipient pubkey for a completion event from the delegation chain.
 *
 * This function looks up the conversation's delegation chain and returns the immediate
 * delegator (second-to-last entry). This ensures completions route back up the delegation
 * stack even when RAL state is lost (e.g., daemon restart) and the triggeringEnvelope
 * is from a different source (e.g., user responding to an ask).
 *
 * Exception: when the chain origin's pubkey matches the triggering event's pubkey,
 * the caller is interacting directly (not via delegation). In this case the function
 * returns undefined so the caller falls back to triggeringEnvelope.pubkey, avoiding
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
        // the caller falls back to triggeringEnvelope.pubkey).
        // In ask-resume, the original trigger is RESTORED to the delegator's
        // message, so this condition is never true there.
        if (triggeringEventPubkey && triggeringEventPubkey === origin.pubkey) {
            return undefined;
        }

        return immediateDelegator.pubkey;
    }

    // No delegation chain or chain too short - caller should fall back to triggeringEnvelope.pubkey
    return undefined;
}

export function resolveCompletionRecipientPrincipal(
    conversationStore: ConversationStore | undefined,
    triggeringEnvelope: ToolExecutionContext["triggeringEnvelope"] | undefined
): PrincipalRef | undefined {
    if (!triggeringEnvelope) {
        return undefined;
    }

    const fallbackPrincipal = fallbackPrincipalFromTriggeringEnvelope(triggeringEnvelope);

    if (!conversationStore) {
        return fallbackPrincipal;
    }

    const delegationChain = conversationStore.metadata?.delegationChain;
    if (delegationChain && delegationChain.length >= 2) {
        const immediateDelegator = delegationChain[delegationChain.length - 2];
        const origin = delegationChain[0];

        if (triggeringEnvelope.principal.linkedPubkey !== origin.pubkey) {
            return {
                id: `nostr:${immediateDelegator.pubkey}`,
                transport: "nostr",
                linkedPubkey: immediateDelegator.pubkey,
                displayName: immediateDelegator.displayName,
                kind: immediateDelegator.isUser ? "human" : "agent",
            };
        }
    }

    if (typeof conversationStore.getAllMessages !== "function") {
        return fallbackPrincipal;
    }

    const messages = conversationStore.getAllMessages();
    let triggeringMessage = undefined;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.eventId === triggeringEnvelope.message.nativeId) {
            triggeringMessage = message;
            break;
        }
    }

    return triggeringMessage?.senderPrincipal ?? fallbackPrincipal;
}

/**
 * Create EventContext for publishing events.
 * Handles missing conversation context gracefully (e.g., in MCP context).
 *
 * For completion events, this function pre-resolves the completion recipient pubkey
 * from the delegation chain stored in ConversationStore. This ensures completions
 * route back to the immediate delegator even when:
 * - RAL state is lost (e.g., daemon restart)
 * - The triggeringEnvelope is from a different source (e.g., user responding to an ask)
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
    const rootEventId = conversation?.getRootEventId() ?? context.triggeringEnvelope.message.nativeId;

    // Resolve completion recipient from delegation chain (layer-3 operation)
    // This pre-resolves the pubkey so AgentEventEncoder (layer 2) doesn't need to import ConversationStore
    const completionRecipientPubkey = resolveCompletionRecipient(
        conversation,
        context.triggeringEnvelope.principal.linkedPubkey
    );
    const completionRecipientPrincipal = resolveCompletionRecipientPrincipal(
        conversation,
        context.triggeringEnvelope
    );

    return {
        triggeringEnvelope: context.triggeringEnvelope,
        rootEvent: rootEventId ? { id: rootEventId } : {},
        conversationId: context.conversationId,
        model: opts.model ?? context.agent.llmConfig,
        ralNumber: context.ralNumber,
        llmRuntime: opts.llmRuntime,
        completionRecipientPubkey,
        completionRecipientPrincipal,
    };
}
