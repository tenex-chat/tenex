import axios from "axios";
import type { Trace, TraceSpan } from "../types.js";

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
                childrenMap.get(parentId)!.push(span);
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
                eventAttributes["event"] ||
                eventAttributes["name"] ||
                log.fields[0]?.key ||
                "event";

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
    private generateTraceSummary(rootSpan: JaegerSpan | null, trace: JaegerTrace): string {
        if (!rootSpan) return "Unknown trace";

        // Try to get event content or operation name
        const contentTag = rootSpan.tags.find((t) => t.key === "event.content");
        if (contentTag?.value) {
            const content = String(contentTag.value);
            return content.length > 60 ? content.substring(0, 60) + "..." : content;
        }

        // Try to get agent name for agent executions
        const agentNameTag = rootSpan.tags.find((t) => t.key === "agent.name");
        if (agentNameTag?.value) {
            return `${agentNameTag.value} - ${rootSpan.operationName}`;
        }

        return rootSpan.operationName;
    }
}
