import { trace } from "@opentelemetry/api";
import type {
  RALRegistryEntry,
  PendingDelegation,
  CompletedDelegation,
  DelegationMessage,
  PendingSubDelegationRef,
  DeferredCompletion,
} from "./types";
import { shortenConversationId, shortenEventId, shortenPubkey } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";

export interface ConversationDelegations {
  pending: Map<string, PendingDelegation>;
  completed: Map<string, CompletedDelegation>;
}

interface DelegationRegistryDeps {
  getRAL: (agentPubkey: string, conversationId: string, ralNumber: number) => RALRegistryEntry | undefined;
  incrementDelegationCounter: (
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ) => void;
  decrementDelegationCounter: (
    agentPubkey: string,
    conversationId: string,
    ralNumber: number
  ) => void;
}

type DelegationLocation = { key: string; ralNumber: number };

/**
 * DelegationRegistry - manages pending/completed delegation bookkeeping.
 */
export class DelegationRegistry {
  private readonly conversationDelegations: Map<string, ConversationDelegations> = new Map();
  private readonly delegationToRal: Map<string, DelegationLocation> = new Map();
  private readonly followupToCanonical: Map<string, string> = new Map();

  constructor(private readonly deps: DelegationRegistryDeps) {}

  get conversationDelegationsMap(): Map<string, ConversationDelegations> {
    return this.conversationDelegations;
  }

  get delegationToRalMap(): Map<string, DelegationLocation> {
    return this.delegationToRal;
  }

  get followupToCanonicalMap(): Map<string, string> {
    return this.followupToCanonical;
  }

  getConversationDelegationState(key: string): ConversationDelegations | undefined {
    return this.conversationDelegations.get(key);
  }

  setConversationDelegationState(key: string, state: ConversationDelegations): void {
    this.conversationDelegations.set(key, state);
  }

  deleteConversationDelegationState(key: string): void {
    this.conversationDelegations.delete(key);
  }

  clearAll(): void {
    this.conversationDelegations.clear();
    this.delegationToRal.clear();
    this.followupToCanonical.clear();
  }

