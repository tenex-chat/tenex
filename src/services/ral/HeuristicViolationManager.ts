import { trace } from "@opentelemetry/api";
import type { RALRegistryEntry } from "./types";

type HeuristicViolation = {
  id: string;
  title: string;
  message: string;
  severity: "warning" | "error";
  timestamp: number;
  heuristicId: string;
};

type HeuristicSummary = NonNullable<NonNullable<RALRegistryEntry["heuristics"]>["summary"]>;

/**
 * HeuristicViolationManager - stores heuristic state on a live RAL entry.
 *
 * The registry keeps the state on the RAL record itself; this helper just owns
 * the mutation logic and the O(1) summary bookkeeping.
 */
export class HeuristicViolationManager {
  /**
   * Add heuristic violations to pending queue for a RAL.
   * These will be injected as system messages in the next LLM step.
   */
  addHeuristicViolations(
    ral: RALRegistryEntry | undefined,
    _agentPubkey: string,
    _conversationId: string,
    ralNumber: number,
    violations: HeuristicViolation[]
  ): void {
    if (!ral) {
      return;
    }

    // Initialize heuristics state if needed
    if (!ral.heuristics) {
      ral.heuristics = this.initializeHeuristicState();
    }

    // Filter out duplicates by heuristicId (not individual violation id)
    const pendingHeuristicIds = new Set(
      ral.heuristics.pendingViolations.map((v) => v.heuristicId)
    );
    const newViolations = violations.filter(
      (v) =>
        !ral.heuristics?.shownViolationIds.has(v.heuristicId) &&
        !pendingHeuristicIds.has(v.heuristicId)
    );

    if (newViolations.length === 0) {
      return; // All violations already shown or pending
    }

    // Add to pending queue
    ral.heuristics.pendingViolations.push(...newViolations);
    ral.lastActivityAt = Date.now();

    trace.getActiveSpan()?.addEvent("ral.heuristic_violations_added", {
      "ral.number": ralNumber,
      "heuristic.violation_count": newViolations.length,
      "heuristic.pending_count": ral.heuristics.pendingViolations.length,
    });
  }

  /**
   * Get and consume pending heuristic violations for injection.
   * Atomically reads and clears the pending queue, marks violations as shown.
   *
   * @returns Array of pending violations (empty if none)
   */
  getAndConsumeHeuristicViolations(
    ral: RALRegistryEntry | undefined,
    _agentPubkey: string,
    _conversationId: string,
    ralNumber: number
  ): HeuristicViolation[] {
    if (!ral || !ral.heuristics || ral.heuristics.pendingViolations.length === 0) {
      return [];
    }

    // Atomic read+clear
    const violations = [...ral.heuristics.pendingViolations];
    ral.heuristics.pendingViolations = [];

    // Mark heuristicId as shown (for deduplication by heuristic, not by individual violation)
    for (const v of violations) {
      ral.heuristics.shownViolationIds.add(v.heuristicId);
    }

    trace.getActiveSpan()?.addEvent("ral.heuristic_violations_consumed", {
      "ral.number": ralNumber,
      "heuristic.violation_count": violations.length,
    });

    return violations;
  }

  /**
   * Check if there are pending heuristic violations for a RAL.
   */
  hasPendingHeuristicViolations(ral: RALRegistryEntry | undefined): boolean {
    return (ral?.heuristics?.pendingViolations?.length ?? 0) > 0;
  }

  /**
   * Initialize heuristic state for a RAL entry (DRY helper).
   */
  initializeHeuristicState(): NonNullable<RALRegistryEntry["heuristics"]> {
    return {
      pendingViolations: [],
      shownViolationIds: new Set(),
      summary: {
        recentTools: [],
        flags: {
          hasTodoWrite: false,
          hasDelegation: false,
          hasVerification: false,
          hasGitAgentCommit: false,
        },
        pendingDelegationCount: 0,
      },
      toolArgs: new Map(),
    };
  }

  /**
   * Store tool arguments by toolCallId for later retrieval by heuristics.
   * BLOCKER 2 FIX: Enables passing real args to heuristics, not result.
   */
  storeToolArgs(
    ral: RALRegistryEntry | undefined,
    _agentPubkey: string,
    _conversationId: string,
    _ralNumber: number,
    toolCallId: string,
    args: unknown
  ): void {
    if (!ral) return;

    if (!ral.heuristics) {
      ral.heuristics = this.initializeHeuristicState();
    }

    if (!ral.heuristics.toolArgs) {
      ral.heuristics.toolArgs = new Map();
    }

    ral.heuristics.toolArgs.set(toolCallId, args);
  }

