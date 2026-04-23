import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import {
    SEMRESATTRS_SERVICE_NAME,
    SEMRESATTRS_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { ToolCallSpanProcessor } from "./ToolCallSpanProcessor.js";
import { NostrSpanProcessor } from "./NostrSpanProcessor.js";

const DEFAULT_SERVICE_NAME = "tenex-daemon";
const DEFAULT_ENDPOINT = "http://localhost:4318/v1/traces";
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 300_000;

class ExportBackoffWrapper implements SpanExporter {
    private nextAttemptAt = 0;
    private currentBackoffMs = INITIAL_BACKOFF_MS;

    constructor(private traceExporter: SpanExporter) {}

    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
        if (Date.now() < this.nextAttemptAt) {
            // Inside the backoff window — drop silently so BatchSpanProcessor
            // doesn't accumulate or repeatedly log the same outage.
            resultCallback({ code: ExportResultCode.SUCCESS });
            return;
        }

        this.traceExporter.export(spans, (result) => {
            if (result.code === ExportResultCode.SUCCESS) {
                this.nextAttemptAt = 0;
                this.currentBackoffMs = INITIAL_BACKOFF_MS;
            } else {
                this.nextAttemptAt = Date.now() + this.currentBackoffMs;
                this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, MAX_BACKOFF_MS);
            }
            resultCallback(result);
        });
    }

    shutdown(): Promise<void> {
        return this.traceExporter.shutdown();
    }
}

// Create a wrapper processor that enriches span names and fixes Nostr IDs before exporting
class EnrichedBatchSpanProcessor extends BatchSpanProcessor {
    private enricher = new ToolCallSpanProcessor();
    private nostrProcessor = new NostrSpanProcessor();

    onEnd(span: ReadableSpan): void {
        // First fix Nostr span IDs (must happen before export)
        this.nostrProcessor.onEnd(span);
        // Then enrich tool call spans
        this.enricher.onEnd(span);
        // Then pass to batch processor
        super.onEnd(span);
    }
}

let sdk: NodeSDK | null = null;

function createSDK(serviceName: string, wrappedExporter: SpanExporter): NodeSDK {
    const resource = resourceFromAttributes({
        [SEMRESATTRS_SERVICE_NAME]: serviceName,
        [SEMRESATTRS_SERVICE_VERSION]: process.env.npm_package_version || "0.8.0",
        "deployment.environment": process.env.NODE_ENV || "development",
    });

    const spanProcessor = new EnrichedBatchSpanProcessor(wrappedExporter, {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000, // Send every 5 seconds
    });

    return new NodeSDK({
        resource,
        spanProcessor,
        // NO sampling - capture everything (100%)
        // NO instrumentation filters - capture all
    });
}

export function initializeTelemetry(
    enabled = true,
    serviceName = DEFAULT_SERVICE_NAME,
    endpoint = DEFAULT_ENDPOINT
): void {
    if (!enabled) {
        return;
    }

    // Use environment variable if set, otherwise use config endpoint
    const exporterUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || endpoint;

    // Create exporter with the configured URL
    const traceExporter = new OTLPTraceExporter({
        url: exporterUrl,
    });

    // Wrap the exporter so transient outages trigger exponential backoff
    // instead of permanently dropping traces.
    const wrappedExporter = new ExportBackoffWrapper(traceExporter);

    sdk = createSDK(serviceName, wrappedExporter);
    sdk.start();
}

export function shutdownTelemetry(): Promise<void> {
    if (!sdk) {
        return Promise.resolve();
    }
    return sdk.shutdown();
}
