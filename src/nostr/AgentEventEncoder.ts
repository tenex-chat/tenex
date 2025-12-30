import { NDKAgentLesson } from "@/events/NDKAgentLesson";
import type { LanguageModelUsageWithCostUsd } from "@/llm/types";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { getProjectContext } from "@/services/projects";
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
    summary?: string;
    /** If true, this is an intermediate response (e.g., partial delegation completion).
     *  Intermediate responses don't p-tag the recipient to avoid notification spam. */
    isIntermediate?: boolean;
}

export interface DelegationIntent {
    delegations: Array<{
        recipient: string;
        request: string;
        phase?: string;
        phaseInstructions?: string;
        branch?: string;
    }>;
    type?: "delegation" | "delegation_followup" | "ask";
    /** Execution mode: 'blocking' (default) or 'pair' for periodic check-ins */
    mode?: "blocking" | "pair";
    /** Configuration for pair mode */
    pairConfig?: {
        stepThreshold?: number;
        checkInTimeoutMs?: number;
    };
}

export interface AskIntent {
    content: string;
    suggestions?: string[];
}

export interface ErrorIntent {
    message: string;
    errorType?: string;
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
    worktrees?: string[]; // Array of branch names, first is default
}

export interface ToolUseIntent {
    toolName: string;
    content: string; // e.g., "Reading $path"
    args?: unknown; // Tool arguments to be serialized
    referencedEventIds?: string[]; // Event IDs to reference (e.g., delegation event IDs)
}

export type AgentIntent =
    | CompletionIntent
    | DelegationIntent
    | AskIntent
    | ErrorIntent
    | LessonIntent
    | StatusIntent
    | ToolUseIntent;

// Execution context provided by RAL
export interface EventContext {
    triggeringEvent: NDKEvent; // The event that triggered this execution (for reply threading)
    rootEvent: NDKEvent; // The conversation root event
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
     * Just e-tags the root event - no reply threading.
     */
    private addConversationTags(event: NDKEvent, context: EventContext): void {
        if (context.rootEvent.id) {
            event.tag(["e", context.rootEvent.id]);
        }
    }

    /**
     * Forward branch tag from triggering event to reply event.
     * Ensures agents carry forward the branch context from the message they're replying to.
     */
    private forwardBranchTag(event: NDKEvent, context: EventContext): void {
        const branchTag = context.triggeringEvent.tags.find((tag) => tag[0] === "branch" && tag[1]);
        if (branchTag) {
            event.tag(["branch", branchTag[1]]);
            logger.debug("Forwarding branch tag", {
                branch: branchTag[1],
                fromEvent: context.triggeringEvent.id?.substring(0, 8),
            });
        }
    }

