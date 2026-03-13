export interface SummarySpan {
    startRecordId: string;
    endRecordId: string;
    summary: string;
    createdAt?: number;
    metadata?: Record<string, unknown>;
}
