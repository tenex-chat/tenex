import axios from "axios";
import type { Trace, TraceSpan, Conversation, StreamItem, StreamItemType } from "../types.js";

interface JaegerSpan {
    traceID: string;
    spanID: string;
    operationName: string;
    references: Array<{
        refType: string;
        traceID: string;
        spanID: string;
    }>;
    startTime: number;
    duration: number;
    tags: Array<{
        key: string;
        type: string;
        value: any;
    }>;
    logs: Array<{
        timestamp: number;
        fields: Array<{
            key: string;
            type: string;
            value: any;
        }>;
    }>;
    processID: string;
}

interface JaegerTrace {
    traceID: string;
    spans: JaegerSpan[];
    processes: Record<
        string,
        {
            serviceName: string;
            tags: Array<{
                key: string;
                type: string;
                value: any;
            }>;
        }
    >;
}

interface JaegerTracesResponse {
    data: JaegerTrace[];
    total: number;
    limit: number;
    offset: number;
    errors: any[] | null;
}

export class JaegerClient {
    private baseUrl: string;

    constructor(baseUrl = "http://localhost:16686") {
        this.baseUrl = baseUrl;
    }

    /**
     * Fetch recent traces for a service
     */
    async getTraces(
        service = "tenex-daemon",
        limit = 20
    ): Promise<
        Array<{
            traceId: string;
            summary: string;
            duration: number;
            timestamp: number;
        }>
    > {
        try {
            const response = await axios.get<JaegerTracesResponse>(`${this.baseUrl}/api/traces`, {
                params: {
                    service,
                    limit,
                    lookback: "1h", // Last hour
                },
            });

            if (!response.data.data || response.data.data.length === 0) {
                return [];
            }

            return response.data.data.map((trace) => {
                const rootSpan = this.findRootSpan(trace.spans);
                const summary = this.generateTraceSummary(rootSpan, trace);
                const duration = this.calculateTotalDuration(trace.spans);
                const timestamp = rootSpan?.startTime || 0;

                return {
                    traceId: trace.traceID,
                    summary,
                    duration: Math.round(duration / 1000), // Convert to ms
                    timestamp: Math.round(timestamp / 1000), // Convert to ms
                };
            });
        } catch (error) {
            if (axios.isAxiosError(error) && error.code === "ECONNREFUSED") {
                throw new Error(`Cannot connect to Jaeger at ${this.baseUrl}. Is Jaeger running?`);
            }
            throw error;
        }
    }

    /**
     * Fetch a specific trace by ID
     */
    async getTrace(traceId: string): Promise<Trace> {
        try {
            const response = await axios.get<JaegerTracesResponse>(
                `${this.baseUrl}/api/traces/${traceId}`
            );

            if (!response.data.data || response.data.data.length === 0) {
                throw new Error(`Trace ${traceId} not found`);
            }

            const jaegerTrace = response.data.data[0];
            return this.convertJaegerTrace(jaegerTrace);
        } catch (error) {
            if (axios.isAxiosError(error) && error.code === "ECONNREFUSED") {
                throw new Error(`Cannot connect to Jaeger at ${this.baseUrl}. Is Jaeger running?`);
            }
            throw error;
        }
    }

