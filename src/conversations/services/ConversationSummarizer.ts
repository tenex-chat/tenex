import type { ConversationStore } from "@/conversations/ConversationStore";
import { getConversationRecordAuthorPubkey } from "@/conversations/record-author";
import { CategoryManager } from "@/conversations/services";
import { NDKEventMetadata } from "@/events/NDKEventMetadata";
import { llmServiceFactory } from "@/llm";
import { shortenConversationId } from "@/utils/conversation-id";
import { NDKKind } from "@/nostr/kinds";
import { enqueueSignedEventForRustPublish } from "@/nostr/RustPublishOutbox";
import { config } from "@/services/ConfigService";
import { getIdentityService } from "@/services/identity";
import type { ProjectContext } from "@/services/projects";
import { logger } from "@/utils/logger";
import { ROOT_CONTEXT, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import { z } from "zod";

const tracer = trace.getTracer("tenex.summarizer");

export class ConversationSummarizer {
    private categoryManager: CategoryManager;

    constructor(private context: ProjectContext) {
        // CategoryManager stores categories in ~/.tenex/data
        this.categoryManager = new CategoryManager(config.getConfigPath());
        this.categoryManager.initialize();
    }

    async summarizeAndPublish(conversation: ConversationStore): Promise<void> {
        // Create a fresh span using ROOT_CONTEXT to avoid inheriting an ended span
        // This is necessary because summarization runs debounced/async after the main processing span ends
        const span = tracer.startSpan("tenex.summarize", {
            attributes: {
                "conversation.id": shortenConversationId(conversation.id),
            },
        }, ROOT_CONTEXT);

        // Wrap execution in the new span's context so child operations use this span
        return otelContext.with(trace.setSpan(ROOT_CONTEXT, span), async () => {
            try {
                // Get LLM configuration - use summarization config if set, otherwise default
                const { llms } = await config.loadConfig();
                const configName = llms.summarization || llms.default;

                if (!configName) {
                    console.warn("No LLM configuration available for summarization");
                    return;
                }

                // Use getLLMConfig to resolve meta models automatically
                const summarizationConfig = config.getLLMConfig(configName);

                // Create LLM service
                const llmService = llmServiceFactory.createService(
                    summarizationConfig,
                    {
                        agentName: "summarizer",
                    }
                );

                // Prepare conversation content from stored messages
                const messages = conversation.getAllMessages();
                const identityService = getIdentityService();

                // Resolve pubkeys to names for all participants
                const textMessages = messages.filter((entry) => entry.messageType === "text");
                const formattedMessages = await Promise.all(
                    textMessages.map(async (entry) => {
                        const name = await identityService.getDisplayName({
                            principalId: entry.senderPrincipal?.id,
                            linkedPubkey: getConversationRecordAuthorPubkey(entry),
                            displayName: entry.senderPrincipal?.displayName,
                            username: entry.senderPrincipal?.username,
                            kind: entry.senderPrincipal?.kind,
                            fallbackName: entry.role === "system" ? "system" : undefined,
                        });
                        return `${name}: ${entry.content}`;
                    })
                );
                const conversationContent = formattedMessages.join("\n\n");

                if (!conversationContent.trim()) {
                    console.log("No content to summarize for conversation", conversation.id);
                    return;
                }

                // Get existing categories for consistency
                const existingCategories = (await this.categoryManager.getCategories()).slice(0, 10);
                const categoryListText = existingCategories.length > 0
                    ? `Existing categories (prefer these for consistency): ${existingCategories.join(", ")}`
                    : "No existing categories yet. Create new ones as needed.";

                // Generate title, summary, and status information
                const { object: result } = await llmService.generateObject(
                    [
                        {
                            role: "system",
                            content: `You generate high-signal titles, summaries, status metadata, and category tags for technical conversations.

                CRITICAL: Base output ONLY on what is explicitly stated in the conversation. Do NOT:
                - Hallucinate success when errors, failures, or problems are mentioned
                - Assume tasks were completed if the conversation shows they failed or are still in progress
                - Invent outcomes not clearly stated in the transcript

                DENSITY RULES (ENFORCE)
                - Summary max 160 characters (hard limit).
                - No narrative glue: avoid “ensuring”, “including”, “key features”, “focused on”, “review of”, “in order to”, “now complete”, “ready for testing” (unless explicitly stated).
                - No redundancy: summary and status_current_activity must not restate the same fact in different words.

                TITLE
                - 3–5 words (hard limit), concrete nouns/verbs, no filler.
                - Prefer outcome/topic phrasing.

                SUMMARY (1 sentence only)
                - Changelog style: state facts only (outcome/state, scope, blockers).
                - For In Progress / Blocked / Waiting: include what is missing or unknown (“Details not provided”).
                - Do not describe process.

                STATUS
                - status_label: one of "Researching", "In Progress", "Blocked", "Waiting", "Completed", "Failed", "Planning".
                - status_current_activity: one dense clause, consistent with status_label.
                - Do not duplicate the summary.

                CATEGORIES (CANONICAL-FIRST, SEMANTIC)
                You are given a list of previously used categories below. This list is a CANONICAL SUGGESTION SET, not an allowlist.
                You must actively judge each candidate (including items from the list) using the rules below.

                Previously used categories:
                ${categoryListText}

                Selection rules:
                - Prefer an existing category from the list *only if* it is a good semantic fit.
                - A valid category must:
                - Name a stable system concept (component, data model, protocol, UI artifact, subsystem)
                - Remain meaningful months later without task context
                - Have high discriminative value (would not apply to most unrelated conversations)
                - Do NOT select a category just because it exists in the list.

                Creation rules (to avoid fragmentation):
                - Create a new category ONLY if no existing category fits well.
                - If creating a new category:
                - Use a simple, canonical noun form
                - Avoid re-ordering words that would create near-duplicates
                - Prefer the most general stable concept (e.g., “agent” over “agent-runtime” unless runtime is explicitly the core topic)

                Rejection rule:
                - If all plausible categories (including those from the list) are low-signal or process-oriented, output [].

                Before emitting categories, silently verify for each:
                - It maps to an explicit noun phrase in the transcript
                - It passes the “6-months later” test
                - It would not create a near-duplicate of an existing category`,
                        },
                        {
                            role: "user",
                            content: `Please generate a title, summary, and status information for this conversation:\n\n${conversationContent}`,
                        },
                    ],
                    z.object({
                        title: z.string().describe("A concise title for the conversation (3-5 words)"),
                        summary: z
                            .string()
                            .describe(
                                "A 1-sentence, information-dense summary (<=160 chars) of key facts, scope, and blockers"
                            ),
                        status_label: z
                            .string()
                            .describe(
                                "A concise status label (e.g., 'In Progress', 'Blocked', 'Waiting', 'Completed', 'Failed')"
                            ),
                        status_current_activity: z
                            .string()
                            .describe(
                                "One dense clause consistent with status_label; no duplication or speculation"
                            ),
                        categories: z
                            .array(z.string())
                            .describe(
                                "0-3 category tags. Lowercase singular nouns. Prefer canonical list; create new only if necessary; may be empty []."
                            ),
                    })
                );



                conversation.updateMetadata({
                    ...(result.title ? { title: result.title } : {}),
                    ...(result.summary ? { summary: result.summary } : {}),
                    ...(result.status_label ? { statusLabel: result.status_label } : {}),
                    ...(result.status_current_activity ? { statusCurrentActivity: result.status_current_activity } : {}),
                });
                await conversation.save();

                if (result.categories && result.categories.length > 0) {
                    await this.categoryManager.updateCategories(result.categories);
                }

                try {
                    const event = new NDKEventMetadata();
                    event.kind = NDKKind.EventMetadata;
                    event.setConversationId(conversation.id);

                    if (result.title) {
                        event.tags.push(["title", result.title]);
                    }
                    if (result.summary) {
                        event.tags.push(["summary", result.summary]);
                    }
                    if (result.status_label) {
                        event.tags.push(["status-label", result.status_label]);
                    }
                    if (result.status_current_activity) {
                        event.tags.push(["status-current-activity", result.status_current_activity]);
                    }
                    if (result.categories && result.categories.length > 0) {
                        for (const category of result.categories) {
                            event.tags.push(["t", category]);
                        }
                    }
                    event.tags.push(["a", this.context.project.tagId()]);
                    event.tags.push(["model", summarizationConfig.model]);

                    const backendSigner = await config.getBackendSigner();
                    await event.sign(backendSigner);
                    await enqueueSignedEventForRustPublish(event, {
                        correlationId: "conversation_metadata",
                        projectId: this.context.project.dTag ?? this.context.project.tagId(),
                        conversationId: conversation.id,
                        requestId: `conversation-metadata:${conversation.id}:${event.id}`,
                    });
                    logger.info("[ConversationSummarizer] Enqueued metadata", {
                        conversationId: conversation.id,
                        title: result.title,
                    });
                } catch (publishError) {
                    logger.debug("[ConversationSummarizer] Skipping metadata publish", {
                        conversationId: conversation.id,
                        error: publishError instanceof Error ? publishError.message : String(publishError),
                    });
                    span.addEvent("nostr_publish_failed", {
                        error: publishError instanceof Error ? publishError.message : String(publishError),
                    });
                }

                span.setStatus({ code: SpanStatusCode.OK });
            } catch (error) {
                span.recordException(error as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                console.error("Error generating conversation summary:", error);
            } finally {
                span.end();
            }
        });
    }
}
