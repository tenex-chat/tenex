import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getRelayUrls } from "../relays";

describe("relays", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        // Reset env before each test
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        // Restore original env after each test
        process.env = originalEnv;
    });

    describe("getRelayUrls", () => {
        it("should return default relay URLs when RELAYS env is not set", () => {
            delete process.env.RELAYS;
            const urls = getRelayUrls();
            expect(urls).toEqual(["wss://tenex.chat"]);
        });

        it("should parse single relay URL from RELAYS env", () => {
            process.env.RELAYS = "wss://relay1.example.com";
            const urls = getRelayUrls();
            expect(urls).toEqual(["wss://relay1.example.com"]);
        });

        it("should parse multiple relay URLs from RELAYS env", () => {
            process.env.RELAYS = "wss://relay1.example.com,wss://relay2.example.com,wss://relay3.example.com";
            const urls = getRelayUrls();
            expect(urls).toEqual([
                "wss://relay1.example.com",
                "wss://relay2.example.com",
                "wss://relay3.example.com"
            ]);
        });

        it("should trim whitespace from relay URLs", () => {
            process.env.RELAYS = "  wss://relay1.example.com  , wss://relay2.example.com  ";
            const urls = getRelayUrls();
            expect(urls).toEqual([
                "wss://relay1.example.com",
                "wss://relay2.example.com"
            ]);
        });

        it("should handle empty RELAYS env variable", () => {
            process.env.RELAYS = "";
            const urls = getRelayUrls();
            // Empty string should return default relay
            expect(urls).toEqual(["wss://tenex.chat"]);
        });

        it("should handle RELAYS with trailing comma", () => {
            process.env.RELAYS = "wss://relay1.example.com,wss://relay2.example.com,";
            const urls = getRelayUrls();
            // Should filter out empty strings from trailing comma
            expect(urls).toEqual([
                "wss://relay1.example.com",
                "wss://relay2.example.com"
            ]);
        });

        it("should handle RELAYS with only commas", () => {
            process.env.RELAYS = ",,,,";
            const urls = getRelayUrls();
            // Should return default when only commas
            expect(urls).toEqual(["wss://tenex.chat"]);
        });

        it("should handle RELAYS with mixed valid and empty values", () => {
            process.env.RELAYS = ",wss://relay1.example.com,,wss://relay2.example.com,";
            const urls = getRelayUrls();
            expect(urls).toEqual([
                "wss://relay1.example.com",
                "wss://relay2.example.com"
            ]);
        });
    });
});