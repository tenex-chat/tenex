import type { ExecutionContext } from "@/agents/execution/types";
import { getNDK } from "@/nostr";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "@/utils/logger";
import { normalizeNostrIdentifier } from "@/utils/nostr-entity-parser";
import { NDKProject } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";
const createProjectSchema = z.object({
    title: z.string().describe("The title/name of the project"),
    description: z.string().nullable().describe("Description of the project"),
    repository: z.string().nullable().describe("Repository URL for the project"),
    image: z.string().nullable().describe("Image URL for the project"),
    tags: z.array(z.string()).nullable().describe("Additional tags for the project"),
    agents: z
        .array(z.string())
        .nullable()
        .describe("Array of agent definition event IDs to include in the project"),
    mcpServers: z
        .array(z.string())
        .nullable()
        .describe("Array of MCP announcement event IDs to include in the project"),
});

type CreateProjectInput = z.infer<typeof createProjectSchema>;
type CreateProjectOutput = {
    id: string;
};

/**
 * Core implementation of the create_project functionality
 * Shared between AI SDK and legacy Tool interfaces
 */
async function executeCreateProject(
    input: CreateProjectInput,
    context: ExecutionContext
): Promise<CreateProjectOutput> {
    const { title, description, repository, image, tags, agents, mcpServers } = input;

    const ndk = getNDK();
    if (!ndk) {
        const error = "NDK instance not available";
        logger.error("❌ Create project failed", {
            error,
            agent: context.agent.name,
        });
        throw new Error(error);
    }

    logger.info("📝 Creating new NDKProject", {
        title,
        agent: context.agent.name,
        conversationId: context.conversationId,
    });

    try {
        // Create a new NDKProject event
        const project = new NDKProject(ndk);

        // Set project metadata
        project.title = title;

        if (description) {
            project.description = description;
        }

        if (repository) {
            project.repo = repository;
        }

        if (image) {
            project.picture = image;
        }

        // Add any additional tags
        if (tags && tags.length > 0) {
            for (const tag of tags) {
                // Add as generic "t" tags for categorization
                project.tags.push(["t", tag]);
            }
        }

        // Add agent event IDs
        if (agents && agents.length > 0) {
            for (const agentEventId of agents) {
                // Normalize the event ID (handles nostr: prefix and validates format)
                const cleanEventId = normalizeNostrIdentifier(agentEventId);
                if (cleanEventId) {
                    project.tags.push(["agent", cleanEventId]);
                } else {
                    logger.warn(`Invalid agent event ID format: ${agentEventId}`);
                }
            }
        }

        // Add MCP server event IDs
        if (mcpServers && mcpServers.length > 0) {
            for (const mcpEventId of mcpServers) {
                // Normalize the event ID (handles nostr: prefix and validates format)
                const cleanEventId = normalizeNostrIdentifier(mcpEventId);
                if (cleanEventId) {
                    project.tags.push(["mcp", cleanEventId]);
                } else {
                    logger.warn(`Invalid MCP event ID format: ${mcpEventId}`);
                }
            }
        }

        // The project will be published with the agent's pubkey as the author
        // This is typically the project-manager agent creating projects

        // Sign and publish the event
        await context.agent.sign(project);
        await project.publish();

        logger.info("✅ NDKProject created successfully", {
            title,
            projectId: project.encode(),
            agent: context.agent.name,
        });

        const result: CreateProjectOutput = {
            id: `nostr:${project.encode()}`,
        };

        return result;
    } catch (error) {
        const errorMessage = formatAnyError(error);
        logger.error("❌ Failed to create NDKProject", {
            error: errorMessage,
            title,
            agent: context.agent.name,
        });

        throw new Error(`Failed to create project: ${errorMessage}`);
    }
}

/**
 * Create an AI SDK tool for creating projects
 * This is the primary implementation
 */
export function createCreateProjectTool(context: ExecutionContext): ReturnType<typeof tool> {
    return tool({
        description: "Create and publish a new NDKProject event to Nostr",
        inputSchema: createProjectSchema,
        execute: async (input: CreateProjectInput) => {
            try {
                return await executeCreateProject(input, context);
            } catch (error) {
                logger.error("Failed to create project", { error });
                throw new Error(
                    `Failed to create project: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        },
    });
} 
