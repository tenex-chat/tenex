import { describe, expect, it } from "bun:test";
import { renderTelegramToolPublication } from "@/services/telegram/telegram-runtime-tool-publications";

describe("renderTelegramToolPublication", () => {
    it("renders todo_write payloads into a Telegram-friendly progress update", () => {
        const result = renderTelegramToolPublication({
            toolName: "todo_write",
            content: "Executing todo_write",
            args: {
                todos: [
                    {
                        title: "Read first poetry file for word count",
                        status: "in_progress",
                    },
                    {
                        title: "Read second poetry file for word count",
                        status: "pending",
                        description: "Continue after counting file one",
                    },
                    {
                        title: "Escalate blocked item",
                        status: "skipped",
                        skip_reason: "Waiting on user input",
                    },
                ],
            },
        });

        expect(result).toBe(
            [
                "**Updating todo list**",
                "",
                "3 items: 1 in progress, 1 pending, 1 skipped",
                "",
                "- In progress: Read first poetry file for word count",
                "- Pending: Read second poetry file for word count (Continue after counting file one)",
                "- Skipped: Escalate blocked item (reason: Waiting on user input)",
            ].join("\n")
        );
    });

    it("supports MCP-wrapped todo_write tool names", () => {
        const result = renderTelegramToolPublication({
            toolName: "mcp__tenex__todo_write",
            content: "Executing tenex's todo_write",
            args: {
                todos: [
                    {
                        title: "Track current task",
                        status: "pending",
                    },
                ],
            },
        });

        expect(result).toContain("**Updating todo list**");
        expect(result).toContain("- Pending: Track current task");
    });

    it("renders intentional empty todo lists distinctly from malformed payloads", () => {
        expect(renderTelegramToolPublication({
            toolName: "todo_write",
            content: "Executing todo_write",
            args: {
                todos: [],
            },
        })).toBe(
            [
                "**Updating todo list**",
                "",
                "- Requested todo list is empty.",
            ].join("\n")
        );
    });

    it("returns undefined for tool uses that are not allowlisted", () => {
        expect(renderTelegramToolPublication({
            toolName: "shell_execute",
            content: "Executing shell_execute",
            args: { command: "pwd" },
        })).toBeUndefined();
    });
});
