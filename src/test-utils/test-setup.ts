/**
 * Global test setup file for Bun tests
 *
 * This file is loaded before each test file to ensure clean state.
 * It resets singletons that may have been polluted by previous tests.
 */

import { beforeEach, afterEach } from "bun:test";

// Import singletons that need to be reset
import { RALRegistry } from "@/services/ral/RALRegistry";
import { ConversationStore } from "@/conversations/ConversationStore";
import { ProviderRegistry } from "@/llm/providers/registry/ProviderRegistry";

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
}

// Register global hooks
beforeEach(() => {
    resetSingletons();
});

afterEach(() => {
    resetSingletons();
});

// Export for tests that need to manually reset
export { resetSingletons };
