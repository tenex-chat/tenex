import type { ToolExecutionContext } from "@/tools/types";
import { getNDK } from "@/nostr";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { AISdkTool } from "@/tools/types";
import { shortenConversationId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { isHexPrefix, resolvePrefixToId, STORAGE_PREFIX_LENGTH } from "@/utils/nostr-entity-parser";
import { createEventContext } from "@/services/event-context";
import { tool } from "ai";
import { z } from "zod";

/**
 * Checks if a string is a 64-character hex ID.
 */
function isFullHexId(input: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(input.trim());
}

/**
 * Fallback resolver for 10-char hex prefixes when PrefixKVStore is not initialized.
 *
 * This handles edge cases where:
 * 1. MCP-only execution mode - PrefixKVStore may not be initialized in pure MCP contexts
 * 2. Timing races with event indexing - the event may exist in RAL but not yet indexed in KV store
 *
 * Scans RALRegistry.pending and RALRegistry.completed for matching delegation conversation IDs.
 * Returns the full 64-char canonical delegation ID if a unique match is found, null otherwise.
 * Note: Unlike PrefixKVStore, this fallback already canonicalizes followup IDs.
 *
 * @param prefix - 10-character hex prefix to resolve
 * @param ralRegistry - RALRegistry instance to scan
 * @returns Full 64-char canonical delegation ID if unique match found, null otherwise
 */
function resolveFromRALFallback(prefix: string, ralRegistry: RALRegistry): string | null {
  const normalizedPrefix = prefix.toLowerCase();
  return ralRegistry.resolveDelegationPrefix(normalizedPrefix);
}

/**
 * Attempts to resolve a 10-char hex prefix to a full delegation conversation ID.
 * Uses PrefixKVStore first, falls back to RALRegistry scan if needed.
 *
 * IMPORTANT: This function always returns the canonical delegation conversation ID.
 * When PrefixKVStore resolves a followup event ID prefix, the result is canonicalized
 * to the original delegation conversation ID. This ensures consistent behavior across
 * daemon mode (PrefixKVStore available) and MCP-only mode (RAL fallback only).
 *
 * @param prefix - 10-character hex prefix to resolve
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
        followupId: resolved.substring(0, STORAGE_PREFIX_LENGTH),
        canonicalId: canonicalized.substring(0, STORAGE_PREFIX_LENGTH),
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
      prefix: prefix.substring(0, STORAGE_PREFIX_LENGTH),
      resolvedId: fallbackResolved.substring(0, STORAGE_PREFIX_LENGTH),
    });
    return fallbackResolved;
  }

  return null;
}

const delegateFollowupSchema = z.object({
  delegation_conversation_id: z
    .string()
    .describe(
      "The event ID of the delegation conversation. Use the delegationConversationId from the delegate response."
    ),
  message: z.string().describe("Your follow-up question or clarification request"),
});

type DelegateFollowupInput = z.infer<typeof delegateFollowupSchema>;

interface DelegateFollowupOutput {
  success: boolean;
  message: string;
  delegationConversationId: string;
  /** Full event ID of the published follow-up event, used for q-tags in tool_use events */
  delegationEventId: string;
}

async function executeDelegateFollowup(
  input: DelegateFollowupInput,
  context: ToolExecutionContext
): Promise<DelegateFollowupOutput> {
  const { delegation_conversation_id: inputConversationId, message } = input;
  const trimmedConversationId = inputConversationId.trim();

  // Resolve input to full canonical delegation conversation ID.
  // Handles supported input formats: 10-char prefixes and full 64-char hex IDs.
  // All formats are canonicalized to the original delegation conversation ID.
  const ralRegistry = RALRegistry.getInstance();
  let delegation_conversation_id = trimmedConversationId;

  // Step 1: Handle 10-char hex prefix resolution
  if (isHexPrefix(trimmedConversationId)) {
    const resolved = resolveDelegationPrefix(trimmedConversationId);
    if (!resolved) {
      throw new Error(
        `Could not resolve "${trimmedConversationId}" to a delegation conversation event ID. Use the delegationConversationId from the delegate response.`
      );
    }
    delegation_conversation_id = resolved;
  }
  // Step 2: Handle full 64-char hex IDs that might be followup event IDs
  else if (isFullHexId(trimmedConversationId)) {
    const normalized = trimmedConversationId.toLowerCase();
    const canonicalized = ralRegistry.canonicalizeDelegationId(normalized);
    if (canonicalized !== normalized) {
      logger.info("[delegate_followup] Canonicalized full hex followup ID", {
        followupId: normalized.substring(0, STORAGE_PREFIX_LENGTH),
        canonicalId: canonicalized.substring(0, STORAGE_PREFIX_LENGTH),
      });
    }
    delegation_conversation_id = canonicalized;
  }
  // Step 3: Unknown format
  else {
    throw new Error(
      `Invalid delegation conversation event ID: "${trimmedConversationId}". Use the delegationConversationId from delegate.`
    );
  }

  // Find the delegation in conversation storage (persists even after RAL is cleared)
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
  await context.agentPublisher.delegateFollowup({
    recipient: recipientPubkey,
    content: message,
    delegationEventId: delegation_conversation_id,
  }, {
    ...eventContext,
    ralNumber: effectiveRalNumber,
  });

  return {
    success: true,
    message: "Follow-up sent. The agent will respond when ready.",
    delegationConversationId: shortenConversationId(delegation_conversation_id),
    delegationEventId: followupEventId,
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

  return aiTool as AISdkTool;
}
