/**
 * API Key Manager - Handles multi-key rotation, health tracking, and fallback
 *
 * This module provides key management for providers that have multiple API keys.
 * It supports:
 * - Random key selection from a pool of healthy keys
 * - Failure tracking with configurable time windows
 * - Temporary key disabling when failure threshold is exceeded
 * - Automatic re-enabling after the disable window expires
 *
 * @module
 */

import { logger } from "@/utils/logger";

/**
 * Clock interface for injectable time source (enables deterministic testing)
 */
export interface Clock {
    now(): number;
}

const systemClock: Clock = { now: () => Date.now() };

/**
 * Configuration for key health tracking
 */
export interface KeyManagerConfig {
    /** Time window (ms) for counting failures. Failures older than this are ignored. Default: 60000 (1 min) */
    failureWindowMs: number;
    /** Number of failures within the window that triggers temporary disabling. Default: 3 */
    failureThreshold: number;
    /** How long (ms) a key stays disabled after hitting the threshold. Default: 300000 (5 min) */
    disableDurationMs: number;
    /** Injectable clock for testing. Defaults to system clock. */
    clock?: Clock;
}

const DEFAULT_CONFIG: KeyManagerConfig = {
    failureWindowMs: 60_000,
    failureThreshold: 3,
    disableDurationMs: 300_000,
};

/**
 * Health state for a single API key
 */
interface KeyHealth {
    /** Timestamps of recent failures */
    failures: number[];
    /** When the key becomes re-enabled (0 = not disabled) */
    disabledUntil: number;
}

/**
 * Manages API key pools, health tracking, and selection for LLM providers.
 *
 * Each provider can have one or more API keys. The manager tracks failures
 * per key and temporarily disables keys that fail too often, allowing
 * automatic fallback to healthy keys.
 */
export class KeyManager {
    private keys: Map<string, string[]> = new Map();
    private health: Map<string, KeyHealth> = new Map();
    private config: KeyManagerConfig;
    private clock: Clock;

    constructor(config?: Partial<KeyManagerConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.clock = config?.clock ?? systemClock;
    }

    /**
     * Register API keys for a provider.
     * Normalizes single keys to arrays for uniform handling.
     */
    registerKeys(providerId: string, apiKey: string | string[]): void {
        const keys = Array.isArray(apiKey) ? [...apiKey] : [apiKey];
        if (keys.length === 0) {
            return;
        }
        this.keys.set(providerId, keys);

        // Initialize health tracking for new keys
        for (const key of keys) {
            const healthKey = this.healthKey(providerId, key);
            if (!this.health.has(healthKey)) {
                this.health.set(healthKey, { failures: [], disabledUntil: 0 });
            }
        }

        if (keys.length > 1) {
            logger.debug(`[KeyManager] Registered ${keys.length} keys for provider "${providerId}"`);
        }
    }

    /**
     * Select a random healthy key for a provider.
     * Returns undefined if no healthy keys are available.
     */
    selectKey(providerId: string): string | undefined {
        const keys = this.keys.get(providerId);
        if (!keys || keys.length === 0) {
            return undefined;
        }

        const healthy = keys.filter(key => this.isKeyHealthy(providerId, key));

        if (healthy.length === 0) {
            logger.warn(`[KeyManager] No healthy keys available for provider "${providerId}", trying all keys`);
            // Fall back to all keys when everything is disabled — better than nothing
            return keys[Math.floor(Math.random() * keys.length)];
        }

        return healthy[Math.floor(Math.random() * healthy.length)];
    }

    /**
     * Report a key failure. If the failure threshold is reached within the
     * configured window, the key is temporarily disabled.
     */
    reportFailure(providerId: string, apiKey: string): void {
        const hKey = this.healthKey(providerId, apiKey);
        const health = this.health.get(hKey);
        if (!health) {
            return;
        }

        const now = this.clock.now();
        health.failures.push(now);

        // Prune old failures outside the window
        this.pruneFailures(health, now);

        if (health.failures.length >= this.config.failureThreshold) {
            health.disabledUntil = now + this.config.disableDurationMs;
            const keyPreview = apiKey.slice(0, 8) + "...";
            logger.warn(
                `[KeyManager] Key ${keyPreview} for "${providerId}" temporarily disabled ` +
                `(${health.failures.length} failures in ${this.config.failureWindowMs}ms window). ` +
                `Re-enables in ${this.config.disableDurationMs / 1000}s`
            );
        }
    }

    /**
     * Check whether a provider has multiple keys registered
     */
    hasMultipleKeys(providerId: string): boolean {
        const keys = this.keys.get(providerId);
        return !!keys && keys.length > 1;
    }

    /**
     * Get the number of currently healthy keys for a provider
     */
    getHealthyKeyCount(providerId: string): number {
        const keys = this.keys.get(providerId);
        if (!keys) return 0;
        return keys.filter(key => this.isKeyHealthy(providerId, key)).length;
    }

    /**
     * Get all registered provider IDs
     */
    getRegisteredProviders(): string[] {
        return Array.from(this.keys.keys());
    }

    /**
     * Reset all state (for testing)
     */
    reset(): void {
        this.keys.clear();
        this.health.clear();
    }

    /**
     * Check if a specific key is currently healthy (not temporarily disabled)
     */
    private isKeyHealthy(providerId: string, apiKey: string): boolean {
        const hKey = this.healthKey(providerId, apiKey);
        const health = this.health.get(hKey);
        if (!health) return true;

        const now = this.clock.now();

        // Re-enable if disable period has passed
        if (health.disabledUntil > 0 && now >= health.disabledUntil) {
            health.disabledUntil = 0;
            health.failures = [];
            return true;
        }

        return health.disabledUntil === 0;
    }

    /**
     * Remove failures outside the tracking window
     */
    private pruneFailures(health: KeyHealth, now: number): void {
        const cutoff = now - this.config.failureWindowMs;
        health.failures = health.failures.filter(ts => ts > cutoff);
    }

    /**
     * Create a composite key for the health map
     */
    private healthKey(providerId: string, apiKey: string): string {
        return `${providerId}:${apiKey}`;
    }
}

/**
 * Singleton instance shared across the application
 */
export const keyManager = new KeyManager();

/**
 * Resolve an API key that may be a single string or an array.
 * For services that only need a single key (embeddings, image gen),
 * this returns the first key from an array or the string itself.
 */
export function resolveApiKey(apiKey: string | string[] | undefined): string | undefined {
    if (!apiKey) return undefined;
    if (Array.isArray(apiKey)) return apiKey[0];
    return apiKey;
}

/**
 * Check whether an API key value represents a configured, usable key.
 * Handles string, string[], undefined, and empty values.
 */
export function hasApiKey(apiKey: string | string[] | undefined): boolean {
    if (!apiKey) return false;
    if (Array.isArray(apiKey)) return apiKey.some(k => k.length > 0);
    return apiKey.length > 0 && apiKey !== "none";
}
