/**
 * SystemPromptInjector - Handles system prompt construction and injection
 *
 * This module handles:
 * - Building system prompts from project context
 * - Injecting lessons and nudges
 * - Fallback prompt generation
 */

import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { buildSystemPromptMessages } from "@/prompts/utils/systemPromptBuilder";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import { NudgeService } from "@/services/nudge";
import type { Span } from "@opentelemetry/api";
import type { ModelMessage } from "ai";
import type { ExecutionContext } from "../types";

/**
 * Add system prompt based on execution context
 */
export async function addSystemPrompt(
    messages: ModelMessage[],
    context: ExecutionContext,
    span: Span
): Promise<void> {
    const conversation = context.getConversation();
    if (!conversation) return;

    if (isProjectContextInitialized()) {
        // Project mode
        const projectCtx = getProjectContext();
        const project = projectCtx.project;
        const availableAgents = Array.from(projectCtx.agents.values());
        const agentLessonsMap = new Map();
        const currentAgentLessons = projectCtx.getLessonsForAgent(context.agent.pubkey);

        // Add lesson tracing to understand lesson state at prompt build time
        span.addEvent("tenex.lesson.context_state", {
            "agent.name": context.agent.name,
            "agent.slug": context.agent.slug,
            "agent.pubkey": context.agent.pubkey.substring(0, 16),
            "agent.event_id": context.agent.eventId?.substring(0, 16) || "none",
            "lessons.for_this_agent_count": currentAgentLessons.length,
            "lessons.total_in_context": projectCtx.agentLessons.size,
            "lessons.all_agent_pubkeys_with_lessons": JSON.stringify(
                Array.from(projectCtx.agentLessons.keys()).map((k) => k.substring(0, 16))
            ),
        });

        // Log all lessons in context for debugging
        if (projectCtx.agentLessons.size > 0) {
            const allLessonsDebug: Array<{ pubkey: string; count: number; titles: string[] }> = [];
            for (const [pubkey, lessons] of projectCtx.agentLessons) {
                allLessonsDebug.push({
                    pubkey: pubkey.substring(0, 16),
                    count: lessons.length,
                    titles: lessons.slice(0, 3).map((l) => l.title || "untitled"),
                });
            }
            span.setAttribute("lessons.all_in_context", JSON.stringify(allLessonsDebug));
        }

        if (currentAgentLessons.length > 0) {
            agentLessonsMap.set(context.agent.pubkey, currentAgentLessons);
            span.addEvent("lessons_found_for_agent", {
                "lessons.count": currentAgentLessons.length,
                "lessons.titles": JSON.stringify(
                    currentAgentLessons.slice(0, 5).map((l) => l.title || "untitled")
                ),
            });
        } else {
            span.addEvent("no_lessons_for_agent", {
                "agent.pubkey": context.agent.pubkey.substring(0, 16),
                "agent.event_id": context.agent.eventId?.substring(0, 16) || "none",
            });
        }

        const isProjectManager = context.agent.pubkey === projectCtx.getProjectManager().pubkey;

        const systemMessages = await buildSystemPromptMessages({
            agent: context.agent,
            project,
            projectBasePath: context.projectBasePath,
            workingDirectory: context.workingDirectory,
            currentBranch: context.currentBranch,
            availableAgents,
            conversation,
            agentLessons: agentLessonsMap,
            isProjectManager,
            projectManagerPubkey: projectCtx.getProjectManager().pubkey,
            alphaMode: context.alphaMode,
        });

        for (const systemMsg of systemMessages) {
            messages.push(systemMsg.message);
        }

        // Add nudges if present on triggering event
        await injectNudges(messages, context, span);
    } else {
        // Fallback minimal prompt
        messages.push({
            role: "system",
            content: `You are ${context.agent.name}. ${context.agent.instructions || ""}`,
        });
    }
}

/**
 * Inject nudge messages if present on the triggering event
 */
async function injectNudges(
    messages: ModelMessage[],
    context: ExecutionContext,
    span: Span
): Promise<void> {
    const nudgeIds = AgentEventDecoder.extractNudgeEventIds(context.triggeringEvent);

    if (nudgeIds.length === 0) {
        span.setAttribute("nudge.injected", false);
        return;
    }

    span.addEvent("nudge.injection_start", {
        "nudge.count": nudgeIds.length,
        "agent.slug": context.agent.slug,
    });

    const nudgeService = NudgeService.getInstance();
    const nudgeContent = await nudgeService.fetchNudges(nudgeIds);

    if (nudgeContent) {
        messages.push({
            role: "system",
            content: nudgeContent,
        });

        span.addEvent("nudge.injection_success", {
            "nudge.content_length": nudgeContent.length,
        });

        span.setAttributes({
            "nudge.injected": true,
            "nudge.count": nudgeIds.length,
            "nudge.content_length": nudgeContent.length,
        });
    } else {
        span.addEvent("nudge.injection_empty");
        span.setAttribute("nudge.injected", false);
    }
}
