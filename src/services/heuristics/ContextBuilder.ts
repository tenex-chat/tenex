/**
 * Context Builder for Heuristics
 *
 * Builds O(1) precomputed context from RAL state and conversation data.
 * CRITICAL: All operations must be O(1) - no expensive scans allowed.
 */

import type { ConversationStore } from "@/conversations/ConversationStore";
import type { RALRegistry } from "@/services/ral/RALRegistry";
import type { HeuristicContext } from "./types";

/**
 * Configuration for context builder
 */
export interface ContextBuilderConfig {
  /** Maximum recent tools to include in context (default: 10) */
  maxRecentTools?: number;
}

/**
 * Build heuristic context from current RAL state.
 * All data is precomputed for O(1) access.
 * BLOCKER 1 FIX: Uses O(1) precomputed summary from RALRegistry.
 */
export function buildHeuristicContext(params: {
  agentPubkey: string;
  conversationId: string;
  ralNumber: number;
  toolName: string;
  toolCallId: string;
  toolArgs: unknown;
  toolResult: unknown;
  ralRegistry: RALRegistry;
  conversationStore: ConversationStore;
  currentBranch?: string;
  config?: ContextBuilderConfig;
}): HeuristicContext {
  const {
    agentPubkey,
    conversationId,
    ralNumber,
    toolName,
    toolCallId,
    toolArgs,
    toolResult,
    ralRegistry,
    conversationStore,
    currentBranch,
  } = params;

  // Get O(1) precomputed summary from RAL (BLOCKER 1 FIX)
  const summary = ralRegistry.getHeuristicSummary(agentPubkey, conversationId, ralNumber) ?? {
    recentTools: [],
    flags: {
      hasTodoWrite: false,
      hasDelegation: false,
      hasVerification: false,
      hasGitAgentCommit: false,
    },
    pendingDelegationCount: 0,
  };

  // Build state from O(1) precomputed summary
  const state = {
    hasTodoWrite: summary.flags.hasTodoWrite,
    hasDelegation: summary.flags.hasDelegation,

    // O(1) counter from summary (no expensive scan)
    pendingDelegationCount: summary.pendingDelegationCount,

    // Current branch
    currentBranch,

    // Check if on worktree branch (heuristic: contains .worktrees or feature/)
    isWorktreeBranch: currentBranch
      ? currentBranch.includes("feature/") || currentBranch.includes(".worktrees")
      : false,

    // Check if verification was performed (tests, builds)
    hasVerification: summary.flags.hasVerification,

    // Check if git-agent was used (via delegation)
    hasGitAgentCommit: summary.flags.hasGitAgentCommit,

    // Total message count (O(1) - stored in ConversationStore)
    messageCount: conversationStore.getMessageCount(),
  };

  // BLOCKER 3 FIX: Generate timestamp here, not in heuristics (for purity)
  const evaluationTimestamp = Date.now();

  return {
    agentPubkey,
    conversationId,
    ralNumber,
    evaluationTimestamp,
    tool: {
      name: toolName,
      callId: toolCallId,
      args: toolArgs,
      result: toolResult,
    },
    state,
    recentTools: summary.recentTools, // O(1) - bounded array from summary
  };
}
