import { describe, expect, it, beforeEach } from "bun:test";
import type { ConversationToolContext } from "@/tools/types";
import type { TodoItem } from "@/services/ral/types";
import { createTodoWriteTool } from "../todo";

/**
 * Create a mock ConversationToolContext for testing.
 * Uses a simple in-memory todo storage.
 */
function createMockContext(): ConversationToolContext & { getTodosRaw: () => TodoItem[] } {
    let todos: TodoItem[] = [];

    const mockConversation = {
        id: "test-conversation-123",
        getTodos: () => todos,
        setTodos: (_pubkey: string, newTodos: TodoItem[]) => {
            todos = newTodos;
        },
    };

    return {
        agent: {
            name: "TestAgent",
            pubkey: "test-agent-pubkey",
            slug: "test-agent",
            signer: {} as never,
            sign: async () => {},
            llmConfig: "default",
            tools: [],
        },
        conversationId: "test-conversation-123",
        projectBasePath: "/test/project",
        workingDirectory: "/test/project",
        currentBranch: "main",
        triggeringEvent: {} as never,
        agentPublisher: {} as never,
        ralNumber: 1,
        conversationStore: mockConversation as never,
        getConversation: () => mockConversation as never,
        // Test helper to inspect raw todos
        getTodosRaw: () => todos,
    };
}

