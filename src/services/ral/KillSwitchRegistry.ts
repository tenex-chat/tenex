import { trace } from "@opentelemetry/api";
import { ConversationStore } from "@/conversations/ConversationStore";
import { shortenConversationId, shortenPubkey } from "@/utils/conversation-id";
import { llmOpsRegistry } from "@/services/LLMOperationsRegistry";
import { logger } from "@/utils/logger";
import type { ProjectDTag } from "@/types/project-ids";
import type { DelegationKillSignal, RALRegistryEntry } from "./types";
import type { DelegationRegistry } from "./DelegationRegistry";

interface KillSwitchRegistryDeps {
  getState: (agentPubkey: string, conversationId: string) => RALRegistryEntry | undefined;
  getActiveRALs: (agentPubkey: string, conversationId: string) => RALRegistryEntry[];
  getAbortControllers: () => Map<string, AbortController>;
  clearConversation: (agentPubkey: string, conversationId: string) => void;
  makeKey: (agentPubkey: string, conversationId: string) => string;
  makeAbortKey: (key: string, ralNumber: number) => string;
}

/**
 * KillSwitchRegistry - tracks kill markers and abort/cascade behavior.
 */
export class KillSwitchRegistry {
  private readonly killedAgentConversations: Set<string> = new Set();

  constructor(
    private readonly deps: KillSwitchRegistryDeps,
    private readonly delegations: DelegationRegistry
  ) {}

  get killedAgentConversationsSet(): Set<string> {
    return this.killedAgentConversations;
  }

  clearAll(): void {
    this.killedAgentConversations.clear();
  }

  getKilledConversationCount(): number {
    return this.killedAgentConversations.size;
  }

  clearConversation(agentPubkey: string, conversationId: string): void {
    const key = this.deps.makeKey(agentPubkey, conversationId);
    this.killedAgentConversations.delete(key);
  }

