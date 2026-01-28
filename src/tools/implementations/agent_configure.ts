import { agentStorage } from "@/agents/AgentStorage";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { getProjectContext } from "@/services/projects";
import { config as configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

/**
 * Get available LLM configuration names from the loaded config.
 * Returns an array of configuration names that can be used for agents.
 */
function getAvailableModels(): string[] {
    try {
        // Access llms through the service's internal state
        // We need to get llms.configurations keys
        const llmsConfig = (configService as unknown as { loadedConfig?: { llms: { configurations: Record<string, unknown> } } }).loadedConfig?.llms;
        if (llmsConfig?.configurations) {
            return Object.keys(llmsConfig.configurations);
        }
        return [];
    } catch {
        return [];
    }
}

/**
 * Generate the tool description dynamically based on available models.
 */
function generateDescription(): string {
    const models = getAvailableModels();
    const modelList = models.length > 0
        ? `Available models: ${models.join(", ")}.`
        : "Models are configured in ~/.tenex/llms.json.";

    return `Configure an agent's settings. Changes take effect immediately. Only agents that are members of the current project can be configured.

## Parameters
- **slug** (required): The agent's slug identifier to configure (must be a project member)
- **model**: Change the agent's LLM model configuration. ${modelList}
- **setAsPM**: Set this agent as the Project Manager (PM) for the current project. When true, this agent becomes the PM regardless of the 31933 project event ordering.

## PM Override
When an agent is set as PM using this tool, it takes precedence over the PM designation in the 31933 project event. This override is project-scoped - an agent can be PM in one project but not another. Only one agent per project can have the PM override. Setting a new PM automatically clears the override from any previous PM.

## Examples
- Change model: \`agent_configure(slug: "my-agent", model: "anthropic:claude-sonnet-4")\`
- Set as PM: \`agent_configure(slug: "architect", setAsPM: true)\`
- Both: \`agent_configure(slug: "architect", model: "anthropic:claude-opus-4", setAsPM: true)\``;
}

// Define the input schema
const agentConfigureSchema = z.object({
    slug: z.string().describe("The slug identifier of the agent to configure"),
    model: z.string().optional().describe("The LLM configuration name to use for this agent (from llms.json configurations)"),
    setAsPM: z.boolean().optional().describe("Set this agent as the Project Manager. Takes precedence over 31933 event designation."),
});

type AgentConfigureInput = z.infer<typeof agentConfigureSchema>;

// Define the output type
interface AgentConfigureOutput {
    success: boolean;
    message?: string;
    error?: string;
    changes?: {
        model?: { from?: string; to: string };
        isPM?: { from: boolean; to: boolean };
    };
    agent?: {
        slug: string;
        name: string;
        pubkey: string;
        model?: string;
        isPM: boolean;
    };
}

/**
 * Core implementation of the agent_configure functionality
 */
async function executeAgentConfigure(
    input: AgentConfigureInput,
    _context?: ToolExecutionContext
): Promise<AgentConfigureOutput> {
    const { slug, model, setAsPM } = input;

    if (!slug) {
        return {
            success: false,
            error: "Agent slug is required",
        };
    }

    // Check that at least one configuration option is provided
    if (model === undefined && setAsPM === undefined) {
        return {
            success: false,
            error: "At least one configuration option (model or setAsPM) must be provided",
        };
    }

    // Get project context and project dTag
    const projectContext = getProjectContext();
    const projectDTag = projectContext.project.dTag || projectContext.project.tagValue("d");

    if (!projectDTag) {
        return {
            success: false,
            error: "Project dTag not found. Cannot configure agent without a project context.",
        };
    }

    // Check if agent exists in storage
    const existingAgent = await agentStorage.getAgentBySlug(slug);

    if (!existingAgent) {
        return {
            success: false,
            error: `Agent "${slug}" not found. Use agents_list to see available agents.`,
        };
    }

    // Get the agent's pubkey for consistent output
    const signer = new NDKPrivateKeySigner(existingAgent.nsec);
    const agentPubkey = signer.pubkey;

    // CRITICAL: Validate agent is in current project BEFORE any persistence
    if (!existingAgent.projects.includes(projectDTag)) {
        return {
            success: false,
            error: `Agent "${slug}" is not a member of this project (${projectDTag}). Only project members can be configured.`,
            agent: {
                slug,
                name: existingAgent.name,
                pubkey: agentPubkey,
                model: existingAgent.llmConfig,
                isPM: agentStorage.hasPMOverride(existingAgent, projectDTag),
            },
        };
    }

    const changes: AgentConfigureOutput["changes"] = {};
    let hasActualChanges = false;

    // Validate and apply model change (only if actually different)
    if (model !== undefined) {
        // Validate that the model configuration exists
        const availableModels = getAvailableModels();
        if (availableModels.length > 0 && !availableModels.includes(model)) {
            return {
                success: false,
                error: `Model "${model}" not found. Available models: ${availableModels.join(", ")}`,
                agent: {
                    slug,
                    name: existingAgent.name,
                    pubkey: agentPubkey,
                    model: existingAgent.llmConfig,
                    isPM: agentStorage.hasPMOverride(existingAgent, projectDTag),
                },
            };
        }

        const oldModel = existingAgent.llmConfig;
        // Only mark as change if value is actually different
        if (oldModel !== model) {
            existingAgent.llmConfig = model;
            changes.model = { from: oldModel, to: model };
            hasActualChanges = true;
            logger.info(`Updating model for agent "${slug}": ${oldModel || "default"} -> ${model}`);
        }
    }

    // Apply PM override (project-scoped)
    if (setAsPM !== undefined) {
        const wasPM = agentStorage.hasPMOverride(existingAgent, projectDTag);

        // Only mark as change if value is actually different
        if (wasPM !== setAsPM) {
            if (setAsPM) {
                // Setting this agent as PM for this project
                agentStorage.setPMOverride(existingAgent, projectDTag, true);

                // Clear PM override from all other agents in this project (enforce uniqueness)
                await agentStorage.clearOtherPMOverrides(projectDTag, agentPubkey);
            } else {
                // Removing PM override from this agent for this project
                agentStorage.setPMOverride(existingAgent, projectDTag, false);
            }

            changes.isPM = { from: wasPM, to: setAsPM };
            hasActualChanges = true;
            logger.info(`${setAsPM ? "Setting" : "Removing"} PM override for agent "${slug}" in project ${projectDTag}`);
        }
    }

    // If no actual changes, return early without persisting (no-op optimization)
    // Use resolved PM status from projectContext for consistency with the persistence path
    if (!hasActualChanges) {
        const resolvedPM = projectContext.projectManager;
        const isPMResolved = resolvedPM?.slug === slug;

        return {
            success: true,
            message: "No changes made (values already match)",
            agent: {
                slug,
                name: existingAgent.name,
                pubkey: agentPubkey,
                model: existingAgent.llmConfig,
                isPM: isPMResolved,
            },
        };
    }

    // Save to storage (only if there were actual changes)
    await agentStorage.saveAgent(existingAgent);

    // Reload project context to pick up changes
    await projectContext.updateProjectData(projectContext.project);

    // Re-check PM status after reload
    const currentPM = projectContext.projectManager;
    const isPMAfterReload = currentPM?.slug === slug;

    logger.info(`Successfully configured agent "${existingAgent.name}" (${slug})`);

    return {
        success: true,
        message: `Successfully configured agent "${existingAgent.name}"`,
        changes,
        agent: {
            slug,
            name: existingAgent.name,
            pubkey: agentPubkey,
            model: existingAgent.llmConfig,
            isPM: isPMAfterReload,
        },
    };
}

/**
 * Create an AI SDK tool for configuring agents
 */
export function createAgentConfigureTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description: generateDescription(),
        inputSchema: agentConfigureSchema,
        execute: async (input: AgentConfigureInput) => {
            try {
                return await executeAgentConfigure(input, context);
            } catch (error) {
                logger.error("Failed to configure agent", { error });
                throw new Error(
                    `Failed to configure agent: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        },
    }) as AISdkTool;
}
