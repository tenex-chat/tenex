import { ALL_PHASES, type Phase } from "@/conversations/phases";
import { type ProjectContext, getProjectContext } from "@/services/ProjectContext";
import type { Tool, NonEmptyArray } from "../types";
import { success, failure, createZodSchema } from "../types";
import { z } from "zod";

/**
 * Continue tool - orchestrator-only control flow tool
 * Routes conversation to next phase/agent
 */
interface ContinueInput {
    phase?: string;
    agents: string[];
    reason: string;
}

export const continueTool: Tool<ContinueInput> = {
    name: "continue",
    description:
        "Route conversation to next phase/agent. REQUIRES 'agents' parameter. This is a TERMINAL action - once called, processing STOPS IMMEDIATELY and control is transferred. DO NOT call this multiple times.",
    promptFragment: `- The continue tool is TERMINAL - it ends your turn IMMEDIATELY. DO NOT call it multiple times.
- Once you call continue(), STOP - do not generate more content or tool calls.
- The system will execute target agents with your triggering event.
- Target agents receive your triggering event as if they were p-tagged originally.
- You are a pure router - just decide WHERE to route, not WHAT to say.
- You can delegate to multiple agents at once if they have relevant expertise.
- When you receive reports back from multiple agents, route to the appropriate primary agent (planner/executor) without summarizing or interpreting.
`,

    parameters: createZodSchema(
        z.object({
            phase: z
                .string()
                .optional()
                .transform((val) => val?.toLowerCase() as Phase | undefined)
                .refine((val) => !val || ALL_PHASES.includes(val as Phase), {
                    message: `Invalid phase. Expected one of: ${ALL_PHASES.join(", ")}`,
                })
                .describe("Target phase"),
            agents: z.array(z.string()).describe("Array of agent slugs to delegate to"),
            reason: z
                .string()
                .describe(
                    "Used for routing debugging. Provide clear reason that justify this decision, include every detail and thought you had for choosing this routing (e.g., 'Request is clear and specific', 'Need planning due to ambiguity', 'Complex task requires specialized agents'). Always start the reason with 'Here is why I decided this path'. ALWAYS."
                ),
        })
    ),

    execute: async (input, context) => {
        const { phase, agents, reason } = input.value;

        // Runtime check for orchestrator
        if (!context.agent.isOrchestrator) {
            return failure({
                kind: "execution",
                tool: "continue",
                message: "Only orchestrator can use continue tool",
            });
        }

        // Validate agents array is not empty
        if (agents.length === 0) {
            return failure({
                kind: "validation",
                field: "agents",
                message: "Agents array cannot be empty",
            });
        }

        // Get project context
        let projectContext: ProjectContext;
        try {
            projectContext = getProjectContext();
        } catch {
            return failure({
                kind: "system",
                message: "Project context not available",
            });
        }

        // Validate agents and collect valid pubkeys
        const invalidAgents: string[] = [];
        const validPubkeys: string[] = [];
        const validNames: string[] = [];

        for (const agent of agents) {
            // Try exact match first
            let agentDef = projectContext.agents.get(agent);
            
            // If not found, try case-insensitive search
            if (!agentDef) {
                const lowerCaseAgent = agent.toLowerCase();
                for (const [key, value] of projectContext.agents.entries()) {
                    if (key.toLowerCase() === lowerCaseAgent) {
                        agentDef = value;
                        break;
                    }
                }
            }
            
            if (!agentDef) {
                invalidAgents.push(agent);
            } else if (agentDef.pubkey === context.agent.pubkey) {
                return failure({
                    kind: "validation",
                    field: "agents",
                    message: `Cannot route to self (${agent})`,
                });
            } else {
                validPubkeys.push(agentDef.pubkey);
                validNames.push(agentDef.name);
            }
        }

        if (invalidAgents.length > 0) {
            const availableAgents = Array.from(projectContext.agents.keys()).join(", ");
            return failure({
                kind: "validation",
                field: "agents",
                message: `Agents not found: ${invalidAgents.join(", ")}. Available agents: ${availableAgents}`,
            });
        }

        if (validPubkeys.length === 0) {
            return failure({
                kind: "validation",
                field: "agents",
                message: "No valid target agents found",
            });
        }

        // We know validPubkeys is non-empty due to check above
        const targetAgentPubkeys = validPubkeys as unknown as NonEmptyArray<string>;

        // Use current phase if not specified (phase is already lowercase from schema transform)
        const targetPhase = (phase as Phase) || context.phase;

        // Update phase IMMEDIATELY if transitioning
        if (targetPhase !== context.phase && context.conversationManager) {
            await context.conversationManager.updatePhase(
                context.conversationId,
                targetPhase,
                `Phase transition: ${reason}`,
                context.agent.pubkey,
                context.agent.name,
                reason
            );
        }


        // Return properly typed control flow
        return success({
            type: "continue",
            routing: {
                phase: targetPhase,
                agents: targetAgentPubkeys,
                reason,
            },
        });
    },
};
