import { describe, expect, it, mock } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        debug: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
    },
}));

// Mock phase-utils
mock.module("@/utils/phase-utils", () => ({
    formatConversationSnapshot: mock(async () => "Mock conversation snapshot"),
}));

import {
    checkTodoCompletion,
    validateTodoPending,
    buildTodoValidationPrompt,
} from "../TodoValidator";
import type { AgentInstance } from "@/agents/types";
import type { ExecutionContext } from "../../types";

describe("TodoValidator", () => {
    describe("checkTodoCompletion", () => {
        it("should return no pending when conversation is null", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const context = {
                getConversation: () => null,
            } as unknown as ExecutionContext;

            const result = checkTodoCompletion(agent, context);

            expect(result.hasPending).toBe(false);
            expect(result.pendingItems).toEqual([]);
        });

        it("should return no pending when agent has no todos", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const context = {
                getConversation: () => ({
                    agentTodos: new Map(),
                }),
            } as unknown as ExecutionContext;

            const result = checkTodoCompletion(agent, context);

            expect(result.hasPending).toBe(false);
            expect(result.pendingItems).toEqual([]);
        });

        it("should detect pending todos", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const todos = [
                { title: "Task 1", status: "pending" },
                { title: "Task 2", status: "done" },
                { title: "Task 3", status: "pending" },
            ];

            const agentTodos = new Map([["agent-pubkey", todos]]);

            const context = {
                getConversation: () => ({
                    agentTodos,
                }),
            } as unknown as ExecutionContext;

            const result = checkTodoCompletion(agent, context);

            expect(result.hasPending).toBe(true);
            expect(result.pendingItems).toEqual(["Task 1", "Task 3"]);
        });

        it("should return no pending when all todos are done", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const todos = [
                { title: "Task 1", status: "done" },
                { title: "Task 2", status: "done" },
            ];

            const agentTodos = new Map([["agent-pubkey", todos]]);

            const context = {
                getConversation: () => ({
                    agentTodos,
                }),
            } as unknown as ExecutionContext;

            const result = checkTodoCompletion(agent, context);

            expect(result.hasPending).toBe(false);
            expect(result.pendingItems).toEqual([]);
        });

        it("should only check todos for the specific agent", () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const agentTodos = new Map([
                ["other-agent-pubkey", [{ title: "Other task", status: "pending" }]],
            ]);

            const context = {
                getConversation: () => ({
                    agentTodos,
                }),
            } as unknown as ExecutionContext;

            const result = checkTodoCompletion(agent, context);

            expect(result.hasPending).toBe(false);
            expect(result.pendingItems).toEqual([]);
        });
    });

    describe("buildTodoValidationPrompt", () => {
        it("should build prompts with pending items listed", () => {
            const pendingItems = ["Write tests", "Update docs"];
            const conversationSnapshot = "User: Please complete tasks";
            const agentResponse = "I've made some progress";

            const result = buildTodoValidationPrompt(
                pendingItems,
                conversationSnapshot,
                agentResponse
            );

            expect(result.system).toContain("<conversation-history>");
            expect(result.system).toContain(conversationSnapshot);
            expect(result.system).toContain("<your-response>");
            expect(result.system).toContain(agentResponse);
            expect(result.system).toContain("<pending-todos>");
            expect(result.system).toContain("Write tests");
            expect(result.system).toContain("Update docs");

            expect(result.user).toContain("I'M DONE:");
            expect(result.user).toContain("CONTINUE:");
        });
    });

    describe("validateTodoPending", () => {
        it("should return empty string when no pending items", async () => {
            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
            } as AgentInstance;

            const context = {
                agent,
            } as unknown as ExecutionContext;

            const result = await validateTodoPending(
                agent,
                context,
                "Some response",
                [], // No pending items
                async () => "System prompt"
            );

            expect(result).toBe("");
        });

        it("should call LLM and return empty for I'M DONE response", async () => {
            const mockComplete = mock(async () => ({
                text: "I'M DONE: These tasks are no longer needed",
            }));

            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
                createLLMService: () => ({
                    complete: mockComplete,
                }),
            } as unknown as AgentInstance;

            const context = {
                agent,
            } as unknown as ExecutionContext;

            const result = await validateTodoPending(
                agent,
                context,
                "Task completed",
                ["Pending task 1"],
                async () => "System prompt"
            );

            expect(mockComplete).toHaveBeenCalled();
            expect(result).toBe("");
        });

        it("should return response when LLM says CONTINUE", async () => {
            const continueResponse = "CONTINUE: I need to complete the pending tasks";
            const mockComplete = mock(async () => ({
                text: continueResponse,
            }));

            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
                createLLMService: () => ({
                    complete: mockComplete,
                }),
            } as unknown as AgentInstance;

            const context = {
                agent,
            } as unknown as ExecutionContext;

            const result = await validateTodoPending(
                agent,
                context,
                "Some response",
                ["Important task"],
                async () => "System prompt"
            );

            expect(result).toBe(continueResponse);
        });

        it("should return empty string on LLM error", async () => {
            const mockComplete = mock(async () => {
                throw new Error("Service unavailable");
            });

            const agent = {
                slug: "test-agent",
                pubkey: "agent-pubkey",
                createLLMService: () => ({
                    complete: mockComplete,
                }),
            } as unknown as AgentInstance;

            const context = {
                agent,
            } as unknown as ExecutionContext;

            const result = await validateTodoPending(
                agent,
                context,
                "Some response",
                ["Pending task"],
                async () => "System prompt"
            );

            // On error, return empty (don't force continuation)
            expect(result).toBe("");
        });
    });
});
