import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { URL } from "node:url";
import type { ExecutionContext } from "@/agents/execution/types";
import { type RAGDocument, RAGService } from "@/services/rag/RAGService";
import type { AISdkTool } from "@/tools/types";
import {
    type ToolResponse,
    executeToolWithErrorHandling,
    resolveAndValidatePath,
} from "@/tools/utils";
import { tool } from "ai";
import { z } from "zod";

// Protocol Constants
const PROTOCOL_FILE = "file:";
const PROTOCOL_HTTP = "http:";
const PROTOCOL_HTTPS = "https:";
const FILE_PROTOCOL_PREFIX = "file://";

// Size and Timeout Constants
const HTTP_TIMEOUT_MS = 30000; // 30 seconds
const MAX_FILE_SIZE_MB = 100; // 100MB max file size
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// User Agent for HTTP requests
const HTTP_USER_AGENT = "TENEX-RAG-Ingester/1.0";

// Type definitions for protocol handlers
type ProtocolHandler = (uri: string, context: { workingDirectory: string }) => Promise<string>;

/**
 * Schema for RAG document input
 */
const ragAddDocumentsSchema = z.object({
    collection: z.string().describe("Name of the collection to add documents to"),
    documents: z
        .array(
            z.union([
                // Option 1: Content with optional file_path
                z.object({
                    content: z.string().nullable().describe("Text content of the document"),
                    file_path: z.string().nullable().describe("Path to file to read content from"),
                    metadata: z
                        .record(z.string(), z.unknown())
                        .nullable()
                        .describe("Optional metadata for the document"),
                    source: z.string().nullable().describe("Source identifier for the document"),
                    id: z
                        .string()
                        .nullable()
                        .describe("Optional unique identifier for the document"),
                }),
                // Option 2: URI-based
                z.object({
                    uri: z.string().describe("URI to fetch content from (file://, https://, etc.)"),
                    metadata: z
                        .record(z.string(), z.unknown())
                        .nullable()
                        .describe("Optional metadata for the document"),
                    source: z.string().nullable().describe("Source identifier for the document"),
                    id: z
                        .string()
                        .nullable()
                        .describe("Optional unique identifier for the document"),
                }),
            ])
        )
        .describe("Array of documents to add to the collection"),
});

/**
 * Validate URI format and return parsed URL
 *
 * Rationale: Early validation prevents downstream errors and provides clear feedback
 * about malformed URIs before any network or file operations are attempted.
 */
function validateURI(uri: string): URL {
    try {
        return new URL(uri);
    } catch (error) {
        throw new Error(
            `Invalid URI format '${uri}': ${error instanceof Error ? error.message : "Unknown error"}`
        );
    }
}

/**
 * Validate content is not empty
 *
 * Rationale: Empty documents cannot be meaningfully embedded or searched,
 * so we reject them early with a clear error message.
 */
function validateContent(content: string, source: string): void {
    if (!content || content.trim().length === 0) {
        throw new Error(`Document from ${source} must have non-empty content`);
    }
}

/**
 * Check if a size exceeds the maximum allowed
 *
 * Rationale: Large files can cause memory issues and slow processing.
 * This validation ensures system stability and predictable performance.
 */
function validateSize(sizeInBytes: number, sourceName: string): void {
    if (sizeInBytes > MAX_FILE_SIZE_BYTES) {
        const sizeMB = (sizeInBytes / 1024 / 1024).toFixed(2);
        throw new Error(
            `${sourceName} size (${sizeMB}MB) exceeds maximum allowed size of ${MAX_FILE_SIZE_MB}MB`
        );
    }
}

/**
 * Handle common fetch errors with context
 *
 * Rationale: Consistent error messages across protocol handlers
 * make debugging easier and provide better user experience.
 */
