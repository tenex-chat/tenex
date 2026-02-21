/**
 * BlossomService - Handles Blossom media uploads with Nostr authentication
 *
 * This service encapsulates all Blossom upload logic including:
 * - SHA256 hash calculation
 * - Kind 24242 authorization event creation and signing
 * - HTTP upload to Blossom servers
 *
 * Centralizes NDK usage in the nostr layer, allowing tools to delegate
 * Blossom operations without directly importing NDK.
 */

import * as crypto from "node:crypto";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";
import { NDKEvent as NDKEventClass } from "@nostr-dev-kit/ndk";

/**
 * Minimal signer interface needed for Blossom authentication.
 * This allows both AgentInstance and ToolAgentInfo to be used.
 */
export interface BlossomSigner {
    sign(event: NDKEvent): Promise<void>;
}

const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Result of a successful Blossom upload
 */
export interface BlossomUploadResult {
    /** URL of the uploaded blob */
    url: string;
    /** SHA256 hash of the uploaded data */
    sha256: string;
    /** Size in bytes */
    size: number;
    /** MIME type (if returned by server) */
    type?: string;
    /** Timestamp of upload */
    uploaded?: number;
}

/**
 * Options for uploading to Blossom
 */
export interface BlossomUploadOptions {
    /** Blossom server URL (required - callers must load from config) */
    serverUrl: string;
    /** Description for the authorization event content */
    description?: string;
}

/**
 * MIME type to file extension mapping
 */
const MIME_TO_EXTENSION: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "application/pdf": ".pdf",
    "application/json": ".json",
    "text/plain": ".txt",
};

/**
 * Get file extension from MIME type
 */
export function getExtensionFromMimeType(mimeType: string): string {
    return MIME_TO_EXTENSION[mimeType] || "";
}

/**
 * Calculate SHA256 hash of data
 */
export function calculateSHA256(data: Buffer): string {
    return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * BlossomService handles uploading media to Blossom servers with Nostr authentication.
 *
 * This service:
 * 1. Calculates SHA256 hash of the data
 * 2. Creates and signs a kind 24242 authorization event
 * 3. Uploads the data to the Blossom server
 * 4. Returns the result with URL and metadata
 */
export class BlossomService {
    private signer: BlossomSigner;

    constructor(signer: BlossomSigner) {
        this.signer = signer;
    }

    /**
     * Upload data to Blossom server with Nostr authentication.
     *
     * @param data - The binary data to upload
     * @param mimeType - MIME type of the data (e.g., "image/png")
     * @param options - Upload configuration including serverUrl (required)
     * @returns Upload result with URL and metadata
     */
    async upload(
        data: Buffer,
        mimeType: string,
        options: BlossomUploadOptions
    ): Promise<BlossomUploadResult> {
        const { serverUrl, description = "Blossom upload" } = options;

        // Calculate hash
        const sha256Hash = calculateSHA256(data);

        logger.debug("[BlossomService] Preparing upload", {
            size: data.length,
            mimeType,
            sha256: sha256Hash.slice(0, 12) + "...",
            serverUrl,
        });

        // Create and sign authorization event
        const authEvent = await this.createAuthEvent(sha256Hash, description);

        // Upload to server
        const result = await this.uploadToServer(serverUrl, data, mimeType, authEvent);

        logger.info("[BlossomService] Upload successful", {
            url: result.url,
            sha256: result.sha256,
            size: result.size,
        });

        return result;
    }

    /**
     * Create Blossom authorization event (kind 24242)
     *
     * Per Blossom protocol, this event authorizes the upload:
     * - kind: 24242
     * - content: description of the upload
     * - tags: ["t", "upload"], ["x", sha256], ["expiration", timestamp]
     */
    private async createAuthEvent(sha256Hash: string, description: string): Promise<NDKEvent> {
        const event = new NDKEventClass();
        event.kind = 24242;
        event.content = description;
        event.created_at = Math.floor(Date.now() / 1000);
        event.tags = [
            ["t", "upload"],
            ["x", sha256Hash],
            ["expiration", String(Math.floor(Date.now() / 1000) + 3600)], // 1 hour expiration
        ];

        await this.signer.sign(event);
        return event;
    }

    /**
     * Upload data to Blossom server
     */
    private async uploadToServer(
        serverUrl: string,
        data: Buffer,
        mimeType: string,
        authEvent: NDKEvent
    ): Promise<BlossomUploadResult> {
        // Encode the auth event as base64 for the Authorization header
        const authHeader = `Nostr ${Buffer.from(JSON.stringify(authEvent.rawEvent())).toString("base64")}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

        try {
            const response = await fetch(`${serverUrl}/upload`, {
                method: "PUT",
                headers: {
                    Authorization: authHeader,
                    "Content-Type": mimeType,
                    "Content-Length": String(data.length),
                },
                body: data,
                signal: controller.signal,
            });

            if (!response.ok) {
                let errorMessage = `Upload failed with status ${response.status}`;
                try {
                    const errorData = (await response.json()) as { message?: string };
                    if (errorData.message) {
                        errorMessage = `Upload failed: ${errorData.message}`;
                    }
                } catch {
                    // If parsing JSON fails, use the default error message
                }
                throw new Error(errorMessage);
            }

            const result = (await response.json()) as BlossomUploadResult;

            // Add extension to URL if not present
            if (result.url && !result.url.match(/\.\w+$/)) {
                const ext = getExtensionFromMimeType(mimeType);
                if (ext) {
                    result.url = result.url + ext;
                }
            }

            return result;
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                throw new Error(`Upload timed out after ${UPLOAD_TIMEOUT_MS}ms`, { cause: error });
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }
}
