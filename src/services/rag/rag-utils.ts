import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import * as path from "node:path";

/**
 * Resolve the default RAG data directory path.
 * Used by RAGCollectionRegistry and other provider-agnostic components.
 */
export function getRAGDataDir(): string {
    return (
        process.env.RAG_DATA_DIR ||
        process.env.SQLITE_VEC_DATA_DIR ||
        path.join(config.getConfigPath("data"), "sqlite-vec")
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

    if (value.language !== undefined && typeof value.language !== "string") return false;
    if (value.type !== undefined && typeof value.type !== "string") return false;
    if (value.category !== undefined && typeof value.category !== "string") return false;
    if (value.author !== undefined && typeof value.author !== "string") return false;
    if (value.title !== undefined && typeof value.title !== "string") return false;
    if (value.uri !== undefined && typeof value.uri !== "string") return false;

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
