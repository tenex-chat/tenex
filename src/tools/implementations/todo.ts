/**
 * Todo Tools - Conversation-scoped todo list management for agents
 *
 * Provides todo_write functionality for full state replacement.
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

/**
 * Simple deterministic hash for generating fallback IDs.
 * Returns a hex string based on the input.
 */
function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    // Convert to positive hex string
    return Math.abs(hash).toString(16);
}

/**
 * Generates a slug-style ID from a title.
 * Converts to lowercase, replaces spaces/special chars with hyphens, and removes consecutive hyphens.
 * Falls back to a deterministic hash if the title produces an empty slug (e.g., emoji-only or non-ASCII titles).
 */
function generateIdFromTitle(title: string): string {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "") // Remove special characters except spaces and hyphens
        .replace(/\s+/g, "-") // Replace spaces with hyphens
        .replace(/-+/g, "-") // Replace consecutive hyphens with single hyphen
        .replace(/^-|-$/g, ""); // Remove leading/trailing hyphens

    // Fall back to hash if slug is empty (non-ASCII/emoji-only titles)
    if (slug === "") {
        return `todo-${simpleHash(title)}`;
    }

    return slug;
}

/**
 * Validates and writes the complete todo list, replacing all existing items.
 * Implements safety check to prevent accidental deletions.
 */
function writeTodosToConversation(
    conversation: ConversationStore,
    agentPubkey: string,
    newItems: Array<{
        id: string;
        title: string;
        description?: string; // undefined means "preserve existing" for updates
        status: TodoStatus;
        skip_reason?: string;
    }>,
    force: boolean
): {
    success: boolean;
    items: TodoItem[];
    error?: string;
    missingIds?: string[];
} {
    const existingTodos = conversation.getTodos(agentPubkey);
    const now = getCurrentTimestamp();

    // Build a map of new item IDs for quick lookup
    const newItemIds = new Set(newItems.map((item) => item.id));

    // Check for duplicate IDs in the input array
    if (newItemIds.size !== newItems.length) {
        const seen = new Set<string>();
        const duplicates: string[] = [];
        for (const item of newItems) {
            if (seen.has(item.id)) {
                duplicates.push(item.id);
            }
            seen.add(item.id);
        }
        return {
            success: false,
            items: [],
            error: `Duplicate IDs in input: ${duplicates.join(", ")}`,
        };
    }

    // Safety check: find any existing IDs that are missing from the new list
    const existingIds = existingTodos.map((t) => t.id);
    const missingIds = existingIds.filter((id) => !newItemIds.has(id));

    if (missingIds.length > 0 && !force) {
        return {
            success: false,
            items: [],
            error: `Safety check failed: ${missingIds.length} existing item(s) would be removed. Use force=true to allow removal.`,
            missingIds,
        };
    }

    // Validate skip_reason requirement
    for (const item of newItems) {
        if (item.status === "skipped" && !item.skip_reason) {
            return {
                success: false,
                items: [],
                error: `Validation failed: skip_reason is required when status='skipped' (item: ${item.id})`,
            };
        }
    }

    // Build the new todo list, preserving timestamps for existing items
    // Array order determines position (index-based ordering)
    const existingMap = new Map(existingTodos.map((t) => [t.id, t]));
    const newTodos: TodoItem[] = newItems.map((item) => {
        const existing = existingMap.get(item.id);
        return {
            id: item.id,
            title: item.title,
            // Preserve existing description if not provided in update (undefined means "keep existing")
            description: item.description ?? existing?.description ?? "",
            status: item.status,
            skipReason: item.skip_reason,
            createdAt: existing?.createdAt ?? now,
            updatedAt: existing && existing.status === item.status ? existing.updatedAt : now,
        };
    });

    // Persist the new list
    conversation.setTodos(agentPubkey, newTodos);

    return {
        success: true,
        items: newTodos,
    };
}

// ============================================================================
// todo_write
// ============================================================================

const todoWriteItemSchema = z.object({
    id: z.string().optional().describe("Optional unique identifier. Auto-generated from title if not provided."),
    title: z.string().describe("Short human-readable title for the todo item"),
    description: z.string().optional().describe("Optional detailed description. When updating existing items, omitting preserves the current description. For new items, defaults to empty string."),
    status: z
        .enum(["pending", "in_progress", "done", "skipped"])
        .describe("Current status of the item"),
    skip_reason: z
        .string()
        .optional()
        .describe("Required when status='skipped' - explain why this item was skipped"),
});

const todoWriteSchema = z.object({
    todos: z.array(todoWriteItemSchema).describe("The complete todo list. All items must be provided - this replaces the entire list."),
    force: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, allows removing items from the list. Default false (safety check prevents removals)."),
});

type TodoWriteInput = z.infer<typeof todoWriteSchema>;

interface TodoWriteOutput {
    success: boolean;
    message: string;
    totalItems: number;
    error?: string;
    missingIds?: string[];
}

async function executeTodoWrite(
    input: TodoWriteInput,
    context: ConversationToolContext
): Promise<TodoWriteOutput> {
    const conversation = context.getConversation();

    const result = writeTodosToConversation(
        conversation,
        context.agent.pubkey,
        input.todos.map((item) => ({
            id: item.id ?? generateIdFromTitle(item.title),
            title: item.title,
            description: item.description, // Pass undefined to preserve existing; handled in writeTodosToConversation
            status: item.status as TodoStatus,
            skip_reason: item.skip_reason,
        })),
        input.force ?? false
    );

    // Generate a concise message based on the operation
    let message: string;
    if (!result.success) {
        message = result.error || "Failed to write todos";
    } else if (result.items.length === 0) {
        message = "Todo list cleared";
    } else if (result.items.length === 1) {
        message = `Todo list updated with 1 item`;
    } else {
        message = `Todo list updated with ${result.items.length} items`;
    }

    return {
        success: result.success,
        message,
        totalItems: result.items.length,
        error: result.error,
        missingIds: result.missingIds,
    };
}

export function createTodoWriteTool(context: ConversationToolContext): AISdkTool {
    const aiTool = tool({
        description:
            "Write the complete todo list, replacing all existing items. Provide ALL items you want to exist - " +
            "this is a full state replacement. By default, removing existing items is blocked (safety check). " +
            "Set force=true to allow item removal. Each item requires: title and status. " +
            "Optional: id (auto-generated from title if not provided), description (preserved on update if omitted, empty for new items). " +
            "Use skip_reason when status='skipped'. " +
            "NOTE: If an existing item used a custom ID and you omit the id field, the auto-generated ID won't match, " +
            "which will trigger the safety check (or require force=true). Always include IDs for items with custom IDs.",
        inputSchema: todoWriteSchema,
        execute: async (input: TodoWriteInput) => {
            return await executeTodoWrite(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ todos }: TodoWriteInput) => {
            if (todos.length === 0) {
                return "Clearing todo list";
            }
            if (todos.length === 1) {
                return `Writing todo list with 1 item: "${todos[0].title}"`;
            }
            return `Writing todo list with ${todos.length} items`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
