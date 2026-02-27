/**
 * UnifiedSearchService - Orchestrates search across all RAG collections.
 *
 * Queries all registered search providers in parallel, merges results
 * by relevance score, and optionally applies LLM extraction when a
 * prompt is provided.
 *
 * Key behaviors:
 * - Parallel queries across all providers
 * - Graceful degradation: one collection failure doesn't block others
 * - Project-scoped isolation via projectId
 * - Optional LLM extraction with configurable prompt
 */

import { logger } from "@/utils/logger";
import { config as configService } from "@/services/ConfigService";
import { RAGService } from "@/services/rag/RAGService";
import { SearchProviderRegistry } from "./SearchProviderRegistry";
import { GenericCollectionSearchProvider } from "./providers/GenericCollectionSearchProvider";
import type { SearchOptions, SearchProvider, SearchResult, UnifiedSearchOutput } from "./types";

/** Default search parameters */
const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_SCORE = 0.3;

export class UnifiedSearchService {
    private static instance: UnifiedSearchService | null = null;
    private registry: SearchProviderRegistry;

    private constructor() {
        this.registry = SearchProviderRegistry.getInstance();
    }

    public static getInstance(): UnifiedSearchService {
        if (!UnifiedSearchService.instance) {
            UnifiedSearchService.instance = new UnifiedSearchService();
        }
        return UnifiedSearchService.instance;
    }

    /**
     * Perform a unified search across all (or selected) collections.
     */
    public async search(options: SearchOptions): Promise<UnifiedSearchOutput> {
        const {
            query,
            projectId,
            limit = DEFAULT_LIMIT,
            minScore = DEFAULT_MIN_SCORE,
            prompt,
            collections,
        } = options;

        logger.info("🔍 [UnifiedSearch] Starting search", {
            query,
            projectId,
            limit,
            minScore,
            prompt: prompt ? `${prompt.substring(0, 50)}...` : undefined,
            collections: collections || "all",
        });

        // Resolve providers: static (specialized) + dynamic (generic for discovered RAG collections)
        const providers = await this.resolveProviders(collections);
        if (providers.length === 0) {
            logger.warn("[UnifiedSearch] No search providers available");
            return {
                success: true,
                results: [],
                totalResults: 0,
                query,
                collectionsSearched: [],
                warnings: ["No search collections are available. RAG may not be initialized."],
            };
        }

        // Query all providers in parallel with graceful degradation
        const searchPromises = providers.map(async (provider) => {
            try {
                const results = await provider.search(query, projectId, limit, minScore);
                return { name: provider.name, results, error: null };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`[UnifiedSearch] Provider '${provider.name}' failed`, {
                    error: message,
                });
                return { name: provider.name, results: [] as SearchResult[], error: message };
            }
        });

        const providerResults = await Promise.all(searchPromises);

        // Collect results and track errors
        const allResults: SearchResult[] = [];
        const collectionsSearched: string[] = [];
        const collectionsErrored: string[] = [];
        const warnings: string[] = [];

        for (const { name, results, error } of providerResults) {
            if (error) {
                collectionsErrored.push(name);
                warnings.push(`Collection '${name}' search failed: ${error}`);
            } else {
                collectionsSearched.push(name);
                allResults.push(...results);
            }
        }

        // Sort all results by relevance score (highest first)
        allResults.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Apply overall limit
        const limitedResults = allResults.slice(0, limit);

        // Optional LLM extraction when prompt is provided
        let extraction: string | undefined;
        if (prompt && limitedResults.length > 0) {
            extraction = await this.extractWithLLM(query, prompt, limitedResults);
        }

        logger.info("✅ [UnifiedSearch] Search complete", {
            query,
            totalResults: limitedResults.length,
            collectionsSearched,
            collectionsErrored: collectionsErrored.length > 0 ? collectionsErrored : undefined,
            hasExtraction: !!extraction,
        });

