/**
 * HeuristicEngine - Core orchestration for reactive heuristic system
 *
 * Evaluates heuristics post-tool execution and manages violation state.
 * CRITICAL: Hard error boundaries ensure single heuristic failure cannot crash pipeline.
 */

import { logger } from "@/utils/logger";
import { formatViolations } from "./formatters";
import type {
  Heuristic,
  HeuristicContext,
  HeuristicEngineConfig,
  HeuristicViolation,
} from "./types";

/**
 * HeuristicEngine orchestrates heuristic evaluation with strict error boundaries.
 *
 * Key guarantees:
 * - Single heuristic failure CANNOT crash tool pipeline
 * - All heuristics get O(1) precomputed context
 * - Violations are stored in RALRegistry namespace
 * - Max 3 warnings per LLM step
 */
export class HeuristicEngine {
  private heuristics: Map<string, Heuristic> = new Map();
  private config: Required<HeuristicEngineConfig>;

  constructor(config: HeuristicEngineConfig = {}) {
    this.config = {
      maxWarningsPerStep: config.maxWarningsPerStep ?? 3,
      debug: config.debug ?? false,
    };

    if (this.config.debug) {
      logger.info("[HeuristicEngine] Initialized", {
        maxWarningsPerStep: this.config.maxWarningsPerStep,
      });
    }
  }

  /**
   * Register a heuristic for evaluation
   */
  register(heuristic: Heuristic): void {
    if (this.heuristics.has(heuristic.id)) {
      logger.warn("[HeuristicEngine] Duplicate heuristic ID - replacing", {
        id: heuristic.id,
      });
    }

    this.heuristics.set(heuristic.id, heuristic);

    if (this.config.debug) {
      logger.info("[HeuristicEngine] Registered heuristic", {
        id: heuristic.id,
        name: heuristic.name,
      });
    }
  }

  /**
   * Unregister a heuristic
   */
  unregister(heuristicId: string): void {
    this.heuristics.delete(heuristicId);
  }

  /**
   * Get all registered heuristics
   */
  getAll(): Heuristic[] {
    return Array.from(this.heuristics.values());
  }

  /**
   * Evaluate all heuristics against the current context.
   * Each heuristic is wrapped in a hard try/catch boundary.
   *
   * @param context - Precomputed O(1) context
   * @returns Array of violations (empty if all rules pass)
   */
  evaluate(context: HeuristicContext): HeuristicViolation[] {
    const violations: HeuristicViolation[] = [];

    for (const heuristic of this.heuristics.values()) {
      const violation = this.evaluateSingle(heuristic, context);
      if (violation) {
        violations.push(violation);
      }
    }

    return violations;
  }


  /**
   * Evaluate a single heuristic with error boundary.
   * CRITICAL: This method MUST NOT throw - it catches all errors.
   */
  private evaluateSingle(heuristic: Heuristic, context: HeuristicContext): HeuristicViolation | null {
    try {
      const violation = heuristic.evaluate(context);

      if (violation && this.config.debug) {
        logger.info("[HeuristicEngine] Violation detected", {
          heuristicId: heuristic.id,
          violationId: violation.id,
          severity: violation.severity,
          title: violation.title,
        });
      }

      return violation;
    } catch (error) {
      // HARD ERROR BOUNDARY: Log but never throw
      logger.error("[HeuristicEngine] Heuristic evaluation failed - skipping", {
        heuristicId: heuristic.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return null;
    }
  }


  /**
   * Format violations for LLM injection.
   * Sorts by severity (errors first) and limits to maxWarningsPerStep.
   *
   * @param violations - All detected violations
   * @returns Markdown string for system message
   */
  formatForInjection(violations: HeuristicViolation[]): string {
    if (violations.length === 0) {
      return "";
    }

    // Sort: errors first, then by timestamp (most recent first)
    const sorted = violations.sort((a, b) => {
      if (a.severity !== b.severity) {
        return a.severity === "error" ? -1 : 1;
      }
      return b.timestamp - a.timestamp;
    });

    // Limit to max warnings
    const limited = sorted.slice(0, this.config.maxWarningsPerStep);

    if (this.config.debug && limited.length < sorted.length) {
      logger.info("[HeuristicEngine] Truncated violations for injection", {
        total: sorted.length,
        shown: limited.length,
        hidden: sorted.length - limited.length,
      });
    }

    return formatViolations(limited);
  }

  /**
   * Get debug summary of current state
   */
  getDebugInfo(): {
    registeredCount: number;
    heuristics: Array<{ id: string; name: string }>;
    config: Required<HeuristicEngineConfig>;
  } {
    return {
      registeredCount: this.heuristics.size,
      heuristics: Array.from(this.heuristics.values()).map((h) => ({
        id: h.id,
        name: h.name,
      })),
      config: this.config,
    };
  }
}

/** Global singleton instance */
let engineInstance: HeuristicEngine | null = null;

/**
 * Get or create the global HeuristicEngine instance
 */
export function getHeuristicEngine(config?: HeuristicEngineConfig): HeuristicEngine {
  if (!engineInstance) {
    engineInstance = new HeuristicEngine(config);
  }
  return engineInstance;
}

/**
 * Reset the global instance (for testing)
 */
export function resetHeuristicEngine(): void {
  engineInstance = null;
}
