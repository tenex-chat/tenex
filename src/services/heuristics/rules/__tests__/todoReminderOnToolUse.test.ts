/**
 * Tests for the todoReminderOnToolUse heuristic
 */

import { describe, it, expect } from "bun:test";
import { todoReminderOnToolUseHeuristic } from "../todoReminderOnToolUse";
import type { HeuristicContext } from "../../types";

const createBaseContext = (): HeuristicContext => ({
  agentPubkey: "test-agent",
  conversationId: "test-conv",
  ralNumber: 1,
  evaluationTimestamp: Date.now(),
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

describe("todoReminderOnToolUse Heuristic", () => {
  it("should trigger reminder when using non-todo tool without todos", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";
    context.state.hasTodoWrite = false;

    const result = todoReminderOnToolUseHeuristic.evaluate(context);

    expect(result).not.toBeNull();
    expect(result?.severity).toBe("warning");
    // Message should NOT contain system-reminder tags (framework adds them)
    expect(result?.message).not.toContain("<system-reminder>");
    expect(result?.message).toContain("todo_write()");
    expect(result?.message).toContain("Benefits of using todos");
  });

  it("should NOT trigger for todo_write tool", () => {
    const context = createBaseContext();
    context.tool.name = "todo_write";
    context.state.hasTodoWrite = false;

    const result = todoReminderOnToolUseHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should NOT trigger for mcp__tenex__todo_write tool", () => {
    const context = createBaseContext();
    context.tool.name = "mcp__tenex__todo_write";
    context.state.hasTodoWrite = false;

    const result = todoReminderOnToolUseHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should NOT trigger for TodoWrite (legacy name) tool", () => {
    const context = createBaseContext();
    context.tool.name = "TodoWrite";
    context.state.hasTodoWrite = false;

    const result = todoReminderOnToolUseHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should NOT trigger when hasTodoWrite is true", () => {
    const context = createBaseContext();
    context.tool.name = "Bash";
    context.state.hasTodoWrite = true;

    const result = todoReminderOnToolUseHeuristic.evaluate(context);
    expect(result).toBeNull();
  });

  it("should trigger on every non-todo tool call (not just once)", () => {
    const context1 = createBaseContext();
    context1.tool.name = "Bash";
    context1.tool.callId = "call-1";
    context1.state.hasTodoWrite = false;

    const context2 = createBaseContext();
    context2.tool.name = "Read";
    context2.tool.callId = "call-2";
    context2.state.hasTodoWrite = false;

    const result1 = todoReminderOnToolUseHeuristic.evaluate(context1);
    const result2 = todoReminderOnToolUseHeuristic.evaluate(context2);

    // Both should trigger (different call IDs = different violations)
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1?.id).not.toBe(result2?.id);
  });

  it("should trigger for delegate tool when no todos (separate from blocking)", () => {
    // Note: The delegate tool blocks at execution level, but the heuristic
    // runs post-execution, so if somehow delegation succeeded, this would still fire.
    const context = createBaseContext();
    context.tool.name = "delegate";
    context.state.hasTodoWrite = false;

    const result = todoReminderOnToolUseHeuristic.evaluate(context);
    expect(result).not.toBeNull();
  });

  it("should have correct heuristic metadata", () => {
    expect(todoReminderOnToolUseHeuristic.id).toBe("todo-reminder-on-tool-use");
    expect(todoReminderOnToolUseHeuristic.name).toBe("Todo Reminder on Tool Use");
    expect(todoReminderOnToolUseHeuristic.description).toContain("todo list");
  });
});
