import type { Conversation } from "@/conversations/types";
import type { TodoItem } from "@/services/ral/types";
import type { PromptFragment } from "../core/types";

interface AgentTodosArgs {
    conversation: Conversation;
    agentPubkey: string;
}

function formatTodoItem(item: TodoItem): string {
    const statusMarker: Record<string, string> = {
        pending: "[ ]",
        in_progress: "[~]",
        done: "[x]",
        skipped: "[-]",
    };

    let line = `${statusMarker[item.status]} ${item.title}`;

    if (item.status === "skipped" && item.skipReason) {
        line += ` (skipped: ${item.skipReason})`;
    }

    if (item.delegationInstructions) {
        line += " [has delegation instructions]";
    }

    return line;
}

export const agentTodosFragment: PromptFragment<AgentTodosArgs> = {
    id: "agent-todos",
    priority: 6, // After phases (5), before other context
    template: ({ conversation, agentPubkey }) => {
        const todos = conversation.agentTodos.get(agentPubkey) || [];

        if (todos.length === 0) {
            return "";
        }

        const parts: string[] = [];
        const pending = todos.filter((t) => t.status === "pending");
        const inProgress = todos.filter((t) => t.status === "in_progress");
        const done = todos.filter((t) => t.status === "done");
        const skipped = todos.filter((t) => t.status === "skipped");

        parts.push("## Your Current Todo List");
        parts.push("");

        // Summary stats
        parts.push(
            `Status: ${pending.length} pending, ${inProgress.length} in progress, ${done.length} done, ${skipped.length} skipped`
        );
        parts.push("");

        // List all items in order
        const sortedTodos = [...todos].sort((a, b) => a.position - b.position);
        for (const todo of sortedTodos) {
            parts.push(formatTodoItem(todo));
        }

        parts.push("");
        parts.push("**Instructions:**");
        parts.push(
            "- Use `todo_update` to mark items as 'in_progress' when starting, 'done' when complete"
        );
        parts.push("- If skipping an item, set status='skipped' and provide a skip_reason");
        parts.push("- Items with 'pending' status have not been started and require attention");

        if (pending.length > 0) {
            parts.push("");
            parts.push(
                `**ATTENTION:** You have ${pending.length} pending todo item(s) that need to be addressed.`
            );
        }

        return parts.join("\n");
    },
};
