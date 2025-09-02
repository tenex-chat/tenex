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
export async function fetchOllamaModels(): Promise<OllamaModel[]> {
  try {
    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.warn(`Failed to fetch Ollama models: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const models = data.models || [];
    
    logger.debug(`Fetched ${models.length} Ollama models`);
    
    return models.map((model: any) => ({
      name: model.name,
      size: formatSize(model.size),
      modified: model.modified_at,
      digest: model.digest
    }));
  } catch (error) {
    logger.warn("Failed to fetch Ollama models", {
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

/**
 * Format bytes to human readable size
 */
function formatSize(bytes: number): string {
  if (!bytes) return 'unknown';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${gb.toFixed(1)}GB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)}MB`;
}

/**
 * Get popular Ollama models for quick selection
 */
export function getPopularOllamaModels(): Record<string, string[]> {
  return {
    "Small Models (< 4GB)": [
      "llama3.2:1b",
      "llama3.2:3b",
      "phi3:mini",
      "gemma2:2b",
      "qwen2.5:1.5b",
      "qwen2.5:3b"
    ],
    "Medium Models (4-8GB)": [
      "llama3.1:8b",
      "mistral:7b",
      "gemma2:9b",
      "qwen2.5:7b",
      "deepseek-coder-v2:16b"
    ],
    "Large Models (> 8GB)": [
      "llama3.1:70b",
      "mixtral:8x7b",
      "qwen2.5:14b",
      "qwen2.5:32b",
      "qwen2.5:72b",
      "deepseek-coder-v2:236b"
    ],
    "Specialized Models": [
      "codellama:7b",
      "codellama:13b",
      "starcoder2:3b",
      "starcoder2:7b",
      "sqlcoder:7b"
    ]
  };
}