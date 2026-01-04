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
                // Only include text messages (skip tool-call and tool-result)
                .filter((entry) => entry.messageType === "text")
                .map((entry) => {
                    // Determine display role based on pubkey
                    const isFromAgent = entry.ral !== undefined;
                    const role = isFromAgent ? "Agent" : "User";
                    return `${role}: ${entry.content}`;
                })
                .join("\n\n");

            if (!conversationContent.trim()) {
                console.log("No content to summarize for conversation", conversation.id);
                return;
            }

            // Generate title, summary, and status information
            const { object: result } = await llmService.generateObject(
                [
                    {
                        role: "system",
                        content: `You are a helpful assistant that generates concise titles, summaries, and status information for technical conversations.
Generate a title (5-10 words) that captures the main topic or goal.
Generate a summary (2-3 sentences) highlighting key decisions, progress, and current status.
Generate a status_label that concisely describes the overall status (e.g., "In Progress", "Blocked", "Completed", "Planning").
Generate a status_current_activity that describes what is currently being done or what comes next (e.g., "Waiting for approval", "Implementing feature X", "Debugging issue").
Focus on what was accomplished or discussed, not on the process.`,
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
