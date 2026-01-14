/**
 * Change Model Tool - Dynamic model selection for meta model agents
 *
 * Allows agents using a meta model configuration to switch between
 * variants on-the-fly during a conversation.
 */

import type { ConversationToolContext } from "@/tools/types";
import type { AISdkTool } from "@/tools/types";
import { config as configService } from "@/services/ConfigService";
import { isMetaModelConfiguration, type MetaModelConfiguration } from "@/services/config/types";
import { tool } from "ai";
import { z } from "zod";

const changeModelSchema = z.object({
    variant: z
        .string()
        .describe("The name of the variant to switch to (e.g., 'fast', 'deep', 'standard')"),
});

type ChangeModelInput = z.infer<typeof changeModelSchema>;

interface ChangeModelOutput {
    success: boolean;
    message: string;
    previousVariant?: string;
    newVariant: string;
    modelConfig?: string;
}

/**
 * Get the meta model configuration for an agent if available
 */
function getAgentMetaModelConfig(agentLlmConfig?: string): MetaModelConfiguration | undefined {
    try {
        const rawConfig = configService.getRawLLMConfig(agentLlmConfig);
        if (isMetaModelConfiguration(rawConfig)) {
            return rawConfig;
        }
    } catch {
        // Config not available or not a meta model
    }
    return undefined;
}

async function executeChangeModel(
    input: ChangeModelInput,
    context: ConversationToolContext
): Promise<ChangeModelOutput> {
    const { variant } = input;
    const conversation = context.getConversation();
    const agentPubkey = context.agent.pubkey;

    // Get the meta model configuration for this agent
    const metaConfig = getAgentMetaModelConfig(context.agent.llmConfig);

    if (!metaConfig) {
        return {
            success: false,
            message: "This agent is not using a meta model configuration. Model switching is not available.",
            newVariant: variant,
        };
    }

    // Validate the variant exists
    if (!metaConfig.variants[variant]) {
        const availableVariants = Object.keys(metaConfig.variants);
        return {
            success: false,
            message: `Unknown variant "${variant}". Available variants: ${availableVariants.join(", ")}`,
            newVariant: variant,
        };
    }

    // Get previous variant (if any)
    const previousVariant = conversation.getMetaModelVariantOverride(agentPubkey);

    // Set the new variant override
    conversation.setMetaModelVariantOverride(agentPubkey, variant);

    // Get info about the new variant
    const variantConfig = metaConfig.variants[variant];
    const modelConfig = variantConfig.model;

    return {
        success: true,
        message: `Switched to "${variant}" variant. The new model is now active and will be used starting from the next step in this run.`,
        previousVariant: previousVariant || metaConfig.default,
        newVariant: variant,
        modelConfig,
    };
}

/**
 * Create the change_model tool for agents using meta model configurations.
 * This tool is automatically injected when an agent is configured with a meta model.
 */
export function createChangeModelTool(context: ConversationToolContext): AISdkTool {
    // Get the meta model config to build the description dynamically
    const metaConfig = getAgentMetaModelConfig(context.agent.llmConfig);

    // Build variant descriptions for the tool
    let variantDescriptions = "";
    if (metaConfig) {
        const variants = Object.entries(metaConfig.variants)
            .map(([name, v]) => {
                const desc = v.description ? `: ${v.description}` : "";
                const isDefault = name === metaConfig.default ? " [default]" : "";
                return `  - ${name}${desc}${isDefault}`;
            })
            .join("\n");
        variantDescriptions = `\n\nAvailable variants:\n${variants}`;
    }

    const aiTool = tool({
        description:
            `Switch to a different model variant for the rest of this conversation. ` +
            `Use this when you determine a different capability level is needed for the current task.${variantDescriptions}`,
        inputSchema: changeModelSchema,
        execute: async (input: ChangeModelInput) => {
            return await executeChangeModel(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: ({ variant }: ChangeModelInput) => {
            return `Switching to model variant: ${variant}`;
        },
        enumerable: false,
        configurable: true,
    });

    // Mark as having side effects (changes conversation state)
    Object.defineProperty(aiTool, "hasSideEffects", {
        value: true,
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
