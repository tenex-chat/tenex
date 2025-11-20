import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { LanguageModelUsageWithCostUsd } from "@/llm/types";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { getProjectContext } from "@/services/ProjectContext";
import { logger } from "@/utils/logger";
import { NDKEvent, NDKTask } from "@nostr-dev-kit/ndk";
import { nip19 } from "nostr-tools";

/**
 * Centralized module for encoding and decoding agent event semantics.
 * This module codifies the tagging structures and their meanings,
 * ensuring consistent event creation and interpretation across the system.
 */

// Intent types that agents can express
export interface CompletionIntent {
    content: string;
    usage?: LanguageModelUsageWithCostUsd;
}

export interface DelegationIntent {
    recipients: string[];
    request: string;
    phase?: string;
    phaseInstructions?: string; // Instructions to be passed with phase delegation
    branch?: string;
    type?: "delegation" | "delegation_followup" | "ask";
}

export interface AskIntent {
    content: string;
    suggestions?: string[];
}

export interface ConversationIntent {
    content: string;
    isReasoning?: boolean;
}

export interface ErrorIntent {
    message: string;
    errorType?: string;
}

export interface TypingIntent {
    state: "start" | "stop";
}

export interface StreamingIntent {
    content: string;
    sequence: number;
    isReasoning?: boolean;
}

export interface LessonIntent {
    title: string;
    lesson: string;
    detailed?: string;
    category?: string;
    hashtags?: string[];
}

export interface StatusIntent {
    type: "status";
    agents: Array<{ pubkey: string; slug: string }>;
    models: Array<{ slug: string; agents: string[] }>;
    tools: Array<{ name: string; agents: string[] }>;
}

export interface ToolUseIntent {
    toolName: string;
    content: string; // e.g., "Reading $path"
    args?: unknown; // Tool arguments to be serialized
}

export type AgentIntent =
    | CompletionIntent
    | DelegationIntent
    | AskIntent
    | ConversationIntent
    | ErrorIntent
    | TypingIntent
    | StreamingIntent
    | LessonIntent
    | StatusIntent
    | ToolUseIntent;

// Execution context provided by RAL
export interface EventContext {
    triggeringEvent: NDKEvent;
    rootEvent: NDKEvent; // Now mandatory for better type safety
    conversationId: string; // Required for conversation lookup
    executionTime?: number;
    model?: string;
    cost?: number; // LLM cost in USD
    phase?: string; // Current phase for phase-aware events
}

/**
 * Encodes agent intents into properly tagged Nostr events.
 * All tagging logic is centralized here for consistency and testability.
 */
export class AgentEventEncoder {
    /**
     * Add conversation tags consistently to any event.
     * Centralizes conversation tagging logic for all agent events.
     */
    private addConversationTags(event: NDKEvent, context: EventContext): void {
        this.tagConversation(event, context.rootEvent);
        this.eTagParentEvent(event, context.rootEvent, context.triggeringEvent);
    }

    /**
     * Tags the root of the conversation
     */
    tagConversation(event: NDKEvent, rootEvent: NDKEvent): void {
        event.tag(["E", rootEvent.id]);
        event.tag(["K", rootEvent.kind.toString()]);
        event.tag(["P", rootEvent.pubkey]);
    }

    /**
     * "e"-tags this reply in the proper context.
     *
     * When the triggering event has the same author as the conversation root AND
     * when the triggering event, we want to publish to the root, and not thread it in
     * the triggering event; otherwise we thread inside the triggering event.
     */
    eTagParentEvent(event: NDKEvent, rootEvent: NDKEvent, triggeringEvent: NDKEvent): void {
        const projectCtx = getProjectContext();
        const ownerPubkey = projectCtx?.project?.pubkey ?? rootEvent.pubkey;

        const triggeringPubkeyIsOwner = triggeringEvent.pubkey === ownerPubkey;
        const eTagValue = triggeringEvent.tagValue("e");

        let replyToEventId = triggeringEvent.id;

        if (triggeringPubkeyIsOwner && eTagValue) {
            // if the triggering pubkey is the owner of the project
            // (or of the thread if there is no projet)

            replyToEventId = eTagValue; // reply inside the same parent
        }

        // Only add the e-tag if we have a valid event ID
        if (replyToEventId && replyToEventId.length > 0) {
            event.tag(["e", replyToEventId]);
        } else {
            // Fallback to root event if we have it
            if (rootEvent.id && rootEvent.id.length > 0) {
                event.tag(["e", rootEvent.id]);
            }
            // If neither is available, skip the e-tag entirely
            // rather than creating an invalid one
        }
    }

