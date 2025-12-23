/**
 * Todo Tools - RAL-scoped todo list management for agents
 *
 * Provides todo_add and todo_update functionality.
 * Todos are stored in RALState (in-memory, ephemeral per execution).
 */

import type { ExecutionContext } from "@/agents/execution/types";
import { RALRegistry } from "@/services/ral";
import type { TodoStatus } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { tool } from "ai";
import { z } from "zod";

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
    const ralRegistry = RALRegistry.getInstance();
    const ralNumber = context.ralNumber!;

    const result = ralRegistry.addTodos(
        context.agent.pubkey,
        context.conversationId,
        ralNumber,
        input.items.map((item) => ({
            title: item.title,
            description: item.description,
            position: item.position,
        }))
    );

    const todos = ralRegistry.getTodos(context.agent.pubkey, context.conversationId, ralNumber);

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
            "Add items to your todo list. Each item gets a unique ID derived from its title. " +
            "Todos are scoped to this execution and help track progress on complex tasks.",
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
    const ralRegistry = RALRegistry.getInstance();
    const ralNumber = context.ralNumber!;

    const result = ralRegistry.updateTodoStatus(
        context.agent.pubkey,
        context.conversationId,
        ralNumber,
        input.items.map((item) => ({
            id: item.id,
            status: item.status as TodoStatus,
            skipReason: item.skip_reason,
        }))
    );

    const todos = ralRegistry.getTodos(context.agent.pubkey, context.conversationId, ralNumber);
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
