import { afterEach, beforeEach, mock } from "bun:test";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { ConversationStore } from "@/conversations/ConversationStore";
import { ProviderRegistry } from "@/llm/providers/registry/ProviderRegistry";
import { IdentityBindingStore, IdentityDisplayService, IdentityService } from "@/services/identity";
import { PubkeyService } from "@/services/PubkeyService";
import { SkillService } from "@/services/skill/SkillService";
import { RAGService } from "@/services/rag/RAGService";
import { RAGCollectionRegistry } from "@/services/rag/RAGCollectionRegistry";
import { RagSubscriptionService } from "@/services/rag/RagSubscriptionService";
import { UnifiedSearchService } from "@/services/search/UnifiedSearchService";
import { SearchProviderRegistry } from "@/services/search/SearchProviderRegistry";
import { McpSubscriptionService } from "@/services/mcp/McpSubscriptionService";
import { ConversationEmbeddingService } from "@/conversations/search/embeddings/ConversationEmbeddingService";
import { ConversationIndexingJob } from "@/conversations/search/embeddings/ConversationIndexingJob";
import { APNsService } from "@/services/apns/APNsService";
import { TransportBindingStore } from "@/services/ingress/TransportBindingStoreService";
import { ChannelSessionStore } from "@/services/ingress/ChannelSessionStoreService";
import { TelegramGatewayService } from "@/services/telegram/TelegramGatewayService";
import { TelegramPendingBindingStore } from "@/services/telegram/TelegramPendingBindingStoreService";
import { TelegramChatContextStore } from "@/services/telegram/TelegramChatContextStoreService";
import { TelegramConfigSessionStore } from "@/services/telegram/TelegramConfigSessionStoreService";
import { resetNDK } from "@/nostr/ndkClient";
import { resetTelemetry } from "@/telemetry/setup";
import { resetDaemon } from "@/daemon/Daemon";
import { resetLogger } from "@/utils/logger";

/**
 * Reset all singletons to ensure clean state between tests
 */
function resetSingletons(): void {
    // Reset RALRegistry singleton
    // @ts-expect-error - accessing private static for testing
    RALRegistry.instance = undefined;

    // Reset ConversationStore static state (check exists for tests that mock ConversationStore)
    if (typeof ConversationStore.reset === "function") {
        ConversationStore.reset();
    }

    if (typeof ProviderRegistry.resetInstance === "function") {
        ProviderRegistry.resetInstance();
    }

    if (typeof IdentityBindingStore.resetInstance === "function") {
        IdentityBindingStore.resetInstance();
    }

    if (typeof IdentityService.resetInstance === "function") {
        IdentityService.resetInstance();
    }

    if (typeof IdentityDisplayService.resetInstance === "function") {
        IdentityDisplayService.resetInstance();
    }

    if (typeof SkillService.resetInstance === "function") {
        SkillService.resetInstance();
    }

    if (typeof RAGService.resetInstance === "function") {
        RAGService.resetInstance();
    }

    if (typeof RAGCollectionRegistry.resetInstance === "function") {
        RAGCollectionRegistry.resetInstance();
    }

    if (typeof RagSubscriptionService.resetInstance === "function") {
        RagSubscriptionService.resetInstance();
    }

    if (typeof UnifiedSearchService.resetInstance === "function") {
        UnifiedSearchService.resetInstance();
    }

    if (typeof SearchProviderRegistry.resetInstance === "function") {
        SearchProviderRegistry.resetInstance();
    }

    if (typeof McpSubscriptionService.resetInstance === "function") {
        McpSubscriptionService.resetInstance();
    }

    if (typeof ConversationEmbeddingService.resetInstance === "function") {
        ConversationEmbeddingService.resetInstance();
    }

    if (typeof ConversationIndexingJob.resetInstance === "function") {
        ConversationIndexingJob.resetInstance();
    }

    if (typeof APNsService.resetInstance === "function") {
        APNsService.resetInstance();
    }

    if (typeof TransportBindingStore.resetInstance === "function") {
        TransportBindingStore.resetInstance();
    }

    if (typeof ChannelSessionStore.resetInstance === "function") {
        ChannelSessionStore.resetInstance();
    }

    if (typeof TelegramGatewayService.resetInstance === "function") {
        TelegramGatewayService.resetInstance();
    }

    if (typeof TelegramPendingBindingStore.resetInstance === "function") {
        TelegramPendingBindingStore.resetInstance();
    }

    if (typeof TelegramChatContextStore.resetInstance === "function") {
        TelegramChatContextStore.resetInstance();
    }

    if (typeof TelegramConfigSessionStore.resetInstance === "function") {
        TelegramConfigSessionStore.resetInstance();
    }

    // Reset PubkeyService singleton cache between tests
    // @ts-expect-error - accessing private static for testing
    PubkeyService.instance = undefined;

    // Reset module-level singletons
    resetNDK();
    resetTelemetry();
    resetDaemon();
    resetLogger();
}

// Register global hooks
beforeEach(() => {
    resetSingletons();
});

afterEach(() => {
    mock.restore();
    resetSingletons();
});

// Export for tests that need to manually reset
export { resetSingletons };
