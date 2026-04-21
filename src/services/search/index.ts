/**
 * Unified Search Module
 *
 * Provides cross-collection semantic search across conversations,
 * lessons, and generic RAG collections within project boundaries.
 */

export { buildProjectFilter } from "./projectFilter";
export { ContextDiscoveryService } from "./ContextDiscoveryService";
export { SearchProviderRegistry } from "./SearchProviderRegistry";
export { UnifiedSearchService } from "./UnifiedSearchService";
export type {
    ContextDiscoveryHint,
    ContextDiscoveryRequest,
    ContextDiscoveryResult,
    ContextDiscoveryUsageRecord,
} from "./ContextDiscoveryService";
export type {
    SearchOptions,
    SearchProvider,
    SearchResult,
    UnifiedSearchOutput,
} from "./types";

// Providers
export { ConversationSearchProvider } from "./providers/ConversationSearchProvider";
export { LessonSearchProvider } from "./providers/LessonSearchProvider";
export { GenericCollectionSearchProvider } from "./providers/GenericCollectionSearchProvider";

import { SearchProviderRegistry } from "./SearchProviderRegistry";
import { ConversationSearchProvider } from "./providers/ConversationSearchProvider";
import { LessonSearchProvider } from "./providers/LessonSearchProvider";

/**
 * Bootstrap all search providers.
 * Call this during application initialization after RAG services are available.
 * Idempotent - safe to call multiple times.
 */
export function bootstrapSearchProviders(): void {
    const registry = SearchProviderRegistry.getInstance();

    if (!registry.has("conversations")) {
        registry.register(new ConversationSearchProvider());
    }

    if (!registry.has("lessons")) {
        registry.register(new LessonSearchProvider());
    }
}
