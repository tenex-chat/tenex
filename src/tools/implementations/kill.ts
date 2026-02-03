/**
 * Unified kill tool - Abort agents or background shell processes
 *
 * This tool provides a unified interface for killing:
 * 1. Agent executions (by conversation_id) - with cascading abort support
 * 2. Background shell processes (by shell_id)
 *
 * When killing an agent by conversation_id, this tool will:
 * - Abort the agent's execution in that conversation
 * - Cascade the abort to all nested delegations (agents this agent delegated to)
 * - Add aborted tuples to cooldown registry to prevent immediate re-routing
 * - Block until all cascade aborts complete
 */

import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { killBackgroundTask, getBackgroundTaskInfo, getAllBackgroundTasks } from "./shell";
import { RALRegistry } from "@/services/ral";
import { CooldownRegistry } from "@/services/CooldownRegistry";
import { ConversationStore } from "@/conversations/ConversationStore";
import { tool } from "ai";
import { z } from "zod";
import { logger } from "@/utils/logger";
import { shortenConversationId } from "@/utils/conversation-id";
import { trace } from "@opentelemetry/api";

const killSchema = z.object({
    target: z
        .string()
        .min(1, "target is required")
        .describe(
            "The target to kill. Can be either:\n" +
            "- A conversation ID (to abort an agent and cascade to nested delegations)\n" +
            "- A shell task ID (to terminate a background shell process)"
        ),
    reason: z
        .string()
        .optional()
        .describe("Optional reason for the kill (used for agent aborts)"),
});

type KillInput = z.infer<typeof killSchema>;

interface KillOutput {
    success: boolean;
    message: string;
    target: string;
    targetType: "agent" | "shell";
    /** For agent kills: number of agents aborted in cascade */
    cascadeAbortCount?: number;
    /** For agent kills: list of aborted conversation:agent tuples */
    abortedTuples?: Array<{ conversationId: string; agentPubkey: string }>;
    /** For shell kills: process info */
    pid?: number;
    taskInfo?: {
        command: string;
        description: string | null;
        outputFile: string;
        startTime: string;
    };
}

/**
 * Core implementation of the unified kill functionality
 */
async function executeKill(input: KillInput, context: ToolExecutionContext): Promise<KillOutput> {
    const { target, reason } = input;

    // Get caller's project ID for filtering (prevents cross-project metadata leakage)
    const callerConversation = context.getConversation?.();
    const callerProjectId = callerConversation?.getProjectId();

    // Determine if target is a conversation ID or shell task ID
    // Convention: conversation IDs are hex strings (64 chars), shell task IDs are UUIDs
    const isConversationId = ConversationStore.has(target);
    const isShellTaskId = !isConversationId && getBackgroundTaskInfo(target) !== null;

    if (!isConversationId && !isShellTaskId) {
        // Try partial match for conversation ID (prefix lookup)
        const allConversations = ConversationStore.getAll();
        const matchingConv = allConversations.find((c) => c.id.startsWith(target));

        if (matchingConv) {
            // Found a conversation by prefix - use it
            return await killAgent(matchingConv.id, reason, context);
        }

        // Not found - provide helpful error with project-filtered listings
        // SECURITY: Only show tasks/conversations from caller's project to prevent metadata leakage
        let errorMessage = `Target '${target}' not found.`;

        if (callerProjectId) {
            // Filter by caller's project to prevent cross-project information disclosure
            const projectTasks = getAllBackgroundTasks().filter(
                (t) => t.projectId === callerProjectId
            );
            const projectConversations = allConversations.filter(
                (c) => c.getProjectId() === callerProjectId
            );

            if (projectTasks.length > 0) {
                errorMessage += ` Available background tasks in this project: ${projectTasks
                    .map((t) => t.taskId)
                    .join(", ")}.`;
            }

            if (projectConversations.length > 0) {
                errorMessage += ` Active conversations in this project: ${projectConversations
                    .map((c) => c.id.substring(0, 12))
                    .join(", ")}.`;
            } else if (projectTasks.length === 0) {
                errorMessage += " No active tasks or conversations found in this project.";
            }
        } else {
            // No project context - return generic error without enumeration
            errorMessage += " Unable to list available targets without project context.";
        }

        return {
            success: false,
            message: errorMessage,
            target,
            targetType: "agent",
        };
    }

    if (isConversationId) {
        return await killAgent(target, reason, context);
    } else {
        return killShellTask(target, context);
    }
}

/**
 * Kill an agent execution with cascading abort
 */
