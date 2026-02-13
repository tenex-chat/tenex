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
import { resolvePrefixToId, normalizeNostrIdentifier } from "@/utils/nostr-entity-parser";
import { nip19 } from "nostr-tools";
import { isFullEventId, isShortEventId, isShellTaskId } from "@/types/event-ids";

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

/**
 * Resolve a target ID from various formats to a canonical full ID.
 *
 * Supports:
 * - 64-char hex: Already a full ID, returned as-is
 * - 12-char hex: Resolve via PrefixKVStore or RALRegistry fallback
 * - 7-char alphanumeric: Shell task ID (returned as-is for separate handling)
 * - NIP-19 formats (nevent, note): Decode to 64-char hex
 *
 * @param input - The target identifier in any supported format
 * @returns Object with resolved ID and type, or null if resolution failed
 */
async function resolveTargetId(input: string): Promise<{
    id: string;
    type: 'conversation' | 'shell' | 'unknown';
    wasResolved: boolean;
} | null> {
    const trimmed = input.trim().toLowerCase();

    // 64-char hex: already a full ID (use typed guard)
    if (isFullEventId(trimmed)) {
        return { id: trimmed, type: 'conversation', wasResolved: false };
    }

    // 12-char hex: resolve via prefix store or RALRegistry fallback (use typed guard)
    if (isShortEventId(trimmed)) {
        // Try PrefixKVStore first (O(1) lookup)
        const resolved = resolvePrefixToId(trimmed);
        if (resolved) {
            logger.debug("[kill.resolveTargetId] Resolved 12-char prefix via PrefixKVStore", {
                prefix: trimmed,
                fullId: resolved.substring(0, 12),
            });
            return { id: resolved, type: 'conversation', wasResolved: true };
        }

        // Fallback: scan RALRegistry for active delegations
        const ralRegistry = RALRegistry.getInstance();
        const ralResolved = ralRegistry.resolveDelegationPrefix(trimmed);
        if (ralResolved) {
            logger.debug("[kill.resolveTargetId] Resolved 12-char prefix via RALRegistry", {
                prefix: trimmed,
                fullId: ralResolved.substring(0, 12),
            });
            return { id: ralResolved, type: 'conversation', wasResolved: true };
        }

        // Prefix not found - could still be valid but unknown
        logger.debug("[kill.resolveTargetId] Could not resolve 12-char prefix", {
            prefix: trimmed,
        });
        return null;
    }

    // 7-char alphanumeric: shell task ID (different ID space, use typed guard)
    if (isShellTaskId(trimmed)) {
        return { id: trimmed, type: 'shell', wasResolved: false };
    }

    // NIP-19 formats (nevent, note)
    const normalized = normalizeNostrIdentifier(input);
    if (normalized && (normalized.startsWith("nevent1") || normalized.startsWith("note1"))) {
        try {
            const decoded = nip19.decode(normalized);
            if (decoded.type === "note" && typeof decoded.data === "string") {
                const eventId = decoded.data.toLowerCase();
                return { id: eventId, type: 'conversation', wasResolved: true };
            }
            if (decoded.type === "nevent" && typeof decoded.data === "object" && decoded.data !== null) {
                const data = decoded.data as { id: string };
                const eventId = data.id.toLowerCase();
                return { id: eventId, type: 'conversation', wasResolved: true };
            }
        } catch (error) {
            logger.debug("[kill.resolveTargetId] Failed to decode NIP-19 identifier", {
                input,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // UUID format (legacy shell task IDs) - check as fallback
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)) {
        return { id: trimmed, type: 'shell', wasResolved: false };
    }

    return null;
}

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

    // Normalize target once for consistent matching throughout
    const normalizedTarget = target.trim().toLowerCase();

    // Get caller's project ID for filtering (prevents cross-project metadata leakage)
    const callerConversation = context.getConversation?.();
    const callerProjectId = callerConversation?.getProjectId();

    // First, try to resolve the target ID to a canonical format
    const resolved = await resolveTargetId(target);

    if (resolved) {
        // Successfully resolved to a known format
        if (resolved.type === 'shell') {
            // Shell task ID - check if it exists and handle
            const taskInfo = getBackgroundTaskInfo(resolved.id);
            if (taskInfo) {
                return killShellTask(resolved.id, context);
            }
            // Shell ID format but task not found - fall through to error
        } else if (resolved.type === 'conversation') {
            // Conversation ID (64-char hex) - check if it exists
            const isConversationId = ConversationStore.has(resolved.id);
            if (isConversationId) {
                return await killAgent(resolved.id, reason, context);
            }
            // Also try prefix match on the resolved ID (in case it's a prefix itself)
            const allConversations = ConversationStore.getAll();
            const matchingConv = allConversations.find((c) => c.id.startsWith(resolved.id));
            if (matchingConv) {
                return await killAgent(matchingConv.id, reason, context);
            }
            // Resolved ID but not found in store - fall through to error
        }
    }

    // Resolution failed or target not found
    // Legacy fallback: try direct lookup with normalized target (handles edge cases)
    const isDirectConversationId = ConversationStore.has(normalizedTarget);
    // Note: getBackgroundTaskInfo returns undefined for non-existent tasks, so use truthiness check
    const isDirectShellTaskId = !isDirectConversationId && !!getBackgroundTaskInfo(normalizedTarget);

    if (isDirectConversationId) {
        return await killAgent(normalizedTarget, reason, context);
    }

    if (isDirectShellTaskId) {
        return killShellTask(normalizedTarget, context);
    }

    // Try partial match for conversation ID (prefix lookup - legacy fallback)
    // Use normalized target to handle uppercase input
    const allConversations = ConversationStore.getAll();
    const matchingConv = allConversations.find((c) => c.id.startsWith(normalizedTarget));

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
            // Use the same detection logic as resolveTargetId for consistent classification
            const trimmed = target.trim().toLowerCase();

            // Check ID format to determine type
            // Shell task IDs are 7-char alphanumeric
            if (isShellTaskId(trimmed)) {
                return `Killing background task ${target}`;
            }

            // Full event IDs (64-char hex) or short prefixes (12-char hex)
            // are conversation/agent targets
            if (isFullEventId(trimmed) || isShortEventId(trimmed)) {
                return `Killing agent in conversation ${trimmed.substring(0, 12)} (with cascade)`;
            }

            // NIP-19 formats (nevent, note) are also agent targets
            const normalized = normalizeNostrIdentifier(target);
            if (normalized && (normalized.startsWith("nevent1") || normalized.startsWith("note1"))) {
                return `Killing agent from ${target.substring(0, 20)}... (with cascade)`;
            }

            // UUID format is shell task (legacy)
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)) {
                return `Killing background task ${target}`;
            }

            // Unknown format - let executeKill determine and error appropriately
            return `Killing target ${target.substring(0, 12)}...`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
