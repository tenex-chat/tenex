import type { ToolExecutionContext } from "@/tools/types";
import { getNDK } from "@/nostr";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { AISdkTool } from "@/tools/types";
import { shortenConversationId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { isHexPrefix, resolvePrefixToId, PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
import { createEventContext } from "@/utils/event-context";
import { tool } from "ai";
import { z } from "zod";

/**
 * Fallback resolver for 12-char hex prefixes when PrefixKVStore is not initialized.
 *
 * This handles edge cases where:
 * 1. MCP-only execution mode - PrefixKVStore may not be initialized in pure MCP contexts
 * 2. Timing races with event indexing - the event may exist in RAL but not yet indexed in KV store
 *
 * Scans RALRegistry.pending and RALRegistry.completed for matching delegation conversation IDs.
 * Returns the full 64-char canonical delegation ID if a unique match is found, null otherwise.
 * Note: Unlike PrefixKVStore, this fallback already canonicalizes followup IDs.
 *
 * @param prefix - 12-character hex prefix to resolve
 * @param ralRegistry - RALRegistry instance to scan
 * @returns Full 64-char canonical delegation ID if unique match found, null otherwise
 */
function resolveFromRALFallback(prefix: string, ralRegistry: RALRegistry): string | null {
  const normalizedPrefix = prefix.toLowerCase();
  return ralRegistry.resolveDelegationPrefix(normalizedPrefix);
}

/**
 * Attempts to resolve a 12-char hex prefix to a full delegation conversation ID.
 * Uses PrefixKVStore first, falls back to RALRegistry scan if needed.
 *
 * IMPORTANT: This function always returns the canonical delegation conversation ID.
 * When PrefixKVStore resolves a followup event ID prefix, the result is canonicalized
 * to the original delegation conversation ID. This ensures consistent behavior across
 * daemon mode (PrefixKVStore available) and MCP-only mode (RAL fallback only).
 *
 * @param prefix - 12-character hex prefix to resolve
 * @returns Full 64-char canonical delegation ID or null if not found
 */
function resolveDelegationPrefix(prefix: string): string | null {
  const ralRegistry = RALRegistry.getInstance();

  // Try PrefixKVStore first (primary resolution path)
  const resolved = resolvePrefixToId(prefix);
  if (resolved) {
    // Post-resolution canonicalization: PrefixKVStore may return a followup event ID
    // when the user provides a followup ID prefix. Canonicalize to the original
    // delegation conversation ID for consistent e-tag and routing behavior.
    const canonicalized = ralRegistry.canonicalizeDelegationId(resolved);
    if (canonicalized !== resolved) {
      logger.info("[delegate_followup] Canonicalized followup ID from PrefixKVStore", {
        followupId: resolved.substring(0, PREFIX_LENGTH),
        canonicalId: canonicalized.substring(0, PREFIX_LENGTH),
      });
    }
    return canonicalized;
  }

  // Fallback: scan RALRegistry for matching delegation conversation IDs
  // This handles MCP-only execution mode and timing races with event indexing
  // Note: RAL fallback already canonicalizes followup IDs internally
  const fallbackResolved = resolveFromRALFallback(prefix, ralRegistry);

  if (fallbackResolved) {
    // Use info level - MCP-only execution is an expected deployment mode, not a warning condition.
    // PrefixKVStore may intentionally not be initialized in pure MCP contexts.
    logger.info("[delegate_followup] Resolved prefix via RAL fallback", {
      prefix: prefix.substring(0, PREFIX_LENGTH),
      resolvedId: fallbackResolved.substring(0, PREFIX_LENGTH),
    });
    return fallbackResolved;
  }

  return null;
}

const delegateFollowupSchema = z.object({
  delegation_conversation_id: z
    .string()
    .describe(
      "The ID of the delegation to follow up on. Accepts: delegationConversationId (from delegate response), " +
        "followupEventId (from delegate_followup response), full 64-char hex, 12-char prefix, or NIP-19 formats " +
        "(note1..., nevent1...) with or without 'nostr:' prefix. Followup IDs are automatically canonicalized " +
        "to the original delegation conversation ID."
    ),
  message: z.string().describe("Your follow-up question or clarification request"),
});

type DelegateFollowupInput = z.infer<typeof delegateFollowupSchema>;

interface DelegateFollowupOutput {
  success: boolean;
  message: string;
  delegationConversationId: string;
  followupEventId: string;
}

async function executeDelegateFollowup(
  input: DelegateFollowupInput,
  context: ToolExecutionContext
): Promise<DelegateFollowupOutput> {
  const { delegation_conversation_id: inputConversationId, message } = input;

  // Resolve prefix to full canonical delegation conversation ID if needed.
  // Supports: delegationConversationId, followupEventId, 12-char prefixes, NIP-19 formats.
  // Followup IDs are automatically canonicalized to the original delegation conversation ID.
  let delegation_conversation_id = inputConversationId;
  if (isHexPrefix(inputConversationId)) {
    const resolved = resolveDelegationPrefix(inputConversationId);
    if (!resolved) {
      throw new Error(
        `Could not resolve prefix "${inputConversationId}" to a delegation. Valid inputs include: ` +
          "delegationConversationId (from delegate response), followupEventId (from delegate_followup response), " +
          "full 64-char hex IDs, 12-char prefixes, or NIP-19 formats (note1..., nevent1...) with or without 'nostr:' prefix. " +
          "The prefix may be ambiguous or no matching delegation was found."
      );
    }
    delegation_conversation_id = resolved;
  }

  // Find the delegation in conversation storage (persists even after RAL is cleared)
  const ralRegistry = RALRegistry.getInstance();
  const delegationInfo = ralRegistry.findDelegation(delegation_conversation_id);

  let recipientPubkey = delegationInfo?.pending?.recipientPubkey ?? delegationInfo?.completed?.recipientPubkey;

  // Fall back to NDK fetch if not found locally (e.g., external delegations or stale state)
  if (!recipientPubkey) {
    const ndk = getNDK();
    const delegationEvent = await ndk.fetchEvent(delegation_conversation_id);

    if (!delegationEvent) {
      throw new Error(
        `Could not fetch delegation conversation ${delegation_conversation_id}. Check the delegationConversationIds from your delegate call.`
      );
    }

    recipientPubkey = delegationEvent.tagValue("p") ?? undefined;
  }

  if (!recipientPubkey) {
    throw new Error(
      `Delegation conversation ${delegation_conversation_id} has no recipient. Cannot determine who to send follow-up to.`
    );
  }

  // Always use the CURRENT RAL number from context.
  // The delegation's stored ralNumber refers to the RAL that created it, which may have
  // been cleared since then. We need to register on the CURRENT RAL so it resumes correctly.
  const effectiveRalNumber = context.ralNumber;

  logger.info("[delegate_followup] Publishing follow-up", {
    fromAgent: context.agent.slug,
    delegationConversationId: delegation_conversation_id,
    recipientPubkey: recipientPubkey.substring(0, 8),
  });

  const eventContext = createEventContext(context);
  const followupEventId = await context.agentPublisher.delegateFollowup({
    recipient: recipientPubkey,
    content: message,
    delegationEventId: delegation_conversation_id,
  }, eventContext);

  // Register the followup as a pending delegation for response routing
  // Use atomic merge to safely handle concurrent delegation calls
  // Note: followup delegations use the same delegationConversationId as the original,
  // but include the followupEventId for routing responses to the new event
  const newDelegation = {
    type: "followup" as const,
    delegationConversationId: delegation_conversation_id,
    recipientPubkey,
    senderPubkey: context.agent.pubkey,
    prompt: message,
    followupEventId,
    ralNumber: effectiveRalNumber,
  };

  // Use atomic merge - this handles concurrent updates safely and merges
  // the followupEventId into existing entries instead of dropping them
  ralRegistry.mergePendingDelegations(
    context.agent.pubkey,
    context.conversationId,
    effectiveRalNumber,
    [newDelegation]
  );

  // Return normal result - agent continues without blocking
  return {
    success: true,
    message: "Follow-up sent. The agent will respond when ready.",
    delegationConversationId: shortenConversationId(delegation_conversation_id),
    followupEventId, // Keep full event ID - this is a Nostr event ID, not a conversation ID
  };
}

export function createDelegateFollowupTool(context: ToolExecutionContext): AISdkTool {
  const aiTool = tool({
    description:
      "Send a follow-up question to an agent you previously delegated to. Use after delegate to ask clarifying questions about their response.",
    inputSchema: delegateFollowupSchema,
    execute: async (input: DelegateFollowupInput) => {
      return await executeDelegateFollowup(input, context);
    },
  });

  Object.defineProperty(aiTool, "getHumanReadableContent", {
    value: () => "Sending follow-up question",
    enumerable: false,
    configurable: true,
  });

  return aiTool as AISdkTool;
}
