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
            expect(result.message).toBe("Todo list updated with 2 items");
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
            // Array order is the source of truth for position
            expect(todos[0].id).toBe("task-a");
            expect(todos[1].id).toBe("task-b");
            expect(todos[2].id).toBe("task-c");
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
            expect(result.message).toContain("Safety check failed");
            expect(result.message).toContain("1 existing item(s) would be removed");
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
            expect(result.message).toContain("Safety check failed");
            expect(result.message).toContain("2 existing item(s) would be removed");
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
            expect(result.message).toContain("Safety check failed");
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
            expect(result.message).toContain("Duplicate IDs");
            expect(result.message).toContain("same-id");
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
            expect(result.message).toContain("Duplicate IDs");
            expect(result.message).toContain("dup-a");
            expect(result.message).toContain("dup-b");
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
            expect(result.message).toContain("skip_reason is required");
            expect(result.message).toContain("skip-task");
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
            expect(result.message).toBe("Todo list updated with 1 item");
            // Verify the status changed in the stored todos
            const todos = context.getTodosRaw();
            expect(todos[0].status).toBe("in_progress");
        });

        it("should allow in_progress -> done transition", async () => {
            await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "in_progress" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const result = await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "done" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.message).toBe("Todo list updated with 1 item");
            // Verify the status changed in the stored todos
            const todos = context.getTodosRaw();
            expect(todos[0].status).toBe("done");
        });

        it("should allow any status -> skipped transition with reason", async () => {
            await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "in_progress" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const result = await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "skipped", skip_reason: "Not needed" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.message).toBe("Todo list updated with 1 item");
            // Verify the status changed in the stored todos
            const todos = context.getTodosRaw();
            expect(todos[0].status).toBe("skipped");
        });

        it("should update updatedAt when status changes", async () => {
            await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "pending" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const firstUpdatedAt = context.getTodosRaw()[0].updatedAt;

            // Small delay to ensure timestamp difference
            await new Promise(resolve => setTimeout(resolve, 50));

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
            await new Promise(resolve => setTimeout(resolve, 50));

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

    describe("auto-generated id and optional description", () => {
        it("should auto-generate id from title when not provided", async () => {
            const result = await tool.execute({
                todos: [
                    { title: "My First Task", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            expect(todos[0].id).toBe("my-first-task");
            expect(todos[0].title).toBe("My First Task");
        });

        it("should use provided id when specified", async () => {
            const result = await tool.execute({
                todos: [
                    { id: "custom-id", title: "My Task", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            expect(todos[0].id).toBe("custom-id");
        });

        it("should default description to empty string when not provided", async () => {
            const result = await tool.execute({
                todos: [
                    { title: "Task without description", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            expect(todos[0].description).toBe("");
        });

        it("should use provided description when specified", async () => {
            const result = await tool.execute({
                todos: [
                    { title: "Task with description", description: "This is the description", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            expect(todos[0].description).toBe("This is the description");
        });

        it("should handle special characters in title when generating id", async () => {
            const result = await tool.execute({
                todos: [
                    { title: "Fix Bug #123: Auth Issue!", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            expect(todos[0].id).toBe("fix-bug-123-auth-issue");
        });

        it("should handle multiple spaces and special chars in title", async () => {
            const result = await tool.execute({
                todos: [
                    { title: "  Multiple   Spaces   Here  ", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            // Should handle leading/trailing spaces and collapse multiple hyphens
            expect(todos[0].id).toBe("multiple-spaces-here");
        });

        it("should allow minimal todo with only title and status", async () => {
            const result = await tool.execute({
                todos: [
                    { title: "Task 1", status: "pending" },
                    { title: "Task 2", status: "in_progress" },
                    { title: "Task 3", status: "done" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.totalItems).toBe(3);

            const todos = context.getTodosRaw();
            expect(todos[0].id).toBe("task-1");
            expect(todos[1].id).toBe("task-2");
            expect(todos[2].id).toBe("task-3");
        });

        it("should detect duplicates from auto-generated ids", async () => {
            const result = await tool.execute({
                todos: [
                    { title: "Same Task", status: "pending" },
                    { title: "Same Task", status: "in_progress" }, // Same title = same generated ID
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(false);
            expect(result.error).toContain("Duplicate IDs");
            expect(result.error).toContain("same-task");
        });

        it("should generate deterministic hash-based id for emoji-only titles", async () => {
            const result = await tool.execute({
                todos: [
                    { title: "🚀🎉", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            // Should have a hash-based ID since emoji produces empty slug
            expect(todos[0].id).toMatch(/^todo-[0-9a-f]+$/);
        });

        it("should generate deterministic hash-based id for non-ASCII titles", async () => {
            const result = await tool.execute({
                todos: [
                    { title: "日本語タイトル", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            // Should have a hash-based ID since non-ASCII produces empty slug
            expect(todos[0].id).toMatch(/^todo-[0-9a-f]+$/);
        });

        it("should generate same hash for same title (deterministic)", async () => {
            await tool.execute({
                todos: [
                    { title: "🔥", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const firstId = context.getTodosRaw()[0].id;

            // Clear and add the same title again
            await tool.execute({
                todos: [],
                force: true,
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            await tool.execute({
                todos: [
                    { title: "🔥", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const secondId = context.getTodosRaw()[0].id;

            expect(firstId).toBe(secondId);
        });

        it("should generate different hashes for different emoji titles", async () => {
            const result = await tool.execute({
                todos: [
                    { title: "🚀", status: "pending" },
                    { title: "🎉", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            expect(todos[0].id).not.toBe(todos[1].id);
        });

        it("should handle mixed ASCII and emoji (partial slug)", async () => {
            const result = await tool.execute({
                todos: [
                    { title: "Task 🚀 Launch", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            // Should extract ASCII parts: "task-launch"
            expect(todos[0].id).toBe("task-launch");
        });

        it("should handle punctuation-only titles with hash fallback", async () => {
            const result = await tool.execute({
                todos: [
                    { title: "...", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            // Should have a hash-based ID since punctuation produces empty slug
            expect(todos[0].id).toMatch(/^todo-[0-9a-f]+$/);
        });
    });

    describe("description preservation on update", () => {
        it("should preserve existing description when omitting description on update", async () => {
            // First write with description
            await tool.execute({
                todos: [
                    { id: "task-1", title: "Task One", description: "Original description", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            // Update without description field
            const result = await tool.execute({
                todos: [
                    { id: "task-1", title: "Task One Updated", status: "in_progress" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            expect(todos[0].description).toBe("Original description"); // Preserved!
            expect(todos[0].title).toBe("Task One Updated");
            expect(todos[0].status).toBe("in_progress");
        });

        it("should allow explicitly setting description to empty string", async () => {
            // First write with description
            await tool.execute({
                todos: [
                    { id: "task-1", title: "Task One", description: "Original description", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            // Update with explicit empty description
            const result = await tool.execute({
                todos: [
                    { id: "task-1", title: "Task One", description: "", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            expect(todos[0].description).toBe(""); // Explicitly cleared
        });

        it("should use empty string for new items without description", async () => {
            const result = await tool.execute({
                todos: [
                    { id: "new-task", title: "New Task", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            const todos = context.getTodosRaw();
            expect(todos[0].description).toBe(""); // Empty for new items
        });

        it("should preserve description when only status changes", async () => {
            await tool.execute({
                todos: [
                    { id: "task-1", title: "Task", description: "Important details here", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            // Update only status
            await tool.execute({
                todos: [
                    { id: "task-1", title: "Task", status: "done" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const todos = context.getTodosRaw();
            expect(todos[0].description).toBe("Important details here");
            expect(todos[0].status).toBe("done");
        });

        it("should allow updating description explicitly", async () => {
            await tool.execute({
                todos: [
                    { id: "task-1", title: "Task", description: "Original", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            // Update with new description
            await tool.execute({
                todos: [
                    { id: "task-1", title: "Task", description: "Updated description", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const todos = context.getTodosRaw();
            expect(todos[0].description).toBe("Updated description");
        });
    });

    describe("success messages", () => {
        it("should return appropriate message for single item", async () => {
            const result = await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "pending" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.message).toBe("Todo list updated with 1 item");
        });

        it("should return appropriate message for multiple items", async () => {
            const result = await tool.execute({
                todos: [
                    { id: "task1", title: "Task 1", description: "Desc", status: "pending" },
                    { id: "task2", title: "Task 2", description: "Desc", status: "pending" },
                    { id: "task3", title: "Task 3", description: "Desc", status: "pending" },
                ],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.message).toBe("Todo list updated with 3 items");
        });

        it("should return appropriate message when clearing list", async () => {
            await tool.execute({
                todos: [{ id: "task", title: "Task", description: "Desc", status: "pending" }],
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            const result = await tool.execute({
                todos: [],
                force: true,
            }, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });

            expect(result.success).toBe(true);
            expect(result.message).toBe("Todo list cleared");
        });
    });
});