    /**
     * Convert Jaeger trace format to our TraceSpan format
     */
    private convertJaegerTrace(jaegerTrace: JaegerTrace): Trace {
        const spans = jaegerTrace.spans;
        const rootSpan = this.findRootSpan(spans);

        if (!rootSpan) {
            throw new Error("No root span found in trace");
        }

        // Debug: Log span structure
        console.error(`[JaegerClient] Converting trace with ${spans.length} spans`);
        console.error(`[JaegerClient] Root span: ${rootSpan.operationName} (${rootSpan.spanID})`);

        // Build parent-child map for efficient tree construction
        const childrenMap = new Map<string, JaegerSpan[]>();
        const spanMap = new Map<string, JaegerSpan>();

        spans.forEach((span) => {
            spanMap.set(span.spanID, span);

            // Find parent reference
            const parentRef = span.references?.find((ref) => ref.refType === "CHILD_OF");
            if (parentRef) {
                const parentId = parentRef.spanID;
                if (!childrenMap.has(parentId)) {
                    childrenMap.set(parentId, []);
                }
                childrenMap.get(parentId)?.push(span);
                console.error(
                    `[JaegerClient] Found child: ${span.operationName} (${span.spanID.substring(0, 8)}) -> parent: ${parentId.substring(0, 8)}`
                );
            }
        });

        console.error(`[JaegerClient] Built children map with ${childrenMap.size} parent spans`);

        // Convert to our format starting from root
        const convertedRoot = this.convertSpan(rootSpan, childrenMap);

        return {
            traceId: jaegerTrace.traceID,
            rootSpan: convertedRoot,
            totalDuration: Math.round(this.calculateTotalDuration(spans) / 1000),
            timestamp: Math.round(rootSpan.startTime / 1000),
        };
    }

    /**
     * Convert a single Jaeger span to our TraceSpan format
     */
    private convertSpan(jaegerSpan: JaegerSpan, childrenMap: Map<string, JaegerSpan[]>): TraceSpan {
        // Convert tags to attributes
        const attributes: Record<string, any> = {};
        jaegerSpan.tags?.forEach((tag) => {
            attributes[tag.key] = tag.value;
        });

        // Convert logs to events
        const events = (jaegerSpan.logs || []).map((log) => {
            const eventAttributes: Record<string, any> = {};
            log.fields.forEach((field) => {
                eventAttributes[field.key] = field.value;
            });

            // Try to get event name from 'event' field, otherwise use first field key
            const eventName =
                eventAttributes.event || eventAttributes.name || log.fields[0]?.key || "event";

            return {
                name: eventName,
                timestamp: Math.round(log.timestamp / 1000), // Convert to ms
                attributes: eventAttributes,
            };
        });

        // Get children from pre-built map and convert recursively
        const jaegerChildren = childrenMap.get(jaegerSpan.spanID) || [];
        const children: TraceSpan[] = jaegerChildren
            .map((child) => this.convertSpan(child, childrenMap))
            .sort((a, b) => a.startTime - b.startTime);

        return {
            spanId: jaegerSpan.spanID,
            parentSpanId: jaegerSpan.references?.find((ref) => ref.refType === "CHILD_OF")?.spanID,
            operationName: jaegerSpan.operationName,
            startTime: Math.round(jaegerSpan.startTime / 1000), // Convert to ms
            duration: Math.round(jaegerSpan.duration / 1000), // Convert to ms
            attributes,
            events,
            children,
        };
    }

    /**
     * Find the root span (span with no parent reference)
     */
    private findRootSpan(spans: JaegerSpan[]): JaegerSpan | null {
        for (const span of spans) {
            const hasParent = span.references.some((ref) => ref.refType === "CHILD_OF");
            if (!hasParent) {
                return span;
            }
        }
        return spans[0] || null; // Fallback to first span
    }

    /**
     * Calculate total duration of a trace
     */
    private calculateTotalDuration(spans: JaegerSpan[]): number {
        if (spans.length === 0) return 0;

        const startTimes = spans.map((s) => s.startTime);
        const endTimes = spans.map((s) => s.startTime + s.duration);

        const minStart = Math.min(...startTimes);
        const maxEnd = Math.max(...endTimes);

        return maxEnd - minStart;
    }

    /**
     * Generate a human-readable summary for a trace
     */
    private generateTraceSummary(rootSpan: JaegerSpan | null, _trace: JaegerTrace): string {
        if (!rootSpan) return "Unknown trace";

        // Try to get event content or operation name
        const contentTag = rootSpan.tags.find((t) => t.key === "event.content");
        if (contentTag?.value) {
            const content = String(contentTag.value);
            return content.length > 60 ? `${content.substring(0, 60)}...` : content;
        }

        // Try to get agent name for agent executions
        const agentNameTag = rootSpan.tags.find((t) => t.key === "agent.name");
        if (agentNameTag?.value) {
            return `${agentNameTag.value} - ${rootSpan.operationName}`;
        }

        return rootSpan.operationName;
    }

