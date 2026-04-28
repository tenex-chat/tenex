/**
 * Unix-socket client for the tenex daemon's LLM config IPC server.
 *
 * Wire protocol (see `crates/tenex-llm-config/src/protocol.rs`):
 *   One JSON object per line, newline-terminated (NDJSON).
 *
 * Socket: `<TENEX_BASE_DIR>/llm-config.sock`
 *
 * ## Requests
 *
 *   resolve:        `{"method":"resolve","name":"<config-name>"}`
 *   resolve_role:   `{"method":"resolve_role","role":"<role>"}`
 *   report_failure: `{"method":"report_failure","provider":"<id>","keyIndex":<n>}`
 *
 * ## Responses
 *
 *   Standard config: `{"ok":true,"kind":"standard","provider":…,"model":…,"apiKeys":[…],…extras}`
 *   Meta config:     `{"ok":true,"kind":"meta","default":"fast","variants":{…}}`
 *   Error:           `{"ok":false,"error":"<message>"}`
 */

import { createConnection } from "node:net";
import { join } from "node:path";
import { getTenexBasePath } from "@/constants";

// ── Response types (mirrors crates/tenex-llm-config/src/protocol.rs) ─────────

/**
 * A single API key with its alias stripped out.
 *
 * Any key string may carry a trailing alias after the first space:
 * `"sk-or-v1-... alice@example.com"` or `"sk-or-v1-... work-key"`.
 * The daemon parses that at load time — callers always receive a clean `key`
 * and never have to split the raw string themselves.
 */
export interface ApiKey {
    /** The actual API key, with any trailing alias removed. */
    key: string;
    /** Human-readable label embedded after the first space in the on-disk key string. */
    alias?: string;
}

/**
 * A fully resolved standard LLM config.
 *
 * `apiKeys` contains only the healthy (not in cooldown) keys for the provider.
 * Extra fields (temperature, maxTokens, effort, …) are inlined at the top level.
 */
export interface ResolvedStandardConfig {
    ok: true;
    kind: "standard";
    provider: string;
    model: string;
    /** Healthy API keys, alias-stripped. Empty for agent providers (claude-code, ollama). */
    apiKeys: ApiKey[];
    baseUrl?: string;
    timeout?: number;
    /** Provider-specific extras — temperature, maxTokens, effort, etc. */
    [key: string]: unknown;
}

/** One variant within a meta config, with its underlying model already resolved. */
export interface ResolvedVariant {
    /** Config name in llms.json that this variant maps to. */
    modelConfig: string;
    keywords: string[];
    description?: string;
    systemPrompt?: string;
    /** Fully resolved standard config for this variant. */
    resolved: ResolvedStandardConfig;
}

/**
 * A meta config returned as-is (variants + default).
 *
 * Keyword dispatch is the caller's responsibility; see `MetaModelResolver`.
 * Each variant's `resolved` field already contains the correct API keys.
 */
export interface ResolvedMetaConfig {
    ok: true;
    kind: "meta";
    default: string;
    variants: Record<string, ResolvedVariant>;
}

export type ResolvedConfig = ResolvedStandardConfig | ResolvedMetaConfig;

export interface LlmConfigError {
    ok: false;
    error: string;
}

export type LlmConfigResponse = ResolvedConfig | LlmConfigError;

// ── Transport ─────────────────────────────────────────────────────────────────

const SOCKET_NAME = "llm-config.sock";
const TIMEOUT_MS = 2000;

export class LlmConfigDaemonError extends Error {}

function socketPath(): string {
    return join(getTenexBasePath(), SOCKET_NAME);
}

function request(payload: Record<string, unknown>): Promise<LlmConfigResponse> {
    return new Promise((resolve, reject) => {
        const sock = createConnection({ path: socketPath() });
        let buf = "";
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            sock.destroy();
            reject(
                new LlmConfigDaemonError(
                    `llm-config daemon timed out after ${TIMEOUT_MS}ms`
                )
            );
        }, TIMEOUT_MS);

        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            action();
        };

        sock.on("connect", () => {
            sock.write(JSON.stringify(payload) + "\n");
        });

        sock.on("data", (chunk) => {
            buf += chunk.toString("utf-8");
            const idx = buf.indexOf("\n");
            if (idx < 0) return;
            const line = buf.slice(0, idx).trim();
            try {
                finish(() => resolve(JSON.parse(line) as LlmConfigResponse));
            } catch {
                finish(() =>
                    reject(
                        new LlmConfigDaemonError(`llm-config: invalid JSON response: ${line}`)
                    )
                );
            }
        });

        sock.on("error", (err) => {
            finish(() =>
                reject(
                    new LlmConfigDaemonError(
                        `llm-config daemon connect failed: ${err.message}`
                    )
                )
            );
        });

        sock.on("end", () => {
            if (settled) return;
            finish(() =>
                reject(
                    new LlmConfigDaemonError(
                        "llm-config daemon closed connection without response"
                    )
                )
            );
        });
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve a named LLM configuration.
 *
 * @example
 * const cfg = await resolveLlmConfig("opus");
 * if (!cfg.ok) throw new Error(cfg.error);
 * if (cfg.kind === "standard") {
 *   const key = cfg.apiKeys[0];
 *   // use key, provider, model, and any extras (temperature, etc.)
 * }
 */
export function resolveLlmConfig(name: string): Promise<LlmConfigResponse> {
    return request({ method: "resolve", name });
}

/**
 * Resolve the config assigned to a role.
 *
 * Roles: `"default"`, `"summarization"`, `"supervision"`, `"promptCompilation"`,
 * `"categorization"`, `"contextDiscovery"`.
 */
export function resolveLlmRole(role: string): Promise<LlmConfigResponse> {
    return request({ method: "resolve_role", role });
}

/**
 * Report that key at position `keyIndex` in the provider's key array has
 * failed. The daemon will exclude that key for 5 minutes.
 *
 * `keyIndex` matches the index of the key in the `apiKeys` array returned
 * by a previous `resolveLlmConfig` call.
 */
export function reportKeyFailure(provider: string, keyIndex: number): Promise<void> {
    return request({ method: "report_failure", provider, keyIndex }).then(() => undefined);
}