async function killAgent(
    conversationId: string,
    reason: string | undefined,
    context: ToolExecutionContext
): Promise<KillOutput> {
    const ralRegistry = RALRegistry.getInstance();
    const cooldownRegistry = CooldownRegistry.getInstance();
    const conversation = ConversationStore.get(conversationId);

    if (!conversation) {
        return {
            success: false,
            message: `Conversation ${conversationId.substring(0, 12)} not found`,
            target: conversationId,
            targetType: "agent",
        };
    }

    // Find the agent executing in this conversation
    const activeRals = conversation.getAllActiveRals();
    if (activeRals.size === 0) {
        return {
            success: false,
            message: `No active agents found in conversation ${conversationId.substring(0, 12)}`,
            target: conversationId,
            targetType: "agent",
        };
    }

    // Get projectId for proper cooldown isolation
    const projectId = conversation.getProjectId();
    if (!projectId) {
        return {
            success: false,
            message: `Cannot abort: conversation ${conversationId.substring(0, 12)} has no project ID`,
            target: conversationId,
            targetType: "agent",
        };
    }

    // === AUTHORIZATION: Project Isolation Check ===
    // Verify that the caller's project context matches the target conversation's project.
    // This prevents cross-project kills and ensures agents can only kill within their own project.
    const callerConversation = context.getConversation?.();
    const callerProjectId = callerConversation?.getProjectId();

    if (!callerProjectId) {
        logger.warn("[kill] Authorization check failed: caller has no project context", {
            callerAgent: context.agent.slug,
            targetConversationId: conversationId.substring(0, 12),
            targetProjectId: projectId.substring(0, 12),
        });

        trace.getActiveSpan()?.addEvent("kill.authorization_failed", {
            "kill.reason": "caller_no_project",
            "kill.caller_agent": context.agent.slug,
            "kill.target_conversation_id": shortenConversationId(conversationId),
        });

        return {
            success: false,
            message: `Authorization failed: cannot kill agents without project context`,
            target: conversationId,
            targetType: "agent",
        };
    }

    if (callerProjectId !== projectId) {
        logger.warn("[kill] Authorization check failed: cross-project kill attempt blocked", {
            callerAgent: context.agent.slug,
            callerProjectId: callerProjectId.substring(0, 12),
            targetConversationId: conversationId.substring(0, 12),
            targetProjectId: projectId.substring(0, 12),
        });

        trace.getActiveSpan()?.addEvent("kill.authorization_failed", {
            "kill.reason": "cross_project_kill_blocked",
            "kill.caller_agent": context.agent.slug,
            "kill.caller_project_id": callerProjectId.substring(0, 12),
            "kill.target_project_id": projectId.substring(0, 12),
        });

        return {
            success: false,
            message: `Authorization failed: cannot kill agents in other projects (target: ${projectId.substring(0, 12)}, caller: ${callerProjectId.substring(0, 12)})`,
            target: conversationId,
            targetType: "agent",
        };
    }

    // Authorization passed - log audit trail
    logger.info("[kill] Authorization check passed for agent kill", {
        callerAgent: context.agent.slug,
        callerConversationId: context.conversationId.substring(0, 12),
        targetConversationId: conversationId.substring(0, 12),
        projectId: projectId.substring(0, 12),
    });

    // Get the first active agent (in multi-agent conversations, we abort all)
    const agentPubkey = Array.from(activeRals.keys())[0];

    trace.getActiveSpan()?.addEvent("kill.agent_abort_starting", {
        "kill.project_id": projectId.substring(0, 12),
        "kill.conversation_id": shortenConversationId(conversationId),
        "kill.agent_pubkey": agentPubkey.substring(0, 12),
        "kill.reason": reason ?? "manual kill",
        "kill.cascade_enabled": true,
    });

    logger.info("[kill] Aborting agent with cascade", {
        projectId: projectId.substring(0, 12),
        conversationId: shortenConversationId(conversationId),
        agentPubkey: agentPubkey.substring(0, 12),
        reason,
    });

    // Perform cascading abort (blocks until all descendants are aborted)
    const result = await ralRegistry.abortWithCascade(
        agentPubkey,
        conversationId,
        projectId,
        reason ?? "manual kill via kill tool",
        cooldownRegistry
    );

    trace.getActiveSpan()?.addEvent("kill.agent_abort_completed", {
        "kill.conversation_id": shortenConversationId(conversationId),
        "kill.agent_pubkey": agentPubkey.substring(0, 12),
        "kill.direct_aborted": result.abortedCount,
        "kill.cascade_aborted": result.descendantConversations.length,
        "kill.total_aborted": result.abortedCount + result.descendantConversations.length,
    });

    const totalAborted = result.abortedCount + result.descendantConversations.length;

    return {
        success: true,
        message: `Aborted agent in conversation ${conversationId.substring(0, 12)} with ${result.descendantConversations.length} cascaded aborts`,
        target: conversationId,
        targetType: "agent",
        cascadeAbortCount: totalAborted,
        abortedTuples: [
            { conversationId, agentPubkey },
            ...result.descendantConversations,
        ],
    };
}

/**
 * Kill a background shell task
 */
