import type { Conversation } from "@/conversations/types";
import { NDKEventMetadata } from "@/events/NDKEventMetadata";
import { llmServiceFactory } from "@/llm";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import type { ProjectContext } from "@/services/ProjectContext";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { z } from "zod";

export class ConversationSummarizer {
    constructor(private context: ProjectContext) {}

    async summarizeAndPublish(conversation: Conversation): Promise<void> {
        const tracer = trace.getTracer("tenex.conversation");
        const span = tracer.startSpan("conversation.summarize_and_publish", {
            attributes: {
                "conversation.id": conversation.id,
                "conversation.message_count": conversation.history.length,
            },
        });

        try {
            // Get LLM configuration
            const { llms } = await config.loadConfig();
            const metadataConfig =
                llms.configurations.metadata ||
                (llms.default ? llms.configurations[llms.default] : undefined);

            if (!metadataConfig) {
                console.warn("No LLM configuration available for metadata generation");
                span.setStatus({ code: SpanStatusCode.ERROR, message: "No LLM configuration" });
                span.end();
                return;
            }

            span.setAttribute("llm.model", metadataConfig.model);

            // Create LLM service
            const llmService = llmServiceFactory.createService(
                this.context.llmLogger,
                metadataConfig,
                {
                    agentName: "summarizer",
                    sessionId: `summarizer-${conversation.id}`,
                }
            );

            // Prepare conversation content
            const conversationContent = conversation.history
                .filter((event) => event.kind !== NDKKind.EventMetadata) // Exclude metadata events
                .map((event) => {
                    const role = event.kind === NDKKind.ConversationRoot ? "User" : "Agent";
                    return `${role}: ${event.content}`;
                })
                .join("\n\n");

            if (!conversationContent.trim()) {
                console.log("No content to summarize for conversation", conversation.id);
                span.addEvent("no_content_to_summarize");
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                return;
            }

            span.setAttribute("content.length", conversationContent.length);

            // Generate title and summary
            const { object: result } = await llmService.generateObject(
                [
                    {
                        role: "system",
                        content: `You are a helpful assistant that generates concise titles and summaries for technical conversations.
Generate a title (5-10 words) that captures the main topic or goal.
Generate a summary (2-3 sentences) highlighting key decisions, progress, and current status.
Focus on what was accomplished or discussed, not on the process.`,
                    },
                    {
                        role: "user",
                        content: `Please generate a title and summary for this conversation:\n\n${conversationContent}`,
                    },
                ],
                z.object({
                    title: z.string().describe("A concise title for the conversation (5-10 words)"),
                    summary: z
                        .string()
                        .describe("A 2-3 sentence summary of key points and progress"),
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
            event.tags.push(["generated-at", Date.now().toString()]);
            event.tags.push(["model", metadataConfig.model]);

            // Sign and publish
            if (this.context.signer) {
                await event.sign(this.context.signer);
                await event.publish();

                // Record successful publication
                span.setAttribute("summary.title", result.title || "");
                span.setAttribute("summary.length", result.summary?.length || 0);
                span.setAttribute("event.id", event.id || "");
                span.addEvent("kind_513_published", {
                    "event.id": event.id,
                    "event.kind": 513,
                    "title": result.title,
                });
                span.setStatus({ code: SpanStatusCode.OK });

                console.log(
                    `Published metadata for conversation ${conversation.id}: ${result.title}`
                );
            } else {
                console.warn("No signer available to publish metadata event");
                span.setStatus({ code: SpanStatusCode.ERROR, message: "No signer available" });
            }

            span.end();
        } catch (error) {
            console.error("Error generating conversation summary:", error);
            span.recordException(error instanceof Error ? error : new Error(String(error)));
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
            });
            span.end();
        }
    }
}