    /**
     * Encode a completion intent into a tagged event.
     * Handles both regular completions and delegation completions.
     */
    encodeCompletion(intent: CompletionIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = 1111;
        event.content = intent.content;

        // Add conversation tags (E, K, P for root)
        this.tagConversation(event, context.rootEvent);

        // if the triggering event is authored by the same as the root event
        // and the triggering event is e-tagging the root event, let's also e-tag the root
        // event. This is so that this completion event also shows up in the main thread.
        // const pTagsMatch = context.triggeringEvent.pubkey === context.rootEvent.pubkey;
        // const authorIsProductOwner = context.triggeringEvent.pubkey === projectCtx?.project?.pubkey;

        // console.log('encode completion', {
        //     pTagsMatch, authorIsProductOwner, eTagValue,
        //     productOwner: projectCtx?.project?.pubkey,
        //     triggeringEventPubkey: context.triggeringEvent.pubkey
        // })

        // // This hack is to make the in-thread replies to the product owner (typically the human) appear
        // // inline instead of threaded-in. This is probably not right.
        // if (pTagsMatch && authorIsProductOwner && eTagValue) {
        //     event.tag(["e", eTagValue, "", "reply"]);
        // } else {
        //     event.tag(["e", context.triggeringEvent.id, "", "reply"]);
        // }

        // const triggerTagsRoot = context.triggeringEvent.tagValue("e") === context.rootEvent.id;

        // if (pTagsMatch && triggerTagsRoot) {
        //     event.tag(["e", context.rootEvent.id, "", "root"]);
        // }

        this.eTagParentEvent(event, context.rootEvent, context.triggeringEvent);

        // p-tag the agent that triggered us
        event.tag(["p", context.triggeringEvent.pubkey]);

        // Mark as natural completion
        event.tag(["status", "completed"]);

        // Add usage information if provided
        if (intent.usage) {
            this.addLLMUsageTags(event, intent.usage);
        }

        // Add standard metadata (without usage, which is now handled above)
        this.addStandardTags(event, context);

        logger.debug("Encoded completion event", {
            eventId: event.id,
            completingTo: context.triggeringEvent.id?.substring(0, 8),
            completingToPubkey: context.triggeringEvent.pubkey?.substring(0, 8),
        });

        return event;
    }

    /**
     * Prepend recipient identifiers to message content for delegation.
     * Uses agent slugs for known agents, npub format for external recipients.
     */
    private prependRecipientsToContent(content: string, recipients: string[]): string {
        // Check if content already starts with nostr:npub or @slug patterns
        const hasNostrPrefix = content.startsWith("nostr:");
        const hasSlugPrefix = content.match(/^@[\w-]+:/);

        if (hasNostrPrefix || hasSlugPrefix) {
            return content;
        }

        // Get project context to look up agents
        const projectCtx = getProjectContext();
        const agentRegistry = projectCtx.agentRegistry;

        // Build recipient identifiers
        const recipientIdentifiers = recipients.map((pubkey) => {
            // Check if this pubkey belongs to an agent in the system
            const agent = agentRegistry.getAgentByPubkey(pubkey);
            if (agent) {
                return `@${agent.slug}`;
            }

            // For external recipients, use nostr:npub format
            try {
                const npub = nip19.npubEncode(pubkey);
                return `nostr:${npub}`;
            } catch (error) {
                logger.warn("Failed to encode pubkey to npub", { pubkey, error });
                return `nostr:${pubkey}`; // Fallback to hex if encoding fails
            }
        });

        // Prepend recipients to content
        return `${recipientIdentifiers.join(", ")}: ${content}`;
    }

    /**
     * Encode a delegation intent into a single kind:1111 conversation event.
     * Creates a single event with multiple p-tags for all recipients.
     */
    encodeDelegation(intent: DelegationIntent, context: EventContext): NDKEvent[] {
        const event = new NDKEvent(getNDK());
        event.kind = 1111; // NIP-22 comment/conversation kind

        // Prepend recipients to the content
        event.content = this.prependRecipientsToContent(intent.request, intent.recipients);

        event.created_at = Math.floor(Date.now() / 1000) + 1; // we publish one second into the future because it looks more natural when the agent says "I will delegate to..." and then the delegation shows up

        this.addConversationTags(event, context);

        // Add ALL recipients as p-tags in a single event
        for (const recipientPubkey of intent.recipients) {
            event.tag(["p", recipientPubkey]);
        }

        // Phase metadata if provided
        if (intent.phase) {
            event.tag(["phase", intent.phase]);

            // Add phase instructions as a separate tag
            if (intent.phaseInstructions) {
                event.tag(["phase-instructions", intent.phaseInstructions]);
            }
        }

        // Branch metadata if provided (for worktree support)
        if (intent.branch) {
            event.tag(["branch", intent.branch]);
        }

        // Add standard metadata
        this.addStandardTags(event, context);

        logger.debug("Encoded delegation request", {
            phase: intent.phase,
            recipients: intent.recipients.map((r) => r.substring(0, 8)),
        });

        return [event];
    }

