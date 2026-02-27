import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import * as path from "node:path";

/**
 * Resolve the LanceDB data directory path.
 * Centralizes env/config fallback logic used by multiple RAG services.
 */
export function getLanceDBDataDir(): string {
    return (
        process.env.LANCEDB_DATA_DIR ||
        path.join(config.getConfigPath("data"), "lancedb")
    );
}

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
 * Converts L2 (Euclidean) distance to similarity score (0-1 range).
 *
 * METRIC ASSUMPTION: This formula assumes L2 (Euclidean) distance metric.
 * If LanceDB is configured to use a different metric (e.g., cosine similarity),
 * this conversion would need adjustment:
 *   - L2 distance: Use 1/(1+d) as implemented here
 *   - Cosine similarity: Already in [0,1] or [-1,1], may need different mapping
 *   - Cosine distance: Use 1-d for distances in [0,2] range
 *
 * OpenAI's text-embedding-3-large returns L2 distances typically in
 * the ~1.2-1.8 range, NOT normalized [0,1]. The formula 1/(1+distance)
 * properly handles this:
 *   - distance = 0   → similarity = 1.0
 *   - distance = 1   → similarity = 0.5
 *   - distance = 1.5 → similarity = 0.4
 *   - distance = 2   → similarity = 0.33
 */
export function calculateRelevanceScore(distance: number | undefined): number {
    if (distance === undefined || distance === null) return 0;
    if (!Number.isFinite(distance)) return 0;
    if (distance < 0) return 0;
    // Convert L2 distance to similarity: closer distance = higher similarity
    return 1 / (1 + distance);
}
