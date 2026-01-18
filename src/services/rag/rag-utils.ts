import { logger } from "@/utils/logger";

/**
 * JSON-serializable primitive value.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * JSON-serializable value (recursive).
 */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/**
 * JSON-serializable object.
 */
export interface JsonObject {
    [key: string]: JsonValue;
}

/**
 * JSON-serializable array.
 */
export type JsonArray = JsonValue[];

/**
 * Document metadata with known common fields and extensibility.
 */
export interface DocumentMetadata {
    language?: string;
    type?: string;
    category?: string;
    tags?: string[];
    author?: string;
    title?: string;
    uri?: string;
    [key: string]: JsonValue | undefined;
}

/**
 * LanceDB stored document structure (what gets stored in the DB).
 */
export interface LanceDBStoredDocument {
    id: string;
    content: string;
    vector: number[];
    metadata: string;
    timestamp: number;
    source: string;
}

/**
 * LanceDB query result structure (what comes back from queries).
 */
export interface LanceDBResult {
    id: string | undefined;
    content: string | undefined;
    metadata?: string | Record<string, unknown>;
    timestamp: number | undefined;
    source: string | undefined;
    vector?: number[];
    _distance?: number;
}

/**
 * RAG-specific document interface for mapping.
 */
export interface MappedRAGDocument {
    id: string;
    content: string;
    metadata: DocumentMetadata;
    timestamp: number;
    source: string;
}

/**
 * Type guard to validate JSON object structure.
 */
function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type guard to validate DocumentMetadata structure.
 */
export function isDocumentMetadata(value: unknown): value is DocumentMetadata {
    if (!isJsonObject(value)) return false;

    // Validate optional known fields if present
    if (value.language !== undefined && typeof value.language !== "string") return false;
    if (value.type !== undefined && typeof value.type !== "string") return false;
    if (value.category !== undefined && typeof value.category !== "string") return false;
    if (value.author !== undefined && typeof value.author !== "string") return false;
    if (value.title !== undefined && typeof value.title !== "string") return false;
    if (value.uri !== undefined && typeof value.uri !== "string") return false;

    // Deep validation for tags array - ensure all elements are strings
    if (value.tags !== undefined) {
        if (!Array.isArray(value.tags)) return false;
        if (!value.tags.every((tag): tag is string => typeof tag === "string")) return false;
    }

    return true;
}

/**
 * Parse document metadata from JSON string or object with type validation.
 */
export function parseDocumentMetadata(
    metadata: string | DocumentMetadata | Record<string, unknown> | undefined
): DocumentMetadata {
    if (!metadata) return {};

    if (typeof metadata === "string") {
        try {
            const parsed = JSON.parse(metadata);
            if (!isDocumentMetadata(parsed)) {
                logger.warn("Parsed metadata does not match DocumentMetadata schema", { parsed });
                return {};
            }
            return parsed;
        } catch (error) {
            logger.warn("Failed to parse document metadata", { error, metadata });
            return {};
        }
    }

    if (!isDocumentMetadata(metadata)) {
        logger.warn("Metadata object does not match DocumentMetadata schema", { metadata });
        return {};
    }

    return metadata;
}

/**
 * Map LanceDB query result to RAG document format.
 * Handles metadata parsing and field extraction.
 */
export function mapLanceResultToDocument(result: LanceDBResult): MappedRAGDocument {
    return {
        id: result.id ?? "",
        content: result.content ?? "",
        metadata: parseDocumentMetadata(result.metadata),
        timestamp: result.timestamp ?? Date.now(),
        source: result.source ?? "unknown",
    };
}

/**
 * Calculate relevance score from vector distance.
 * Converts distance to similarity score (0-1 range).
 */
export function calculateRelevanceScore(distance: number | undefined): number {
    if (distance === undefined || distance === null) return 0;
    // Closer distance = higher similarity
    return Math.max(0, Math.min(1, 1 - distance));
}
