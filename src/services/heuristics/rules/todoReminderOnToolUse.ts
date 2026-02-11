/**
 * Todo Reminder on Tool Use Heuristic
 *
 * Injects a system reminder on ANY tool use (except todo_write variants)
 * when the agent has no todos. This encourages proactive todo list creation.
 */

import type { Heuristic, HeuristicContext, HeuristicResult } from "../types";

const HEURISTIC_ID = "todo-reminder-on-tool-use";

/**
 * Tools that are exempt from the todo reminder
 * These are the todo tools themselves (both naked and MCP-wrapped)
 */
const TODO_TOOLS = new Set([
  "todo_write",
  "mcp__tenex__todo_write",
  "TodoWrite", // Legacy name that might appear in recentTools
]);

/**
 * Inject a reminder to use todo_write on every non-todo tool call
 * when the agent has no todos.
 */
export const todoReminderOnToolUseHeuristic: Heuristic = {
  id: HEURISTIC_ID,
  name: "Todo Reminder on Tool Use",
  description: "Reminds agents to create a todo list when using tools without one",

  evaluate(context: HeuristicContext): HeuristicResult {
    // Skip if this IS a todo tool
    if (TODO_TOOLS.has(context.tool.name)) {
      return null;
    }

    // Skip if agent already has todos (hasTodoWrite flag means they've called todo_write this RAL)
    if (context.state.hasTodoWrite) {
      return null;
    }

    // Violation: Using a tool without having created todos
    // Note: The framework already injects heuristic violations as system messages,
    // so no need to wrap in <system-reminder> tags here
    return {
      id: `${HEURISTIC_ID}-${context.tool.callId}`,
      heuristicId: HEURISTIC_ID,
      title: "Consider Creating a Todo List",
      severity: "warning",
      timestamp: context.evaluationTimestamp,
      message: [
        "You haven't created a todo list yet. Consider using `todo_write()` to track your work.",
        "",
        "Benefits of using todos:",
        "- Shows your progress to observers",
        "- Helps you stay organized",
        "- Required before delegating to other agents",
        "",
        "Even a simple 1-2 item todo list is valuable!",
      ].join("\n"),
    };
  },
};