    /**
     * Encode an Ask intent into a kind:1111 event with suggestions as tags.
     * Creates an event that asks a question to the project manager/human user.
     */
    encodeAsk(intent: AskIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = 1111; // NIP-22 comment/conversation kind
        event.content = intent.content;

        // Add conversation tags
        this.addConversationTags(event, context);

        // Get project owner to ask the question to
        const projectCtx = getProjectContext();
        const ownerPubkey = projectCtx?.project?.pubkey;

        if (ownerPubkey) {
            event.tag(["p", ownerPubkey]);
        }

        // Add suggestions as individual tags if provided
        if (intent.suggestions && intent.suggestions.length > 0) {
            for (const suggestion of intent.suggestions) {
                event.tag(["suggestion", suggestion]);
            }
        }

        // Mark this as an ask event
        event.tag(["intent", "ask"]);

        // Add standard metadata
        this.addStandardTags(event, context);

        logger.debug("Encoded ask event", {
            content: intent.content,
            suggestions: intent.suggestions,
            recipient: ownerPubkey?.substring(0, 8),
        });

        return event;
    }

    /**
     * Encode a conversation intent into a response event.
     * Standard agent response without flow termination semantics.
     */
    encodeConversation(intent: ConversationIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.GenericReply;
        event.content = intent.content;

        // Add conversation tags
        this.addConversationTags(event, context);

        // Add reasoning tag if this is reasoning content
        if (intent.isReasoning) {
            event.tag(["reasoning"]);
        }

        // Add standard metadata
        this.addStandardTags(event, context);

        return event;
    }

    /**
     * Add standard metadata tags that all agent events should have.
     * Centralizes common tagging logic.
     */
    public addStandardTags(event: NDKEvent, context: EventContext): void {
        this.aTagProject(event);

        // Phase metadata
        if (context.phase) {
            event.tag(["phase", context.phase]);
        }

        // LLM metadata
        if (context.model) {
            event.tag(["llm-model", context.model]);
        }
        // Add cost metadata if available
        if (context.cost !== undefined) {
            // Format cost to avoid scientific notation and ensure proper decimal representation
            // Use toFixed with enough precision (10 decimal places) then remove trailing zeros
            const formattedCost = context.cost.toFixed(10).replace(/\.?0+$/, "");
            event.tag(["llm-cost-usd", formattedCost]);
        }
        if (context.executionTime) {
            event.tag(["execution-time", context.executionTime.toString()]);
        }
    }

    /**
     * Encode an error intent into an error event.
     */
    encodeError(intent: ErrorIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.GenericReply;
        event.content = intent.message;

        // Add conversation tags
        this.addConversationTags(event, context);

        // Mark as error
        event.tag(["error", intent.errorType || "system"]);

        // Add standard metadata
        this.addStandardTags(event, context);

        return event;
    }

    /**
     * Encode a typing indicator intent.
     */
    encodeTypingIndicator(
        intent: TypingIntent,
        context: EventContext,
        agent: { name: string }
    ): NDKEvent {
        const event = new NDKEvent(getNDK());

        // Use appropriate event kind based on state
        if (intent.state === "start") {
            event.kind = NDKKind.TenexAgentTypingStart;
            event.content = `${agent.name} is typing`;
        } else {
            // Stop event uses different kind
            event.kind = NDKKind.TenexAgentTypingStop;
            event.content = "";
        }

        // Add conversation tags
        this.addConversationTags(event, context);

        // Add standard metadata tags (includes project tag)
        this.addStandardTags(event, context);

        return event;
    }

    /**
     * Encode a streaming progress intent.
     */
    encodeStreamingContent(intent: StreamingIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.TenexStreamingResponse;
        event.content = intent.content;

        // Add conversation tags for proper threading
        this.addConversationTags(event, context);

        // Add streaming-specific tags
        event.tag(["streaming", "true"]);
        event.tag(["sequence", intent.sequence.toString()]);

        // Add reasoning tag if this is reasoning content
        if (intent.isReasoning) {
            event.tag(["reasoning"]);
        }

        // Add standard metadata tags
        this.addStandardTags(event, context);

        return event;
    }

    /**
     * Add LLM usage metadata tags to an event.
     * Centralizes the encoding of usage information from AI SDK's LanguageModelUsageWithCostUsd.
     */
    private addLLMUsageTags(event: NDKEvent, usage: LanguageModelUsageWithCostUsd): void {
        if (usage.inputTokens !== undefined) {
            event.tag(["llm-prompt-tokens", usage.inputTokens.toString()]);
        }
        if (usage.outputTokens !== undefined) {
            event.tag(["llm-completion-tokens", usage.outputTokens.toString()]);
        }
        if (usage.totalTokens !== undefined) {
            event.tag(["llm-total-tokens", usage.totalTokens.toString()]);
        } else if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
            // Fallback: calculate total if not provided
            event.tag(["llm-total-tokens", (usage.inputTokens + usage.outputTokens).toString()]);
        }

