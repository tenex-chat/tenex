import { trace } from "@opentelemetry/api";
import { ConversationStore } from "@/conversations/ConversationStore";
import { shortenConversationId, shortenPubkey } from "@/utils/conversation-id";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { logger } from "@/utils/logger";
import type { ProjectDTag } from "@/types/project-ids";
import type { RALRegistryEntry } from "./types";
import type { DelegationRegistry } from "./DelegationRegistry";

interface KillSwitchRegistryDeps {
  getState: (agentPubkey: string, conversationId: string) => RALRegistryEntry | undefined;
  getActiveRALs: (agentPubkey: string, conversationId: string) => RALRegistryEntry[];
  getAbortControllers: () => Map<string, AbortController>;
  makeKey: (agentPubkey: string, conversationId: string) => string;
  makeAbortKey: (key: string, ralNumber: number) => string;
}

/**
 * KillSwitchRegistry - orchestrates abort controllers and cascades kill
 * intents to descendant delegations. Kill state itself lives in Rust's
 * RAL journal; the cascade emits delegation_killed frames through the
 * onDelegationKilled callback so Rust records every kill.
 *
 * The only session-local state is the abort controller set maintained
 * via deps.getAbortControllers; abort signalling is transient per-worker
 * state, not durable RAL state.
 */
export class KillSwitchRegistry {
  constructor(
    private readonly deps: KillSwitchRegistryDeps,
    private readonly delegations: DelegationRegistry
  ) {}

  clearAll(): void {
    // Abort controllers are owned by deps.getAbortControllers() and tied to
    // RAL state; they are cleared when the RAL state is cleared.
  }

  getKilledConversationCount(): number {
    return 0;
  }

  pruneStaleKilledConversations(_hasState: (key: string) => boolean): number {
    return 0;
  }

  isDelegationKilled(delegationConversationId: string): boolean {
    return this.delegations.isDelegationKilled(delegationConversationId);
  }

  isAgentConversationKilled(agentPubkey: string, conversationId: string): boolean {
    return this.delegations.isAgentConversationKilled(agentPubkey, conversationId);
  }

  getDelegationRecipientPubkey(delegationConversationId: string): string | null {
    return this.delegations.getDelegationRecipientPubkey(delegationConversationId);
  }

  abortCurrentTool(agentPubkey: string, conversationId: string): void {
    const ral = this.deps.getState(agentPubkey, conversationId);
    if (!ral) return;

    const abortKey = this.deps.makeAbortKey(this.deps.makeKey(agentPubkey, conversationId), ral.ralNumber);
    const controller = this.deps.getAbortControllers().get(abortKey);
    if (controller) {
      controller.abort();
      this.deps.getAbortControllers().delete(abortKey);
      trace.getActiveSpan()?.addEvent("ral.tool_aborted", {
        "ral.number": ral.ralNumber,
      });
    }
  }

  abortAllForAgent(agentPubkey: string, conversationId: string): number {
    const rals = this.deps.getActiveRALs(agentPubkey, conversationId);
    if (rals.length === 0) return 0;

    const key = this.deps.makeKey(agentPubkey, conversationId);
    let abortedCount = 0;

    for (const ral of rals) {
      const abortKey = this.deps.makeAbortKey(key, ral.ralNumber);
      const controller = this.deps.getAbortControllers().get(abortKey);
      if (controller && !controller.signal.aborted) {
        controller.abort();
        abortedCount++;
        trace.getActiveSpan()?.addEvent("ral.aborted_by_stop_signal", {
          "ral.number": ral.ralNumber,
          "agent.pubkey": agentPubkey.substring(0, 8),
          "conversation.id": shortenConversationId(conversationId),
        });
      }
    }

    return abortedCount;
  }

  async abortWithCascade(
    agentPubkey: string,
    conversationId: string,
    projectId: ProjectDTag,
    reason: string,
    cooldownRegistry?: { add: (projectId: ProjectDTag, convId: string, agentPubkey: string, reason: string) => void },
    onDelegationKilled?: (delegationConversationId: string, reason: string) => Promise<void>
  ): Promise<{ abortedCount: number; descendantConversations: Array<{ conversationId: string; agentPubkey: string }> }> {
    if (!reason) {
      throw new Error("[RALRegistry] Missing abort reason for cascade.");
    }

    const abortedTuples: Array<{ conversationId: string; agentPubkey: string }> = [];

    const pendingDelegations = this.delegations.getConversationPendingDelegations(agentPubkey, conversationId);

    if (onDelegationKilled) {
      for (const pending of pendingDelegations) {
        await onDelegationKilled(pending.delegationConversationId, reason);
      }
    }

    const directAbortCount = this.abortAllForAgent(agentPubkey, conversationId);
    const llmAborted = llmOpsRegistry.stopByAgentAndConversation(agentPubkey, conversationId, reason);

    const conversation = ConversationStore.get(conversationId);
    if (conversation) {
      conversation.blockAgent(agentPubkey);
    }

    if (cooldownRegistry) {
      cooldownRegistry.add(projectId, conversationId, agentPubkey, reason);
    }

    if (conversation) {
      const abortMessage = `This conversation was aborted at ${new Date().toISOString()}. Reason: ${reason}`;
      conversation.addMessage({
        pubkey: "system",
        content: abortMessage,
        messageType: "text",
        timestamp: Math.floor(Date.now() / 1000),
      });
      await conversation.save();
    }

    trace.getActiveSpan()?.addEvent("ral.cascade_abort_started", {
      "cascade.root_conversation_id": shortenConversationId(conversationId),
      "cascade.root_agent_pubkey": shortenPubkey(agentPubkey),
      "cascade.pending_delegations": pendingDelegations.length,
      "cascade.reason": reason,
    });

    for (const delegation of pendingDelegations) {
      const descendantConvId = delegation.delegationConversationId;
      const descendantAgentPubkey = delegation.recipientPubkey;

      const descendantConversation = ConversationStore.get(descendantConvId);
      const descendantProjectId = descendantConversation?.getProjectId() ?? projectId;

      logger.info("[RALRegistry] Cascading abort to nested delegation", {
        parentConversation: shortenConversationId(conversationId),
        parentAgent: shortenPubkey(agentPubkey),
        childConversation: shortenConversationId(descendantConvId),
        childAgent: shortenPubkey(descendantAgentPubkey),
        projectId: descendantProjectId?.substring(0, 12),
      });

      const descendantResult = await this.abortWithCascade(
        descendantAgentPubkey,
        descendantConvId,
        descendantProjectId,
        `cascaded from ${shortenConversationId(conversationId)}`,
        cooldownRegistry,
        onDelegationKilled
      );

      abortedTuples.push({ conversationId: descendantConvId, agentPubkey: descendantAgentPubkey });
      abortedTuples.push(...descendantResult.descendantConversations);
    }

    trace.getActiveSpan()?.addEvent("ral.cascade_abort_completed", {
      "cascade.root_conversation_id": shortenConversationId(conversationId),
      "cascade.root_agent_pubkey": shortenPubkey(agentPubkey),
      "cascade.total_aborted": abortedTuples.length,
    });

    return {
      abortedCount: directAbortCount + (llmAborted ? 1 : 0),
      descendantConversations: abortedTuples,
    };
  }
}
