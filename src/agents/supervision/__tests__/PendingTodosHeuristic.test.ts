import { describe, it, expect, beforeEach } from "vitest";
import { PendingTodosHeuristic } from "../heuristics/PendingTodosHeuristic";
import type { PostCompletionContext } from "../types";

describe("PendingTodosHeuristic", () => {
    let heuristic: PendingTodosHeuristic;

    beforeEach(() => {
        heuristic = new PendingTodosHeuristic();
    });

    const createContext = (
        overrides: Partial<PostCompletionContext> = {}
    ): PostCompletionContext => ({
        agentSlug: "test-agent",
        agentPubkey: "abc123",
        messageContent: "",
        toolCallsMade: [],
        systemPrompt: "You are a helpful assistant.",
        conversationHistory: [],
        availableTools: {},
        hasBeenNudgedAboutTodos: false,
        todos: [],
        pendingDelegationCount: 0,
        ...overrides,
    });

    describe("detect", () => {
        it("should NOT trigger when agent has no todos at all", async () => {
            const context = createContext({
                        todos: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger when all todos are completed", async () => {
            const context = createContext({
                todos: [
                    { id: "1", title: "Task 1", status: "done" },
                    { id: "2", title: "Task 2", status: "done" },
                ],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger when all todos are skipped", async () => {
            const context = createContext({
                todos: [
                    { id: "1", title: "Task 1", status: "skipped" },
                    { id: "2", title: "Task 2", status: "skipped" },
                ],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger when todos are mixed completed and skipped", async () => {
            const context = createContext({
                todos: [
                    { id: "1", title: "Task 1", status: "done" },
                    { id: "2", title: "Task 2", status: "skipped" },
                ],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should trigger when agent has pending todos", async () => {
            const context = createContext({
                todos: [
                    { id: "1", title: "Task 1", status: "done" },
                    { id: "2", title: "Task 2", status: "pending" },
                ],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
            expect(result.reason).toContain("1 incomplete todo");
            expect(result.evidence).toMatchObject({
                totalTodos: 2,
                incompleteTodos: [
                    { id: "2", title: "Task 2", status: "pending" },
                ],
            });
        });

        it("should NOT trigger when agent has pending delegations (even with incomplete todos)", async () => {
            const context = createContext({
                todos: [
                    { id: "1", title: "Task 1", status: "done" },
                    { id: "2", title: "Task 2", status: "pending" },
                    { id: "3", title: "Task 3", status: "in_progress" },
                ],
                pendingDelegationCount: 1,
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
            expect(result.reason).toContain("pending delegation");
        });

        it("should NOT trigger when agent has multiple pending delegations", async () => {
            const context = createContext({
                todos: [
                    { id: "1", title: "Task 1", status: "pending" },
                ],
                pendingDelegationCount: 3,
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
            expect(result.reason).toContain("3 pending delegation(s)");
        });

        it("should trigger when delegations are complete (pendingDelegationCount = 0) and todos remain", async () => {
            const context = createContext({
                todos: [
                    { id: "1", title: "Task 1", status: "pending" },
                ],
                pendingDelegationCount: 0,
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
            expect(result.reason).toContain("1 incomplete todo");
        });

        it("should trigger when agent has in_progress todos", async () => {
            const context = createContext({
                todos: [
                    { id: "1", title: "Task 1", status: "in_progress" },
                ],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
            expect(result.reason).toContain("1 incomplete todo");
            expect(result.evidence).toMatchObject({
                totalTodos: 1,
                incompleteTodos: [
                    { id: "1", title: "Task 1", status: "in_progress" },
                ],
            });
        });

        it("should trigger with multiple incomplete todos", async () => {
            const context = createContext({
                todos: [
                    { id: "1", title: "Task 1", status: "pending" },
                    { id: "2", title: "Task 2", status: "in_progress" },
                    { id: "3", title: "Task 3", status: "done" },
                    { id: "4", title: "Task 4", status: "pending" },
                ],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
            expect(result.reason).toContain("3 incomplete todo");
            expect(result.evidence?.incompleteTodos).toHaveLength(3);
        });
    });

    describe("buildCorrectionMessage", () => {
        it("should contain softer tone with 'Would you like to address...'", () => {
            const context = createContext({
                todos: [
                    { id: "1", title: "Fix bug", status: "pending" },
                ],
            });

            const message = heuristic.buildCorrectionMessage(context, {
                verdict: "violation",
                explanation: "Incomplete todos",
            });

            expect(message).toContain("Would you like to address");
            expect(message).toContain("Fix bug");
            expect(message).toContain("[pending]");
        });

        it("should list all incomplete todos with their status", () => {
            const context = createContext({
                todos: [
                    { id: "1", title: "Task A", status: "pending", description: "Do something" },
                    { id: "2", title: "Task B", status: "in_progress" },
                    { id: "3", title: "Task C", status: "done" }, // Should not appear
                ],
            });

            const message = heuristic.buildCorrectionMessage(context, {
                verdict: "violation",
                explanation: "Incomplete todos",
            });

            expect(message).toContain("[pending] **Task A**: Do something");
            expect(message).toContain("[in_progress] **Task B**");
            expect(message).not.toContain("Task C");
        });

        it("should mention todo_write tool", () => {
            const context = createContext({
                todos: [
                    { id: "1", title: "Fix bug", status: "pending" },
                ],
            });

            const message = heuristic.buildCorrectionMessage(context, {
                verdict: "violation",
                explanation: "Incomplete todos",
            });

            expect(message).toContain("todo_write");
        });
    });

    describe("getCorrectionAction", () => {
        it("should return suppress-publish with reEngage", () => {
            const action = heuristic.getCorrectionAction({
                verdict: "violation",
                explanation: "Agent has pending todos",
            });

            expect(action.type).toBe("suppress-publish");
            expect(action.reEngage).toBe(true);
        });
    });

    describe("metadata", () => {
        it("should have correct id and timing", () => {
            expect(heuristic.id).toBe("pending-todos");
            expect(heuristic.timing).toBe("post-completion");
        });

        it("should skip verification since this is an objective check", () => {
            expect(heuristic.skipVerification).toBe(true);
        });
    });
});
