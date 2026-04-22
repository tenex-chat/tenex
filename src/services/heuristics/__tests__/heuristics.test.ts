import { describe, expect, it } from "bun:test";
import {
    getDefaultHeuristics,
    todoBeforeDelegationHeuristic,
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
        context.tool.name = "mcp__tenex__delegate";

        const result = todoBeforeDelegationHeuristic.evaluate(context);
        expect(result?.heuristicId).toBe("todo-before-delegation");
        expect(result?.severity).toBe("warning");
        expect(result?.title).toContain("TODO");
    });
});

describe("getDefaultHeuristics", () => {
    it("registers no default heuristics", () => {
        expect(getDefaultHeuristics()).toEqual([]);
    });
});
