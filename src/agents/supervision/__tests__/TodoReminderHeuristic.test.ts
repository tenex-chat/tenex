import { describe, it, expect, beforeEach } from "vitest";
import { TodoReminderHeuristic, TODO_TOOL_NAMES } from "../heuristics/TodoReminderHeuristic";
import type { PostCompletionContext } from "../types";

describe("TodoReminderHeuristic", () => {
    let heuristic: TodoReminderHeuristic;

    beforeEach(() => {
        heuristic = new TodoReminderHeuristic();
    });

    const createContext = (
        overrides: Partial<PostCompletionContext> = {}
    ): PostCompletionContext => ({
        agentSlug: "test-agent",
        agentPubkey: "abc123",
        messageContent: "Task completed successfully",
        toolCallsMade: ["some_tool"],
        systemPrompt: "You are a helpful assistant.",
        conversationHistory: [],
        availableTools: {},
        hasTodoList: false,
        hasBeenNudgedAboutTodos: false,
        hasBeenRemindedAboutTodos: false,
        todos: [],
        ...overrides,
    });

    describe("detect", () => {
        it("should NOT trigger when agent has no todos", async () => {
            const context = createContext({
                hasTodoList: false,
                todos: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger when agent has empty todo list", async () => {
            const context = createContext({
                hasTodoList: true,
                todos: [],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger when all todos are completed", async () => {
            const context = createContext({
                hasTodoList: true,
                todos: [
                    { id: "1", title: "Task 1", status: "done" },
                    { id: "2", title: "Task 2", status: "done" },
                ],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should NOT trigger when agent has already been reminded", async () => {
            const context = createContext({
                hasTodoList: true,
                hasBeenRemindedAboutTodos: true,
                todos: [
                    { id: "1", title: "Task 1", status: "pending" },
                ],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });

        it("should trigger when agent has pending todos and not been reminded", async () => {
            const context = createContext({
                hasTodoList: true,
                hasBeenRemindedAboutTodos: false,
                todos: [
                    { id: "1", title: "Pending Task", status: "pending" },
                ],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
            expect(result.reason).toContain("1 incomplete todo");
        });

        it("should trigger when agent has in_progress todos", async () => {
            const context = createContext({
                hasTodoList: true,
                hasBeenRemindedAboutTodos: false,
                todos: [
                    { id: "1", title: "In Progress Task", status: "in_progress" },
                ],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
            expect(result.reason).toContain("1 incomplete todo");
        });

        it("should count multiple incomplete todos correctly", async () => {
            const context = createContext({
                hasTodoList: true,
                hasBeenRemindedAboutTodos: false,
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
        });

        it("should include evidence with incomplete todos", async () => {
            const context = createContext({
                hasTodoList: true,
                hasBeenRemindedAboutTodos: false,
                todos: [
                    { id: "1", title: "Task 1", status: "pending" },
                    { id: "2", title: "Task 2", status: "done" },
                ],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(true);
            expect(result.evidence).toBeDefined();
            const evidence = result.evidence as {
                incompleteTodos: Array<{ id: string; title: string; status: string }>;
                totalTodos: number;
            };
            expect(evidence.incompleteTodos).toHaveLength(1);
            expect(evidence.incompleteTodos[0].title).toBe("Task 1");
            expect(evidence.totalTodos).toBe(2);
        });
    });

    describe("getCorrectionAction", () => {
        it("should return inject-message with reEngage", () => {
            const action = heuristic.getCorrectionAction({
                verdict: "violation",
                explanation: "Agent has incomplete todos",
            });

            expect(action.type).toBe("inject-message");
            expect(action.reEngage).toBe(true);
        });
    });

    describe("buildCorrectionMessage", () => {
        it("should list incomplete todos in the message", () => {
            const context = createContext({
                hasTodoList: true,
                todos: [
                    { id: "1", title: "Fix bug", status: "pending", description: "Critical bug in auth" },
                    { id: "2", title: "Write tests", status: "in_progress" },
                    { id: "3", title: "Done task", status: "done" },
                ],
            });

            const message = heuristic.buildCorrectionMessage(context, {
                verdict: "violation",
                explanation: "test",
            });

            expect(message).toContain("Fix bug");
            expect(message).toContain("pending");
            expect(message).toContain("Write tests");
            expect(message).toContain("in_progress");
            expect(message).not.toContain("Done task");
            expect(message).toContain("todo_write");
        });

        it("should include description when present", () => {
            const context = createContext({
                hasTodoList: true,
                todos: [
                    { id: "1", title: "Fix bug", status: "pending", description: "Critical bug in auth" },
                ],
            });

            const message = heuristic.buildCorrectionMessage(context, {
                verdict: "violation",
                explanation: "test",
            });

            expect(message).toContain("Critical bug in auth");
        });
    });

    describe("heuristic properties", () => {
        it("should have correct id", () => {
            expect(heuristic.id).toBe("todo-reminder");
        });

        it("should have correct name", () => {
            expect(heuristic.name).toBe("Todo List Reminder");
        });

        it("should have post-completion timing", () => {
            expect(heuristic.timing).toBe("post-completion");
        });

        it("should skip verification (objective check)", () => {
            expect(heuristic.skipVerification).toBe(true);
        });
    });

    describe("helper methods", () => {
        describe("getTodoTools", () => {
            it("should return todo tool names", () => {
                const tools = heuristic.getTodoTools();
                expect(tools).toEqual(TODO_TOOL_NAMES);
                expect(tools).toContain("todo_write");
            });
        });
    });

    describe("edge cases", () => {
        it("should handle mixed status todos correctly", async () => {
            const context = createContext({
                hasTodoList: true,
                hasBeenRemindedAboutTodos: false,
                todos: [
                    { id: "1", title: "Done", status: "done" },
                    { id: "2", title: "Skipped", status: "skipped" },
                    { id: "3", title: "Pending", status: "pending" },
                    { id: "4", title: "Blocked", status: "blocked" },
                ],
            });

            const result = await heuristic.detect(context);

            // Only pending and in_progress are considered incomplete
            expect(result.triggered).toBe(true);
            const evidence = result.evidence as {
                incompleteTodos: Array<{ id: string; title: string; status: string }>;
            };
            expect(evidence.incompleteTodos).toHaveLength(1);
            expect(evidence.incompleteTodos[0].title).toBe("Pending");
        });

        it("should not trigger when hasBeenRemindedAboutTodos is true even with incomplete todos", async () => {
            const context = createContext({
                hasTodoList: true,
                hasBeenRemindedAboutTodos: true,
                todos: [
                    { id: "1", title: "Pending Task", status: "pending" },
                    { id: "2", title: "In Progress Task", status: "in_progress" },
                ],
            });

            const result = await heuristic.detect(context);

            expect(result.triggered).toBe(false);
        });
    });
});
