import type { MessageGenerationStrategy } from "./types";
import type { ExecutionContext, StandaloneAgentContext } from "../types";
import type { ModelMessage } from "ai";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import {
    buildStandaloneSystemPromptMessages,
    buildSystemPromptMessages,
} from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext, isProjectContextInitialized } from "@/services";
import { logger } from "@/utils/logger";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import { isDebugMode } from "@/prompts/fragments/debug-mode";

/**
 * Default message generation strategy that implements the current behavior
 */
export class DefaultMessageGenerationStrategy implements MessageGenerationStrategy {
    constructor(
        private standaloneContext?: StandaloneAgentContext
    ) {}

    /**
     * Build the messages array for the agent execution
     */
    async buildMessages(
        context: ExecutionContext,
        _triggeringEvent: NDKEvent
    ): Promise<ModelMessage[]> {
        const messages: ModelMessage[] = [];

        // Get fresh conversation data
        const conversation = context.conversationCoordinator.getConversation(
            context.conversationId
        );
        if (!conversation) {
            throw new Error(`Conversation ${context.conversationId} not found`);
        }

        // Extract transient phase context from the triggering event
        const transientPhaseContext = this.extractPhaseContext(context.triggeringEvent);

        // Check if we're in standalone mode or project mode
        if (this.standaloneContext) {
            // Standalone mode - use minimal context
            const availableAgents = Array.from(this.standaloneContext.agents.values());

            // Get lessons if available
            const agentLessonsMap = new Map<string, NDKAgentLesson[]>();
            if (this.standaloneContext.getLessonsForAgent) {
                const lessons = this.standaloneContext.getLessonsForAgent(context.agent.pubkey);
                if (lessons.length > 0) {
                    agentLessonsMap.set(context.agent.pubkey, lessons);
                }
            }

            // Build standalone system prompt
            const systemMessages = buildStandaloneSystemPromptMessages({
                agent: context.agent,
                availableAgents,
                conversation,
                agentLessons: agentLessonsMap,
                triggeringEvent: context.triggeringEvent,
                transientPhaseContext,
            });

            // Add all system messages
            for (const systemMsg of systemMessages) {
                messages.push(systemMsg.message);
            }
        } else if (isProjectContextInitialized()) {
            // Project mode - use full project context
            const projectCtx = getProjectContext();
            const project = projectCtx.project;

            // Create tag map for efficient lookup
            const tagMap = new Map<string, string>();
            for (const tag of project.tags) {
                if (tag.length >= 2 && tag[0] && tag[1]) {
                    tagMap.set(tag[0], tag[1]);
                }
            }

            // Get all available agents for delegations
            const availableAgents = Array.from(projectCtx.agents.values());

            // Build system prompt using the shared function
            // Only pass the current agent's lessons
            const agentLessonsMap = new Map<string, NDKAgentLesson[]>();
            const currentAgentLessons = projectCtx.getLessonsForAgent(context.agent.pubkey);

            if (currentAgentLessons.length > 0) {
                agentLessonsMap.set(context.agent.pubkey, currentAgentLessons);
            }

            // Check if this agent is the project manager
            const isProjectManager = context.agent.pubkey === projectCtx.getProjectManager().pubkey;

            // Build system prompt messages for all agents (including orchestrator)
            const systemMessages = buildSystemPromptMessages({
                agent: context.agent,
                project,
                availableAgents,
                conversation,
                agentLessons: agentLessonsMap,
                triggeringEvent: context.triggeringEvent,
                isProjectManager,
                transientPhaseContext,
            });

            // Add all system messages
            for (const systemMsg of systemMessages) {
                messages.push(systemMsg.message);
            }
        } else {
            // Fallback: No context available - use absolute minimal prompt
            logger.warn("No context available for agent execution, using minimal prompt");
            messages.push({
                role: "system",
                content: `You are ${context.agent.name}. ${context.agent.instructions || ""}`,
            });
        }

        // Add special context instructions using fragments
        const contextBuilder = new PromptBuilder();

        // Add delegation completion fragment if needed
        if (context.isDelegationCompletion) {
            logger.info(
                "[DefaultMessageGenerationStrategy] 🔄 DELEGATION COMPLETION: Agent resumed after delegation",
                {
                    agent: context.agent.name,
                    triggeringEventId: context.triggeringEvent?.id?.substring(0, 8),
                    triggeringEventPubkey: context.triggeringEvent?.pubkey?.substring(0, 8),
                    mode: "delegation-completion",
                }
            );

            contextBuilder.add("delegation-completion", {
                isDelegationCompletion: true
            });

            logger.info(
                `[DefaultMessageGenerationStrategy] 🔁 Starting delegation completion flow for ${context.agent.name}`,
                {
                    conversationId: context.conversationId,
                    agentSlug: context.agent.slug,
                    mode: "delegation-completion",
                    reason: "delegation-completed",
                }
            );
        }

        // Add debug mode fragment if needed
        const hasDebugFlag = isDebugMode(context.triggeringEvent);
        if (hasDebugFlag) {
            contextBuilder.add("debug-mode", { enabled: true });

            logger.info(`[DefaultMessageGenerationStrategy] Debug mode activated for agent ${context.agent.name}`, {
                conversationId: context.conversationId,
                agentSlug: context.agent.slug,
            });
        }

        // Build and add any special context instructions
        const contextInstructions = contextBuilder.build();
        if (contextInstructions) {
            messages.push({ role: "system", content: contextInstructions });
        }

        // All agents now get conversation transcript
        const { messages: agentMessages } =
            await context.conversationCoordinator.buildAgentMessages(
                context.conversationId,
                context.agent,
                context.triggeringEvent
            );

        // Add the agent's messages
        messages.push(...agentMessages);

        return messages;
    }

    /**
     * Extract phase context from triggering event if it contains delegate_phase tags
     */
    private extractPhaseContext(triggeringEvent: NDKEvent): { phase?: string; phaseInstructions?: string } | undefined {
        // Check if triggering event exists and has tags
        if (!triggeringEvent || !triggeringEvent.tags) {
            return undefined;
        }

        // Check if this is a phase delegation by looking for the tool tag
        const toolTag = triggeringEvent.tags.find(tag => tag[0] === 'tool' && tag[1] === 'delegate_phase');
        if (!toolTag) {
            return undefined;
        }

        // Extract phase name from phase tag
        const phaseTag = triggeringEvent.tags.find(tag => tag[0] === 'phase');
        if (!phaseTag || !phaseTag[1]) {
            return undefined;
        }

        // Extract phase instructions from phase-instructions tag (optional)
        const phaseInstructionsTag = triggeringEvent.tags.find(tag => tag[0] === 'phase-instructions');

        return {
            phase: phaseTag[1],
            phaseInstructions: phaseInstructionsTag?.[1]
        };
    }
}