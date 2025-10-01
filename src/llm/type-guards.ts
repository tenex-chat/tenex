import type { AISdkProvider } from "./types";

/**
 * Type guard to check if a string is a valid AISdkProvider
 */
export function isAISdkProvider(provider: string): provider is AISdkProvider {
    const validProviders: readonly AISdkProvider[] = [
        "openrouter",
        "anthropic",
        "openai",
        "ollama",
        "claudeCode"
    ] as const;
    return (validProviders as readonly string[]).includes(provider);
}
