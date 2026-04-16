import { describe, expect, it } from "vitest";
import { WorkerTodoBeforeFileOrShellHeuristic } from "../heuristics/WorkerTodoBeforeFileOrShellHeuristic";
import type { PreToolContext } from "../types";

function createContext(overrides: Partial<PreToolContext> = {}): PreToolContext {
    return {
        agentSlug: "test-worker",
        agentPubkey: "worker-pubkey",
        agentCategory: "worker",
        toolName: "fs_read",
        toolArgs: {},
        systemPrompt: "system",
        conversationHistory: [],
        availableTools: {},
        todos: [],
        ...overrides,
    };
}

describe("WorkerTodoBeforeFileOrShellHeuristic", () => {
    const heuristic = new WorkerTodoBeforeFileOrShellHeuristic();

    it("triggers for worker fs tools when no todo list exists", async () => {
        const result = await heuristic.detect(createContext({ toolName: "fs_read" }));

        expect(result.triggered).toBe(true);
        expect(result.reason).toContain("fs_read");
    });

    it("triggers for worker home_fs fallback tools when no todo list exists", async () => {
        const result = await heuristic.detect(createContext({ toolName: "home_fs_read" }));

        expect(result.triggered).toBe(true);
        expect(result.reason).toContain("home_fs_read");
    });

    it("triggers for worker shell tool use when no todo list exists", async () => {
        const result = await heuristic.detect(createContext({ toolName: "shell" }));

        expect(result.triggered).toBe(true);
        expect(result.reason).toContain("shell");
    });

    it("does not trigger when a worker already has todos", async () => {
        const result = await heuristic.detect(createContext({
            todos: [
                {
                    id: "todo-1",
                    title: "Inspect files",
                    status: "pending",
                },
            ],
        }));

        expect(result.triggered).toBe(false);
    });

    it.each([
        "reviewer",
        "orchestrator",
        "domain-expert",
        "generalist",
        undefined,
    ] as const)("does not trigger for non-worker category %s", async (agentCategory) => {
        const result = await heuristic.detect(createContext({ agentCategory }));

        expect(result.triggered).toBe(false);
    });

    it.each(["todo_write", "delegate"] as const)(
        "does not trigger for unprotected tool %s",
        async (toolName) => {
            const result = await heuristic.detect(createContext({ toolName }));

            expect(result.triggered).toBe(false);
        }
    );

    it("blocks and re-engages until the todo state is resolved", () => {
        const action = heuristic.getCorrectionAction({
            verdict: "violation",
            explanation: "confirmed",
        });

        expect(action.type).toBe("block-tool");
        expect(action.reEngage).toBe(true);
        expect(heuristic.enforcementMode).toBe("repeat-until-resolved");
    });
});
