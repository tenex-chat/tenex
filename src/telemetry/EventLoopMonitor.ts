/**
 * EventLoopMonitor - Tracks event loop lag to identify blocking operations
 *
 * This module monitors the Node.js event loop for blocking/slow operations
 * that could cause unresponsiveness when multiple agents are streaming.
 *
 * DIAGNOSTIC: This is part of the concurrent streaming bottleneck investigation.
 */

import { trace } from "@opentelemetry/api";
import { logger } from "@/utils/logger";

interface LagSample {
    timestamp: number;
    lagMs: number;
    activeOperations: number;
}

interface EventLoopStats {
    samples: LagSample[];
    peakLagMs: number;
    avgLagMs: number;
    sampleCount: number;
    blockedCount: number; // samples where lag > threshold
}

const DEFAULT_SAMPLE_INTERVAL_MS = 100; // Sample every 100ms
const DEFAULT_LAG_THRESHOLD_MS = 50; // Consider >50ms as "blocked"
const MAX_SAMPLES = 1000; // Keep last 1000 samples

class EventLoopMonitor {
    private static instance: EventLoopMonitor;
    private isRunning = false;
    private samples: LagSample[] = [];
    private peakLagMs = 0;
    private totalLagMs = 0;
    private sampleCount = 0;
    private blockedCount = 0;
    private intervalHandle: ReturnType<typeof setInterval> | null = null;
    private lastCheckTime = 0;
    private getActiveOperationsCount: () => number = () => 0;

    private constructor() {}

    static getInstance(): EventLoopMonitor {
        if (!EventLoopMonitor.instance) {
            EventLoopMonitor.instance = new EventLoopMonitor();
        }
        return EventLoopMonitor.instance;
    }

    /**
     * Start monitoring the event loop.
     * @param getActiveOperationsCount - Function to get current active LLM operations count
     * @param sampleIntervalMs - How often to sample (default 100ms)
     * @param lagThresholdMs - What lag value is considered "blocked" (default 50ms)
     */
    start(
        getActiveOperationsCount: () => number,
        sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
        lagThresholdMs = DEFAULT_LAG_THRESHOLD_MS
    ): void {
        if (this.isRunning) {
            return;
        }

        this.getActiveOperationsCount = getActiveOperationsCount;
        this.isRunning = true;
        this.lastCheckTime = Date.now();

        // Use setInterval but measure actual elapsed time vs expected
        this.intervalHandle = setInterval(() => {
            const now = Date.now();
            const expectedElapsed = sampleIntervalMs;
            const actualElapsed = now - this.lastCheckTime;
            const lag = actualElapsed - expectedElapsed;

            // Only record positive lag (negative would mean timer fired early)
            const lagMs = Math.max(0, lag);
            const activeOps = this.getActiveOperationsCount();

            const sample: LagSample = {
                timestamp: now,
                lagMs,
                activeOperations: activeOps,
            };

            this.samples.push(sample);
            if (this.samples.length > MAX_SAMPLES) {
                this.samples.shift();
            }

            this.sampleCount++;
            this.totalLagMs += lagMs;
            if (lagMs > this.peakLagMs) {
                this.peakLagMs = lagMs;
            }
            if (lagMs > lagThresholdMs) {
                this.blockedCount++;

                // Log significant lag events
                if (lagMs > lagThresholdMs * 2) {
                    const activeSpan = trace.getActiveSpan();
                    activeSpan?.addEvent("event_loop.significant_lag", {
                        "lag.ms": lagMs,
                        "lag.threshold_ms": lagThresholdMs,
                        "concurrent.active_operations": activeOps,
                        "process.memory_heap_used_mb": Math.round(
                            process.memoryUsage().heapUsed / 1024 / 1024
                        ),
                    });

                    logger.warn("[EventLoopMonitor] Significant event loop lag detected", {
                        lagMs,
                        activeOperations: activeOps,
                        threshold: lagThresholdMs,
                    });
                }
            }

            this.lastCheckTime = now;
        }, sampleIntervalMs);

        logger.info("[EventLoopMonitor] Started monitoring", {
            sampleIntervalMs,
            lagThresholdMs,
        });
    }

    /**
     * Stop monitoring
     */
    stop(): void {
        if (!this.isRunning || !this.intervalHandle) {
            return;
        }

        clearInterval(this.intervalHandle);
        this.intervalHandle = null;
        this.isRunning = false;

        logger.info("[EventLoopMonitor] Stopped monitoring");
    }

    /**
     * Get current statistics
     */
    getStats(): EventLoopStats {
        return {
            samples: [...this.samples],
            peakLagMs: this.peakLagMs,
            avgLagMs: this.sampleCount > 0 ? this.totalLagMs / this.sampleCount : 0,
            sampleCount: this.sampleCount,
            blockedCount: this.blockedCount,
        };
    }

    /**
     * Get recent samples where lag was above threshold
     */
    getRecentBlockedSamples(thresholdMs = DEFAULT_LAG_THRESHOLD_MS, maxCount = 10): LagSample[] {
        return this.samples
            .filter((s) => s.lagMs > thresholdMs)
            .slice(-maxCount);
    }

    /**
     * Emit current stats as an OTL span event
     */
    emitStatsEvent(contextLabel: string): void {
        const stats = this.getStats();
        const activeSpan = trace.getActiveSpan();

        activeSpan?.addEvent("event_loop.stats_snapshot", {
            "stats.context": contextLabel,
            "stats.peak_lag_ms": stats.peakLagMs,
            "stats.avg_lag_ms": Math.round(stats.avgLagMs * 100) / 100,
            "stats.sample_count": stats.sampleCount,
            "stats.blocked_count": stats.blockedCount,
            "stats.blocked_percentage":
                stats.sampleCount > 0
                    ? Math.round((stats.blockedCount / stats.sampleCount) * 10000) / 100
                    : 0,
        });
    }

    /**
     * Reset all metrics (for testing)
     */
    reset(): void {
        this.samples = [];
        this.peakLagMs = 0;
        this.totalLagMs = 0;
        this.sampleCount = 0;
        this.blockedCount = 0;
    }

    /**
     * Check if monitoring is currently active
     */
    isActive(): boolean {
        return this.isRunning;
    }
}

export const eventLoopMonitor = EventLoopMonitor.getInstance();