  clearConversation(agentPubkey: string, conversationId: string): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const convDelegations = this.conversationDelegations.get(key);
    if (convDelegations) {
      for (const [id, d] of convDelegations.pending) {
        this.delegationToRal.delete(id);
        if (d.type === "followup" && d.followupEventId) {
          this.delegationToRal.delete(d.followupEventId);
          this.followupToCanonical.delete(d.followupEventId);
        }
        this.removePendingSubDelegationFromAnyParent(id);
      }
      for (const id of convDelegations.completed.keys()) {
        this.delegationToRal.delete(id);
        this.removePendingSubDelegationFromAnyParent(id);
      }
      this.conversationDelegations.delete(key);
    }
  }

  getConversationPendingDelegations(
    agentPubkey: string,
    conversationId: string,
    ralNumber?: number
  ): PendingDelegation[] {
    const key = this.makeKey(agentPubkey, conversationId);
    const delegations = this.conversationDelegations.get(key);
    if (!delegations) return [];
    const pending = Array.from(delegations.pending.values());
    return ralNumber !== undefined ? pending.filter((d) => d.ralNumber === ralNumber) : pending;
  }

  getConversationCompletedDelegations(
    agentPubkey: string,
    conversationId: string,
    ralNumber?: number
  ): CompletedDelegation[] {
    const key = this.makeKey(agentPubkey, conversationId);
    const delegations = this.conversationDelegations.get(key);
    if (!delegations) return [];
    const completed = Array.from(delegations.completed.values());
    return ralNumber !== undefined ? completed.filter((d) => d.ralNumber === ralNumber) : completed;
  }

  registerPendingSubDelegation(
    parentDelegationConversationId: string,
    subDelegation: PendingDelegation
  ): boolean {
    const location = this.delegationToRal.get(parentDelegationConversationId);
    if (!location) {
      return false;
    }

    const [agentPubkey, conversationId] = location.key.split(":");
    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) {
      return false;
    }

    const canonicalParentId = this.followupToCanonical.get(parentDelegationConversationId)
      ?? parentDelegationConversationId;
    const parentDelegation = convDelegations.pending.get(canonicalParentId);
    if (!parentDelegation) {
      return false;
    }

    const existingSubDelegations = parentDelegation.pendingSubDelegations ?? [];
    if (existingSubDelegations.some((delegation) => delegation.delegationConversationId === subDelegation.delegationConversationId)) {
      return true;
    }

    parentDelegation.pendingSubDelegations = [
      ...existingSubDelegations,
      {
        delegationConversationId: subDelegation.delegationConversationId,
        type: subDelegation.type ?? "standard",
      } satisfies PendingSubDelegationRef,
    ];

    const ral = this.deps.getRAL(agentPubkey, conversationId, location.ralNumber);
    if (ral) {
      ral.lastActivityAt = Date.now();
    }

    trace.getActiveSpan()?.addEvent("ral.pending_subdelegation_registered", {
      "delegation.parent_conversation_id": shortenConversationId(parentDelegationConversationId),
      "delegation.sub_conversation_id": shortenConversationId(subDelegation.delegationConversationId),
      "ral.number": location.ralNumber,
    });

    return true;
  }

  clearPendingSubDelegation(
    parentDelegationConversationId: string,
    subDelegationConversationId: string
  ): { agentPubkey: string; conversationId: string; ralNumber: number } | undefined {
    const location = this.delegationToRal.get(parentDelegationConversationId);
    if (!location) {
      return undefined;
    }

    const [agentPubkey, conversationId] = location.key.split(":");
    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) {
      return undefined;
    }

    const canonicalParentId = this.followupToCanonical.get(parentDelegationConversationId)
      ?? parentDelegationConversationId;
    const parentDelegation = convDelegations.pending.get(canonicalParentId);
    if (!parentDelegation?.pendingSubDelegations?.length) {
      return undefined;
    }

    const nextSubDelegations = parentDelegation.pendingSubDelegations.filter(
      (delegation) => delegation.delegationConversationId !== subDelegationConversationId
    );

    if (nextSubDelegations.length === parentDelegation.pendingSubDelegations.length) {
      return undefined;
    }

    parentDelegation.pendingSubDelegations = nextSubDelegations.length > 0
      ? nextSubDelegations
      : undefined;

    const ral = this.deps.getRAL(agentPubkey, conversationId, location.ralNumber);
    if (ral) {
      ral.lastActivityAt = Date.now();
    }

    trace.getActiveSpan()?.addEvent("ral.pending_subdelegation_cleared", {
      "delegation.parent_conversation_id": shortenConversationId(parentDelegationConversationId),
      "delegation.sub_conversation_id": shortenConversationId(subDelegationConversationId),
      "ral.number": location.ralNumber,
    });

    if (
      parentDelegation.pendingSubDelegations === undefined &&
      parentDelegation.deferredCompletion &&
      !parentDelegation.killed
    ) {
      const deferredCompletion = parentDelegation.deferredCompletion;
      parentDelegation.deferredCompletion = undefined;
      return this.finalizeDeferredCompletion({
        agentPubkey,
        conversationId,
        ralNumber: location.ralNumber,
        delegationConversationId: canonicalParentId,
        pendingDelegation: parentDelegation,
        deferredCompletion,
      });
    }

    return undefined;
  }

  private removePendingSubDelegationFromAnyParent(subDelegationConversationId: string): boolean {
    let removed = false;

    for (const delegations of this.conversationDelegations.values()) {
      for (const pendingDelegation of delegations.pending.values()) {
        if (!pendingDelegation.pendingSubDelegations?.length) {
          continue;
        }

        const nextChildren = pendingDelegation.pendingSubDelegations.filter(
          (delegation) => delegation.delegationConversationId !== subDelegationConversationId
        );

        if (nextChildren.length === pendingDelegation.pendingSubDelegations.length) {
          continue;
        }

        pendingDelegation.pendingSubDelegations = nextChildren.length > 0 ? nextChildren : undefined;
        removed = true;
      }
    }

    return removed;
  }

  private finalizeDeferredCompletion(params: {
    agentPubkey: string;
    conversationId: string;
    ralNumber: number;
    delegationConversationId: string;
    pendingDelegation: PendingDelegation;
    deferredCompletion: DeferredCompletion;
  }): { agentPubkey: string; conversationId: string; ralNumber: number } | undefined {
    const {
      agentPubkey,
      conversationId,
      ralNumber,
      delegationConversationId,
      pendingDelegation,
      deferredCompletion,
    } = params;

    const key = this.makeKey(agentPubkey, conversationId);
    const convDelegations = this.conversationDelegations.get(key);
    if (!convDelegations) {
      return undefined;
    }

    const existingCompletion = convDelegations.completed.get(delegationConversationId);
    if (existingCompletion) {
      if (deferredCompletion.fullTranscript) {
        existingCompletion.transcript = deferredCompletion.fullTranscript;
      } else {
        existingCompletion.transcript = [
          {
            senderPubkey: pendingDelegation.senderPubkey,
            recipientPubkey: pendingDelegation.recipientPubkey,
            content: pendingDelegation.prompt,
            timestamp: deferredCompletion.completedAt - 1,
          },
          {
            senderPubkey: deferredCompletion.recipientPubkey,
            recipientPubkey: pendingDelegation.senderPubkey,
            content: deferredCompletion.response,
            timestamp: deferredCompletion.completedAt,
          },
        ];
      }

      existingCompletion.ralNumber = pendingDelegation.ralNumber;
    } else {
      const transcript: DelegationMessage[] = deferredCompletion.fullTranscript ?? [
        {
          senderPubkey: pendingDelegation.senderPubkey,
          recipientPubkey: pendingDelegation.recipientPubkey,
          content: pendingDelegation.prompt,
          timestamp: deferredCompletion.completedAt - 1,
        },
        {
          senderPubkey: deferredCompletion.recipientPubkey,
          recipientPubkey: pendingDelegation.senderPubkey,
          content: deferredCompletion.response,
          timestamp: deferredCompletion.completedAt,
        },
      ];

      convDelegations.completed.set(delegationConversationId, {
        delegationConversationId,
        recipientPubkey: deferredCompletion.recipientPubkey,
        senderPubkey: pendingDelegation.senderPubkey,
        ralNumber: pendingDelegation.ralNumber,
        transcript,
        completedAt: deferredCompletion.completedAt,
        status: "completed",
      });
    }

    convDelegations.pending.delete(delegationConversationId);
    this.deps.decrementDelegationCounter(agentPubkey, conversationId, ralNumber);

    const ral = this.deps.getRAL(agentPubkey, conversationId, ralNumber);
    if (ral) {
      ral.lastActivityAt = Date.now();
    }

    trace.getActiveSpan()?.addEvent("ral.deferred_completion_released", {
      "ral.number": ralNumber,
      "delegation.conversation_id": shortenConversationId(delegationConversationId),
    });

    return { agentPubkey, conversationId, ralNumber };
  }

  clearCompletedDelegations(agentPubkey: string, conversationId: string, ralNumber?: number): void {
    const key = this.makeKey(agentPubkey, conversationId);
    const delegations = this.conversationDelegations.get(key);
    if (!delegations) return;

    if (ralNumber !== undefined) {
      for (const [id, completion] of delegations.completed) {
        if (completion.ralNumber === ralNumber) {
          this.delegationToRal.delete(id);
          delegations.completed.delete(id);
        }
      }
    } else {
      for (const id of delegations.completed.keys()) {
        this.delegationToRal.delete(id);
      }
      delegations.completed.clear();
    }

    trace.getActiveSpan()?.addEvent("ral.completed_delegations_cleared", {
      "conversation.id": shortenConversationId(conversationId),
      "ral.number": ralNumber ?? "all",
    });
  }

  mergePendingDelegations(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    newDelegations: PendingDelegation[]
  ): { insertedCount: number; mergedCount: number } {
    const ral = this.deps.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) {
      logger.warn("[RALRegistry] No RAL found to merge pending delegations", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
      });
      return { insertedCount: 0, mergedCount: 0 };
    }

    const key = this.makeKey(agentPubkey, conversationId);
    const convDelegations = this.getOrCreateConversationDelegations(key);
    ral.lastActivityAt = Date.now();

    let insertedCount = 0;
    let mergedCount = 0;

    for (const d of newDelegations) {
      const existing = convDelegations.pending.get(d.delegationConversationId);

      if (existing) {
        const merged: PendingDelegation = {
          ...existing,
          ...d,
          ralNumber,
        };
        convDelegations.pending.set(d.delegationConversationId, merged);
        this.delegationToRal.set(d.delegationConversationId, { key, ralNumber });

        if (merged.type === "followup" && merged.followupEventId) {
          this.delegationToRal.set(merged.followupEventId, { key, ralNumber });
          this.followupToCanonical.set(merged.followupEventId, d.delegationConversationId);
        }

        mergedCount++;
      } else {
        const delegation = { ...d, ralNumber };
        convDelegations.pending.set(d.delegationConversationId, delegation);
        this.delegationToRal.set(d.delegationConversationId, { key, ralNumber });

        if (d.type === "followup" && d.followupEventId) {
          this.delegationToRal.set(d.followupEventId, { key, ralNumber });
          this.followupToCanonical.set(d.followupEventId, d.delegationConversationId);
        }

        this.deps.incrementDelegationCounter(agentPubkey, conversationId, ralNumber);
        insertedCount++;
      }
    }

    trace.getActiveSpan()?.addEvent("ral.delegations_merged", {
      "ral.id": ral.id,
      "ral.number": ralNumber,
      "delegation.inserted_count": insertedCount,
      "delegation.merged_count": mergedCount,
      "delegation.total_pending": convDelegations.pending.size,
    });

    return { insertedCount, mergedCount };
  }

  setPendingDelegations(
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    pendingDelegations: PendingDelegation[]
  ): void {
    const ral = this.deps.getRAL(agentPubkey, conversationId, ralNumber);
    if (!ral) {
      logger.warn("[RALRegistry] No RAL found to set pending delegations", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
      });
      return;
    }

    const key = this.makeKey(agentPubkey, conversationId);
    const convDelegations = this.getOrCreateConversationDelegations(key);
    ral.lastActivityAt = Date.now();

    for (const [id, d] of convDelegations.pending) {
      if (d.ralNumber === ralNumber) {
        convDelegations.pending.delete(id);
        this.delegationToRal.delete(id);
        if (d.type === "followup" && d.followupEventId) {
          this.delegationToRal.delete(d.followupEventId);
          this.followupToCanonical.delete(d.followupEventId);
        }
      }
    }

    for (const d of pendingDelegations) {
      const delegation = { ...d, ralNumber };
      convDelegations.pending.set(d.delegationConversationId, delegation);
      this.delegationToRal.set(d.delegationConversationId, { key, ralNumber });

      if (d.type === "followup" && d.followupEventId) {
        this.delegationToRal.set(d.followupEventId, { key, ralNumber });
        this.followupToCanonical.set(d.followupEventId, d.delegationConversationId);
      }
    }

    trace.getActiveSpan()?.addEvent("ral.delegations_set", {
      "ral.id": ral.id,
      "ral.number": ralNumber,
      "delegation.pending_count": pendingDelegations.length,
    });
  }

  recordCompletion(completion: {
    delegationConversationId: string;
    recipientPubkey: string;
    response: string;
    completedAt: number;
    fullTranscript?: DelegationMessage[];
  }): { agentPubkey: string; conversationId: string; ralNumber: number; deferred?: boolean } | undefined {
    const location = this.delegationToRal.get(completion.delegationConversationId);
    if (!location) return undefined;

    const [agentPubkey, conversationId] = location.key.split(":");
    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) return undefined;

    const canonicalId = this.followupToCanonical.get(completion.delegationConversationId)
      ?? completion.delegationConversationId;

    const pendingDelegation = convDelegations.pending.get(canonicalId);
    if (!pendingDelegation) {
      logger.warn("[RALRegistry] No pending delegation found for completion", {
        delegationConversationId: completion.delegationConversationId.substring(0, 8),
      });
      return undefined;
    }

    if (pendingDelegation.killed) {
      trace.getActiveSpan()?.addEvent("ral.completion_rejected_killed", {
        "delegation.conversation_id": shortenConversationId(canonicalId),
        "delegation.killed_at": pendingDelegation.killedAt,
      });
      logger.info("[RALRegistry.recordCompletion] Rejected completion - delegation was killed", {
        delegationConversationId: shortenConversationId(canonicalId),
        killedAt: pendingDelegation.killedAt,
      });
      return undefined;
    }

    if (completion.recipientPubkey !== pendingDelegation.recipientPubkey) {
      logger.debug("[RALRegistry] Ignoring completion - sender is not the delegatee", {
        delegationConversationId: completion.delegationConversationId.substring(0, 8),
        expectedRecipient: pendingDelegation.recipientPubkey.substring(0, 8),
        actualSender: completion.recipientPubkey.substring(0, 8),
      });
      return undefined;
    }

    const ral = this.deps.getRAL(agentPubkey, conversationId, location.ralNumber);
    if (ral) {
      ral.lastActivityAt = Date.now();
    }

    const pendingSubDelegations = pendingDelegation.pendingSubDelegations ?? [];
    if (pendingSubDelegations.length > 0) {
      pendingDelegation.deferredCompletion = {
        recipientPubkey: completion.recipientPubkey,
        response: completion.response,
        completedAt: completion.completedAt,
        fullTranscript: completion.fullTranscript,
      };

      trace.getActiveSpan()?.addEvent("ral.completion_deferred_pending_subdelegations", {
        "ral.id": ral?.id,
        "ral.number": location.ralNumber,
        "delegation.completed_conversation_id": shortenConversationId(completion.delegationConversationId),
        "delegation.pending_subdelegations": pendingSubDelegations.length,
      });

      return {
        agentPubkey,
        conversationId,
        ralNumber: location.ralNumber,
        deferred: true,
      };
    }

    const existingCompletion = convDelegations.completed.get(canonicalId);

    if (existingCompletion) {
      if (completion.fullTranscript) {
        existingCompletion.transcript = completion.fullTranscript;
      } else {
        existingCompletion.transcript.push({
          senderPubkey: pendingDelegation.senderPubkey,
          recipientPubkey: pendingDelegation.recipientPubkey,
          content: pendingDelegation.prompt,
          timestamp: completion.completedAt - 1,
        });
        existingCompletion.transcript.push({
          senderPubkey: completion.recipientPubkey,
          recipientPubkey: pendingDelegation.senderPubkey,
          content: completion.response,
          timestamp: completion.completedAt,
        });
      }

      existingCompletion.ralNumber = pendingDelegation.ralNumber;

      trace.getActiveSpan()?.addEvent("ral.followup_response_appended", {
        "ral.id": ral?.id,
        "ral.number": location.ralNumber,
        "delegation.completed_conversation_id": shortenConversationId(completion.delegationConversationId),
        "delegation.transcript_length": existingCompletion.transcript.length,
      });
    } else {
      const transcript: DelegationMessage[] = completion.fullTranscript ?? [
        {
          senderPubkey: pendingDelegation.senderPubkey,
          recipientPubkey: pendingDelegation.recipientPubkey,
          content: pendingDelegation.prompt,
          timestamp: completion.completedAt - 1,
        },
        {
          senderPubkey: completion.recipientPubkey,
          recipientPubkey: pendingDelegation.senderPubkey,
          content: completion.response,
          timestamp: completion.completedAt,
        },
      ];

      convDelegations.completed.set(canonicalId, {
        delegationConversationId: canonicalId,
        recipientPubkey: completion.recipientPubkey,
        senderPubkey: pendingDelegation.senderPubkey,
        ralNumber: pendingDelegation.ralNumber,
        transcript,
        completedAt: completion.completedAt,
        status: "completed",
      });

      const remainingPending = this.getConversationPendingDelegations(
        agentPubkey,
        conversationId,
        location.ralNumber
      ).length - 1;
      trace.getActiveSpan()?.addEvent("ral.completion_recorded", {
        "ral.id": ral?.id,
        "ral.number": location.ralNumber,
        "delegation.completed_conversation_id": shortenConversationId(completion.delegationConversationId),
        "delegation.remaining_pending": remainingPending,
      });
    }

    convDelegations.pending.delete(canonicalId);

    let completionLocation = { agentPubkey, conversationId, ralNumber: location.ralNumber };

    if (pendingDelegation.parentDelegationConversationId) {
      const deferredCompletionLocation = this.clearPendingSubDelegation(
        pendingDelegation.parentDelegationConversationId,
        canonicalId
      );
      if (deferredCompletionLocation) {
        completionLocation = deferredCompletionLocation;
      }
    }

    this.deps.decrementDelegationCounter(agentPubkey, conversationId, location.ralNumber);

    return completionLocation;
  }

  resolveDelegationPrefix(prefix: string): string | null {
    const matches: string[] = [];

    for (const [_key, delegations] of this.conversationDelegations) {
      for (const [delegationId] of delegations.pending) {
        if (delegationId.toLowerCase().startsWith(prefix)) {
          matches.push(delegationId);
        }
      }

      for (const [delegationId] of delegations.completed) {
        if (delegationId.toLowerCase().startsWith(prefix)) {
          if (!matches.includes(delegationId)) {
            matches.push(delegationId);
          }
        }
      }
    }

    for (const [followupId, canonicalId] of this.followupToCanonical) {
      if (followupId.toLowerCase().startsWith(prefix)) {
        if (!matches.includes(canonicalId)) {
          matches.push(canonicalId);
        }
      }
    }

    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      logger.debug("[RALRegistry.resolveDelegationPrefix] Ambiguous prefix match", {
        prefix,
        matchCount: matches.length,
      });
    }

    return null;
  }

  canonicalizeDelegationId(id: string): string {
    const fromMap = this.followupToCanonical.get(id);
    if (fromMap) {
      return fromMap;
    }

    const normalizedId = id.toLowerCase();
    for (const [_key, delegations] of this.conversationDelegations) {
      for (const [canonicalId, pending] of delegations.pending) {
        if (pending.type === "followup" && pending.followupEventId?.toLowerCase() === normalizedId) {
          logger.debug("[RALRegistry.canonicalizeDelegationId] Found canonical via pending scan", {
            followupId: shortenEventId(id),
            canonicalId: shortenConversationId(canonicalId),
          });
          return canonicalId;
        }
      }
    }

    return id;
  }

  findDelegation(delegationEventId: string): {
    pending?: PendingDelegation;
    completed?: CompletedDelegation;
    agentPubkey: string;
    conversationId: string;
    ralNumber: number;
  } | undefined {
    const location = this.delegationToRal.get(delegationEventId);
    if (!location) return undefined;

    const [agentPubkey, conversationId] = location.key.split(":");
    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) return undefined;

    const canonicalId = this.followupToCanonical.get(delegationEventId) ?? delegationEventId;

    return {
      pending: convDelegations.pending.get(canonicalId),
      completed: convDelegations.completed.get(canonicalId),
      agentPubkey,
      conversationId,
      ralNumber: location.ralNumber,
    };
  }

  findStateWaitingForDelegation(delegationEventId: string): RALRegistryEntry | undefined {
    const location = this.delegationToRal.get(delegationEventId);
    if (!location) return undefined;

    const ral = this.deps.getRAL(location.key.split(":")[0], location.key.split(":")[1], location.ralNumber);
    if (!ral) return undefined;

    const canonicalId = this.followupToCanonical.get(delegationEventId) ?? delegationEventId;
    const convDelegations = this.conversationDelegations.get(location.key);
    const hasPending = convDelegations?.pending.has(canonicalId) ?? false;
    return hasPending ? ral : undefined;
  }

  getRalKeyForDelegation(delegationEventId: string): string | undefined {
    return this.delegationToRal.get(delegationEventId)?.key;
  }

  getDelegationRecipientPubkey(delegationConversationId: string): string | null {
    const location = this.delegationToRal.get(delegationConversationId);
    if (!location) {
      return null;
    }

    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) {
      return null;
    }

    const canonicalId = this.followupToCanonical.get(delegationConversationId)
      ?? delegationConversationId;

    const pendingDelegation = convDelegations.pending.get(canonicalId);
    if (pendingDelegation) {
      return pendingDelegation.recipientPubkey;
    }

    return null;
  }

  markDelegationKilled(delegationConversationId: string): boolean {
    const location = this.delegationToRal.get(delegationConversationId);
    if (!location) {
      logger.debug("[RALRegistry.markDelegationKilled] No delegation found for ID", {
        delegationConversationId: shortenConversationId(delegationConversationId),
      });
      return false;
    }

    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) {
      return false;
    }

    const canonicalId = this.followupToCanonical.get(delegationConversationId)
      ?? delegationConversationId;

    const pendingDelegation = convDelegations.pending.get(canonicalId);
    if (!pendingDelegation) {
      logger.debug("[RALRegistry.markDelegationKilled] No pending delegation found", {
        delegationConversationId: shortenConversationId(canonicalId),
      });
      return false;
    }

    if (pendingDelegation.killed) {
      logger.debug("[RALRegistry.markDelegationKilled] Delegation already killed", {
        delegationConversationId: shortenConversationId(canonicalId),
        killedAt: pendingDelegation.killedAt,
      });
      return true;
    }

    pendingDelegation.killed = true;
    pendingDelegation.killedAt = Date.now();

    trace.getActiveSpan()?.addEvent("ral.delegation_marked_killed", {
      "delegation.conversation_id": shortenConversationId(canonicalId),
      "delegation.recipient_pubkey": shortenPubkey(pendingDelegation.recipientPubkey),
    });

    logger.info("[RALRegistry.markDelegationKilled] Delegation marked as killed", {
      delegationConversationId: shortenConversationId(canonicalId),
      recipientPubkey: shortenPubkey(pendingDelegation.recipientPubkey),
    });

    if (pendingDelegation.parentDelegationConversationId) {
      this.clearPendingSubDelegation(
        pendingDelegation.parentDelegationConversationId,
        canonicalId
      );
    }

    return true;
  }

  isDelegationKilled(delegationConversationId: string): boolean {
    const location = this.delegationToRal.get(delegationConversationId);
    if (!location) {
      return false;
    }

    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) {
      return false;
    }

    const canonicalId = this.followupToCanonical.get(delegationConversationId)
      ?? delegationConversationId;

    const pendingDelegation = convDelegations.pending.get(canonicalId);
    return pendingDelegation?.killed === true;
  }

  markAllDelegationsKilled(agentPubkey: string, conversationId: string): number {
    const key = this.makeKey(agentPubkey, conversationId);
    const convDelegations = this.conversationDelegations.get(key);
    if (!convDelegations) {
      return 0;
    }

    let killedCount = 0;
    const now = Date.now();

    for (const [delegationId, pendingDelegation] of convDelegations.pending) {
      if (!pendingDelegation.killed) {
        pendingDelegation.killed = true;
        pendingDelegation.killedAt = now;
        killedCount++;

        trace.getActiveSpan()?.addEvent("ral.delegation_marked_killed_bulk", {
          "delegation.conversation_id": shortenConversationId(delegationId),
          "delegation.recipient_pubkey": shortenPubkey(pendingDelegation.recipientPubkey),
        });
      }
    }

    if (killedCount > 0) {
      logger.info("[RALRegistry.markAllDelegationsKilled] Marked delegations as killed", {
        agentPubkey: shortenPubkey(agentPubkey),
        conversationId: shortenConversationId(conversationId),
        killedCount,
      });
    }

    return killedCount;
  }

  markParentDelegationKilled(delegationConversationId: string): boolean {
    const location = this.delegationToRal.get(delegationConversationId);
    if (!location) {
      logger.debug("[RALRegistry.markParentDelegationKilled] No parent found for delegation", {
        delegationConversationId: shortenConversationId(delegationConversationId),
      });
      return false;
    }

    const convDelegations = this.conversationDelegations.get(location.key);
    if (!convDelegations) {
      logger.debug("[RALRegistry.markParentDelegationKilled] No delegations found for parent", {
        parentKey: location.key.substring(0, 20),
      });
      return false;
    }

    const canonicalId = this.followupToCanonical.get(delegationConversationId)
      ?? delegationConversationId;

    const pendingDelegation = convDelegations.pending.get(canonicalId);
    if (!pendingDelegation) {
      logger.debug("[RALRegistry.markParentDelegationKilled] No pending delegation found", {
        delegationConversationId: shortenConversationId(canonicalId),
      });
      return false;
    }

    if (!pendingDelegation.killed) {
      pendingDelegation.killed = true;
      pendingDelegation.killedAt = Date.now();

      trace.getActiveSpan()?.addEvent("ral.parent_delegation_marked_killed", {
        "parent.key": location.key.substring(0, 20),
        "delegation.conversation_id": shortenConversationId(canonicalId),
        "delegation.recipient_pubkey": shortenPubkey(pendingDelegation.recipientPubkey),
      });

      logger.info("[RALRegistry.markParentDelegationKilled] Parent delegation marked as killed", {
        parentKey: location.key.substring(0, 20),
        delegationConversationId: shortenConversationId(canonicalId),
        recipientPubkey: shortenPubkey(pendingDelegation.recipientPubkey),
      });
    }

    convDelegations.pending.delete(canonicalId);

    const existingCompletion = convDelegations.completed.get(canonicalId);
    if (existingCompletion) {
      convDelegations.completed.set(canonicalId, {
        delegationConversationId: canonicalId,
        recipientPubkey: existingCompletion.recipientPubkey,
        senderPubkey: existingCompletion.senderPubkey,
        ralNumber: existingCompletion.ralNumber,
        transcript: existingCompletion.transcript,
        completedAt: Date.now(),
        status: "aborted",
        abortReason: "killed via kill tool (after partial completion)",
      });

      trace.getActiveSpan()?.addEvent("ral.parent_delegation_updated_as_aborted", {
        "delegation.conversation_id": shortenConversationId(canonicalId),
        "delegation.status": "aborted",
        "delegation.transcript_preserved": existingCompletion.transcript.length,
      });
    } else {
      convDelegations.completed.set(canonicalId, {
        delegationConversationId: canonicalId,
        recipientPubkey: pendingDelegation.recipientPubkey,
        senderPubkey: pendingDelegation.senderPubkey,
        ralNumber: pendingDelegation.ralNumber,
        transcript: [],
        completedAt: Date.now(),
        status: "aborted",
        abortReason: "killed via kill tool",
      });

      trace.getActiveSpan()?.addEvent("ral.parent_delegation_moved_to_completed", {
        "delegation.conversation_id": shortenConversationId(canonicalId),
        "delegation.status": "aborted",
      });
    }

    this.deps.decrementDelegationCounter(
      location.key.split(":")[0],
      location.key.split(":")[1],
      pendingDelegation.ralNumber
    );

    return true;
  }

  private makeKey(agentPubkey: string, conversationId: string): string {
    return `${agentPubkey}:${conversationId}`;
  }

  private getOrCreateConversationDelegations(key: string): ConversationDelegations {
    let delegations = this.conversationDelegations.get(key);
    if (!delegations) {
      delegations = { pending: new Map(), completed: new Map() };
      this.conversationDelegations.set(key, delegations);
    }
    return delegations;
  }
}
