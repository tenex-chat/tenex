export interface SpanEvent {
    name: string;
    timestamp: number;
    attributes: Record<string, any>;
}

export interface TraceSpan {
    spanId: string;
    parentSpanId?: string;
    operationName: string;
    startTime: number;
    duration: number;
    attributes: Record<string, any>;
    events: SpanEvent[];
    children: TraceSpan[];
}

export interface Trace {
    traceId: string;
    rootSpan: TraceSpan;
    totalDuration: number;
    timestamp: number;
}

export interface TraceSummary {
    traceId: string;
    summary: string;
    duration: number;
    timestamp: number;
    conversationId?: string;
}

// Conversation-first view types

export type StreamItemType =
    | "received"
    | "routed"
    | "llm"
    | "tool"
    | "delegated"
    | "delegate_response"
    | "replied"
    | "error";

export interface StreamItemDetails {
    duration?: number;
    tokens?: { input: number; output: number };
    model?: string;
    toolName?: string;
    toolArgs?: Record<string, any>;
    toolResult?: string;
    error?: string;
    fullPayloadAvailable?: boolean;
}

export interface StreamItem {
    timestamp: number;
    type: StreamItemType;
    agent: string;
    preview: string;
    details?: StreamItemDetails;
    spanId?: string;
    eventId?: string;
}

export interface Conversation {
    id: string;
    firstMessage: string;
    timestamp: number;
    messageCount: number;
    agents: string[];
}

export interface AgentIndex {
    bySlug: Record<string, string>;
    byEventId: Record<string, string>;
}

export interface ToolMessage {
    eventId: string;
    agentPubkey: string;
    timestamp: number;
    messages: Array<{
        role: string;
        content: any;
    }>;
}
