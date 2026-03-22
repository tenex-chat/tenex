import { logger } from "@/utils/logger";

export interface OllamaModel {
    name: string;
    size: string;
    modified: string;
    digest: string;
}

export type OllamaModelsResult =
    | { status: "ok"; models: OllamaModel[] }
    | { status: "not_found" }
    | { status: "unreachable" };

/**
 * Fetch available models from local Ollama instance
 */
export async function fetchOllamaModels(baseUrl?: string): Promise<OllamaModelsResult> {
    try {
        // Normalize baseUrl - treat empty strings as undefined
        const normalizedUrl = baseUrl?.trim() || process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434";

        // Validate URL format
        let validatedUrl: string;
        try {
            const url = new URL(normalizedUrl);
            validatedUrl = url.origin;
        } catch {
            logger.warn(`Invalid Ollama base URL: ${normalizedUrl}, falling back to default`);
            validatedUrl = "http://localhost:11434";
        }

        const response = await fetch(`${validatedUrl}/api/tags`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
            },
        });

        if (response.status === 404) {
            return { status: "not_found" };
        }

        if (!response.ok) {
            logger.warn(`Failed to fetch Ollama models: ${response.status}`);
            return { status: "unreachable" };
        }

        interface OllamaResponse {
            models?: Array<{
                name: string;
                size: number;
                modified_at: string;
                digest: string;
            }>;
        }

        const data = (await response.json()) as OllamaResponse;
        const models = data.models || [];

        logger.debug(`Fetched ${models.length} Ollama models`);

        return {
            status: "ok",
            models: models.map((model) => ({
                name: model.name,
                size: formatSize(model.size),
                modified: model.modified_at,
                digest: model.digest,
            })),
        };
    } catch (error) {
        logger.warn("Failed to fetch Ollama models", {
            error: error instanceof Error ? error.message : String(error),
        });
        return { status: "unreachable" };
    }
}

/**
 * Format bytes to human readable size
 */
function formatSize(bytes: number): string {
    if (!bytes) {
        throw new Error("[OllamaModels] Missing model size for formatSize.");
    }
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) {
        return `${gb.toFixed(1)}GB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)}MB`;
}
