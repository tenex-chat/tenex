import type { SummarySpan } from "ai-sdk-context-management";
import type { ConversationRecord } from "@/conversations/types";

export function createSummaryRecordId(summarySpan: SummarySpan): string {
    return `summary:${summarySpan.startRecordId}:${summarySpan.endRecordId}`;
}

export function applySummarySpansToRecords(
    records: ConversationRecord[],
    summarySpans: SummarySpan[]
): ConversationRecord[] {
    if (summarySpans.length === 0) {
        return records;
    }

    const result: ConversationRecord[] = [];
    let currentIndex = 0;

    for (const summarySpan of summarySpans) {
        const fromIndex = records.findIndex((record) => record.id === summarySpan.startRecordId);
        const toIndex = records.findIndex((record) => record.id === summarySpan.endRecordId);

        if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex) {
            continue;
        }

        while (currentIndex < fromIndex) {
            result.push(records[currentIndex]);
            currentIndex++;
        }

        result.push({
            id: createSummaryRecordId(summarySpan),
            pubkey: "system",
            content: `[History summary]\n${summarySpan.summary}`,
            messageType: "text",
            timestamp: summarySpan.createdAt ? Math.floor(summarySpan.createdAt / 1000) : undefined,
            role: "user",
        });

        currentIndex = toIndex + 1;
    }

    while (currentIndex < records.length) {
        result.push(records[currentIndex]);
        currentIndex++;
    }

    return result;
}

function estimateRecordChars(record: ConversationRecord): number {
    let chars = record.content.length;

    if (record.toolData && record.toolData.length > 0) {
        chars += JSON.stringify(record.toolData).length;
    }

    return chars;
}

export function estimateTokensFromRecords(records: ConversationRecord[]): number {
    const totalChars = records.reduce((sum, record) => sum + estimateRecordChars(record), 0);
    return Math.ceil(totalChars / 4);
}
