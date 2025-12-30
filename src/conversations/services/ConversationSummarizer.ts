import type { ConversationStore } from "@/conversations/ConversationStore";
import { NDKEventMetadata } from "@/events/NDKEventMetadata";
import { llmServiceFactory } from "@/llm";
import { NDKKind } from "@/nostr/kinds";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import type { ProjectContext } from "@/services/projects";
import { z } from "zod";

export class ConversationSummarizer {
    constructor(private context: ProjectContext) {}

    async summarizeAndPublish(conversation: ConversationStore): Promise<void> {
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
            const conversationContent = messages
                .filter((entry) => entry.message.role !== "system")
                .map((entry) => {
                    const role = entry.message.role === "user" ? "User" : "Agent";
                    const content = typeof entry.message.content === "string"
                        ? entry.message.content
                        : JSON.stringify(entry.message.content);
                    return `${role}: ${content}`;
                })
                .join("\n\n");

            if (!conversationContent.trim()) {
                console.log("No content to summarize for conversation", conversation.id);
                return;
            }

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
            event.tags.push(["a", this.context.project.tagId()]); // Project reference
            event.tags.push(["model", summarizationConfig.model]);

            // Sign and publish
            if (this.context.signer) {
                await event.sign(this.context.signer);
                await event.publish();
                console.log(
                    `Published metadata for conversation ${conversation.id}: ${result.title}`
                );
            } else {
                console.warn("No signer available to publish metadata event");
            }
        } catch (error) {
            console.error("Error generating conversation summary:", error);
        }
    }
}