    /**
     * Fetch recent conversations (traces grouped by conversation.id)
     */
    async getConversations(
        service = "tenex-daemon",
        limit = 50
    ): Promise<Conversation[]> {
        try {
            const response = await axios.get<JaegerTracesResponse>(`${this.baseUrl}/api/traces`, {
                params: {
                    service,
                    limit: limit * 5, // Fetch more traces to group into conversations
                    lookback: "6h",
                },
            });

            if (!response.data.data || response.data.data.length === 0) {
                return [];
            }

            // Group traces by conversation.id
            const conversationMap = new Map<string, {
                traces: JaegerTrace[];
                firstMessage: string;
                timestamp: number;
                agents: Set<string>;
            }>();

            for (const trace of response.data.data) {
                const rootSpan = this.findRootSpan(trace.spans);
                if (!rootSpan) continue;

                const conversationId = this.getTagValue(rootSpan, "conversation.id") || trace.traceID;
                const eventContent = this.getTagValue(rootSpan, "event.content");
                const agentName = this.getTagValue(rootSpan, "agent.name") ||
                    this.getTagValue(rootSpan, "agent.slug");

                if (!conversationMap.has(conversationId)) {
                    conversationMap.set(conversationId, {
                        traces: [],
                        firstMessage: eventContent || rootSpan.operationName,
                        timestamp: rootSpan.startTime,
                        agents: new Set(),
                    });
                }

                const conv = conversationMap.get(conversationId)!;
                conv.traces.push(trace);

                if (agentName) {
                    conv.agents.add(agentName);
                }

                // Update first message if this trace is earlier
                if (rootSpan.startTime < conv.timestamp) {
                    conv.timestamp = rootSpan.startTime;
                    if (eventContent) {
                        conv.firstMessage = eventContent;
                    }
                }
            }

            // Convert to Conversation array
            const conversations: Conversation[] = [];

            for (const [id, data] of conversationMap) {
                // Count unique spans as "messages" (approximation)
                let messageCount = 0;
                for (const trace of data.traces) {
                    // Count event processing spans as messages
                    messageCount += trace.spans.filter(
                        (s) => s.operationName === "tenex.event.process"
                    ).length;
                }

                conversations.push({
                    id,
                    firstMessage: data.firstMessage.length > 60
                        ? data.firstMessage.substring(0, 60) + "..."
                        : data.firstMessage,
                    timestamp: Math.round(data.timestamp / 1000),
                    messageCount: messageCount || data.traces.length,
                    agents: Array.from(data.agents),
                });
            }

            // Sort by timestamp descending (most recent first)
            conversations.sort((a, b) => b.timestamp - a.timestamp);

            return conversations.slice(0, limit);
        } catch (error) {
            if (axios.isAxiosError(error) && error.code === "ECONNREFUSED") {
                throw new Error(`Cannot connect to Jaeger at ${this.baseUrl}. Is Jaeger running?`);
            }
            throw error;
        }
    }

    /**
     * Fetch all spans for a conversation as a chronological stream
     */
    async getConversationStream(
        conversationId: string,
        service = "tenex-daemon"
    ): Promise<StreamItem[]> {
        try {
            // Query Jaeger for traces with this conversation.id tag
            const response = await axios.get<JaegerTracesResponse>(`${this.baseUrl}/api/traces`, {
                params: {
                    service,
                    limit: 100,
                    lookback: "24h",
                    tags: JSON.stringify({ "conversation.id": conversationId }),
                },
            });

            if (!response.data.data || response.data.data.length === 0) {
                // Fallback: try fetching by trace ID directly
                try {
                    const traceResponse = await axios.get<JaegerTracesResponse>(
                        `${this.baseUrl}/api/traces/${conversationId}`
                    );
                    if (traceResponse.data.data?.length > 0) {
                        return this.tracesToStreamItems(traceResponse.data.data);
                    }
                } catch {
                    // Ignore fallback errors
                }
                return [];
            }

            return this.tracesToStreamItems(response.data.data);
        } catch (error) {
            if (axios.isAxiosError(error) && error.code === "ECONNREFUSED") {
                throw new Error(`Cannot connect to Jaeger at ${this.baseUrl}. Is Jaeger running?`);
            }
            throw error;
        }
    }

