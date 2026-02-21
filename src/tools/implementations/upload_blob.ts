/**
 * Upload Blob Tool
 *
 * Uploads files, URLs, or base64 blobs to a Blossom server using Nostr authentication.
 * Supports downloading from URLs, reading local files, and handling base64-encoded data.
 *
 * The tool delegates Blossom upload operations to BlossomService in the nostr layer,
 * keeping NDK usage centralized.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolExecutionContext, AISdkTool } from "@/tools/types";
import { BlossomService } from "@/nostr/BlossomService";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const MAX_BLOB_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_BLOSSOM_SERVER = "https://blossom.primal.net";

/**
 * Load Blossom server URL from config.
 * Falls back to default if config is unavailable.
 */
async function loadBlossomServerUrl(): Promise<string> {
    try {
        const tenexConfig = await config.loadTenexConfig(config.getGlobalPath());
        return tenexConfig.blossomServerUrl || DEFAULT_BLOSSOM_SERVER;
    } catch (error) {
        logger.warn("[upload_blob] Failed to load Blossom config, using default", {
            error: error instanceof Error ? error.message : String(error),
        });
        return DEFAULT_BLOSSOM_SERVER;
    }
}

const uploadBlobSchema = z.object({
    input: z
        .string()
        .describe(
            "REQUIRED: The source to upload - can be a file path (e.g., /path/to/file.jpg), URL to download from (e.g., https://example.com/image.jpg), or base64-encoded blob data. This parameter must be named 'input', not 'url' or 'file'."
        ),
    mimeType: z
        .string()
        .nullable()
        .describe(
            "MIME type of the data (e.g., 'image/jpeg', 'video/mp4'). If not provided, it will be detected from the file extension, URL response headers, or data"
        ),
    description: z
        .string()
        .nullable()
        .describe("Optional description of the upload for the authorization event"),
});

type UploadBlobInput = z.infer<typeof uploadBlobSchema>;

interface UploadBlobOutput {
    url: string;
    sha256: string;
    size: number;
    type?: string;
    uploaded?: number;
}

/**
 * Enforce size limit on blob data
 */
function enforceSizeLimit(bytes: number): void {
    if (bytes > MAX_BLOB_SIZE_BYTES) {
        throw new Error(
            `Blob size ${bytes} bytes exceeds limit of ${MAX_BLOB_SIZE_BYTES} bytes. Please provide a smaller file.`
        );
    }
}

/**
 * Detect MIME type from file extension or data magic bytes
 */
function detectMimeType(filePath?: string, data?: Buffer): string {
    // Try file extension first
    if (filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".mp4": "video/mp4",
            ".mov": "video/quicktime",
            ".avi": "video/x-msvideo",
            ".webm": "video/webm",
            ".mp3": "audio/mpeg",
            ".wav": "audio/wav",
            ".pdf": "application/pdf",
            ".json": "application/json",
            ".txt": "text/plain",
        };
        if (mimeTypes[ext]) {
            return mimeTypes[ext];
        }
    }

    // Try magic bytes detection
    if (data && data.length > 4) {
        const header = data.slice(0, 4).toString("hex");
        if (header.startsWith("ffd8ff")) return "image/jpeg";
        if (header === "89504e47") return "image/png";
        if (header === "47494638") return "image/gif";
        if (header.startsWith("52494646") && data.length > 12) {
            if (data.slice(8, 12).toString("hex") === "57454250") {
                return "image/webp";
            }
        }
    }

    return "application/octet-stream";
}

/**
 * Check if input is a URL
 */
