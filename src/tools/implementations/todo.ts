/**
 * Todo Tools - Conversation-scoped todo list management for agents
 *
 * Provides todo_add and todo_update functionality.
 * Todos are stored on the Conversation object and persisted with it.
 */

import type { ExecutionContext } from "@/agents/execution/types";
import type { Conversation } from "@/conversations/types";
import type { TodoItem, TodoStatus } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { tool } from "ai";
import { z } from "zod";

// ============================================================================
// Helper functions
// ============================================================================

function slugify(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .substring(0, 50);
}

function getOrCreateTodoList(conversation: Conversation, agentPubkey: string): TodoItem[] {
    let todos = conversation.agentTodos.get(agentPubkey);
    if (!todos) {
        todos = [];
        conversation.agentTodos.set(agentPubkey, todos);
    }
    return todos;
}

function addTodosToConversation(
    conversation: Conversation,
    agentPubkey: string,
    items: Array<{
        title: string;
        description: string;
        position?: number;
        delegationInstructions?: string;
    }>
): { added: TodoItem[]; duplicates: string[] } {
    const todos = getOrCreateTodoList(conversation, agentPubkey);

    const added: TodoItem[] = [];
    const duplicates: string[] = [];
    const now = Date.now();

    for (const item of items) {
        const id = slugify(item.title);

        // Check for duplicate ID
        if (todos.some((t) => t.id === id)) {
            duplicates.push(item.title);
            continue;
        }

        const position = item.position ?? todos.length;
        const todoItem: TodoItem = {
            id,
            title: item.title,
            description: item.description,
            status: "pending",
            delegationInstructions: item.delegationInstructions,
            position,
            createdAt: now,
            updatedAt: now,
        };

        // Insert at position (clamped to valid range)
        const clampedPosition = Math.max(0, Math.min(position, todos.length));
        todos.splice(clampedPosition, 0, todoItem);

        // Reindex positions
        todos.forEach((t, idx) => (t.position = idx));

        added.push(todoItem);
    }

    return { added, duplicates };
}

function updateTodoStatusInConversation(
    conversation: Conversation,
    agentPubkey: string,
    updates: Array<{ id: string; status: TodoStatus; skipReason?: string }>
): { updated: TodoItem[]; notFound: string[]; errors: string[] } {
    const todos = getOrCreateTodoList(conversation, agentPubkey);

    const updated: TodoItem[] = [];
    const notFound: string[] = [];
    const errors: string[] = [];
    const now = Date.now();

    for (const update of updates) {
        const todo = todos.find((t) => t.id === update.id);
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

    return { updated, notFound, errors };
}

// ============================================================================
// todo_add
// ============================================================================

const todoAddItemSchema = z.object({
    title: z.string().describe("Short title for the todo item (becomes the ID as a slug)"),
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
}

async function executeTodoAdd(
    input: TodoAddInput,
    context: ExecutionContext
): Promise<TodoAddOutput> {
    const conversation = context.getConversation();
    if (!conversation) {
        return {
            success: false,
            added: [],
            duplicates: [],
            totalItems: 0,
        };
    }

    const result = addTodosToConversation(
        conversation,
        context.agent.pubkey,
        input.items.map((item) => ({
            title: item.title,
            description: item.description,
            position: item.position,
        }))
    );

    const todos = conversation.agentTodos.get(context.agent.pubkey) || [];

    return {
        success: result.added.length > 0,
        added: result.added.map((t) => ({ id: t.id, title: t.title, position: t.position })),
        duplicates: result.duplicates,
        totalItems: todos.length,
    };
}

export function createTodoAddTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
        `## Task Management
You have access to the todo_add and todo_update tools to help you manage and plan tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.
These tools are also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable.

## Task Execution Rules
- Exactly ONE task must be in_progress at any time (not less, not more)
- Complete current tasks before starting new ones
- Mark todos as done IMMEDIATELY after finishing (don't batch completions)
- If a new request comes in while working: add it as pending, acknowledge it, finish current task first
- Exception: if new request is blocking or urgent, ask about priority rather than just queuing`,
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
}

async function executeTodoUpdate(
    input: TodoUpdateInput,
    context: ExecutionContext
): Promise<TodoUpdateOutput> {
    const conversation = context.getConversation();
    if (!conversation) {
        return {
            success: false,
            updated: [],
            notFound: [],
            errors: ["No conversation context available"],
            pendingCount: 0,
        };
    }

    const result = updateTodoStatusInConversation(
        conversation,
        context.agent.pubkey,
        input.items.map((item) => ({
            id: item.id,
            status: item.status as TodoStatus,
            skipReason: item.skip_reason,
        }))
    );

    const todos = conversation.agentTodos.get(context.agent.pubkey) || [];
    const pendingCount = todos.filter((t) => t.status === "pending").length;

    return {
        success: result.updated.length > 0 && result.errors.length === 0,
        updated: result.updated.map((t) => ({ id: t.id, status: t.status })),
        notFound: result.notFound,
        errors: result.errors,
        pendingCount,
    };
}

export function createTodoUpdateTool(context: ExecutionContext): AISdkTool {
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

// ============================================================================
// Exported helper for use by other modules (e.g., AgentExecutor for phases)
// ============================================================================

export { addTodosToConversation };
