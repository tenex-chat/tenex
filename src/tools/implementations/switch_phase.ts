import { z } from "zod";
import { createToolDefinition, success, failure } from "../types";
import { PHASES, type Phase } from "@/conversations/phases";
import { logger } from "@/utils/logger";

const switchPhaseSchema = z.object({
    phase: z.enum([
        PHASES.CHAT,
        PHASES.BRAINSTORM,
        PHASES.PLAN,
        PHASES.EXECUTE,
        PHASES.VERIFICATION,
        PHASES.CHORES,
        PHASES.REFLECTION
    ] as const).describe("The target phase to switch to"),
    reason: z.string().describe("The goal or purpose of entering this phase - becomes context for agents working in this phase")
});

/**
 * Switch the conversation to a new phase.
 * This tool is EXCLUSIVE to the Project Manager agent for orchestrating workflow.
 * 
 * The reason provided becomes critical context for the next agent, explaining
 * what needs to be accomplished in this phase.
 */
export const switchPhaseTool = createToolDefinition<z.infer<typeof switchPhaseSchema>, { phase: Phase; reason: string; success: boolean }>({
    name: "switch_phase",
    description: "Switch the conversation to a new phase of work. Only available to the Project Manager for workflow orchestration.",
    schema: switchPhaseSchema,
    execute: async (input, context) => {
        const { phase, reason } = input.value;
        
        logger.info("[switch_phase] PM initiating phase transition", {
            fromPhase: context.phase,
            toPhase: phase,
            reason,
            agent: context.agent.name,
            conversationId: context.conversationId
        });

        // Verify this is the PM (belt and suspenders - should already be restricted by toolset)
        if (context.agent.slug !== "project-manager") {
            logger.warn("[switch_phase] Non-PM agent attempted to switch phases", {
                agent: context.agent.name,
                slug: context.agent.slug
            });
            return failure({
                kind: "execution",
                tool: "switch_phase",
                message: "Only the Project Manager can switch phases"
            });
        }

        try {
            // Update conversation phase through ConversationManager
            const success = await context.conversationManager.updatePhase(
                context.conversationId,
                phase,
                reason, // This becomes the phase transition message
                context.agent.pubkey,
                context.agent.name,
                reason, // Also store as the reason
                `Switching to ${phase} phase: ${reason}` // Summary for history
            );

            if (!success) {
                return failure({
                    kind: "execution",
                    tool: "switch_phase",
                    message: `Failed to switch to ${phase} phase`
                });
            }

            logger.info("[switch_phase] Phase transition successful", {
                conversationId: context.conversationId,
                newPhase: phase,
                reason
            });

            return success({
                phase,
                reason,
                success: true
            });
        } catch (error) {
            logger.error("[switch_phase] Error during phase transition", {
                error,
                phase,
                reason,
                conversationId: context.conversationId
            });
            
            return failure({
                kind: "execution",
                tool: "switch_phase",
                message: `Error switching phases: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }
});