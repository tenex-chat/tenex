/**
 * Todo Tools - Conversation-scoped todo list management for agents
 *
 * Provides todo_add and todo_update functionality.
 * Todos are stored on the Conversation object and persisted with it.
 */

import type { ConversationToolContext } from "@/tools/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { TodoItem, TodoStatus } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { tool } from "ai";
import { z } from "zod";

// ============================================================================
// Helper functions
// ============================================================================

function getCurrentTimestamp(): number {
    return Date.now();
}

function addTodosToConversation(
    conversation: ConversationStore,
    agentPubkey: string,
    items: Array<{
        id: string;
        title: string;
        description: string;
        position?: number;
    }>
): { added: TodoItem[]; duplicates: string[] } {
    const todos = [...conversation.getTodos(agentPubkey)];

    const added: TodoItem[] = [];
    const duplicates: string[] = [];
    const now = getCurrentTimestamp();

    for (const item of items) {
        const id = item.id;

        // Check for duplicate ID
        if (todos.some((t: TodoItem) => t.id === id)) {
            duplicates.push(id);
            continue;
        }

        const position = item.position ?? todos.length;
        const todoItem: TodoItem = {
            id,
            title: item.title,
            description: item.description,
            status: "pending",
            position,
            createdAt: now,
            updatedAt: now,
        };

        // Append to the list (no re-indexing of existing items)
        todos.push(todoItem);
        added.push(todoItem);
    }

    // Persist the updated list
    conversation.setTodos(agentPubkey, todos);

    return { added, duplicates };
}

function updateTodoStatusInConversation(
    conversation: ConversationStore,
    agentPubkey: string,
    updates: Array<{ id: string; status: TodoStatus; skipReason?: string }>
): { updated: TodoItem[]; notFound: string[]; errors: string[]; debug?: { conversationId: string; agentPubkey: string; existingTodoIds: string[] } } {
    const todos = [...conversation.getTodos(agentPubkey)];

    const updated: TodoItem[] = [];
    const notFound: string[] = [];
    const errors: string[] = [];
    const now = getCurrentTimestamp();

    for (const update of updates) {
        const todo = todos.find((t: TodoItem) => t.id === update.id);
        if (!todo) {
            notFound.push(update.id);
            continue;
        }

        // Validate skip_reason requirement
        if (update.status === "skipped" && !update.skipReason) {
            errors.push(`${update.id}: skip_reason required when status='skipped'`);
            continue;
        }

        todo.status = update.status;
        todo.skipReason = update.skipReason;
        todo.updatedAt = now;
        updated.push(todo);
    }

    // Persist the updated list
    conversation.setTodos(agentPubkey, todos);

    // Include debug info when there are notFound items to help diagnose issues
    if (notFound.length > 0) {
        return {
            updated,
            notFound,
            errors,
            debug: {
                conversationId: conversation.id,
                agentPubkey,
                existingTodoIds: todos.map((t: TodoItem) => t.id),
            },
        };
    }

    return { updated, notFound, errors };
}

// ============================================================================
// todo_add
// ============================================================================

const todoAddItemSchema = z.object({
    id: z.string().describe("Unique identifier for the todo item (e.g., 'implement-auth', 'fix-bug-123')"),
    title: z.string().describe("Short human-readable title for the todo item"),
    description: z.string().describe("Detailed description of what needs to be done"),
    position: z
        .number()
        .optional()
        .describe("Position in the list (0-indexed). If omitted, appends to end"),
});

const todoAddSchema = z.object({
    items: z.array(todoAddItemSchema).min(1).describe("Array of todo items to add"),
});

type TodoAddInput = z.infer<typeof todoAddSchema>;

interface TodoAddOutput {
    success: boolean;
    added: Array<{ id: string; title: string; position: number }>;
    duplicates: string[];
    totalItems: number;
    debug: {
        conversationId: string;
        agentPubkey: string;
    };
}

async function executeTodoAdd(
    input: TodoAddInput,
    context: ConversationToolContext
): Promise<TodoAddOutput> {
    const conversation = context.getConversation();

    const result = addTodosToConversation(
        conversation,
        context.agent.pubkey,
        input.items.map((item) => ({
            id: item.id,
            title: item.title,
            description: item.description,
            position: item.position,
        }))
    );

    const todos = conversation.getTodos(context.agent.pubkey);

    return {
        success: result.added.length > 0,
        added: result.added.map((t: TodoItem) => ({ id: t.id, title: t.title, position: t.position })),
        duplicates: result.duplicates,
        totalItems: todos.length,
        debug: {
            conversationId: conversation.id,
            agentPubkey: context.agent.pubkey,
        },
    };
}

export function createTodoAddTool(context: ConversationToolContext): AISdkTool {
    const aiTool = tool({
        description:
            "Add one or more todo items to track tasks. Each item requires an id (unique identifier), " +
            "title (short label), and description (details). Optionally specify position to insert at a " +
            "specific index; otherwise items are appended. Returns the added items and any duplicate IDs skipped.",
        inputSchema: todoAddSchema,
        execute: async (input: TodoAddInput) => {
            return await executeTodoAdd(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ items }: TodoAddInput) => {
            if (items.length === 1) {
                return `Adding todo: "${items[0].title}"`;
            }
            return `Adding ${items.length} todos`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}

// ============================================================================
// todo_update
// ============================================================================

const todoUpdateItemSchema = z.object({
    id: z.string().describe("The todo item ID (slug)"),
    status: z
        .enum(["pending", "in_progress", "done", "skipped"])
        .describe("New status for the item"),
    skip_reason: z
        .string()
        .optional()
        .describe("Required when status='skipped' - explain why this item was skipped"),
});

const todoUpdateSchema = z.object({
    items: z.array(todoUpdateItemSchema).min(1).describe("Array of todo status updates"),
});

type TodoUpdateInput = z.infer<typeof todoUpdateSchema>;

interface TodoUpdateOutput {
    success: boolean;
    updated: Array<{ id: string; status: string }>;
    notFound: string[];
    errors: string[];
    pendingCount: number;
    debug?: {
        conversationId: string;
        agentPubkey: string;
        existingTodoIds: string[];
    };
}

async function executeTodoUpdate(
    input: TodoUpdateInput,
    context: ConversationToolContext
): Promise<TodoUpdateOutput> {
    const conversation = context.getConversation();

    const result = updateTodoStatusInConversation(
        conversation,
        context.agent.pubkey,
        input.items.map((item) => ({
            id: item.id,
            status: item.status as TodoStatus,
            skipReason: item.skip_reason,
        }))
    );

    const todos = conversation.getTodos(context.agent.pubkey);
    const pendingCount = todos.filter((t: TodoItem) => t.status === "pending").length;

    return {
        success: result.updated.length > 0 && result.errors.length === 0,
        updated: result.updated.map((t: TodoItem) => ({ id: t.id, status: t.status })),
        notFound: result.notFound,
        errors: result.errors,
        pendingCount,
        debug: result.debug,
    };
}

export function createTodoUpdateTool(context: ConversationToolContext): AISdkTool {
    const aiTool = tool({
        description:
            "Update the status of todo items. Use 'in_progress' when starting work, 'done' when complete, " +
            "'skipped' (with skip_reason) if not applicable. Items with 'pending' status indicate work not yet started.",
        inputSchema: todoUpdateSchema,
        execute: async (input: TodoUpdateInput) => {
            return await executeTodoUpdate(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ items }: TodoUpdateInput) => {
            if (items.length === 1) {
                return `Updating todo "${items[0].id}" to ${items[0].status}`;
            }
            return `Updating ${items.length} todo statuses`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
