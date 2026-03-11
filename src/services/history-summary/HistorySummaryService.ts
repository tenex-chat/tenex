import { createSummarizer, summarizeConversation, type ConversationRecord as PackageConversationRecord, type SummarySpan, type TranscriptBuilder } from "ai-sdk-context-management";
import type { ConversationStore } from "@/conversations/ConversationStore";
import type { ConversationRecord, ConversationRecordInput } from "@/conversations/types";
import { renderConversationXml } from "@/conversations/formatters/utils/conversation-transcript-formatter";
import type { LLMService } from "@/llm/service";
import { logger } from "@/utils/logger";
import {
    applySummarySpansToRecords,
    estimateTokensFromRecords,
} from "@/services/history-summary/summary-utils";

function mapRecordKind(record: ConversationRecord): PackageConversationRecord["kind"] {
    if (record.messageType === "tool-call") return "tool-call";
    if (record.messageType === "tool-result") return "tool-result";
    return "text";
}

function mapRecordRole(record: ConversationRecord): PackageConversationRecord["role"] {
    if (record.role) {
        return record.role;
    }

    if (record.messageType === "tool-result") {
        return "tool";
    }

    if (record.messageType === "tool-call") {
        return "assistant";
    }

    return "user";
}

function mapToPackageConversationRecord(record: ConversationRecord): PackageConversationRecord {
    const firstToolPart = Array.isArray(record.toolData) && record.toolData.length > 0
        ? record.toolData[0]
        : undefined;

    return {
        id: record.id,
        role: mapRecordRole(record),
        kind: mapRecordKind(record),
        content: record.content,
        toolCallId: firstToolPart && typeof firstToolPart === "object" && typeof firstToolPart.toolCallId === "string"
            ? firstToolPart.toolCallId
            : undefined,
        toolName: firstToolPart && typeof firstToolPart === "object" && typeof firstToolPart.toolName === "string"
            ? firstToolPart.toolName
            : undefined,
        timestamp: record.timestamp,
        attributes: {
            ...(record.senderPubkey ? { senderPubkey: record.senderPubkey } : {}),
            ...(record.targetedPubkeys?.length ? { targetedPubkeys: record.targetedPubkeys.join(",") } : {}),
            ...(record.humanReadable ? { humanReadable: record.humanReadable } : {}),
        },
        metadata: {
            pubkey: record.pubkey,
            ral: record.ral,
            messageType: record.messageType,
            eventId: record.eventId,
            toolData: record.toolData,
            transcriptToolAttributes: record.transcriptToolAttributes,
            delegationMarker: record.delegationMarker,
        },
    };
}

function createTranscriptBuilder(conversationId: string): TranscriptBuilder {
    return {
        build(records) {
            const transcriptRecords: ConversationRecordInput[] = records.map((record): ConversationRecordInput => ({
                pubkey: typeof record.metadata?.pubkey === "string" ? record.metadata.pubkey : "unknown",
                ral: typeof record.metadata?.ral === "number" ? record.metadata.ral : undefined,
                content: record.content,
                messageType:
                    record.kind === "tool-call"
                        ? "tool-call"
                        : record.kind === "tool-result"
                            ? "tool-result"
                            : "text",
                toolData: Array.isArray(record.metadata?.toolData)
                    ? record.metadata.toolData as ConversationRecord["toolData"]
                    : undefined,
                eventId: record.id,
                timestamp: record.timestamp,
                targetedPubkeys:
                    typeof record.attributes?.targetedPubkeys === "string"
                        ? record.attributes.targetedPubkeys.split(",").map((value) => value.trim()).filter(Boolean)
                        : undefined,
                senderPubkey:
                    typeof record.attributes?.senderPubkey === "string"
                        ? record.attributes.senderPubkey
                        : undefined,
                role: record.role,
                humanReadable:
                    typeof record.attributes?.humanReadable === "string"
                        ? record.attributes.humanReadable
                        : undefined,
                transcriptToolAttributes:
                    record.metadata?.transcriptToolAttributes &&
                    typeof record.metadata.transcriptToolAttributes === "object"
                        ? record.metadata.transcriptToolAttributes as Record<string, string>
                        : undefined,
                delegationMarker:
                    record.metadata?.delegationMarker &&
                    typeof record.metadata.delegationMarker === "object"
                        ? record.metadata.delegationMarker as ConversationRecord["delegationMarker"]
                        : undefined,
            }));
            const rendered = renderConversationXml(transcriptRecords, { conversationId });

            return {
                text: rendered.xml,
                shortIdMap: rendered.shortIdToEventId,
                firstTranscriptId: rendered.firstShortId ?? null,
                lastTranscriptId: rendered.lastShortId ?? null,
            };
        },
    };
}

export interface HistorySummaryConfig {
    tokenThreshold: number;
    tokenBudget: number;
    preservedTailCount: number;
}

export class HistorySummaryService {
    constructor(
        private readonly conversationStore: ConversationStore,
        private readonly llmService?: LLMService,
        private readonly summaryLlmService?: LLMService
    ) {}

    async ensureUnderLimit(conversationId: string, config: HistorySummaryConfig): Promise<void> {
        await this.summarize(conversationId, config, true);
    }

    maybeSummarizeAsync(conversationId: string, config: HistorySummaryConfig): void {
        void this.summarize(conversationId, config, false).catch((error) => {
            logger.warn("[HistorySummaryService] Proactive summarization failed", {
                conversationId,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }

    getSummarySpans(conversationId: string): SummarySpan[] {
        return this.conversationStore.loadSummarySpans(conversationId);
    }

    private async summarize(
        conversationId: string,
        config: HistorySummaryConfig,
        blocking: boolean
    ): Promise<void> {
        const records = this.conversationStore.getAllMessages();
        const existingSummarySpans = this.conversationStore.loadSummarySpans(conversationId);
        const effectiveRecords = applySummarySpansToRecords(records, existingSummarySpans);
        const currentTokens = estimateTokensFromRecords(effectiveRecords);

        if (!blocking && currentTokens < config.tokenThreshold) {
            return;
        }

        if (blocking && currentTokens <= config.tokenBudget) {
            return;
        }

        const effectiveLlmService = this.summaryLlmService ?? this.llmService;
        if (!effectiveLlmService && !blocking) {
            return;
        }

        const transcriptBuilder = createTranscriptBuilder(conversationId);

        const result = await summarizeConversation({
            records: records.map(mapToPackageConversationRecord),
            maxTokens: blocking ? config.tokenBudget : config.tokenThreshold,
            summaryThreshold: 1,
            preservedTailCount: config.preservedTailCount,
            conversationKey: conversationId,
            summaryStore: {
                load: (key) => this.conversationStore.loadSummarySpans(key),
                append: (key, summarySpans) => this.conversationStore.appendSummarySpans(key, summarySpans),
            },
            transcriptBuilder,
            summarizer: effectiveLlmService
                ? createSummarizer({
                    summarize: async (prompt) => {
                        const response = await effectiveLlmService.generateText([
                            { role: "user", content: prompt },
                        ]);
                        return response.text;
                    },
                })
                : undefined,
            existingSummarySpans,
            summaryFailureMode: blocking ? "last-resort-truncate" : "throw",
        });

        if (blocking && result.stats.finalTokenEstimate > config.tokenBudget) {
            logger.warn("[HistorySummaryService] Summary spans did not reduce history under budget", {
                conversationId,
                finalTokenEstimate: result.stats.finalTokenEstimate,
                tokenBudget: config.tokenBudget,
            });
        }
    }
}
