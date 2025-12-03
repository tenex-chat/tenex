import type { ExecutionContext } from "@/agents/execution/types";
import { type DelegationResponses, DelegationService } from "@/services/delegation";
import type { AISdkTool } from "@/tools/types";
import { resolveRecipientToPubkey } from "@/utils/agent-resolution";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const delegateMultiSchema = z.object({
    delegations: z
        .array(
            z.object({
                to: z.string().describe("Agent slug, name, npub, or hex pubkey"),
                task: z.string().describe("The specific task/prompt for this agent"),
                branch: z.string().optional().describe("Git branch name for worktree isolation"),
                phase: z.string().optional().describe("Phase to switch to for this delegation"),
            })
        )
        .min(1)
        .describe("Array of delegations to execute in parallel"),
});

type DelegateMultiInput = z.infer<typeof delegateMultiSchema>;
type DelegateMultiOutput = DelegationResponses;

async function executeDelegateMulti(
    input: DelegateMultiInput,
    context: ExecutionContext
): Promise<DelegateMultiOutput> {
    const { delegations } = input;

    // Resolve all recipients to pubkeys and validate
    const resolvedDelegations: Array<{
        recipient: string;
        request: string;
        branch?: string;
        phase?: string;
        phaseInstructions?: string;
    }> = [];
    const failedRecipients: string[] = [];

    for (const delegation of delegations) {
        const pubkey = resolveRecipientToPubkey(delegation.to);
        if (pubkey) {
            // Look up phase instructions if phase is specified
            let phaseInstructions: string | undefined;
            if (delegation.phase && context.agent.phases) {
                const normalizedPhase = delegation.phase.toLowerCase();
                const phaseEntry = Object.entries(context.agent.phases).find(
                    ([phaseName]) => phaseName.toLowerCase() === normalizedPhase
                );
                if (phaseEntry) {
                    phaseInstructions = phaseEntry[1];
                }
            }

            resolvedDelegations.push({
                recipient: pubkey,
                request: delegation.task,
                branch: delegation.branch,
                phase: delegation.phase,
                phaseInstructions,
            });
        } else {
            failedRecipients.push(delegation.to);
        }
    }

    if (failedRecipients.length > 0) {
        logger.warn("Some recipients could not be resolved", {
            failed: failedRecipients,
            resolved: resolvedDelegations.length,
        });
    }

    if (resolvedDelegations.length === 0) {
        throw new Error("No valid recipients provided.");
    }

    // Check for self-delegation (not allowed without phase)
    const selfDelegationAttempts = resolvedDelegations.filter(
        (d) => d.recipient === context.agent.pubkey && !d.phase
    );

    if (selfDelegationAttempts.length > 0) {
        throw new Error(
            `Self-delegation is not permitted without a phase. Agent "${context.agent.slug}" cannot delegate to itself without specifying a phase.`
        );
    }

    // Use DelegationService to execute the delegation
    const delegationService = new DelegationService(
        context.agent,
        context.conversationId,
        context.conversationCoordinator,
        context.triggeringEvent,
        context.agentPublisher!
    );

    const responses = await delegationService.execute({
        delegations: resolvedDelegations,
    });

    logger.info("[delegate_multi() tool] ✅ COMPLETE: Received all responses", {
        delegationCount: resolvedDelegations.length,
        responseCount: responses.responses.length,
        worktreeCount: responses.worktrees?.length ?? 0,
    });

    return responses;
}

export function createDelegateMultiTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description:
            "Delegate different tasks to multiple agents in parallel, each with their own prompt and optional isolated git worktree. Waits for all agents to complete and returns all responses together. Use when you need to explore multiple approaches simultaneously or divide work across specialists. Each delegation can have a different task, branch, and phase.",
        inputSchema: delegateMultiSchema,
        execute: async (input: DelegateMultiInput) => {
            return await executeDelegateMulti(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: (args: unknown) => {
            if (!args || typeof args !== "object" || !("delegations" in args)) {
                return "Delegating to multiple agents";
            }

            const { delegations } = args as DelegateMultiInput;

            if (!delegations || !Array.isArray(delegations)) {
                return "Delegating to multiple agents";
            }

            const recipients = delegations.map((d) => d.to).join(", ");
            return `Delegating ${delegations.length} tasks to: ${recipients}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}

/**
 * Delegate Multi tool - enables agents to delegate different tasks to multiple agents in parallel
 *
 * This tool allows an agent to:
 * 1. Delegate different tasks to different agents simultaneously
 * 2. Create isolated git worktrees for each delegation
 * 3. Specify different phases for each delegation
 * 4. Wait for all responses before continuing
 *
 * Use cases:
 * - Explore multiple implementation approaches in parallel (e.g., OOP vs FP)
 * - Divide work across specialists with different prompts
 * - Create isolated development environments for each task
 *
 * Example:
 * ```
 * delegate_multi({
 *   delegations: [
 *     { to: "coder", task: "Implement calculator using OOP", branch: "calc-oop" },
 *     { to: "coder", task: "Implement calculator using FP", branch: "calc-func" }
 *   ]
 * })
 * ```
 *
 * The tool returns all responses once all delegations complete, along with
 * information about any worktrees that were created.
 */
