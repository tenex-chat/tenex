import type { ConversationStore } from "@/conversations/ConversationStore";
import { CategoryManager } from "@/conversations/services";
import { NDKEventMetadata } from "@/events/NDKEventMetadata";
import { llmServiceFactory } from "@/llm";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { getPubkeyService } from "@/services/PubkeyService";
import type { ProjectContext } from "@/services/projects";
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
                "conversation.id": conversation.id,
            },
        }, ROOT_CONTEXT);

        // Wrap execution in the new span's context so child operations use this span
        return otelContext.with(trace.setSpan(ROOT_CONTEXT, span), async () => {
            try {
                // Get LLM configuration - use summarization config if set, otherwise default
                const { llms } = await config.loadConfig();
                const configName = llms.summarization || llms.default;
                const summarizationConfig = configName ? llms.configurations[configName] : undefined;

                if (!summarizationConfig) {
                    console.warn("No LLM configuration available for summarization");
                    return;
                }

                // Create LLM service
                const llmService = llmServiceFactory.createService(
                    summarizationConfig,
                    {
                        agentName: "summarizer",
                        sessionId: `summarizer-${conversation.id}`,
                    }
                );

                // Prepare conversation content from stored messages
                const messages = conversation.getAllMessages();
                const pubkeyService = getPubkeyService();

                // Resolve pubkeys to names for all participants
                const textMessages = messages.filter((entry) => entry.messageType === "text");
                const formattedMessages = await Promise.all(
                    textMessages.map(async (entry) => {
                        const name = await pubkeyService.getName(entry.pubkey);
                        return `${name}: ${entry.content}`;
                    })
                );
                const conversationContent = formattedMessages.join("\n\n");

                if (!conversationContent.trim()) {
                    console.log("No content to summarize for conversation", conversation.id);
                    return;
                }

                // Get existing categories for consistency
                const existingCategories = await this.categoryManager.getCategories();
                const categoryListText = existingCategories.length > 0
                    ? `Existing categories (prefer these for consistency): ${existingCategories.join(", ")}`
                    : "No existing categories yet. Create new ones as needed.";

                // Generate title, summary, and status information
                const { object: result } = await llmService.generateObject(
                    [
                        {
                            role: "system",
                            content: `You are a helpful assistant that generates concise titles, summaries, and status information for technical conversations.

CRITICAL: Base your summary ONLY on what is explicitly stated in the conversation. Do NOT:
- Hallucinate success when errors, failures, or problems are mentioned
- Assume tasks were completed if the conversation shows they failed or are still in progress
- Invent outcomes that are not clearly stated in the transcript

Generate a title (~5 words) that captures the main topic or goal.
Generate a summary (2-3 sentences) highlighting key decisions, progress, and current status. If errors occurred, mention them.
Generate a status_label that concisely describes the overall status (e.g., "Researching", "In Progress", "Blocked", "Completed", "Failed", "Planning"). You are not limited to these examples—choose the most appropriate label.
Generate a status_current_activity that is consistent with status_label:
- If completed: describe the outcome (e.g., "All files created", "Bug fixed")
- If failed: describe what failed (e.g., "Build failed with errors", "Tests not passing")
- If in progress: describe the current action (e.g., "Implementing feature X", "Debugging issue")
- If blocked/waiting: describe what's needed (e.g., "Waiting for user input", "Awaiting approval")
Focus on what was accomplished or discussed, not on the process. Be truthful about failures and errors.

CATEGORIES: Assign 1-3 category tags to classify this conversation.
- Use lowercase, singular nouns only (e.g., "authentication", "storage", "testing")
- ${categoryListText}
- If no existing category fits, create a new descriptive one following the format requirements`,
                        },
                        {
                            role: "user",
                            content: `Please generate a title, summary, and status information for this conversation:\n\n${conversationContent}`,
                        },
                    ],
                    z.object({
                        title: z.string().describe("A concise title for the conversation (5-10 words)"),
                        summary: z
                            .string()
                            .describe("A 2-3 sentence summary of key points and progress"),
                        status_label: z
                            .string()
                            .describe("A concise status label (e.g., 'In Progress', 'Blocked', 'Completed')"),
                        status_current_activity: z
                            .string()
                            .describe("Description of current activity or what comes next"),
                        categories: z
                            .array(z.string())
                            .max(3)
                            .describe(
                                "1-3 category tags for classifying the conversation. Use lowercase, singular nouns only (e.g., 'authentication', 'storage', 'testing'). Must be from the existing category list if possible."
                            ),
                    })
                );

                // Publish metadata event
                const ndk = getNDK();
                const event = new NDKEventMetadata(ndk);
                event.kind = NDKKind.EventMetadata;
                event.setConversationId(conversation.id);

                // Add metadata tags
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
                event.tags.push(["a", this.context.project.tagId()]); // Project reference
                event.tags.push(["model", summarizationConfig.model]);

                // Sign and publish with backend signer
                const backendSigner = await config.getBackendSigner();
                await event.sign(backendSigner);
                await event.publish();
                console.log(
                    `Published metadata for conversation ${conversation.id}: ${result.title}`
                );

                // Update category tally for future consistency
                if (result.categories && result.categories.length > 0) {
                    await this.categoryManager.updateCategories(result.categories);
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
