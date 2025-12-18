import type { ExecutionContext } from "@/agents/execution/types";
import type { AISdkTool } from "@/tools/types";
// import { resolveRecipientToPubkey } from "@/utils/agent-resolution"; // Unused after RAL migration
// import { logger } from "@/utils/logger"; // Unused after RAL migration
import { tool } from "ai";
import { z } from "zod";

/**
 * Base delegation item schema (no phase field)
 */
const baseDelegationItemSchema = z.object({
    recipient: z
        .string()
        .describe(
            "Agent slug (e.g., 'architect'), name (e.g., 'Architect'), npub, or hex pubkey"
        ),
    prompt: z.string().describe("The request or task for this agent"),
    branch: z
        .string()
        .optional()
        .describe("Git branch name for worktree isolation"),
});

/**
 * Extended delegation item schema with phase field (for agents with phases)
 */
const phaseDelegationItemSchema = baseDelegationItemSchema.extend({
    phase: z
        .string()
        .optional()
        .describe("Phase to switch to for this delegation (must be defined in your phases configuration)"),
});

type BaseDelegationItem = z.infer<typeof baseDelegationItemSchema>;
type PhaseDelegationItem = z.infer<typeof phaseDelegationItemSchema>;
type DelegationItem = BaseDelegationItem | PhaseDelegationItem;

interface DelegateInput {
    delegations: DelegationItem[];
    mode: "wait" | "pair";
}

/**
 * Execute delegation with unified logic
 * TODO: This needs to be updated to use RALRegistry (see Task 4 in implementation plan)
 */
async function executeDelegate(
    _input: DelegateInput,
    _context: ExecutionContext
): Promise<any> {
    throw new Error("Delegation tool not yet migrated to RAL system. See Task 4 in experimental-delegation-implementation.md");
}

/**
 * Create the unified delegate tool with conditional schema based on agent phases
 */
export function createDelegateTool(context: ExecutionContext): AISdkTool {
    const hasPhases = context.agent.phases && Object.keys(context.agent.phases).length > 0;

    // Build delegation item schema based on whether agent has phases
    const delegationItemSchema = hasPhases
        ? phaseDelegationItemSchema
        : baseDelegationItemSchema;

    // Build the full schema
    const delegateSchema = z.object({
        delegations: z
            .array(delegationItemSchema)
            .min(1)
            .describe("Array of delegations to execute"),
        mode: z
            .enum(["wait", "pair"])
            .default("wait")
            .describe(
                "Execution mode: 'wait' (default) waits for all completions, 'pair' enables periodic check-ins where you can CONTINUE, STOP, or CORRECT the delegated agent(s)"
            ),
    });

    // Build description based on whether agent has phases
    const description = hasPhases
        ? "Delegate tasks to one or more agents. Supports two modes: 'wait' (default) waits for completion, 'pair' enables periodic check-ins where you can CONTINUE, STOP, or CORRECT the delegated agent(s). Each delegation can have its own prompt, branch, and phase. Provide complete context - agents have no visibility into your conversation."
        : "Delegate tasks to one or more agents. Supports two modes: 'wait' (default) waits for completion, 'pair' enables periodic check-ins where you can CONTINUE, STOP, or CORRECT the delegated agent(s). Each delegation can have its own prompt and branch. Provide complete context - agents have no visibility into your conversation.";

    const aiTool = tool({
        description,
        inputSchema: delegateSchema,
        execute: async (input: unknown) => {
            return await executeDelegate(input as DelegateInput, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: (args: unknown) => {
            if (!args || typeof args !== "object" || !("delegations" in args)) {
                return "Delegating to agent(s)";
            }

            const { delegations } = args as DelegateInput;

            if (!delegations || !Array.isArray(delegations)) {
                return "Delegating to agent(s)";
            }

            if (delegations.length === 1) {
                const d = delegations[0];
                const phaseStr = "phase" in d && d.phase ? ` (${d.phase} phase)` : "";
                return `Delegating to ${d.recipient}${phaseStr}`;
            }

            const recipients = delegations.map((d) => d.recipient).join(", ");
            return `Delegating ${delegations.length} tasks to: ${recipients}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}

/**
 * Unified Delegate Tool
 *
 * Delegates tasks to one or more agents with optional phase switching and worktree isolation.
 *
 * Features:
 * - Single or multiple delegations in one call
 * - Each delegation can have a different prompt, branch, and phase
 * - Supports 'wait' mode (blocks until all complete) and 'pair' mode (periodic check-ins)
 * - Phase field is only available for agents with defined phases
 * - Self-delegation is only allowed when a phase is specified
 *
 * Recipients can be:
 * - Agent slugs (e.g., "architect", "coder")
 * - Agent names (e.g., "Architect", "Coder")
 * - Npubs (e.g., "npub1...")
 * - Hex pubkeys (64 characters)
 *
 * Examples:
 *
 * Single delegation:
 * ```
 * delegate({
 *   delegations: [{ recipient: "coder", prompt: "Implement the login page" }],
 *   mode: "wait"
 * })
 * ```
 *
 * Multiple delegations with different tasks:
 * ```
 * delegate({
 *   delegations: [
 *     { recipient: "coder", prompt: "Implement OOP approach", branch: "impl-oop" },
 *     { recipient: "coder", prompt: "Implement FP approach", branch: "impl-fp" }
 *   ],
 *   mode: "wait"
 * })
 * ```
 *
 * With phase (agents with phases only):
 * ```
 * delegate({
 *   delegations: [{ recipient: "architect", prompt: "Design the API", phase: "planning" }],
 *   mode: "pair"
 * })
 * ```
 */
