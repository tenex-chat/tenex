import type { AgentInstance } from "@/agents/types";
import type { ScheduledTask } from "@/services/scheduling";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";

/**
 * Converts a cron expression to a human-readable format
 */
function cronToHumanReadable(cronExpression: string): string {
    const parts = cronExpression.split(" ");
    if (parts.length !== 5) {
        return cronExpression; // Return as-is if not a valid cron expression
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Common patterns
    if (minute === "*" && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        return "Every minute";
    }

    if (minute.startsWith("*/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        const interval = minute.replace("*/", "");
        return `Every ${interval} minutes`;
    }

    if (hour.startsWith("*/") && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        const interval = hour.replace("*/", "");
        return `Every ${interval} hours at minute ${minute}`;
    }

    if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        return `Every hour at minute ${minute}`;
    }

    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        return `Daily at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")} UTC`;
    }

    if (dayOfMonth === "*" && month === "*") {
        const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const dayName = days[Number.parseInt(dayOfWeek, 10)] || dayOfWeek;
        return `Every ${dayName} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")} UTC`;
    }

    if (month === "*") {
        return `Monthly on day ${dayOfMonth} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")} UTC`;
    }

    // Fallback to the original expression
    return cronExpression;
}

/**
 * Formats scheduled tasks for display in the agent's system prompt
 */
function formatScheduledTasks(tasks: ScheduledTask[], agentPubkey: string): string {
    // Filter tasks that belong to this agent (tasks where this agent is the target)
    const myTasks = tasks.filter((task) => task.toPubkey === agentPubkey);

    if (myTasks.length === 0) {
        return "";
    }

    const taskLines = myTasks.map((task, index) => {
        const title = task.title || `Task ${index + 1}`;
        const humanCron = cronToHumanReadable(task.schedule);
        const lastRunInfo = task.lastRun ? ` (last run: ${new Date(task.lastRun).toISOString()})` : "";

        return `- **${title}**: ${humanCron} (cron: \`${task.schedule}\`)${lastRunInfo}
  Prompt: "${task.prompt.length > 100 ? `${task.prompt.substring(0, 100)}...` : task.prompt}"`;
    });

    return `## Your Scheduled Tasks

You have ${myTasks.length} scheduled task${myTasks.length === 1 ? "" : "s"} that will trigger automatically:

${taskLines.join("\n\n")}

These tasks run automatically based on their cron schedules. You can use \`schedule_tasks_list\` to see all tasks or \`schedule_task_cancel\` to remove any of them.`;
}

// Scheduled tasks fragment - shows agent's scheduled tasks in system prompt
interface ScheduledTasksArgs {
    agent: AgentInstance;
    scheduledTasks: ScheduledTask[];
}

export const scheduledTasksFragment: PromptFragment<ScheduledTasksArgs> = {
    id: "scheduled-tasks",
    priority: 22, // Between voice-mode (20) and retrieved-lessons (24)
    template: ({ agent, scheduledTasks }) => {
        return formatScheduledTasks(scheduledTasks, agent.pubkey);
    },
    validateArgs: (args): args is ScheduledTasksArgs => {
        return (
            args !== null &&
            typeof args === "object" &&
            "agent" in args &&
            "scheduledTasks" in args &&
            Array.isArray((args as ScheduledTasksArgs).scheduledTasks)
        );
    },
    expectedArgs: "{ agent: AgentInstance, scheduledTasks: ScheduledTask[] }",
};

// Register the fragment
fragmentRegistry.register(scheduledTasksFragment);