describe("todo_write tool", () => {
    let context: ReturnType<typeof createMockContext>;
    let tool: ReturnType<typeof createTodoWriteTool>;

    beforeEach(() => {
        context = createMockContext();
        tool = createTodoWriteTool(context);
    });

    describe("full state persistence", () => {
        it("should write a new todo list from empty state", async () => {
            const result = await tool.execute({
                todos: [
                    { id: "task-1", title: "First Task", description: "Do the first thing", status: "pending" },
                    { id: "task-2", title: "Second Task", description: "Do the second thing", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.totalItems).toBe(2);
            expect(result.items).toHaveLength(2);
            expect(result.items[0].id).toBe("task-1");
            expect(result.items[1].id).toBe("task-2");
        });

        it("should preserve item order based on array position", async () => {
            await tool.execute({
                todos: [
                    { id: "task-a", title: "A", description: "A task", status: "pending" },
                    { id: "task-b", title: "B", description: "B task", status: "pending" },
                    { id: "task-c", title: "C", description: "C task", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const todos = context.getTodosRaw();
            expect(todos[0].position).toBe(0);
            expect(todos[1].position).toBe(1);
            expect(todos[2].position).toBe(2);
        });

        it("should update existing items when IDs match", async () => {
            // First write
            await tool.execute({
                todos: [
                    { id: "task-1", title: "Task One", description: "Description one", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const firstWrite = context.getTodosRaw();
            const originalCreatedAt = firstWrite[0].createdAt;

            // Second write - update the status
            const result = await tool.execute({
                todos: [
                    { id: "task-1", title: "Task One Updated", description: "Updated description", status: "in_progress" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            expect(todos[0].createdAt).toBe(originalCreatedAt); // Preserved
            expect(todos[0].title).toBe("Task One Updated");
            expect(todos[0].status).toBe("in_progress");
        });
    });

    describe("safety check (removal protection)", () => {
        it("should reject when existing items are removed without force", async () => {
            // First, create some todos
            await tool.execute({
                todos: [
                    { id: "keep-me", title: "Keep", description: "Keep this", status: "pending" },
                    { id: "remove-me", title: "Remove", description: "Remove this", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            // Try to write without the second item (removal)
            const result = await tool.execute({
                todos: [
                    { id: "keep-me", title: "Keep", description: "Keep this", status: "done" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Safety check failed");
            expect(result.error).toContain("1 existing item(s) would be removed");
            expect(result.missingIds).toContain("remove-me");
        });

        it("should list all missing IDs in the error", async () => {
            await tool.execute({
                todos: [
                    { id: "item-1", title: "Item 1", description: "Desc", status: "pending" },
                    { id: "item-2", title: "Item 2", description: "Desc", status: "pending" },
                    { id: "item-3", title: "Item 3", description: "Desc", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const result = await tool.execute({
                todos: [
                    { id: "item-1", title: "Item 1", description: "Desc", status: "done" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(false);
            expect(result.missingIds).toContain("item-2");
            expect(result.missingIds).toContain("item-3");
            expect(result.missingIds).toHaveLength(2);
        });
    });

    describe("force parameter", () => {
        it("should allow item removal when force=true", async () => {
            await tool.execute({
                todos: [
                    { id: "keep", title: "Keep", description: "Keep this", status: "pending" },
                    { id: "remove", title: "Remove", description: "Remove this", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const result = await tool.execute({
                todos: [
                    { id: "keep", title: "Keep", description: "Keep this", status: "done" },
                ],
                force: true,
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.totalItems).toBe(1);
            expect(context.getTodosRaw()).toHaveLength(1);
        });

        it("should allow clearing entire list with force=true", async () => {
            await tool.execute({
                todos: [
                    { id: "item-1", title: "Item 1", description: "Desc", status: "pending" },
                    { id: "item-2", title: "Item 2", description: "Desc", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const result = await tool.execute({
                todos: [],
                force: true,
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.totalItems).toBe(0);
            expect(context.getTodosRaw()).toHaveLength(0);
        });

        it("should default force to false", async () => {
            await tool.execute({
                todos: [
                    { id: "item", title: "Item", description: "Desc", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            // Not passing force at all
            const result = await tool.execute({
                todos: [],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Safety check failed");
        });
    });

    describe("duplicate ID validation", () => {
        it("should reject when input contains duplicate IDs", async () => {
            const result = await tool.execute({
                todos: [
                    { id: "same-id", title: "First", description: "First occurrence", status: "pending" },
                    { id: "same-id", title: "Second", description: "Second occurrence", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Duplicate IDs");
            expect(result.error).toContain("same-id");
        });

        it("should identify all duplicate IDs", async () => {
            const result = await tool.execute({
                todos: [
                    { id: "dup-a", title: "A1", description: "A1", status: "pending" },
                    { id: "dup-a", title: "A2", description: "A2", status: "pending" },
                    { id: "dup-b", title: "B1", description: "B1", status: "pending" },
                    { id: "dup-b", title: "B2", description: "B2", status: "pending" },
                    { id: "unique", title: "U", description: "U", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(false);
            expect(result.error).toContain("dup-a");
            expect(result.error).toContain("dup-b");
        });
    });

    describe("skip_reason validation", () => {
        it("should require skip_reason when status is skipped", async () => {
            const result = await tool.execute({
                todos: [
                    { id: "skip-task", title: "Skipped Task", description: "This was skipped", status: "skipped" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(false);
            expect(result.error).toContain("skip_reason is required");
            expect(result.error).toContain("skip-task");
        });

        it("should accept skip_reason when status is skipped", async () => {
            const result = await tool.execute({
                todos: [
                    {
                        id: "skip-task",
                        title: "Skipped Task",
                        description: "This was skipped",
                        status: "skipped",
                        skip_reason: "No longer needed after requirements change",
                    },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            expect(todos[0].skipReason).toBe("No longer needed after requirements change");
        });

        it("should not require skip_reason for other statuses", async () => {
            const result = await tool.execute({
                todos: [
                    { id: "pending-task", title: "Pending", description: "Pending task", status: "pending" },
                    { id: "progress-task", title: "In Progress", description: "In progress task", status: "in_progress" },
                    { id: "done-task", title: "Done", description: "Done task", status: "done" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.totalItems).toBe(3);
        });
    });

    describe("status transitions", () => {
        it("should allow pending -> in_progress transition", async () => {
            await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "pending" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const result = await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "in_progress" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.items[0].status).toBe("in_progress");
        });

        it("should allow in_progress -> done transition", async () => {
            await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "in_progress" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const result = await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "done" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.items[0].status).toBe("done");
        });

        it("should allow any status -> skipped transition with reason", async () => {
            await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "in_progress" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const result = await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "skipped", skip_reason: "Not needed" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.items[0].status).toBe("skipped");
        });

        it("should update updatedAt when status changes", async () => {
            await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "pending" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const firstUpdatedAt = context.getTodosRaw()[0].updatedAt;

            // Small delay to ensure timestamp difference
            await new Promise(resolve => setTimeout(resolve, 10));

            await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "in_progress" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const secondUpdatedAt = context.getTodosRaw()[0].updatedAt;
            expect(secondUpdatedAt).toBeGreaterThan(firstUpdatedAt);
        });

        it("should not update updatedAt when status stays the same", async () => {
            await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "pending" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const firstUpdatedAt = context.getTodosRaw()[0].updatedAt;

            // Small delay
            await new Promise(resolve => setTimeout(resolve, 10));

            // Update title but keep status the same
            await tool.execute({
                todos: [{ id: "task", title: "Updated Title", description: "Updated Desc", status: "pending" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const secondUpdatedAt = context.getTodosRaw()[0].updatedAt;
            expect(secondUpdatedAt).toBe(firstUpdatedAt);
        });
    });

    describe("getHumanReadableContent", () => {
        it("should return appropriate message for empty list", () => {
            const getHumanReadable = (tool as { getHumanReadableContent?: (args: { todos: unknown[] }) => string }).getHumanReadableContent;
            expect(getHumanReadable?.({ todos: [] })).toBe("Clearing todo list");
        });

        it("should return appropriate message for single item", () => {
            const getHumanReadable = (tool as { getHumanReadableContent?: (args: { todos: { title: string }[] }) => string }).getHumanReadableContent;
            expect(getHumanReadable?.({ todos: [{ title: "My Task" }] })).toBe('Writing todo list with 1 item: "My Task"');
        });

        it("should return appropriate message for multiple items", () => {
            const getHumanReadable = (tool as { getHumanReadableContent?: (args: { todos: unknown[] }) => string }).getHumanReadableContent;
            expect(getHumanReadable?.({ todos: [{}, {}, {}] })).toBe("Writing todo list with 3 items");
        });
    });

    describe("debug info", () => {
        it("should include debug info in response", async () => {
            const result = await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "pending" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.debug).toBeDefined();
            expect(result.debug.conversationId).toBe("test-conversation-123");
            expect(result.debug.agentPubkey).toBe("test-agent-pubkey");
        });
    });
});
