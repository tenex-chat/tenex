import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { ToolCallSpanProcessor } from "./ToolCallSpanProcessor.js";

const resource = resourceFromAttributes({
  [SEMRESATTRS_SERVICE_NAME]: "tenex-daemon",
  [SEMRESATTRS_SERVICE_VERSION]: process.env.npm_package_version || "0.8.0",
  "deployment.environment": process.env.NODE_ENV || "development",
});

const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces",
});

// Create a wrapper processor that enriches span names before exporting
class EnrichedBatchSpanProcessor extends BatchSpanProcessor {
  private enricher = new ToolCallSpanProcessor();

  onEnd(span: any): void {
    // First enrich the span name
    this.enricher.onEnd(span);
    // Then pass to batch processor
    super.onEnd(span);
  }
}

const spanProcessor = new EnrichedBatchSpanProcessor(traceExporter, {
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
  console.log(`[Telemetry] Exporting to ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces"}`);

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
