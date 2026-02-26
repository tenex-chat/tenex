/**
 * Unified Search Module
 *
 * Provides cross-collection semantic search across reports,
 * conversations, and lessons within project boundaries.
 */

export { buildProjectFilter } from "./projectFilter";
export { SearchProviderRegistry } from "./SearchProviderRegistry";
export { UnifiedSearchService } from "./UnifiedSearchService";
export type {
    SearchOptions,
    SearchProvider,
    SearchResult,
    UnifiedSearchOutput,
} from "./types";

// Providers
export { ReportSearchProvider } from "./providers/ReportSearchProvider";
export { ConversationSearchProvider } from "./providers/ConversationSearchProvider";
export { LessonSearchProvider } from "./providers/LessonSearchProvider";

import { SearchProviderRegistry } from "./SearchProviderRegistry";
import { ReportSearchProvider } from "./providers/ReportSearchProvider";
import { ConversationSearchProvider } from "./providers/ConversationSearchProvider";
import { LessonSearchProvider } from "./providers/LessonSearchProvider";

/**
 * Bootstrap all search providers.
 * Call this during application initialization after RAG services are available.
 * Idempotent - safe to call multiple times.
 */
export function bootstrapSearchProviders(): void {
    const registry = SearchProviderRegistry.getInstance();

    if (!registry.has("reports")) {
        registry.register(new ReportSearchProvider());
    }

    if (!registry.has("conversations")) {
        registry.register(new ConversationSearchProvider());
    }

    if (!registry.has("lessons")) {
        registry.register(new LessonSearchProvider());
    }
}
