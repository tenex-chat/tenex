/**
 * Diagnostics Configuration - Feature flag for diagnostic instrumentation
 *
 * Controls whether detailed diagnostic telemetry is collected.
 * Disable in production for performance; enable when investigating issues.
 *
 * Set TENEX_DIAGNOSTICS=true to enable all diagnostic instrumentation.
 */

/**
 * Check if diagnostics are enabled via environment variable.
 * Caches the result at module load time.
 */
export function isDiagnosticsEnabled(): boolean {
    return process.env.TENEX_DIAGNOSTICS === "true";
}

/**
 * Get the diagnostics enabled state (for logging/tracing).
 */
export function getDiagnosticsState(): { enabled: boolean; source: string } {
    const enabled = isDiagnosticsEnabled();
    return {
        enabled,
        source: enabled ? "TENEX_DIAGNOSTICS=true" : "default (disabled)",
    };
}
