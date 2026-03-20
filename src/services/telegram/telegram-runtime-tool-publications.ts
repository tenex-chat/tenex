import { unwrapMcpToolName } from "@/agents/tool-names";
import type { ToolUseIntent } from "@/nostr/types";
import { z } from "zod";

const MAX_TELEGRAM_TOOL_MESSAGE_LENGTH = 3500;

const todoWriteArgsSchema = z.object({
    todos: z.array(z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(["pending", "in_progress", "done", "skipped"]).optional(),
        skip_reason: z.string().optional(),
    })).optional(),
});

type TodoStatus = "pending" | "in_progress" | "done" | "skipped";

const TODO_STATUS_LABELS: Record<TodoStatus, string> = {
    pending: "Pending",
    in_progress: "In progress",
    done: "Done",
    skipped: "Skipped",
};

const TODO_STATUS_SUMMARY_ORDER: TodoStatus[] = ["in_progress", "pending", "done", "skipped"];

function sanitizeInlineText(value: string | undefined): string {
    return (value ?? "").replace(/\s+/g, " ").trim();
}

function summarizeTodoStatuses(todos: Array<{ status?: TodoStatus }>): string | undefined {
    const counts = new Map<TodoStatus, number>();
    for (const todo of todos) {
        if (!todo.status) {
            continue;
        }
        counts.set(todo.status, (counts.get(todo.status) ?? 0) + 1);
    }

    const segments = TODO_STATUS_SUMMARY_ORDER
        .map((status) => {
            const count = counts.get(status);
            if (!count) {
                return undefined;
            }
            return `${count} ${TODO_STATUS_LABELS[status].toLowerCase()}`;
        })
        .filter((segment): segment is string => Boolean(segment));

    return segments.length > 0 ? segments.join(", ") : undefined;
}

function buildTodoLine(todo: {
    title?: string;
    description?: string;
    status?: TodoStatus;
    skip_reason?: string;
}): string {
    const title = sanitizeInlineText(todo.title) || "Untitled item";
    const statusLabel = todo.status ? TODO_STATUS_LABELS[todo.status] : "Todo";
    const details = [
        sanitizeInlineText(todo.description),
        todo.status === "skipped" && sanitizeInlineText(todo.skip_reason)
            ? `reason: ${sanitizeInlineText(todo.skip_reason)}`
            : undefined,
    ].filter((detail): detail is string => Boolean(detail));

    if (details.length === 0) {
        return `- ${statusLabel}: ${title}`;
    }

    return `- ${statusLabel}: ${title} (${details.join(" | ")})`;
}

function truncateLines(lines: string[]): string {
    const output: string[] = [];

    for (let index = 0; index < lines.length; index++) {
        const nextValue = [...output, lines[index]].join("\n");
        if (nextValue.length <= MAX_TELEGRAM_TOOL_MESSAGE_LENGTH) {
            output.push(lines[index]);
            continue;
        }

        const remaining = lines.length - index;
        if (remaining > 0) {
            output.push(`- ...and ${remaining} more item${remaining === 1 ? "" : "s"}`);
        }
        break;
    }

    return output.join("\n");
}

function renderTodoWriteToolPublication(intent: ToolUseIntent): string {
    const parsed = todoWriteArgsSchema.safeParse(intent.args);
    if (!parsed.success) {
        return [
            "**Updating todo list**",
            "",
            "- The todo payload could not be rendered.",
        ].join("\n");
    }

    const todos = parsed.data.todos ?? [];

    if (todos.length === 0) {
        return [
            "**Updating todo list**",
            "",
            "- Requested todo list is empty.",
        ].join("\n");
    }

    const summary = summarizeTodoStatuses(todos);
    const lines = [
        "**Updating todo list**",
        "",
        `${todos.length} item${todos.length === 1 ? "" : "s"}${summary ? `: ${summary}` : ""}`,
        "",
        ...todos.map(buildTodoLine),
    ];

    return truncateLines(lines);
}

const TELEGRAM_TOOL_PUBLICATIONS: Record<string, (intent: ToolUseIntent) => string> = {
    todo_write: renderTodoWriteToolPublication,
};

export function renderTelegramToolPublication(intent: ToolUseIntent): string | undefined {
    const toolName = unwrapMcpToolName(intent.toolName);
    const renderer = TELEGRAM_TOOL_PUBLICATIONS[toolName];
    return renderer?.(intent);
}