  pruneStaleKilledConversations(hasState: (key: string) => boolean): number {
    let pruned = 0;
    for (const key of this.killedAgentConversations) {
      if (!hasState(key)) {
        this.killedAgentConversations.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  markDelegationKilled(delegationConversationId: string): boolean {
    return this.delegations.markDelegationKilled(delegationConversationId);
  }

  isDelegationKilled(delegationConversationId: string): boolean {
    return this.delegations.isDelegationKilled(delegationConversationId);
  }

  markAllDelegationsKilled(agentPubkey: string, conversationId: string): number {
    return this.delegations.markAllDelegationsKilled(agentPubkey, conversationId);
  }

  markAgentConversationKilled(agentPubkey: string, conversationId: string): void {
    const key = this.deps.makeKey(agentPubkey, conversationId);
    this.killedAgentConversations.add(key);

    trace.getActiveSpan()?.addEvent("ral.agent_conversation_marked_killed", {
      "agent.pubkey": shortenPubkey(agentPubkey),
      "conversation.id": shortenConversationId(conversationId),
    });

    logger.info("[RALRegistry.markAgentConversationKilled] Agent+conversation marked as killed", {
      agentPubkey: shortenPubkey(agentPubkey),
      conversationId: shortenConversationId(conversationId),
    });
  }

  isAgentConversationKilled(agentPubkey: string, conversationId: string): boolean {
    const key = this.deps.makeKey(agentPubkey, conversationId);
    return this.killedAgentConversations.has(key);
  }

  getDelegationRecipientPubkey(delegationConversationId: string): string | null {
    return this.delegations.getDelegationRecipientPubkey(delegationConversationId);
  }

  markParentDelegationKilled(
    delegationConversationId: string,
    abortReason?: string
  ): DelegationKillSignal | undefined {
    return this.delegations.markParentDelegationKilled(delegationConversationId, abortReason);
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

    this.deps.clearConversation(agentPubkey, conversationId);

    return abortedCount;
  }

  async abortWithCascade(
    agentPubkey: string,
    conversationId: string,
    projectId: ProjectDTag,
    reason: string,
    cooldownRegistry?: { add: (projectId: ProjectDTag, convId: string, agentPubkey: string, reason: string) => void }
  ): Promise<{
    abortedCount: number;
    descendantConversations: Array<{ conversationId: string; agentPubkey: string }>;
    killSignal?: DelegationKillSignal;
  }> {
    if (!reason) {
      throw new Error("[RALRegistry] Missing abort reason for cascade.");
    }

    const abortedTuples: Array<{ conversationId: string; agentPubkey: string }> = [];
    let killSignal: DelegationKillSignal | undefined;

    const pendingDelegations = this.delegations.getConversationPendingDelegations(agentPubkey, conversationId);
    const key = this.deps.makeKey(agentPubkey, conversationId);
    const convDelegations = this.delegations.getConversationDelegationState(key);

    const killedDelegationCount = this.delegations.markAllDelegationsKilled(agentPubkey, conversationId);
    if (killedDelegationCount > 0) {
      trace.getActiveSpan()?.addEvent("ral.delegations_marked_killed_before_abort", {
        "cascade.agent_pubkey": shortenPubkey(agentPubkey),
        "cascade.conversation_id": shortenConversationId(conversationId),
        "cascade.killed_delegation_count": killedDelegationCount,
      });
    }

    const directAbortCount = this.abortAllForAgent(agentPubkey, conversationId);
    const llmAborted = llmOpsRegistry.stopByAgentAndConversation(agentPubkey, conversationId, reason);

    this.markAgentConversationKilled(agentPubkey, conversationId);
    const conversation = ConversationStore.get(conversationId);
    if (conversation) {
      conversation.blockAgent(agentPubkey);
    }

    if (directAbortCount > 0 || llmAborted) {
      abortedTuples.push({ conversationId, agentPubkey });

      killSignal = this.markParentDelegationKilled(conversationId, reason);

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
        cooldownRegistry
      );

      abortedTuples.push(...descendantResult.descendantConversations);

      if (convDelegations) {
        const pendingDelegation = convDelegations.pending.get(descendantConvId);
        if (pendingDelegation) {
          convDelegations.pending.delete(descendantConvId);

          const abortedConv = ConversationStore.get(descendantConvId);
          const partialTranscript: Array<{
            senderPubkey: string;
            recipientPubkey: string;
            content: string;
            timestamp: number;
          }> = [];
          if (abortedConv) {
            const messages = abortedConv.getAllMessages();
            for (const msg of messages) {
              if (msg.messageType === "text" && msg.targetedPubkeys && msg.targetedPubkeys.length > 0) {
                partialTranscript.push({
                  senderPubkey: msg.pubkey,
                  recipientPubkey: msg.targetedPubkeys[0],
                  content: msg.content,
                  timestamp: msg.timestamp ?? Date.now(),
                });
              }
            }
          }

          convDelegations.completed.set(descendantConvId, {
            delegationConversationId: descendantConvId,
            recipientPubkey: descendantAgentPubkey,
            senderPubkey: pendingDelegation.senderPubkey,
            ralNumber: pendingDelegation.ralNumber,
            transcript: partialTranscript,
            completedAt: Date.now(),
            status: "aborted",
            abortReason: `cascaded from ${shortenConversationId(conversationId)}`,
          });

          trace.getActiveSpan()?.addEvent("ral.delegation_marked_aborted", {
            "delegation.conversation_id": shortenConversationId(descendantConvId),
            "delegation.transcript_length": partialTranscript.length,
          });
        }
      }
    }

    if (convDelegations && (convDelegations.pending.size > 0 || convDelegations.completed.size > 0)) {
      this.delegations.setConversationDelegationState(key, convDelegations);
    }

    trace.getActiveSpan()?.addEvent("ral.cascade_abort_completed", {
      "cascade.root_conversation_id": shortenConversationId(conversationId),
      "cascade.root_agent_pubkey": shortenPubkey(agentPubkey),
      "cascade.total_aborted": abortedTuples.length,
    });

    return {
      abortedCount: directAbortCount + (llmAborted ? 1 : 0),
      descendantConversations: abortedTuples,
      killSignal,
    };
  }

}