    /**
     * Encode a completion intent into a tagged event.
     * Handles both regular completions and delegation completions.
     */
    encodeCompletion(intent: CompletionIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.Text; // kind:1 - unified conversation format
        event.content = intent.content;

        // Add conversation e-tag
        this.addConversationTags(event, context);

        // Only p-tag for final completions (not intermediate responses)
        // Intermediate responses (e.g., partial delegation completions) skip p-tag
        // to avoid notification spam while delegations are still pending
        if (!intent.isIntermediate) {
            event.tag(["p", context.triggeringEvent.pubkey]);
            event.tag(["status", "completed"]);
        } else {
            event.tag(["status", "intermediate"]);
        }

        // Add usage information if provided
        if (intent.usage) {
            this.addLLMUsageTags(event, intent.usage);
        }

        // Add standard metadata
        this.addStandardTags(event, context);

        // Forward branch tag from triggering event
        this.forwardBranchTag(event, context);

        logger.debug("Encoded completion event", {
            eventId: event.id,
            replyingTo: context.triggeringEvent.id?.substring(0, 8),
            replyingToPubkey: context.triggeringEvent.pubkey?.substring(0, 8),
            isIntermediate: intent.isIntermediate,
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
     * Encode a delegation intent into N kind:1111 conversation events.
     * Creates one event per delegation, each with its own content and tags.
     */
    encodeDelegation(intent: DelegationIntent, context: EventContext): NDKEvent[] {
        return intent.delegations.map((delegation) => {
            const event = new NDKEvent(getNDK());
            event.kind = NDKKind.Text; // kind:1 - unified conversation format

            // Prepend recipient to the content
            event.content = this.prependRecipientsToContent(delegation.request, [
                delegation.recipient,
            ]);

            event.created_at = Math.floor(Date.now() / 1000) + 1; // we publish one second into the future because it looks more natural when the agent says "I will delegate to..." and then the delegation shows up

            // No e-tag: delegation events are separate conversations
            // The recipient starts a fresh conversation thread

            // Add recipient as p-tag
            event.tag(["p", delegation.recipient]);

            // Phase metadata if provided
            if (delegation.phase) {
                event.tag(["phase", delegation.phase]);

                // Add phase instructions as a separate tag
                if (delegation.phaseInstructions) {
                    event.tag(["phase-instructions", delegation.phaseInstructions]);
                }
            }

            // Branch metadata if provided (for worktree support)
            if (delegation.branch) {
                event.tag(["branch", delegation.branch]);
            }

            // Add standard metadata
            this.addStandardTags(event, context);

            // Forward branch tag from triggering event if not explicitly set
            if (!delegation.branch) {
                this.forwardBranchTag(event, context);
            }

            logger.debug("Encoded delegation request", {
                phase: delegation.phase,
                recipient: delegation.recipient.substring(0, 8),
            });

            return event;
        });
    }

    /**
     * Encode an Ask intent into a kind:1111 event with suggestions as tags.
     * Creates an event that asks a question to the project manager/human user.
     */
    encodeAsk(intent: AskIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.Text; // kind:1 - unified conversation format
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

        // Forward branch tag from triggering event
        this.forwardBranchTag(event, context);

        logger.debug("Encoded ask event", {
            content: intent.content,
            suggestions: intent.suggestions,
            recipient: ownerPubkey?.substring(0, 8),
        });

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
            // Handle both string and object formats (some providers return {model: "..."})
            const modelString =
                typeof context.model === "string"
                    ? context.model
                    : (context.model as { model?: string }).model;
            if (modelString) {
                event.tag(["llm-model", modelString]);
            }
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
        event.kind = NDKKind.Text; // kind:1 - unified conversation format
        event.content = intent.message;

        // Add conversation tags
        this.addConversationTags(event, context);

        // Mark as error
        event.tag(["error", intent.errorType || "system"]);

        // Add standard metadata
        this.addStandardTags(event, context);

        // Forward branch tag from triggering event
        this.forwardBranchTag(event, context);

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
     * @param context Event context for standard tags
     * @returns The encoded follow-up event
     */
    encodeFollowUp(responseEvent: NDKEvent, message: string, context: EventContext): NDKEvent {
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

        // Add standard metadata (project tag, phase, model, cost, etc)
        this.addStandardTags(followUpEvent, context);

        // Forward branch tag from response event
        const branchTag = responseEvent.tags.find((tag) => tag[0] === "branch" && tag[1]);
        if (branchTag) {
            followUpEvent.tag(["branch", branchTag[1]]);
        }

        return followUpEvent;
    }

    /**
     * Encode a tool usage event.
     * Creates an event that tracks tool invocation with output.
     */
    encodeToolUse(intent: ToolUseIntent, context: EventContext): NDKEvent {
        const event = new NDKEvent(getNDK());
        event.kind = NDKKind.Text; // kind:1 - unified conversation format
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

        // Add q-tags for referenced events (e.g., delegation event IDs)
        // Using "q" (quote) tag to indicate these are referenced/quoted events
        if (intent.referencedEventIds) {
            for (const eventId of intent.referencedEventIds) {
                event.tag(["q", eventId]);
            }
        }

        // Add standard metadata
        this.addStandardTags(event, context);

        // Forward branch tag from triggering event
        this.forwardBranchTag(event, context);

        return event;
    }
}