        if (usage.costUsd !== undefined) {
            event.tag(["llm-cost-usd", usage.costUsd.toString()]);
        }

        // Add additional usage metadata if available
        if ("reasoningTokens" in usage && usage.reasoningTokens !== undefined) {
            event.tag(["llm-reasoning-tokens", String(usage.reasoningTokens)]);
        }
        if ("cachedInputTokens" in usage && usage.cachedInputTokens !== undefined) {
            event.tag(["llm-cached-input-tokens", String(usage.cachedInputTokens)]);
        }
    }

    aTagProject(event: NDKEvent): undefined {
        const projectCtx = getProjectContext();
        event.tag(projectCtx.project.tagReference());
    }

    /**
     * p-tags the project owner
     */
    pTagProjectOwner(event: NDKEvent): undefined {
        const projectCtx = getProjectContext();
        event.tag(["p", projectCtx.project.pubkey]);
    }

    /**
     * Encode a task creation with proper conversation tagging.
     * Creates an NDKTask that references the triggering event.
     */
    encodeTask(
        title: string,
        content: string,
        context: EventContext,
        claudeSessionId?: string
    ): NDKTask {
        const task = new NDKTask(getNDK());
        task.title = title;
        task.content = content;

        // Add conversation tags (E, K, P for root, e for triggering)
        this.addConversationTags(task, context);

        // Add session ID if provided
        if (claudeSessionId) {
            task.tags.push(["claude-session", claudeSessionId]);
        }

        // Add standard metadata tags (project, phase, etc)
        this.addStandardTags(task, context);

        return task;
    }

    /**
     * Encode a lesson learned intent.
     */
    encodeLesson(
        intent: LessonIntent,
        context: EventContext,
        agent: { eventId?: string }
    ): NDKAgentLesson {
        const lessonEvent = new NDKAgentLesson(getNDK());

        // Set core properties
        lessonEvent.title = intent.title;
        lessonEvent.lesson = intent.lesson;

        // Set optional properties
        if (intent.detailed) {
            lessonEvent.detailed = intent.detailed;
        }
        if (intent.category) {
            lessonEvent.category = intent.category;
        }
        if (intent.hashtags && intent.hashtags.length > 0) {
            lessonEvent.hashtags = intent.hashtags;
        }

        // Add reference to the agent event if available
        if (agent.eventId) {
            lessonEvent.agentDefinitionId = agent.eventId;
        }

        // Add standard metadata including project tag
        this.addStandardTags(lessonEvent, context);

        return lessonEvent;
    }

    /**
     * Encode a follow-up event to a previous delegation response.
     * Creates a threaded reply that maintains conversation context.
     *
     * @param responseEvent The event being responded to
     * @param message The follow-up message content
     * @returns The encoded follow-up event
     */
    encodeFollowUp(responseEvent: NDKEvent, message: string): NDKEvent {
        // Create a reply to the response event to maintain thread
        const followUpEvent = responseEvent.reply();

        // Handle e-tag to avoid deep nesting
        const eTagVal = responseEvent.tagValue("e");
        if (eTagVal) {
            followUpEvent.removeTag("e");
            followUpEvent.tags.push(["e", eTagVal]); // Root thread tag
        }

        // Prepend recipient to content for follow-ups (single recipient)
        const recipientPubkey = responseEvent.pubkey;
        followUpEvent.content = this.prependRecipientsToContent(message, [recipientPubkey]);

        // Clean out p-tags and add recipient
        followUpEvent.tags = followUpEvent.tags.filter((t) => t[0] !== "p");
        followUpEvent.tag(responseEvent.author);

        return followUpEvent;
    }

    /**
     * Encode a tool usage event.
     * Creates an event that tracks tool invocation with output.
     */
    encodeToolUse(intent: ToolUseIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.GenericReply;
        event.content = intent.content;

        // Add conversation tags
        this.addConversationTags(event, context);

        // Add tool usage tags
        event.tag(["tool", intent.toolName]);

        // Add tool-args tag with JSON serialization
        // If args are provided and can be serialized, add them
        // If the serialized args are > 1000 chars, add empty tag
        if (intent.args !== undefined) {
            try {
                const serialized = JSON.stringify(intent.args);
                if (serialized.length <= 1000) {
                    event.tag(["tool-args", serialized]);
                } else {
                    event.tag(["tool-args"]);
                }
            } catch {
                // If serialization fails, add empty tag
                event.tag(["tool-args"]);
            }
        }

        // Add standard metadata
        this.addStandardTags(event, context);

        return event;
    }
}
