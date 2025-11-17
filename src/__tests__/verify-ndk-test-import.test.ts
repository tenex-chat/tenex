/**
 * Verify that NDK test utilities can be imported
 */

import { describe, expect, it } from "bun:test";

describe("NDK Test Utilities Import", () => {
    it("should import NDK test utilities", async () => {
        // Try to import the test utilities
        const testUtils = await import("@nostr-dev-kit/ndk/test");

        // Check that expected exports are available
        expect(testUtils).toBeDefined();
        expect(testUtils.RelayPoolMock).toBeDefined();
        expect(testUtils.RelayMock).toBeDefined();
        expect(testUtils.UserGenerator).toBeDefined();
        expect(testUtils.SignerGenerator).toBeDefined();
        expect(testUtils.EventGenerator).toBeDefined();

        console.log("Available NDK test utilities:", Object.keys(testUtils));
    });
});