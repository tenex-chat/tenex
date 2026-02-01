/**
 * Unit tests for individual heuristics
 */

import { describe, it, expect } from "bun:test";
import {
  todoBeforeDelegationHeuristic,
  branchIsolationHeuristic,
  verificationBeforeMergeHeuristic,
  gitAgentForCommitsHeuristic,
} from "../rules";
import type { HeuristicContext } from "../types";

const createBaseContext = (): HeuristicContext => ({
  agentPubkey: "test-agent",
  conversationId: "test-conv",
  ralNumber: 1,
  tool: {
    name: "Bash",
    callId: "test-call",
    args: { command: "ls" },
    result: {},
  },
  state: {
    hasTodoWrite: false,
    hasDelegation: false,
    pendingDelegationCount: 0,
    currentBranch: "main",
    isWorktreeBranch: false,
    hasVerification: false,
    hasGitAgentCommit: false,
    messageCount: 10,
  },
  recentTools: [],
});

describe("TodoBeforeDelegation Heuristic", () => {
  it("should not trigger for non-delegation tools", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";

    const result = todoBeforeDelegationHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should not trigger when TodoWrite exists in state", () => {
    const context = createBaseContext();
    context.tool.name = "mcp__tenex__delegate";
    context.state.hasTodoWrite = true;

    const result = todoBeforeDelegationHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should not trigger when TodoWrite in recent tools", () => {
    const context = createBaseContext();
    context.tool.name = "mcp__tenex__delegate";
    context.recentTools = [{ name: "TodoWrite", timestamp: Date.now() }];

    const result = todoBeforeDelegationHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should trigger violation when delegating without TODO", () => {
    const context = createBaseContext();
    context.tool.name = "mcp__tenex__delegate";
    context.state.hasTodoWrite = false;

    const result = todoBeforeDelegationHeuristic.evaluate(context);
    expect(result).not.toBeNull();
    expect(result?.severity).toBe("warning");
    expect(result?.title).toContain("TODO");
  });

  it("should trigger for delegate_crossproject too", () => {
    const context = createBaseContext();
    context.tool.name = "mcp__tenex__delegate_crossproject";

    const result = todoBeforeDelegationHeuristic.evaluate(context);
    expect(result).not.toBeNull();
  });
});

describe("BranchIsolation Heuristic", () => {
  it("should not trigger for non-delegation tools", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";

    const result = branchIsolationHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should not trigger for crossproject delegations", () => {
    const context = createBaseContext();
    context.tool.name = "mcp__tenex__delegate_crossproject";

    const result = branchIsolationHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should not trigger when branch parameter provided", () => {
    const context = createBaseContext();
    context.tool.name = "mcp__tenex__delegate";
    context.tool.args = {
      delegations: [{ recipient: "worker", prompt: "test", branch: "feature/test" }],
    };

    const result = branchIsolationHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should not trigger when already on worktree branch", () => {
    const context = createBaseContext();
    context.tool.name = "mcp__tenex__delegate";
    context.state.isWorktreeBranch = true;
    context.tool.args = {
      delegations: [{ recipient: "worker", prompt: "test" }],
    };

    const result = branchIsolationHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should not trigger for simple conversations", () => {
    const context = createBaseContext();
    context.tool.name = "mcp__tenex__delegate";
    context.state.messageCount = 5; // Below threshold
    context.tool.args = {
      delegations: [{ recipient: "worker", prompt: "test" }],
    };

    const result = branchIsolationHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should trigger violation for complex delegation without branch", () => {
    const context = createBaseContext();
    context.tool.name = "mcp__tenex__delegate";
    context.state.messageCount = 20; // Complex conversation
    context.state.isWorktreeBranch = false;
    context.tool.args = {
      delegations: [{ recipient: "worker", prompt: "test" }],
    };

    const result = branchIsolationHeuristic.evaluate(context);
    expect(result).not.toBeNull();
    expect(result?.severity).toBe("warning");
    expect(result?.title).toContain("Branch Isolation");
  });
});

describe("VerificationBeforeMerge Heuristic", () => {
  it("should not trigger for non-Bash tools", () => {
    const context = createBaseContext();
    context.tool.name = "Read";

    const result = verificationBeforeMergeHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should not trigger for non-merge commands", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";
    context.tool.args = { command: "git status" };

    const result = verificationBeforeMergeHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should not trigger when verification exists", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";
    context.tool.args = { command: "git merge feature" };
    context.state.hasVerification = true;

    const result = verificationBeforeMergeHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should not trigger for safe merge flags", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";
    context.tool.args = { command: "git merge --ff-only feature" };

    const result = verificationBeforeMergeHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should trigger violation for merge without verification", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";
    context.tool.args = { command: "git merge feature" };
    context.state.hasVerification = false;

    const result = verificationBeforeMergeHeuristic.evaluate(context);
    expect(result).not.toBeNull();
    expect(result?.severity).toBe("warning");
    expect(result?.title).toContain("Verification");
  });

  it("should trigger for git rebase too", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";
    context.tool.args = { command: "git rebase main" };

    const result = verificationBeforeMergeHeuristic.evaluate(context);
    expect(result).not.toBeNull();
  });
});

describe("GitAgentForCommits Heuristic", () => {
  it("should not trigger for non-Bash tools", () => {
    const context = createBaseContext();
    context.tool.name = "Read";

    const result = gitAgentForCommitsHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should not trigger for non-git commands", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";
    context.tool.args = { command: "npm test" };

    const result = gitAgentForCommitsHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should not trigger for safe git commands", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";
    context.tool.args = { command: "git status" };

    const result = gitAgentForCommitsHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should not trigger when git-agent was used", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";
    context.tool.args = { command: "git commit -m 'test'" };
    context.state.hasGitAgentCommit = true;

    const result = gitAgentForCommitsHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should trigger violation for direct git commit", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";
    context.tool.args = { command: "git commit -m 'fix bug'" };
    context.state.hasGitAgentCommit = false;

    const result = gitAgentForCommitsHeuristic.evaluate(context);
    expect(result).not.toBeNull();
    expect(result?.severity).toBe("warning");
    expect(result?.title).toContain("Git Agent");
  });

  it("should trigger for git add too", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";
    context.tool.args = { command: "git add ." };

    const result = gitAgentForCommitsHeuristic.evaluate(context);
    expect(result).not.toBeNull();
  });
});

describe("Heuristic Purity", () => {
  it("should be pure - same input gives same output", () => {
    const context = createBaseContext();
    context.tool.name = "mcp__tenex__delegate";

    const result1 = todoBeforeDelegationHeuristic.evaluate(context);
    const result2 = todoBeforeDelegationHeuristic.evaluate(context);

    expect(result1?.title).toBe(result2?.title);
    expect(result1?.severity).toBe(result2?.severity);
  });

  it("should be synchronous - no async behavior", () => {
    const context = createBaseContext();
    context.tool.name = "mcp__tenex__delegate";

    const start = performance.now();
    todoBeforeDelegationHeuristic.evaluate(context);
    const duration = performance.now() - start;

    // Should complete in microseconds (synchronous)
    expect(duration).toBeLessThan(1);
  });

  it("should not throw exceptions", () => {
    const context = createBaseContext();
    // @ts-expect-error - Testing invalid input
    context.tool.args = null;

    expect(() => {
      todoBeforeDelegationHeuristic.evaluate(context);
      branchIsolationHeuristic.evaluate(context);
      verificationBeforeMergeHeuristic.evaluate(context);
      gitAgentForCommitsHeuristic.evaluate(context);
    }).not.toThrow();
  });
});
