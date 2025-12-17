import type { ExportResult } from "@opentelemetry/core";
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

const resource = resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: "tenex-daemon",
    [SEMRESATTRS_SERVICE_VERSION]: process.env.npm_package_version || "0.8.0",
    "deployment.environment": process.env.NODE_ENV || "development",
});

const exporterUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces";
const traceExporter = new OTLPTraceExporter({
    url: exporterUrl,
});

let collectorAvailable = true;

class ErrorHandlingExporterWrapper implements SpanExporter {
    private hasLoggedError = false;

    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
        traceExporter.export(spans, (result) => {
            if (result.error && collectorAvailable) {
                const errorMessage = result.error?.message || String(result.error);
                if (errorMessage.includes("ECONNREFUSED") || errorMessage.includes("connect")) {
                    if (!this.hasLoggedError) {
                        console.warn(`[Telemetry] ⚠️  Collector not available at ${exporterUrl}`);
                        console.warn(
                            "[Telemetry] Traces will be collected locally but not exported"
                        );
                        this.hasLoggedError = true;
                        collectorAvailable = false;
                    }
                } else if (!this.hasLoggedError) {
                    console.error("[Telemetry] Export error:", errorMessage);
                    this.hasLoggedError = true;
                }
            }
            resultCallback(result);
        });
    }

    shutdown(): Promise<void> {
        return traceExporter.shutdown();
    }
}

const wrappedExporter = new ErrorHandlingExporterWrapper();

// Create a wrapper processor that enriches span names and fixes Nostr IDs before exporting
class EnrichedBatchSpanProcessor extends BatchSpanProcessor {
    private enricher = new ToolCallSpanProcessor();
    private nostrProcessor = new NostrSpanProcessor();

    onEnd(span: ReadableSpan): void {
        // First fix Nostr span IDs (must happen before export)
        this.nostrProcessor.onEnd(span);
        // Then enrich the span name
        this.enricher.onEnd(span);
        // Then pass to batch processor
        super.onEnd(span);
    }
}

const spanProcessor = new EnrichedBatchSpanProcessor(wrappedExporter, {
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
    scheduledDelayMillis: 5000, // Send every 5 seconds
});

export const sdk = new NodeSDK({
    resource,
    spanProcessor,
    // NO sampling - capture everything (100%)
    // NO instrumentation filters - capture all
});

export function initializeTelemetry(): void {
    sdk.start();
    console.log("[Telemetry] OpenTelemetry enabled - capturing ALL traces");
    console.log(
        `[Telemetry] Exporting to ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces"}`
    );

    process.on("SIGTERM", () => {
        sdk.shutdown()
            .then(() => console.log("[Telemetry] Shut down successfully"))
            .catch(console.error);
    });

    process.on("SIGINT", () => {
        sdk.shutdown()
            .then(() => console.log("[Telemetry] Shut down successfully"))
            .catch(console.error)
            .finally(() => process.exit(0));
    });
}

export function shutdownTelemetry(): Promise<void> {
    return sdk.shutdown();
}