function handleFetchError(error: unknown, protocol: string): never {
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
        throw new Error(`Request timeout after ${HTTP_TIMEOUT_MS / 1000} seconds`);
    }

    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to fetch from ${protocol} URI: ${message}`);
}

/**
 * Type for document input - represents the union of possible document shapes
 */
type DocumentInput = {
    content?: string;
    file_path?: string;
    uri?: string;
    metadata?: Record<string, unknown>;
    source?: string;
    id?: string;
};

/**
 * Generate consistent source field based on input type
 *
 * Rationale: Consistent source identification helps with debugging
 * and tracking document origins across different input methods.
 */
function generateSourceField(doc: DocumentInput, resolvedPath?: string): string | undefined {
    // Explicit source takes precedence
    if (doc.source) {
        return doc.source;
    }

    // URI-based document
    if ("uri" in doc && doc.uri) {
        return doc.uri;
    }

    // File path-based document
    if (doc.file_path) {
        return `${FILE_PROTOCOL_PREFIX}${resolvedPath || doc.file_path}`;
    }

    // Direct content has no default source
    return undefined;
}

/**
 * Parse file path from file:// URI
 *
 * Rationale: File URIs have various formats that need normalization
 * for cross-platform compatibility.
 */
function parseFilePathFromURI(uri: string): string {
    // Remove 'file://' prefix
    let filePath = uri.substring(FILE_PROTOCOL_PREFIX.length);

    // Handle different file:// formats
    if (filePath.startsWith("//")) {
        // file:////absolute/path or file://host/path
        filePath = filePath.substring(2);
    } else if (filePath.startsWith("/./")) {
        // file://./relative/path - explicit relative
        filePath = filePath.substring(3);
    } else if (filePath.startsWith("./")) {
        // file://./relative/path - explicit relative
        filePath = filePath.substring(2);
    }

    // On Windows, file:///C:/path becomes /C:/path, need to remove leading slash
    if (process.platform === "win32" && filePath.match(/^\/[a-zA-Z]:[\\/]/)) {
        filePath = filePath.slice(1);
    }

    return filePath;
}

/**
 * Handle file:// protocol URIs
 *
 * Rationale: File URIs require special handling for path resolution,
 * size validation, and cross-platform compatibility.
 */
async function handleFileProtocolURI(
    uri: string,
    context: { workingDirectory: string }
): Promise<string> {
    try {
        const filePath = parseFilePathFromURI(uri);

        // Resolve the path (handles both absolute and relative paths)
        const resolvedPath = path.resolve(context.workingDirectory, filePath);

        // Check file size before reading
        const stats = await stat(resolvedPath);
        validateSize(stats.size, "File");

        return await readFile(resolvedPath, "utf-8");
    } catch (error) {
        handleFetchError(error, PROTOCOL_FILE);
    }
}

/**
 * Handle HTTP/HTTPS protocol URIs with timeout and size limits
 *
 * Rationale: HTTP requests need timeouts to prevent hanging,
 * and size limits to prevent memory exhaustion from large responses.
 */
async function handleHttpProtocolURI(
    uri: string,
    _context: { workingDirectory: string }
): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    try {
        const response = await fetch(uri, {
            signal: controller.signal,
            headers: {
                "User-Agent": HTTP_USER_AGENT,
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Check content length before reading body
        const contentLength = response.headers.get("content-length");
        if (contentLength) {
            const sizeInBytes = Number.parseInt(contentLength, 10);
            validateSize(sizeInBytes, "Response");
        }

        // Read response body with streaming size check
        const chunks: string[] = [];
        let totalSize = 0;
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) {
            throw new Error("Response body is not readable");
        }

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalSize += value.length;
            validateSize(totalSize, "Response");

            chunks.push(decoder.decode(value, { stream: true }));
        }

        return chunks.join("");
    } catch (error) {
        handleFetchError(error, uri.startsWith(PROTOCOL_HTTPS) ? PROTOCOL_HTTPS : PROTOCOL_HTTP);
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Extensible protocol handler map
 */
const PROTOCOL_HANDLERS: Map<string, ProtocolHandler> = new Map([
    [PROTOCOL_FILE, handleFileProtocolURI],
    [PROTOCOL_HTTP, handleHttpProtocolURI],
    [PROTOCOL_HTTPS, handleHttpProtocolURI],
]);

/**
 * Register a new protocol handler
 *
 * Rationale: Extensibility allows adding support for new protocols
 * without modifying the core implementation.
 */
export function registerProtocolHandler(protocol: string, handler: ProtocolHandler): void {
    PROTOCOL_HANDLERS.set(protocol, handler);
}

/**
 * Fetch content from a URI using the appropriate protocol handler
 */
async function fetchFromURI(uri: string, workingDirectory: string): Promise<string> {
    // Validate URI first
    const parsedUrl = validateURI(uri);

    // Get protocol handler
    const handler = PROTOCOL_HANDLERS.get(parsedUrl.protocol);
    if (!handler) {
        throw new Error(
            `Unsupported URI protocol '${parsedUrl.protocol}'. ` +
                `Supported protocols: ${Array.from(PROTOCOL_HANDLERS.keys()).join(", ")}`
        );
    }

    // Execute handler
    return await handler(uri, { workingDirectory });
}

/**
 * Extract document content from various sources (renamed from processSingleDocument)
 *
 * Rationale: This function unifies content extraction from different input types,
 * providing a consistent interface for document processing.
 */
async function extractDocumentContentFromSource(
    doc: DocumentInput,
    workingDirectory: string
): Promise<{ content: string; source: string | undefined }> {
    let content = "";
    let resolvedPath: string | undefined;

    if ("uri" in doc && doc.uri) {
        // URI-based document
        content = await fetchFromURI(doc.uri, workingDirectory);
    } else {
        // Content/file_path based document
        content = doc.content || "";

        // Read from file if file_path is provided
        if (doc.file_path) {
            resolvedPath = resolveAndValidatePath(doc.file_path, workingDirectory);

            // Check file size
            const stats = await stat(resolvedPath);
            validateSize(stats.size, "File");

            try {
                content = await readFile(resolvedPath, "utf-8");
            } catch (error) {
                if (!doc.content) {
                    throw new Error(
                        `Cannot read file '${doc.file_path}': ${error instanceof Error ? error.message : "Unknown error"}`
                    );
                }
                // Fall back to provided content if file read fails but content exists
            }
        }
    }

    // Generate source field
    const source = generateSourceField(doc, resolvedPath);

    return { content, source };
}

/**
 * Process documents and prepare them for insertion
 */
async function processDocuments(
    documents: z.infer<typeof ragAddDocumentsSchema>["documents"],
    workingDirectory: string
): Promise<RAGDocument[]> {
    const processedDocs: RAGDocument[] = [];

    for (const doc of documents) {
        try {
            const { content, source } = await extractDocumentContentFromSource(
                doc,
                workingDirectory
            );

            // Validate content
            validateContent(content, source || "document");

            processedDocs.push({
                id: doc.id,
                content,
                metadata: doc.metadata,
                source,
                timestamp: Date.now(),
            });
        } catch (error) {
            // Add context to error
            const identifier =
                doc.id || ("uri" in doc ? doc.uri : doc.file_path) || "unknown document";
            throw new Error(
                `Error processing document '${identifier}': ${error instanceof Error ? error.message : "Unknown error"}`
            );
        }
    }

    return processedDocs;
}

/**
 * Core implementation of adding documents to a RAG collection
 */
async function executeAddDocuments(
    input: z.infer<typeof ragAddDocumentsSchema>,
    context: ExecutionContext
): Promise<ToolResponse> {
    const { collection, documents } = input;

    // Process documents
    const processedDocs = await processDocuments(documents, context.workingDirectory);

    // Add to collection
    const ragService = RAGService.getInstance();
    await ragService.addDocuments(collection, processedDocs);

    return {
        success: true,
        message: `Successfully added ${processedDocs.length} documents to collection '${collection}'`,
        documents_added: processedDocs.length,
        collection: collection,
    };
}

/**
 * Add documents to a RAG collection for semantic search
 *
 * Supports multiple input methods:
 * - Direct text content
 * - File paths (relative or absolute)
 * - URIs (file://, http://, https://)
 *
 * Features:
 * - Automatic content validation (non-empty check)
 * - File size limits (100MB) with early validation
 * - HTTP request timeouts (30s) to prevent hanging
 * - Streaming size validation for HTTP responses
 * - Extensible protocol handlers for custom schemes
 * - Cross-platform file path resolution
 * - Backward compatible with existing code
 *
 * Rationale for validations:
 * - Size limits prevent memory exhaustion
 * - Timeouts prevent hanging requests
 * - URI validation provides early error detection
 * - Content validation ensures meaningful documents
 */
export function createRAGAddDocumentsTool(context: ExecutionContext): AISdkTool {
    return tool({
        description:
            "Add documents to a RAG collection. Documents can be provided as text content, file paths, or URIs (file://, https://, etc.). Each document will be automatically embedded for semantic search. Enforces file size limits (100MB) and HTTP timeouts (30s).",
        inputSchema: ragAddDocumentsSchema,
        execute: async (input: z.infer<typeof ragAddDocumentsSchema>) => {
            return executeToolWithErrorHandling(
                "rag_add_documents",
                input,
                context,
                executeAddDocuments
            );
        },
    });
}