function killShellTask(taskId: string, context: ToolExecutionContext): KillOutput {
    // Get task info before killing (for reporting)
    const taskInfo = getBackgroundTaskInfo(taskId);

    // === AUTHORIZATION: Shell Task Project Isolation ===
    // Shell tasks are bound to projectId at creation time.
    // Verify caller's projectId matches task's projectId before allowing kill operation.
    const callerConversation = context.getConversation?.();
    const callerProjectId = callerConversation?.getProjectId();

    if (!callerProjectId) {
        logger.warn("[kill] Authorization check failed: caller has no project context for shell kill", {
            callerAgent: context.agent?.slug ?? "unknown",
            targetTaskId: taskId,
        });

        trace.getActiveSpan()?.addEvent("kill.shell_authorization_failed", {
            "kill.reason": "caller_no_project",
            "kill.caller_agent": context.agent?.slug ?? "unknown",
            "kill.target_task_id": taskId,
        });

        return {
            success: false,
            message: `Authorization failed: cannot kill shell tasks without project context`,
            target: taskId,
            targetType: "shell",
        };
    }

    // Verify task exists and belongs to caller's project
    if (!taskInfo) {
        logger.warn("[kill] Task not found", {
            callerAgent: context.agent?.slug ?? "unknown",
            targetTaskId: taskId,
        });

        return {
            success: false,
            message: `Task ${taskId} not found`,
            target: taskId,
            targetType: "shell",
        };
    }

    // CRITICAL: Enforce project isolation - deny kill if projectId doesn't match
    if (taskInfo.projectId !== callerProjectId) {
        logger.warn("[kill] Authorization check failed: project isolation violation", {
            callerAgent: context.agent?.slug ?? "unknown",
            callerProjectId: callerProjectId.substring(0, 12),
            taskProjectId: taskInfo.projectId.substring(0, 12),
            targetTaskId: taskId,
        });

        trace.getActiveSpan()?.addEvent("kill.shell_authorization_failed", {
            "kill.reason": "project_mismatch",
            "kill.caller_agent": context.agent?.slug ?? "unknown",
            "kill.caller_project_id": callerProjectId.substring(0, 12),
            "kill.task_project_id": taskInfo.projectId.substring(0, 12),
            "kill.target_task_id": taskId,
        });

        return {
            success: false,
            message: `Authorization failed: task ${taskId} belongs to a different project`,
            target: taskId,
            targetType: "shell",
        };
    }

    // Log audit trail for shell kill
    logger.info("[kill] Shell task kill requested", {
        callerAgent: context.agent?.slug ?? "unknown",
        callerConversationId: context.conversationId?.substring(0, 12) ?? "unknown",
        callerProjectId: callerProjectId.substring(0, 12),
        targetTaskId: taskId,
        taskCommand: taskInfo?.command,
    });

    trace.getActiveSpan()?.addEvent("kill.shell_task_killing", {
        "kill.caller_agent": context.agent?.slug ?? "unknown",
        "kill.caller_project_id": callerProjectId.substring(0, 12),
        "kill.target_task_id": taskId,
    });

    // Attempt to kill the task
    const result = killBackgroundTask(taskId);

    const output: KillOutput = {
        success: result.success,
        message: result.message,
        target: taskId,
        targetType: "shell",
        pid: result.pid,
    };

    // Include task info if it was found
    if (taskInfo) {
        output.taskInfo = {
            command: taskInfo.command,
            description: taskInfo.description,
            outputFile: taskInfo.outputFile,
            startTime: taskInfo.startTime.toISOString(),
        };
    }

    // If task not found, suggest listing tasks (filtered by project to prevent metadata leakage)
    if (!result.success && !taskInfo && callerProjectId) {
        // SECURITY: Only show tasks from caller's project to prevent cross-project information disclosure
        const projectTasks = getAllBackgroundTasks().filter(
            (t) => t.projectId === callerProjectId
        );
        if (projectTasks.length > 0) {
            output.message += `\n\nAvailable background tasks in this project: ${projectTasks
                .map((t) => t.taskId)
                .join(", ")}`;
        } else {
            output.message += "\n\nNo background tasks are currently running in this project.";
        }
    }

    // Log audit trail for result
    if (result.success) {
        logger.info("[kill] Shell task killed successfully", {
            taskId,
            pid: result.pid,
            callerAgent: context.agent?.slug ?? "unknown",
            projectId: callerProjectId.substring(0, 12),
        });
    }

    return output;
}

/**
 * Create an AI SDK tool for the unified kill command
 */
export function createKillTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Terminate an agent execution or background shell process. " +
            "For agents: aborts the agent and all nested delegations with 15s cooldown. " +
            "For shells: terminates the background process. " +
            "IMPORTANT: This tool blocks until all cascade aborts complete.",

        inputSchema: killSchema,

        execute: async (input: KillInput) => {
            return await executeKill(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ target }: KillInput) => {
            // Determine type based on target format
            const isConvId = ConversationStore.has(target);
            if (isConvId) {
                return `Killing agent in conversation ${target.substring(0, 12)} (with cascade)`;
            } else {
                return `Killing background task ${target}`;
            }
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
