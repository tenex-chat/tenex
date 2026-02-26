/**
 * SearchProviderRegistry - Registry for search providers.
 *
 * Holds all registered search providers and provides lookup by name.
 * Providers are registered during application bootstrap.
 */

import type { SearchProvider } from "./types";

export class SearchProviderRegistry {
    private static instance: SearchProviderRegistry | null = null;
    private providers = new Map<string, SearchProvider>();

    private constructor() {}

    public static getInstance(): SearchProviderRegistry {
        if (!SearchProviderRegistry.instance) {
            SearchProviderRegistry.instance = new SearchProviderRegistry();
        }
        return SearchProviderRegistry.instance;
    }

    /**
     * Register a search provider.
     * @param provider - The search provider to register
     */
    public register(provider: SearchProvider): void {
        this.providers.set(provider.name, provider);
    }

    /**
     * Get a provider by name.
     */
    public get(name: string): SearchProvider | undefined {
        return this.providers.get(name);
    }

    /**
     * Get all registered providers.
     */
    public getAll(): SearchProvider[] {
        return Array.from(this.providers.values());
    }

    /**
     * Get provider names.
     */
    public getNames(): string[] {
        return Array.from(this.providers.keys());
    }

    /**
     * Check if a provider is registered.
     */
    public has(name: string): boolean {
        return this.providers.has(name);
    }

    /**
     * Get providers filtered by collection names.
     * If no names provided, returns all providers.
     */
    public getByNames(names?: string[]): SearchProvider[] {
        if (!names || names.length === 0) {
            return this.getAll();
        }
        return names
            .map((name) => this.providers.get(name))
            .filter((p): p is SearchProvider => p !== undefined);
    }

    /**
     * Reset singleton (for testing).
     */
    public static resetInstance(): void {
        SearchProviderRegistry.instance = null;
    }
}
