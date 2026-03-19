import { describe, expect, it } from "bun:test";
import {
    getDefaultHeuristics,
    todoBeforeDelegationHeuristic,
    todoReminderOnToolUseHeuristic,
} from "../rules";
import type { HeuristicContext } from "../types";

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

describe("todoBeforeDelegationHeuristic", () => {
    it("does not trigger for non-delegation tools", () => {
        const context = createBaseContext();

        const result = todoBeforeDelegationHeuristic.evaluate(context);
        expect(result).toBeNull();
    });

    it("does not trigger when todo state already exists", () => {
        const context = createBaseContext();
        context.tool.name = "mcp__tenex__delegate";
        context.state.hasTodoWrite = true;

        const result = todoBeforeDelegationHeuristic.evaluate(context);
        expect(result).toBeNull();
    });

    it("triggers for delegation without todo state", () => {
        const context = createBaseContext();
        context.tool.name = "mcp__tenex__delegate_crossproject";

        const result = todoBeforeDelegationHeuristic.evaluate(context);
        expect(result?.heuristicId).toBe("todo-before-delegation");
        expect(result?.severity).toBe("warning");
        expect(result?.title).toContain("TODO");
    });
});

describe("todoReminderOnToolUseHeuristic", () => {
    it("triggers on non-todo tools when no todo list exists", () => {
        const context = createBaseContext();

        const result = todoReminderOnToolUseHeuristic.evaluate(context);
        expect(result?.heuristicId).toBe("todo-reminder-on-tool-use");
        expect(result?.message).toContain("todo_write()");
    });

    it("does not trigger for todo_write tools", () => {
        const context = createBaseContext();
        context.tool.name = "mcp__tenex__todo_write";

        const result = todoReminderOnToolUseHeuristic.evaluate(context);
        expect(result).toBeNull();
    });

    it("does not trigger once todo state exists", () => {
        const context = createBaseContext();
        context.state.hasTodoWrite = true;

        const result = todoReminderOnToolUseHeuristic.evaluate(context);
        expect(result).toBeNull();
    });
});

describe("getDefaultHeuristics", () => {
    it("registers only the active default heuristics", () => {
        expect(getDefaultHeuristics().map((heuristic) => heuristic.id)).toEqual([
            "todo-reminder-on-tool-use",
        ]);
    });
});
