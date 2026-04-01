import { trace } from "@opentelemetry/api";
import { shortenConversationId, shortenEventId, shortenPubkey } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import type { QueuedInjection, RALRegistryEntry, InjectionRole } from "./types";

/**
 * MessageInjectionQueue - manages queued message injections for a live RAL entry.
 *
 * The queue is stored on the RAL entry itself; this helper owns the mechanics
 * for enqueue, dequeue, and targeted cleanup.
 */
export class MessageInjectionQueue {
  constructor(private readonly maxQueueSize: number) {}

  /**
   * Queue a system message for injection into a specific RAL.
   */
  queueSystemMessage(
    ral: RALRegistryEntry | undefined,
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    message: string
  ): void {
    this.queueMessage(ral, agentPubkey, conversationId, ralNumber, "system", message);
  }

  /**
   * Queue a user message for injection into a specific RAL.
   */
  queueUserMessage(
    ral: RALRegistryEntry | undefined,
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    message: string,
    options?: {
      senderPubkey?: string;
      senderPrincipal?: QueuedInjection["senderPrincipal"];
      targetedPrincipals?: QueuedInjection["targetedPrincipals"];
      eventId?: string;
    }
  ): void {
    this.queueMessage(ral, agentPubkey, conversationId, ralNumber, "user", message, options);
  }

  /**
   * Queue a message with specified role for injection into a specific RAL.
   */
  queueMessage(
    ral: RALRegistryEntry | undefined,
    agentPubkey: string,
    conversationId: string,
    ralNumber: number,
    role: InjectionRole,
    message: string,
    options?: {
      senderPubkey?: string;
      senderPrincipal?: QueuedInjection["senderPrincipal"];
      targetedPrincipals?: QueuedInjection["targetedPrincipals"];
      eventId?: string;
    }
  ): void {
    if (!ral) {
      logger.warn("[RALRegistry] Cannot queue message - no RAL state", {
        agentPubkey: agentPubkey.substring(0, 8),
        conversationId: conversationId.substring(0, 8),
        ralNumber,
        role,
      });
      return;
    }

    if (ral.queuedInjections.length >= this.maxQueueSize) {
      ral.queuedInjections.shift();
      logger.warn("[RALRegistry] Queue full, dropping oldest message", {
        agentPubkey: agentPubkey.substring(0, 8),
      });
    }

    ral.queuedInjections.push({
      role,
      content: message,
      queuedAt: Date.now(),
      senderPubkey: options?.senderPubkey,
      senderPrincipal: options?.senderPrincipal,
      targetedPrincipals: options?.targetedPrincipals,
      eventId: options?.eventId,
    });
  }

  /**
   * Get and consume queued injections for a specific RAL.
   * Injections are persisted to ConversationStore by the caller.
   */
  getAndConsumeInjections(
    ral: RALRegistryEntry | undefined,
    _agentPubkey: string,
    _conversationId: string,
    ralNumber: number
  ): QueuedInjection[] {
    if (!ral) return [];

    if (ral.queuedInjections.length === 0) {
      return [];
    }

    const injections = [...ral.queuedInjections];
    ral.queuedInjections = [];

    trace.getActiveSpan()?.addEvent("ral.injections_consumed", {
      "ral.id": ral.id,
      "ral.number": ralNumber,
      "injection.count": injections.length,
    });

    return injections;
  }

  /**
   * Clear a specific queued injection identified by its source event ID.
   * Used after a live MessageInjector delivery succeeds so unrelated queued
   * follow-ups remain pending for the same conversation.
   */
  clearQueuedInjectionByEventId(
    rals: Iterable<RALRegistryEntry> | undefined,
    agentPubkey: string,
    conversationId: string,
    eventId: string
  ): number {
    if (!rals) return 0;

    let totalCleared = 0;
    for (const ral of rals) {
      if (ral.queuedInjections.length === 0) {
        continue;
      }

      const beforeCount = ral.queuedInjections.length;
      ral.queuedInjections = ral.queuedInjections.filter((injection) => injection.eventId !== eventId);
      totalCleared += beforeCount - ral.queuedInjections.length;
    }

    if (totalCleared > 0) {
      trace.getActiveSpan()?.addEvent("ral.injection_cleared_after_delivery", {
        "agent.pubkey": shortenPubkey(agentPubkey),
        "conversation.id": shortenConversationId(conversationId),
        "event.id": shortenEventId(eventId),
        "cleared.count": totalCleared,
      });
    }

    return totalCleared;
  }

  /**
   * Clear all queued injections for an agent's conversation.
   * Called by AgentDispatchService after MessageInjector successfully delivers a message.
   * This prevents hasOutstandingWork() from incorrectly reporting queued injections
   * that have already been delivered, which would cause the agent to use conversation()
   * instead of complete().
   */
  clearQueuedInjections(
    rals: Iterable<RALRegistryEntry> | undefined,
    agentPubkey: string,
    conversationId: string
  ): void {
    if (!rals) return;

    let totalCleared = 0;
    for (const ral of rals) {
      if (ral.queuedInjections.length > 0) {
        totalCleared += ral.queuedInjections.length;
        ral.queuedInjections = [];
      }
    }

    if (totalCleared > 0) {
      trace.getActiveSpan()?.addEvent("ral.injections_cleared_after_delivery", {
        "agent.pubkey": shortenPubkey(agentPubkey),
        "conversation.id": shortenConversationId(conversationId),
        "cleared.count": totalCleared,
      });
    }
  }
}