    /**
     * Convert traces to chronological stream items
     */
    private tracesToStreamItems(traces: JaegerTrace[]): StreamItem[] {
        const items: StreamItem[] = [];

        for (const trace of traces) {
            for (const span of trace.spans) {
                const item = this.spanToStreamItem(span);
                if (item) {
                    items.push(item);
                }
            }
        }

        // Sort by timestamp
        items.sort((a, b) => a.timestamp - b.timestamp);

        return items;
    }

    /**
     * Convert a span to a stream item
     */
    private spanToStreamItem(span: JaegerSpan): StreamItem | null {
        const agent = this.getTagValue(span, "agent.name") ||
            this.getTagValue(span, "agent.slug") ||
            "unknown";

        // Determine item type and preview based on operation name
        let type: StreamItemType;
        let preview: string;

        if (span.operationName === "tenex.event.process") {
            type = "received";
            const content = this.getTagValue(span, "event.content") || "";
            preview = content.length > 50 ? content.substring(0, 50) + "..." : content;
        } else if (span.operationName.includes("ai.streamText") || span.operationName.includes("ai.generateText")) {
            type = "llm";
            const model = this.getTagValue(span, "ai.model.id") || "unknown";
            preview = model.split("/").pop() || model;
        } else if (span.operationName.includes("ai.toolCall") || span.operationName.match(/^\[.+\] ai\.toolCall/)) {
            type = "tool";
            const toolName = this.getTagValue(span, "ai.toolCall.name") || "unknown";
            const args = this.getTagValue(span, "ai.toolCall.args");
            let argsPreview = "";
            if (args) {
                try {
                    const parsed = JSON.parse(args);
                    const firstKey = Object.keys(parsed)[0];
                    if (firstKey) {
                        const val = String(parsed[firstKey]);
                        argsPreview = `("${val.substring(0, 30)}${val.length > 30 ? "..." : ""}")`;
                    }
                } catch { /* ignore */ }
            }
            preview = toolName + argsPreview;
        } else if (span.operationName.includes("agent.execute")) {
            type = "routed";
            preview = `to ${agent}`;
        } else if (span.operationName.includes("delegate")) {
            type = "delegated";
            preview = this.getTagValue(span, "delegation.target") || agent;
        } else {
            // Skip spans we don't recognize as meaningful stream events
            return null;
        }

        // Check for errors
        const hasError = span.tags.some((t) => t.key === "error" && t.value === true);
        if (hasError) {
            type = "error";
            const errorMsg = span.tags.find((t) => t.key === "error.message")?.value;
            if (errorMsg) {
                preview = String(errorMsg).substring(0, 50);
            }
        }

        return {
            timestamp: Math.round(span.startTime / 1000),
            type,
            agent,
            preview,
            spanId: span.spanID,
            eventId: this.getTagValue(span, "event.id"),
            details: {
                duration: Math.round(span.duration / 1000),
                model: this.getTagValue(span, "ai.model.id"),
                toolName: this.getTagValue(span, "ai.toolCall.name"),
                toolArgs: this.parseJson(this.getTagValue(span, "ai.toolCall.args")),
                toolResult: this.getTagValue(span, "ai.toolCall.result"),
                error: hasError ? this.getTagValue(span, "error.message") : undefined,
            },
        };
    }

    /**
     * Helper to get a tag value from a span
     */
    private getTagValue(span: JaegerSpan, key: string): string | undefined {
        const tag = span.tags.find((t) => t.key === key);
        return tag?.value ? String(tag.value) : undefined;
    }

    /**
     * Helper to parse JSON safely
     */
    private parseJson(value: string | undefined): Record<string, any> | undefined {
        if (!value) return undefined;
        try {
            return JSON.parse(value);
        } catch {
            return undefined;
        }
    }
}
