/**
 * Formats RAL (Reason-Act-Loop) summaries for display to agents.
 * Extracted from ConversationStore to separate data storage from presentation.
 */

import type { ToolCallPart, ToolResultPart } from "ai";
import type { ConversationEntry } from "./ConversationStore";

/**
 * Build a human-readable summary of an active RAL's progress.
 * Used when an agent has multiple concurrent RALs and needs context about others.
 */
export function buildRalSummary(
    messages: ConversationEntry[],
    agentPubkey: string,
    ralNumber: number
): string {
    const lines: string[] = [
        `You have another reason-act-loop (#${ralNumber}) executing:`,
        "",
    ];

    for (const entry of messages) {
        if (entry.pubkey !== agentPubkey || entry.ral !== ralNumber) {
            continue;
        }

        if (entry.messageType === "text" && entry.content) {
            lines.push(`[text-output] ${entry.content}`);
        } else if (entry.messageType === "tool-call" && entry.toolData) {
            for (const part of entry.toolData as ToolCallPart[]) {
                const args = formatToolArgs(part.input);
                lines.push(`[tool ${part.toolName}] ${args}`);
            }
        } else if (entry.messageType === "tool-result" && entry.toolData) {
            for (const part of entry.toolData as ToolResultPart[]) {
                const formatted = formatToolResult(part);
                if (formatted) {
                    lines.push(formatted);
                }
            }
        }
    }

    return lines.join("\n");
}

/**
 * Format tool arguments for display.
 */
function formatToolArgs(args: unknown): string {
    if (!args || typeof args !== "object") return "";

    const pairs: string[] = [];
    for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string") {
            pairs.push(`${key}="${value}"`);
        } else {
            pairs.push(`${key}=${JSON.stringify(value)}`);
        }
    }
    return pairs.join(", ");
}

/**
 * Format tool result for display.
 * Only certain tool results are included (e.g., delegate needs delegationConversationIds).
 */
function formatToolResult(part: ToolResultPart): string | null {
    // Include delegate results - agent needs delegationConversationIds for followup
    if (part.toolName === "delegate" && part.output?.type === "json") {
        const result = part.output.value as {
            pendingDelegations?: Array<{
                delegationConversationId: string;
                recipientSlug?: string;
                recipientPubkey: string;
            }>;
        };
        if (result?.pendingDelegations) {
            const ids = result.pendingDelegations
                .map((d) => `${d.recipientSlug ?? d.recipientPubkey}: ${d.delegationConversationId}`)
                .join(", ");
            return `[delegate result] delegationConversationIds: ${ids}`;
        }
    }

    return null;
}
