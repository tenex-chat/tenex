/**
 * OpenRouter model fetching utilities
 */

export interface OpenRouterModel {
    id: string;
    name: string;
    description?: string;
    context_length: number;
    pricing: {
        prompt: string;
        completion: string;
    };
    top_provider?: {
        max_completion_tokens?: number;
    };
}

export interface OpenRouterModelsResponse {
    data: OpenRouterModel[];
}

/**
 * Fetch available models from OpenRouter API
 */
export async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
    try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
            headers: {
                Accept: "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.statusText}`);
        }

        const data = (await response.json()) as OpenRouterModelsResponse;

        // Sort models by popularity/relevance (you can customize this)
        return data.data.sort((a, b) => {
            // Prioritize commonly used models
            const priority = [
                "openai/gpt-4",
                "openai/gpt-4-turbo",
                "anthropic/claude-3-5-sonnet",
                "anthropic/claude-3-opus",
                "google/gemini-2.0-flash",
                "google/gemini-pro",
            ];

            const aIndex = priority.indexOf(a.id);
            const bIndex = priority.indexOf(b.id);

            if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;

            return a.name.localeCompare(b.name);
        });
    } catch (error) {
        console.error("Error fetching OpenRouter models:", error);
        return [];
    }
}

/**
 * Get popular models grouped by provider
 */
export function getPopularModels(): Record<string, string[]> {
    return {
        OpenAI: [
            "openai/gpt-4",
            "openai/gpt-4-turbo",
            "openai/gpt-3.5-turbo",
            "openai/o1-preview",
            "openai/o1-mini",
        ],
        Anthropic: [
            "anthropic/claude-3-5-sonnet",
            "anthropic/claude-3-opus",
            "anthropic/claude-3-haiku",
            "anthropic/claude-3-5-haiku",
        ],
        Google: [
            "google/gemini-2.0-flash-thinking-exp",
            "google/gemini-2.0-flash-exp",
            "google/gemini-pro",
            "google/gemini-pro-1.5",
        ],
        Meta: [
            "meta-llama/llama-3.1-405b-instruct",
            "meta-llama/llama-3.1-70b-instruct",
            "meta-llama/llama-3.1-8b-instruct",
        ],
        Mistral: [
            "mistralai/mistral-large",
            "mistralai/mixtral-8x22b-instruct",
            "mistralai/mixtral-8x7b-instruct",
        ],
    };
}
