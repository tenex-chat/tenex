/**
 * ConcurrentRALCoordinator - Manages coordination between concurrent RALs
 *
 * Responsible for:
 * - Building context messages for agents about other active RALs
 * - Determining when paused RALs should be released
 * - Providing tool availability based on RAL state
 */

import type { RALSummary } from "@/services/ral";
import type { ModelMessage } from "ai";

export interface StepInfo {
  stepNumber: number;
  toolCalls: Array<{ toolName: string }>;
  text: string;
  reasoningText?: string;
}

export interface RALToolAvailability {
  ralNumber: number;
  canAbort: boolean;
  abortReason?: string;
}

/**
 * Format a ModelMessage for display in concurrent RAL context
 */
function formatMessageForContext(msg: ModelMessage): string {
  if (msg.role === "system") {
    const content = String(msg.content);
    if (content.length > 200) {
      return `[system] ${content.substring(0, 200)}...`;
    }
    return `[system] ${content}`;
  }

  if (msg.role === "user") {
    const content = String(msg.content);
    if (content.length > 300) {
      return `[user] ${content.substring(0, 300)}...`;
    }
    return `[user] ${content}`;
  }

  if (msg.role === "assistant") {
    const parts: string[] = [];

    if (typeof msg.content === "string" && msg.content.trim()) {
      const text = msg.content.length > 300
        ? msg.content.substring(0, 300) + "..."
        : msg.content;
      parts.push(`[assistant] ${text}`);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text.trim()) {
          const text = part.text.length > 300
            ? part.text.substring(0, 300) + "..."
            : part.text;
          parts.push(`[assistant] ${text}`);
        } else if (part.type === "tool-call") {
          const inputStr = JSON.stringify(part.input);
          const inputPreview = inputStr.substring(0, 100);
          parts.push(`[tool-call] ${part.toolName}(${inputPreview}${inputStr.length > 100 ? "..." : ""})`);
        }
      }
    }

    return parts.join("\n");
  }

  if (msg.role === "tool") {
    if (Array.isArray(msg.content)) {
      return msg.content.map(result => {
        if (result.type !== "tool-result") return "";
        const resultStr = typeof result.output === "string"
          ? result.output
          : JSON.stringify(result.output);
        const preview = resultStr.length > 200
          ? resultStr.substring(0, 200) + "..."
          : resultStr;
        return `[tool-result] ${preview}`;
      }).filter(s => s.length > 0).join("\n");
    }
  }

  return `[${msg.role}] (content omitted)`;
}

/**
 * Format RAL's unique message history for context
 */
function formatRALHistory(uniqueMessages: ModelMessage[]): string {
  if (uniqueMessages.length === 0) return "(no messages yet)";

  const lastMessages = uniqueMessages.slice(-10);

  return lastMessages
    .map(formatMessageForContext)
    .filter(s => s.length > 0)
    .join("\n");
}

export class ConcurrentRALCoordinator {
  /**
   * Determine tool availability for each RAL
   * - ral_abort is only available if RAL has no pending delegations
   */
  getToolAvailability(rals: RALSummary[]): RALToolAvailability[] {
    return rals.map(ral => {
      const hasPendingDelegations = ral.pendingDelegations.length > 0;
      return {
        ralNumber: ral.ralNumber,
        canAbort: !hasPendingDelegations,
        abortReason: hasPendingDelegations
          ? `Has ${ral.pendingDelegations.length} pending delegation(s) - use ral_inject to tell it to stop and cancel its delegations`
          : undefined,
      };
    });
  }

  /**
   * Determine if paused RALs should be released based on completed steps
   *
   * Release when:
   * - At least one step has completed (stepNumber > 0)
   * - AND that step had tool calls (agent made an actual decision)
   *
   * Don't release when:
   * - No steps completed yet
   * - Only reasoning/thinking was produced (no tool calls)
   */
  shouldReleasePausedRALs(steps: StepInfo[]): boolean {
    if (steps.length === 0) {
      return false;
    }

    // Check if any step had tool calls (agent made a decision)
    return steps.some(step => step.toolCalls.length > 0);
  }

  /**
   * Build the context message for an agent about other active RALs
   * @param otherRALs - Summaries of other active RALs
   * @param currentRALNumber - The RAL number of the agent receiving this context
   */
  buildContext(otherRALs: RALSummary[], currentRALNumber: number): string {
    if (otherRALs.length === 0) return "";

    const toolAvailability = this.getToolAvailability(otherRALs);

    const ralDescriptions = otherRALs.map(ral => {
      const status = ral.isStreaming ? "actively streaming" :
        ral.hasPendingDelegations ? "waiting on delegations" : "idle";

      const ageMinutes = Math.round((Date.now() - ral.createdAt) / 60000);

      let delegationInfo = "";
      if (ral.pendingDelegations.length > 0) {
        const delegationList = ral.pendingDelegations
          .map(d => `${d.recipientSlug || "agent"}: "${d.prompt}" (event_id: ${d.eventId.substring(0, 8)}...)`)
          .join("\n    ");
        delegationInfo = `\n  Pending delegations:\n    ${delegationList}`;
      }

      const history = formatRALHistory(ral.uniqueMessages);

      return `RAL #${ral.ralNumber} (${status}, started ${ageMinutes}m ago):
  Current tool: ${ral.currentTool || "none"}${delegationInfo}
  Message history:
${history.split("\n").map(line => "    " + line).join("\n")}`;
    }).join("\n\n");

    // Build tool instructions based on availability
    const abortableRALs = toolAvailability.filter(t => t.canAbort);
    const nonAbortableRALs = toolAvailability.filter(t => !t.canAbort);

    let toolInstructions = `Available tools for coordination:
- ral_inject(ral_number, message): Send an instruction to that RAL (it will see it when it next processes)`;

    if (abortableRALs.length > 0) {
      toolInstructions += `
- ral_abort(ral_number): Immediately stop a RAL (available for: ${abortableRALs.map(t => `#${t.ralNumber}`).join(", ")})`;
    }

    if (nonAbortableRALs.length > 0) {
      const reasons = nonAbortableRALs.map(t => `RAL #${t.ralNumber}: ${t.abortReason}`).join("\n  ");
      toolInstructions += `

Note: Some RALs cannot be aborted directly:
  ${reasons}`;
    }

    return `
CONCURRENT EXECUTION CONTEXT:
YOU ARE RAL #${currentRALNumber} - a NEW execution that just started.
You are NOT any of the other RALs listed below. They are PAUSED waiting for YOUR decision.

Other active executions in this conversation (currently PAUSED):

${ralDescriptions}

${toolInstructions}

CRITICAL: You must coordinate with paused RALs before proceeding:

1. If the user's request CONFLICTS with or CHANGES what a paused RAL is doing:
   → Use ral_inject FIRST to tell that RAL to change its behavior
   → Example: User says "write jokes instead" while RAL #1 is writing poems
   → Call: ral_inject(1, "STOP your current task. The user changed their request to: write jokes instead.")

2. If the user wants to CANCEL a paused RAL entirely:
   → Use ral_abort if available, OR ral_inject with stop instruction if it has delegations

3. If the user's request is UNRELATED to the paused RALs:
   → Proceed with your own work (the paused RALs will resume automatically)

The paused RALs will resume after you make your first tool call. Decide NOW.
`;
  }
}

// Singleton instance for convenience
let coordinatorInstance: ConcurrentRALCoordinator | undefined;

export function getConcurrentRALCoordinator(): ConcurrentRALCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new ConcurrentRALCoordinator();
  }
  return coordinatorInstance;
}
