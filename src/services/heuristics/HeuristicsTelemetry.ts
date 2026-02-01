/**
 * Telemetry utilities for heuristics system
 *
 * Provides dedicated tracer and span processor for heuristic evaluation
 */

import { trace, type Span } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Span as MutableSpan } from "@opentelemetry/sdk-trace-base";
import type { HeuristicViolation } from "./types";

/** Dedicated tracer for heuristics */
export const heuristicsTracer = trace.getTracer("tenex.heuristics");

/**
 * Span processor that enriches heuristic spans with violation metadata
 */
export class HeuristicSpanProcessor implements SpanProcessor {
  onStart(_span: MutableSpan, _parentContext: Context): void {
    // No-op: we enrich on end
  }

  onEnd(span: ReadableSpan): void {
    // Enrich heuristic evaluation spans with agent context
    if (span.name.startsWith("heuristics.evaluate")) {
      const heuristicId = span.attributes?.["heuristic.id"];
      const agentSlug = span.attributes?.["agent.slug"];
      const violated = span.attributes?.["heuristic.violated"];

      if (heuristicId && typeof heuristicId === "string") {
        const prefix = agentSlug ? `[${agentSlug}] ` : "";
        const suffix = violated ? " ⚠️" : "";
        (span as ReadableSpan & { name: string }).name =
          `${prefix}heuristics.${heuristicId}${suffix}`;
      }
    }

    // Enrich engine evaluation spans
    if (span.name === "heuristics.evaluate_all") {
      const agentSlug = span.attributes?.["agent.slug"];
      const violationCount = span.attributes?.["heuristic.violation_count"];

      if (agentSlug) {
        const suffix = violationCount && typeof violationCount === "number" && violationCount > 0 ? ` [${violationCount} violations]` : "";
        (span as ReadableSpan & { name: string }).name =
          `[${agentSlug}] heuristics.evaluate${suffix}`;
      }
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Add violation metadata to current span
 */
export function recordViolation(span: Span | undefined, violation: HeuristicViolation): void {
  if (!span) return;

  span.addEvent("heuristic.violation_detected", {
    "heuristic.id": violation.heuristicId,
    "violation.id": violation.id,
    "violation.severity": violation.severity,
    "violation.title": violation.title,
  });
}

/**
 * Record evaluation timing
 */
export function recordEvaluation(
  span: Span | undefined,
  heuristicId: string,
  durationMs: number,
  violated: boolean
): void {
  if (!span) return;

  span.addEvent("heuristic.evaluated", {
    "heuristic.id": heuristicId,
    "heuristic.duration_ms": durationMs,
    "heuristic.violated": violated,
  });
}
