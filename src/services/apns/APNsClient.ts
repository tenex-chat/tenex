/**
 * HTTP/2 client for Apple Push Notification service (APNs).
 *
 * Handles JWT token generation (ES256) and push delivery.
 * Uses native fetch (Bun supports HTTP/2 via ALPN).
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { logger } from "@/utils/logger";
import type { APNsPayload, APNsSendResult } from "./types";

const LOG_PREFIX = "[APNsClient]";

/** JWT tokens are valid for up to 1 hour; we refresh at 50 minutes. */
const JWT_REFRESH_INTERVAL_MS = 50 * 60 * 1000;

/** APNs production endpoint */
const APNS_PRODUCTION_HOST = "https://api.push.apple.com";

/** APNs sandbox endpoint */
const APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com";

export interface APNsClientConfig {
    keyPath: string;
    keyId: string;
    teamId: string;
    bundleId: string;
    production: boolean;
}

/**
 * Base64url encode a buffer (no padding).
 */
function base64url(buf: Buffer): string {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class APNsClient {
    private config: APNsClientConfig;
    private signingKey: crypto.KeyObject | null = null;
    private cachedJwt: string | null = null;
    private jwtIssuedAt = 0;
    private fetchFn: typeof fetch;

    constructor(clientConfig: APNsClientConfig, fetchFn?: typeof fetch) {
        this.config = clientConfig;
        this.fetchFn = fetchFn ?? fetch;
    }

    /**
     * Load the .p8 private key from disk.
     * Called lazily on first send.
     */
    private loadSigningKey(): void {
        const keyData = fs.readFileSync(this.config.keyPath, "utf-8");
        this.signingKey = crypto.createPrivateKey(keyData);

        logger.info(`${LOG_PREFIX} Loaded APNs signing key`, {
            keyId: this.config.keyId,
            teamId: this.config.teamId,
        });
    }

    /**
     * Generate a JWT for APNs authentication (ES256).
     * Caches the token and refreshes before expiry.
     */
    private getJwt(): string {
        const now = Math.floor(Date.now() / 1000);

        // Return cached JWT if still fresh
        if (this.cachedJwt && (now - this.jwtIssuedAt) * 1000 < JWT_REFRESH_INTERVAL_MS) {
            return this.cachedJwt;
        }

        if (!this.signingKey) {
            this.loadSigningKey();
        }

        // JWT Header
        const header = base64url(
            Buffer.from(JSON.stringify({ alg: "ES256", kid: this.config.keyId }))
        );

        // JWT Payload
        const payload = base64url(
            Buffer.from(JSON.stringify({ iss: this.config.teamId, iat: now }))
        );

        // Sign
        if (!this.signingKey) {
            throw new Error("Signing key not loaded");
        }
        const signingInput = `${header}.${payload}`;
        const sign = crypto.createSign("SHA256");
        sign.update(signingInput);
        const derSignature = sign.sign(this.signingKey);

        // Convert DER signature to raw r||s (64 bytes) for ES256
        const rawSignature = derToRaw(derSignature);
        const signature = base64url(rawSignature);

        this.cachedJwt = `${signingInput}.${signature}`;
        this.jwtIssuedAt = now;

        logger.debug(`${LOG_PREFIX} Generated new JWT`, { iat: now });

        return this.cachedJwt;
    }

    /**
     * Send a push notification to a single device token.
     */
    async send(deviceToken: string, payload: APNsPayload): Promise<APNsSendResult> {
        const host = this.config.production ? APNS_PRODUCTION_HOST : APNS_SANDBOX_HOST;
        const url = `${host}/3/device/${deviceToken}`;
        const body = JSON.stringify(payload);

        try {
            const jwt = this.getJwt();
            const response = await this.fetchFn(url, {
                method: "POST",
                headers: {
                    "authorization": `bearer ${jwt}`,
                    "apns-topic": this.config.bundleId,
                    "apns-push-type": "alert",
                    "apns-priority": "10",
                    "content-type": "application/json",
                },
                body,
            });

            const statusCode = response.status;

            if (statusCode === 200) {
                return { success: true, statusCode };
            }

            // Parse error response
            const errorBody = await response.json().catch(() => ({})) as Record<string, unknown>;
            const reason = (errorBody.reason as string) ?? "unknown";

            logger.warn(`${LOG_PREFIX} APNs rejected push`, {
                statusCode,
                reason,
                deviceToken: deviceToken.substring(0, 8),
            });

            const result: APNsSendResult = { success: false, statusCode, reason };

            // 410 Gone means the token is no longer valid
            if (statusCode === 410 && typeof errorBody.timestamp === "number") {
                result.timestampMs = errorBody.timestamp as number;
            }

            return result;
        } catch (error) {
            logger.error(`${LOG_PREFIX} Failed to send push notification`, {
                error: error instanceof Error ? error.message : String(error),
                deviceToken: deviceToken.substring(0, 8),
            });

            return { success: false, statusCode: 0, reason: "network_error" };
        }
    }
}

/**
 * Convert a DER-encoded ECDSA signature to raw r||s format (64 bytes for P-256).
 * DER format: 0x30 <total_len> 0x02 <r_len> <r> 0x02 <s_len> <s>
 */
function derToRaw(der: Buffer): Buffer {
    const raw = Buffer.alloc(64);

    // Parse DER structure
    let offset = 2; // skip 0x30 and total length

    // Read r
    offset += 1; // skip 0x02
    const rLen = der[offset] ?? 0;
    offset += 1;
    const rBytes = der.subarray(offset, offset + rLen);
    offset += rLen;

    // Read s
    offset += 1; // skip 0x02
    const sLen = der[offset] ?? 0;
    offset += 1;
    const sBytes = der.subarray(offset, offset + sLen);

    // Copy r (right-aligned, strip leading zero if present)
    const rStart = rBytes[0] === 0 ? 1 : 0;
    const rActual = rBytes.subarray(rStart);
    rActual.copy(raw, 32 - rActual.length);

    // Copy s (right-aligned, strip leading zero if present)
    const sStart = sBytes[0] === 0 ? 1 : 0;
    const sActual = sBytes.subarray(sStart);
    sActual.copy(raw, 64 - sActual.length);

    return raw;
}