function isURL(input: string): boolean {
    try {
        const url = new URL(input);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

/**
 * Download media from URL
 */
async function downloadFromURL(
    url: string
): Promise<{ data: Buffer; mimeType?: string; filename?: string }> {
    logger.info("[upload_blob] Downloading from URL", { url });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            headers: {
                "User-Agent": "TENEX/1.0 (Blossom Upload Tool)",
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(
                `Failed to download from URL: ${response.status} ${response.statusText}`
            );
        }

        // Check declared size before downloading body
        const declaredSize = response.headers.get("content-length");
        if (declaredSize) {
            const parsed = Number.parseInt(declaredSize, 10);
            if (Number.isFinite(parsed)) {
                enforceSizeLimit(parsed);
            }
        }

        // Get content type from headers
        const contentType = response.headers.get("content-type");
        const mimeType = contentType?.split(";")[0].trim();

        // Try to extract filename from Content-Disposition header or URL
        let filename: string | undefined;
        const contentDisposition = response.headers.get("content-disposition");
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
            if (filenameMatch) {
                filename = filenameMatch[1].replace(/['"]/g, "");
            }
        }

        if (!filename) {
            // Try to extract filename from URL
            const urlPath = new URL(url).pathname;
            const pathSegments = urlPath.split("/");
            const lastSegment = pathSegments[pathSegments.length - 1];
            if (lastSegment?.includes(".")) {
                filename = lastSegment;
            }
        }

        const arrayBuffer = await response.arrayBuffer();
        const data = Buffer.from(arrayBuffer);
        enforceSizeLimit(data.length);

        logger.info("[upload_blob] Downloaded from URL", {
            size: data.length,
            mimeType,
            filename,
        });

        return { data, mimeType, filename };
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(
                `Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms while fetching ${url}`,
                { cause: error }
            );
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Resolve input to data buffer and MIME type
 */
async function resolveInput(
    dataInput: string,
    providedMimeType: string | null
): Promise<{ data: Buffer; mimeType: string; description: string }> {
    // Handle URL download
    if (isURL(dataInput)) {
        const downloadResult = await downloadFromURL(dataInput);
        return {
            data: downloadResult.data,
            mimeType:
                providedMimeType ||
                downloadResult.mimeType ||
                detectMimeType(downloadResult.filename, downloadResult.data),
            description: downloadResult.filename || "Upload from URL",
        };
    }

    // Handle base64 data (with or without data URL prefix)
    if (dataInput.startsWith("data:") || dataInput.includes(",")) {
        const base64Data = dataInput.includes(",") ? dataInput.split(",")[1] : dataInput;
        let mimeType: string;

        // Extract MIME type from data URL if present
        if (dataInput.startsWith("data:")) {
            const matches = dataInput.match(/^data:([^;]+);/);
            mimeType = matches ? matches[1] : (providedMimeType || "application/octet-stream");
        } else {
            mimeType = providedMimeType || "application/octet-stream";
        }

        const data = Buffer.from(base64Data, "base64");
        enforceSizeLimit(data.length);

        return {
            data,
            mimeType,
            description: "Upload blob data",
        };
    }

    // Handle file path
    const filePath = path.resolve(dataInput);

    try {
        await fs.access(filePath);
    } catch {
        throw new Error(`File not found: ${filePath}`);
    }

    const stats = await fs.stat(filePath);
    enforceSizeLimit(stats.size);

    const data = await fs.readFile(filePath);
    const mimeType = providedMimeType || detectMimeType(filePath, data);

    return {
        data,
        mimeType,
        description: `Upload ${path.basename(filePath)}`,
    };
}

/**
 * Execute the upload_blob tool
 */
async function executeUploadBlob(
    input: UploadBlobInput,
    context: ToolExecutionContext
): Promise<UploadBlobOutput> {
    const { input: dataInput, mimeType: providedMimeType, description: providedDescription } = input;

    // Validate that input is provided
    if (!dataInput) {
        throw new Error(
            "The 'input' parameter is required. Pass the URL, file path, or base64 data via { input: '...' }. Note: The parameter name is 'input', not 'url' or 'file'."
        );
    }

    logger.info("[upload_blob] Starting blob upload", {
        isURL: isURL(dataInput),
        hasFilePath: !isURL(dataInput) && !dataInput.startsWith("data:") && !dataInput.includes(","),
        hasMimeType: !!providedMimeType,
        description: providedDescription,
    });

    // Resolve input to data buffer
    const resolved = await resolveInput(dataInput, providedMimeType);
    const uploadDescription = providedDescription || resolved.description;

    logger.info("[upload_blob] Resolved input", {
        size: resolved.data.length,
        mimeType: resolved.mimeType,
        description: uploadDescription,
    });

    // Upload to Blossom using the service (delegates NDK usage to nostr layer)
    // Layer 3 (tools) loads config and passes serverUrl to Layer 2 (nostr)
    const blossomServerUrl = await loadBlossomServerUrl();
    const blossomService = new BlossomService(context.agent);
    const result = await blossomService.upload(resolved.data, resolved.mimeType, {
        serverUrl: blossomServerUrl,
        description: uploadDescription,
    });

    logger.info("[upload_blob] Upload successful", {
        url: result.url,
        sha256: result.sha256,
        size: result.size,
    });

    return result;
}

/**
 * Create the upload_blob tool for AI SDK
 */
export function createUploadBlobTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description: `Upload files, URLs, or base64 blobs to a Blossom server.

    IMPORTANT: The parameter is named 'input' (not 'url' or 'file').

    Pass the source via the 'input' parameter:
    - URLs: { input: "https://example.com/image.jpg" }
    - File paths: { input: "/path/to/file.jpg" }
    - Base64 data: { input: "data:image/jpeg;base64,..." } or { input: "<base64_string>" }

    Optional parameters:
    - mimeType: Specify MIME type (auto-detected if not provided)
    - description: Add a description for the upload

    The Blossom server URL is configured in .tenex/config.json (default: https://blossom.primal.net).
    Returns the URL of the uploaded media with appropriate file extension.`,
        inputSchema: uploadBlobSchema,
        execute: async (input: UploadBlobInput) => {
            return await executeUploadBlob(input, context);
        },
    });

    // Add human-readable content generation
    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: (args: UploadBlobInput | undefined) => {
            if (!args || !args.input) {
                return "Uploading blob data";
            }
            const { input, description } = args;

            if (isURL(input)) {
                const url = new URL(input);
                return `Downloading and uploading from ${url.hostname}${description ? ` - ${description}` : ""}`;
            }
            if (!input.startsWith("data:") && !input.includes(",")) {
                return `Uploading file: ${path.basename(input)}${description ? ` - ${description}` : ""}`;
            }
            return `Uploading blob data${description ? ` - ${description}` : ""}`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