        return {
            success: true,
            results: limitedResults,
            totalResults: limitedResults.length,
            query,
            collectionsSearched,
            ...(collectionsErrored.length > 0 && { collectionsErrored }),
            ...(warnings.length > 0 && { warnings }),
            ...(extraction && { extraction }),
        };
    }

    /**
     * Resolve all providers to query: specialized (from registry) + generic
     * (dynamically created for any RAG collections not covered by a specialized provider).
     *
     * @param requestedCollections - Optional filter by **provider name**. When provided,
     *   only providers whose `name` matches are returned. For specialized providers, the
     *   name is a friendly label (e.g., "reports"); for dynamic/generic providers, the
     *   name equals the RAG collection name (e.g., "custom_knowledge").
     */
    private async resolveProviders(requestedCollections?: string[]): Promise<SearchProvider[]> {
        const specializedProviders = this.registry.getAll();

        // Derive covered RAG collections from the providers themselves.
        // A collection is "covered" if a specialized provider declares it via
        // `collectionName` or if its `name` matches a RAG collection name.
        const coveredCollections = new Set<string>();
        for (const provider of specializedProviders) {
            if (provider.collectionName) {
                coveredCollections.add(provider.collectionName);
            }
            coveredCollections.add(provider.name);
        }

        // Discover all RAG collections
        let allCollections: string[];
        try {
            const ragService = RAGService.getInstance();
            allCollections = await ragService.listCollections();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("[UnifiedSearch] Failed to discover RAG collections", { error: message });
            allCollections = [];
        }

        // Create generic providers for collections not covered by specialized providers
        const genericProviders = allCollections
            .filter((name) => !coveredCollections.has(name))
            .map((name) => new GenericCollectionSearchProvider(name));

        const allProviders = [...specializedProviders, ...genericProviders];

        if (genericProviders.length > 0) {
            logger.debug("[UnifiedSearch] Dynamic collections discovered", {
                specialized: specializedProviders.map((p) => p.name),
                generic: genericProviders.map((p) => p.name),
            });
        }

        // Apply collection filter by provider name
        if (requestedCollections && requestedCollections.length > 0) {
            const requestedSet = new Set(requestedCollections);
            return allProviders.filter((p) => requestedSet.has(p.name));
        }

        return allProviders;
    }

    /**
     * Use a fast/cheap LLM to extract focused information from search results.
     *
     * Uses the 'summarization' config if available, falls back to 'search',
     * then falls back to the default LLM config.
     */
    private async extractWithLLM(
        query: string,
        prompt: string,
        results: SearchResult[]
    ): Promise<string | undefined> {
        try {
            // Try to find a fast/cheap model config
            const configName = this.getExtractionModelConfig();
            if (!configName) {
                logger.debug("[UnifiedSearch] No LLM config available for extraction");
                return undefined;
            }

            const llmService = configService.createLLMService(configName);

            // Build context from search results
            const resultContext = results
                .map((r, i) => {
                    const parts = [`[${i + 1}] (${r.source}) ${r.title}`];
                    if (r.summary) parts.push(`   ${r.summary}`);
                    if (r.tags?.length) parts.push(`   Tags: ${r.tags.join(", ")}`);
                    return parts.join("\n");
                })
                .join("\n\n");

            const systemPrompt =
                "You are a search result extraction assistant. " +
                "Given search results and a specific prompt, extract and synthesize " +
                "the most relevant information. Be concise and focused. " +
                "Reference results by their number when citing information.";

            const userPrompt =
                `Search query: "${query}"\n\n` +
                `Extraction prompt: ${prompt}\n\n` +
                `Search results:\n${resultContext}\n\n` +
                "Based on these search results, provide a focused extraction addressing the prompt.";

            const result = await llmService.generateText([
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ]);

            return result.text;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("[UnifiedSearch] LLM extraction failed", { error: message });
            return undefined;
        }
    }

    /**
     * Get the best available LLM config name for extraction.
     * Priority: search config (typically fast/cheap) > undefined (createLLMService uses default)
     */
    private getExtractionModelConfig(): string | undefined {
        try {
            // Try search config first (typically configured as a fast/cheap model)
            const search = configService.getSearchModelName();
            if (search) return search;
        } catch {
            // Not available
        }

        // Return undefined - createLLMService will use default config with fallback
        return undefined;
    }

    /**
     * Reset singleton (for testing).
     */
    public static resetInstance(): void {
        UnifiedSearchService.instance = null;
    }
}
