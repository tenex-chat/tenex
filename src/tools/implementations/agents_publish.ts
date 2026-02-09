import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import { config } from "@/services/ConfigService";
import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";
import { getNDK } from "@/nostr/ndkClient";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const agentsPublishSchema = z.object({
    slug: z.string().describe("The slug identifier of the agent to publish"),
});

type AgentsPublishInput = z.infer<typeof agentsPublishSchema>;

/**
 * Publishes an agent definition (kind 4199) to Nostr using the TENEX backend signer.
 * Returns the event ID on success.
 */
async function executeAgentsPublish(input: AgentsPublishInput): Promise<string> {
    const { slug } = input;

    if (!slug) {
        throw new Error("Agent slug is required");
    }

    const projectCtx = getProjectContext();
    const agent = projectCtx.getAgent(slug);

    if (!agent) {
        throw new Error(`Agent with slug "${slug}" not found in current project`);
    }

    const signer = await config.getBackendSigner();
    const ndk = getNDK();

    const agentDefinition = new NDKAgentDefinition(ndk);
    agentDefinition.pubkey = signer.pubkey;

    agentDefinition.title = agent.name;
    agentDefinition.role = agent.role;

    if (agent.description) {
        agentDefinition.description = agent.description;
    }

    if (agent.instructions) {
        agentDefinition.instructions = agent.instructions;
    }

    if (agent.useCriteria) {
        agentDefinition.useCriteria = agent.useCriteria;
    }

    agentDefinition.version = 1;

    await agentDefinition.sign(signer, { pTags: false });
    await agentDefinition.publish();

    logger.info(`Successfully published agent definition for "${agent.name}" (${slug})`, {
        eventId: agentDefinition.id,
        pubkey: signer.pubkey,
    });

    return agentDefinition.id;
}

/**
 * Create an AI SDK tool for publishing agent definitions
 */
export function createAgentsPublishTool(_context: ToolExecutionContext): AISdkTool {
    return tool({
        description:
            "Publish an agent definition (kind 4199) to Nostr using the TENEX backend signer. Takes an agent slug and publishes its definition. Returns the event ID on success.",
        inputSchema: agentsPublishSchema,
        execute: async (input: AgentsPublishInput) => {
            try {
                return await executeAgentsPublish(input);
            } catch (error) {
                logger.error("Failed to publish agent definition", { error });
                throw new Error(
                    `Failed to publish agent definition: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error }
                );
            }
        },
    }) as AISdkTool;
}
