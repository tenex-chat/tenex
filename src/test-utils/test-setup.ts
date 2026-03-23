import { afterEach, beforeEach, mock } from "bun:test";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { ConversationStore } from "@/conversations/ConversationStore";
import { ProviderRegistry } from "@/llm/providers/registry/ProviderRegistry";
import { IdentityBindingStore, IdentityDisplayService, IdentityService } from "@/services/identity";
import { PubkeyService } from "@/services/PubkeyService";

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

    // Reset ProviderRegistry singleton (check exists for tests that mock ProviderRegistry)
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

    // Reset PubkeyService singleton cache between tests
    // @ts-expect-error - accessing private static for testing
    PubkeyService.instance = undefined;
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