  /**
   * Retrieve stored tool arguments by toolCallId.
   * BLOCKER 2 FIX: Returns real args stored at tool-will-execute.
   */
  getToolArgs(
    ral: RALRegistryEntry | undefined,
    _agentPubkey: string,
    _conversationId: string,
    _ralNumber: number,
    toolCallId: string
  ): unknown | undefined {
    return ral?.heuristics?.toolArgs?.get(toolCallId);
  }

  /**
   * Clear stored tool args for a specific toolCallId after evaluation.
   * Prevents memory leak by cleaning up after heuristic evaluation.
   */
  clearToolArgs(
    ral: RALRegistryEntry | undefined,
    _agentPubkey: string,
    _conversationId: string,
    _ralNumber: number,
    toolCallId: string
  ): void {
    if (!ral?.heuristics?.toolArgs) return;
    ral.heuristics.toolArgs.delete(toolCallId);
  }

  /**
   * Update O(1) precomputed summary for heuristic evaluation.
   * BLOCKER 1 FIX: Maintains O(1) context building with bounded history.
   *
   * @param maxRecentTools - Maximum recent tools to track (default: 10)
   */
  updateHeuristicSummary(
    ral: RALRegistryEntry | undefined,
    _agentPubkey: string,
    _conversationId: string,
    _ralNumber: number,
    toolName: string,
    toolArgs: unknown,
    maxRecentTools = 10
  ): void {
    if (!ral) return;

    if (!ral.heuristics) {
      ral.heuristics = this.initializeHeuristicState();
    }

    if (!ral.heuristics.summary) {
      ral.heuristics.summary = {
        recentTools: [],
        flags: {
          hasTodoWrite: false,
          hasDelegation: false,
          hasVerification: false,
          hasGitAgentCommit: false,
        },
        pendingDelegationCount: 0,
      };
    }

    const summary = ral.heuristics.summary;

    // Add to recent tools (bounded)
    summary.recentTools.push({ name: toolName, timestamp: Date.now() });
    if (summary.recentTools.length > maxRecentTools) {
      summary.recentTools.shift(); // Remove oldest
    }

    // Update flags based on tool name
    // Include all variants: todo_write (actual ToolName), TodoWrite (legacy), mcp__tenex__todo_write (MCP)
    if (toolName === "todo_write" || toolName === "TodoWrite" || toolName === "mcp__tenex__todo_write") {
      summary.flags.hasTodoWrite = true;
    }

    if (toolName === "mcp__tenex__delegate") {
      summary.flags.hasDelegation = true;

      // Check if delegation to git-agent
      const args = toolArgs as { delegations?: Array<{ recipient?: string }> };
      if (args?.delegations?.some((d) => d.recipient === "git-agent")) {
        summary.flags.hasGitAgentCommit = true;
      }
    }

    if (toolName === "Bash") {
      const args = toolArgs as { command?: string };
      const command = args?.command?.toLowerCase() || "";

      // Check for verification commands
      if (
        command.includes("test") ||
        command.includes("build") ||
        command.includes("lint") ||
        command.includes("jest") ||
        command.includes("vitest")
      ) {
        summary.flags.hasVerification = true;
      }
    }
  }

  /**
   * Increment the pending delegation counter for a RAL.
   * Used when a new delegation is added in mergePendingDelegations.
   */
  incrementDelegationCounter(
    ral: RALRegistryEntry | undefined,
    _agentPubkey: string,
    _conversationId: string,
    _ralNumber: number
  ): void {
    if (!ral) return;

    if (!ral.heuristics) {
      ral.heuristics = this.initializeHeuristicState();
    }

    if (!ral.heuristics.summary) {
      ral.heuristics.summary = {
        recentTools: [],
        flags: {
          hasTodoWrite: false,
          hasDelegation: false,
          hasVerification: false,
          hasGitAgentCommit: false,
        },
        pendingDelegationCount: 0,
      };
    }

    ral.heuristics.summary.pendingDelegationCount++;
  }

  /**
   * Decrement the pending delegation counter for a RAL.
   * Used when a delegation is completed.
   */
  decrementDelegationCounter(
    ral: RALRegistryEntry | undefined,
    _agentPubkey: string,
    _conversationId: string,
    _ralNumber: number
  ): void {
    if (!ral?.heuristics?.summary) return;

    ral.heuristics.summary.pendingDelegationCount = Math.max(
      0,
      ral.heuristics.summary.pendingDelegationCount - 1
    );
  }

  /**
   * Get the O(1) precomputed summary for heuristic evaluation.
   * BLOCKER 1 FIX: Provides O(1) access to RAL state without scans.
   */
  getHeuristicSummary(
    ral: RALRegistryEntry | undefined,
    _agentPubkey: string,
    _conversationId: string,
    _ralNumber: number
  ): HeuristicSummary | undefined {
    return ral?.heuristics?.summary;
  }
}
