import type { ConversationToolContext, AISdkTool } from "@/tools/types";
import { config as configService } from "@/services/ConfigService";
import { createEventContext } from "@/services/event-context";
import { RALRegistry } from "@/services/ral/RALRegistry";
import type { PendingDelegation } from "@/services/ral/types";
import { SkillIdentifierResolver } from "@/services/skill";
import type { DelegationMarker } from "@/conversations/types";
import { shortenConversationId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { isMetaModelConfiguration, type MetaModelConfiguration } from "@/services/config/types";
import { tool } from "ai";
import { z } from "zod";

interface SelfDelegateInput {
    prompt: string;
    model?: string;
    skills?: string[];
}

interface SelfDelegateOutput {
    success: boolean;
    message: string;
    delegationConversationId?: string;
    selectedVariant?: string;
}

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

function hasTodos(context: ConversationToolContext): boolean {
    return context.getConversation().getTodos(context.agent.pubkey).length > 0;
}

function createSelfDelegateSchema(metaConfig?: MetaModelConfiguration): z.ZodSchema<SelfDelegateInput> {
    const baseShape = {
        prompt: z
            .string()
            .describe(
                "The task and full context for the new instance of yourself. Self-delegated runs only see this prompt, so include everything needed."
            ),
        skills: z
            .array(z.string())
            .optional()
            .describe(
                "Additional skill IDs to apply to the new instance. Any currently inherited skills are forwarded automatically."
            ),
    };

    if (!metaConfig) {
        return z.object(baseShape);
    }

    const variantDescriptions = Object.entries(metaConfig.variants)
        .map(([name, variant]) => {
            const description = variant.description ? `: ${variant.description}` : "";
            const isDefault = name === metaConfig.default ? " [default]" : "";
            return `  - ${name}${description}${isDefault}`;
        })
        .join("\n");

    return z.object({
        ...baseShape,
        model: z
            .string()
            .optional()
            .describe(
                `Optional model variant for the new instance.\n\nAvailable variants:\n${variantDescriptions}`
            ),
    });
}

async function executeSelfDelegate(
    input: SelfDelegateInput,
    context: ConversationToolContext
): Promise<SelfDelegateOutput> {
    if (!input.prompt) {
        throw new Error("Delegation prompt is required");
    }

    const metaConfig = getAgentMetaModelConfig(context.agent.llmConfig);

    if (input.model && !metaConfig) {
        return {
            success: false,
            message: "This agent is not using a meta model configuration. Model selection is not available.",
        };
    }

    if (input.model && metaConfig && !metaConfig.variants[input.model]) {
        const availableVariants = Object.keys(metaConfig.variants);
        return {
            success: false,
            message: `Unknown variant "${input.model}". Available variants: ${availableVariants.join(", ")}`,
            selectedVariant: input.model,
        };
    }

    const inheritedSkills = context.triggeringEnvelope.metadata.skillEventIds ?? [];

    // Same skill inheritance + identifier resolution pattern as delegate.ts.
    const combinedSkills = [...inheritedSkills, ...(input.skills || [])];
    const uniqueSkills = Array.from(
        new Set(
            combinedSkills
                .map((skillIdentifier) => {
                    const trimmedIdentifier = skillIdentifier.trim();
                    if (!trimmedIdentifier) {
                        return null;
                    }

                    return (
                        SkillIdentifierResolver.getInstance().resolveSkillIdentifier(trimmedIdentifier) ??
                        trimmedIdentifier
                    );
                })
                .filter((skillIdentifier): skillIdentifier is string => Boolean(skillIdentifier))
        )
    );

    const eventContext = createEventContext(context);
    const eventId = await context.agentPublisher.delegate(
        {
            recipient: context.agent.pubkey,
            content: input.prompt,
            variant: input.model,
            skills: uniqueSkills.length > 0 ? uniqueSkills : undefined,
        },
        eventContext
    );

    const pendingDelegation: PendingDelegation = {
        delegationConversationId: eventId,
        recipientPubkey: context.agent.pubkey,
        senderPubkey: context.agent.pubkey,
        prompt: input.prompt,
        ralNumber: context.ralNumber,
    };

    // Same pending-delegation registration pattern as delegate.ts.
    RALRegistry.getInstance().mergePendingDelegations(
        context.agent.pubkey,
        context.conversationId,
        context.ralNumber,
        [pendingDelegation]
    );

    const parentStore = context.getConversation();
    const initiatedAt = Math.floor(Date.now() / 1000);
    const marker: DelegationMarker = {
        delegationConversationId: eventId,
        recipientPubkey: context.agent.pubkey,
        parentConversationId: context.conversationId,
        initiatedAt,
        status: "pending",
    };

    parentStore.addDelegationMarker(marker, context.agent.pubkey, context.ralNumber);
    await parentStore.save();

    await context.agentPublisher.delegationMarker({
        delegationConversationId: eventId,
        recipientPubkey: context.agent.pubkey,
        parentConversationId: context.conversationId,
        status: "pending",
        initiatedAt,
    });

    const delegationConversationId = shortenConversationId(eventId);
    logger.info("[self_delegate] Published self-delegation", {
        delegationConversationId,
        agent: context.agent.slug,
        variant: input.model || "default",
        inheritedSkillsCount: inheritedSkills.length,
    });

    let message = input.model
        ? `Delegated task to a new instance of yourself using the "${input.model}" variant. The agent will wake you up when ready with the response.`
        : "Delegated task to a new instance of yourself. The agent will wake you up when ready with the response.";

    if (!hasTodos(context)) {
        message +=
            "\n\n<system-reminder type=\"delegation-todo-nudge\">\n" +
            "You just delegated a task but don't have a todo list yet. Use `todo_write()` to set up a todo list tracking your delegated work and overall workflow.\n" +
            "</system-reminder>";
    }

    return {
        success: true,
        message,
        delegationConversationId,
        selectedVariant: input.model,
    };
}

export function createSelfDelegateTool(context: ConversationToolContext): AISdkTool {
    const metaConfig = getAgentMetaModelConfig(context.agent.llmConfig);
    const inputSchema = createSelfDelegateSchema(metaConfig);

    const description = metaConfig
        ? "Delegate the task to a fresh instance of yourself. Use this when you want a clean child conversation, optionally on a specific meta-model variant."
        : "Delegate the task to a fresh instance of yourself. Use this when you want a clean child conversation with the same agent.";

    const aiTool = tool({
        description,
        inputSchema,
        execute: async (input: SelfDelegateInput) => {
            return await executeSelfDelegate(input, context);
        },
    });

    return aiTool as AISdkTool;
}
