/**
 * Global test setup file for Bun tests
 *
 * This file is loaded before each test file to ensure clean state.
 * It resets singletons that may have been polluted by previous tests.
 */

import { beforeEach, afterEach } from "bun:test";

/**
 * Reset all singletons to ensure clean state between tests
 */
async function resetSingletons(): Promise<void> {
    const [{ RALRegistry }, { ConversationStore }, { ProviderRegistry }] = await Promise.all([
        import("@/services/ral/RALRegistry"),
        import("@/conversations/ConversationStore"),
        import("@/llm/providers/registry/ProviderRegistry"),
    ]);

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
beforeEach(async () => {
    await resetSingletons();
});

afterEach(async () => {
    await resetSingletons();
});

// Export for tests that need to manually reset
export { resetSingletons };
