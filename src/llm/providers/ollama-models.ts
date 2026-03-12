import { logger } from "@/utils/logger";

export interface OllamaModel {
    name: string;
    size: string;
    modified: string;
    digest: string;
}

/**
 * Fetch available models from local Ollama instance
 */
export async function fetchOllamaModels(baseUrl?: string): Promise<OllamaModel[]> {
    try {
        baseUrl = baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
        const response = await fetch(`${baseUrl}/api/tags`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            logger.warn(`Failed to fetch Ollama models: ${response.status}`);
            return [];
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

        return models.map((model) => ({
            name: model.name,
            size: formatSize(model.size),
            modified: model.modified_at,
            digest: model.digest,
        }));
    } catch (error) {
        logger.warn("Failed to fetch Ollama models", {
            error: error instanceof Error ? error.message : String(error),
        });
        return [];
    }
}

/**
 * Format bytes to human readable size
 */
function formatSize(bytes: number): string {
    if (!bytes) return "unknown";
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) {
        return `${gb.toFixed(1)}GB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)}MB`;
}
