/**
 * Todo Tools - In-memory todo list management for agents
 *
 * Provides todo_add, todo_list, and todo_remove functionality.
 * Each agent's todo list is stored in memory, keyed by their pubkey.
 */

import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
import { tool } from "ai";
import { z } from "zod";

// In-memory storage for todo lists, keyed by agent pubkey
const todoStorage = new Map<string, string[]>();

/**
 * Get the todo list for an agent
 */
function getTodoList(pubkey: string): string[] {
    if (!todoStorage.has(pubkey)) {
        todoStorage.set(pubkey, []);
    }
    return todoStorage.get(pubkey)!;
}

// ============================================================================
// todo_add
// ============================================================================

const todoAddSchema = z.object({
    item: z.string().describe("The todo item to add to the list"),
});

type TodoAddInput = z.infer<typeof todoAddSchema>;

interface TodoAddOutput {
    success: boolean;
    message: string;
    item: string;
    totalItems: number;
}

async function executeTodoAdd(input: TodoAddInput, context: ExecutionContext): Promise<TodoAddOutput> {
    const { item } = input;
    const pubkey = context.agent.pubkey;

    const todoList = getTodoList(pubkey);

    // Check for duplicates
    if (todoList.includes(item)) {
        return {
            success: false,
            message: "Item already exists in the todo list",
            item,
            totalItems: todoList.length,
        };
    }

    todoList.push(item);

    return {
        success: true,
        message: "Item added successfully",
        item,
        totalItems: todoList.length,
    };
}

export function createTodoAddTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description: "Add a new item to your todo list. Each agent has their own separate todo list stored in memory.",
        inputSchema: todoAddSchema,
        execute: async (input: TodoAddInput) => {
            return await executeTodoAdd(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ item }: TodoAddInput) => `Adding todo: "${item}"`,
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}

// ============================================================================
// todo_list
// ============================================================================

const todoListSchema = z.object({}).describe("No parameters required");

interface TodoListOutput {
    items: string[];
    count: number;
}

async function executeTodoList(context: ExecutionContext): Promise<TodoListOutput> {
    const pubkey = context.agent.pubkey;
    const todoList = getTodoList(pubkey);

    return {
        items: [...todoList],
        count: todoList.length,
    };
}

export function createTodoListTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description: "List all items on your todo list. Returns all todo items for the current agent.",
        inputSchema: todoListSchema,
        execute: async () => {
            return await executeTodoList(context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: () => "Listing todo items",
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}

// ============================================================================
// todo_remove
// ============================================================================

const todoRemoveSchema = z.object({
    item: z.string().describe("The todo item to remove from the list"),
});

type TodoRemoveInput = z.infer<typeof todoRemoveSchema>;

interface TodoRemoveOutput {
    success: boolean;
    message: string;
    item: string;
    remainingItems: number;
}

async function executeTodoRemove(input: TodoRemoveInput, context: ExecutionContext): Promise<TodoRemoveOutput> {
    const { item } = input;
    const pubkey = context.agent.pubkey;

    const todoList = getTodoList(pubkey);
    const index = todoList.indexOf(item);

    if (index === -1) {
        return {
            success: false,
            message: "Item not found in the todo list",
            item,
            remainingItems: todoList.length,
        };
    }

    todoList.splice(index, 1);

    return {
        success: true,
        message: "Item removed successfully",
        item,
        remainingItems: todoList.length,
    };
}

export function createTodoRemoveTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Remove an item from your todo list. The item must match exactly as it was added.",
        inputSchema: todoRemoveSchema,
        execute: async (input: TodoRemoveInput) => {
            return await executeTodoRemove(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ item }: TodoRemoveInput) => `Removing todo: "${item}"`,
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}

// ============================================================================
// Utility functions for testing/management
// ============================================================================

/**
 * Clear the todo list for an agent (useful for testing)
 */
export function clearTodoList(pubkey: string): void {
    todoStorage.delete(pubkey);
}

/**
 * Clear all todo lists (useful for testing)
 */
export function clearAllTodoLists(): void {
    todoStorage.clear();
}
