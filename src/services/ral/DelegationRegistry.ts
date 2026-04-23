import type {
  CompletedDelegation,
  PendingDelegation,
  RALRegistryEntry,
} from "./types";
import { DelegationJournalReader } from "./DelegationJournalReader";

export interface ConversationDelegations {
  pending: Map<string, PendingDelegation>;
  completed: Map<string, CompletedDelegation>;
}

interface DelegationRegistryDeps {
  getRAL: (agentPubkey: string, conversationId: string, ralNumber: number) => RALRegistryEntry | undefined;
}

/**
 * Read-only facade over Rust's RAL journal for delegation state. All
 * mutations flow through the worker protocol (delegation_registered,
 * delegation_killed) which causes Rust to append journal records; this
 * registry derives its view by replaying the journal on each query.
 *
 * The only session-local state is an idempotency guard for implicit
 * kill wake-ups so a single aborted completion does not wake the same
 * parent twice within the same session.
 */
export class DelegationRegistry {
  private readonly reader = DelegationJournalReader.getInstance();
  private readonly consumedKillWakeTargets: Set<string> = new Set();

  constructor(_deps: DelegationRegistryDeps) {}

  clearAll(): void {
    this.consumedKillWakeTargets.clear();
  }

  getConversationPendingDelegations(
    agentPubkey: string,
    conversationId: string,
    ralNumber?: number
  ): PendingDelegation[] {
    return this.reader.getConversationPendingDelegations(agentPubkey, conversationId, ralNumber);
  }

  getConversationCompletedDelegations(
    agentPubkey: string,
    conversationId: string,
    ralNumber?: number
  ): CompletedDelegation[] {
    return this.reader.getConversationCompletedDelegations(agentPubkey, conversationId, ralNumber);
  }

  getConversationDelegationState(key: string): ConversationDelegations | undefined {
    const [agentPubkey, conversationId] = key.split(":");
    if (!agentPubkey || !conversationId) return undefined;
    const pending = this.reader.getConversationPendingDelegations(agentPubkey, conversationId);
    const completed = this.reader.getConversationCompletedDelegations(agentPubkey, conversationId);
    if (pending.length === 0 && completed.length === 0) return undefined;
    return {
      pending: new Map(pending.map((d) => [d.delegationConversationId, d])),
      completed: new Map(completed.map((d) => [d.delegationConversationId, d])),
    };
  }

  findDelegation(delegationEventId: string):
    | {
        pending?: PendingDelegation;
        completed?: CompletedDelegation;
        agentPubkey: string;
        conversationId: string;
        ralNumber: number;
      }
    | undefined {
    return this.reader.findDelegation(delegationEventId);
  }

  findStateWaitingForDelegation(_delegationEventId: string): RALRegistryEntry | undefined {
    return undefined;
  }

  getRalKeyForDelegation(delegationEventId: string): string | undefined {
    const location = this.reader.findLocation(delegationEventId);
    if (!location) return undefined;
    return `${location.agentPubkey}:${location.conversationId}`;
  }

  getDelegationRecipientPubkey(delegationConversationId: string): string | null {
    return this.reader.getDelegationRecipientPubkey(delegationConversationId);
  }

  isDelegationKilled(delegationConversationId: string): boolean {
    return this.reader.isDelegationKilled(delegationConversationId);
  }

  isAgentConversationKilled(agentPubkey: string, conversationId: string): boolean {
    return this.reader.isAgentConversationKilled(agentPubkey, conversationId);
  }

  resolveDelegationPrefix(prefix: string): string | null {
    return this.reader.resolveDelegationPrefix(prefix);
  }

  canonicalizeDelegationId(id: string): string {
    return this.reader.canonicalizeDelegationId(id);
  }

  consumeImplicitKillWakeTarget(
    delegationConversationId: string
  ): { agentPubkey: string; conversationId: string; ralNumber: number } | null {
    if (this.consumedKillWakeTargets.has(delegationConversationId)) return null;
    const lookup = this.reader.findDelegation(delegationConversationId);
    if (!lookup) return null;
    const completed = lookup.completed;
    if (!completed || completed.status !== "aborted") return null;
    this.consumedKillWakeTargets.add(delegationConversationId);
    return {
      agentPubkey: lookup.agentPubkey,
      conversationId: lookup.conversationId,
      ralNumber: lookup.ralNumber,
    };
  }
}
