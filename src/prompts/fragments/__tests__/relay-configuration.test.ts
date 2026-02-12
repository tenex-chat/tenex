import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as relaysModule from "@/nostr/relays";
import { relayConfigurationFragment } from "../04-relay-configuration";

// Mock the logger to avoid console output during tests
mock.module("@/utils/logger", () => ({
    logger: {
        warn: () => {},
        info: () => {},
        error: () => {},
        debug: () => {},
    },
}));

describe("relay-configuration fragment", () => {
    let getRelayUrlsSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        getRelayUrlsSpy = spyOn(relaysModule, "getRelayUrls");
    });

    afterEach(() => {
        getRelayUrlsSpy.mockRestore();
    });

    describe("template", () => {
        it("should show default relay message when using only the default relay", () => {
            getRelayUrlsSpy.mockReturnValue(["wss://tenex.chat"]);

            const result = relayConfigurationFragment.template({});

            expect(result).toContain("## Nostr Relay Configuration");
            expect(result).toContain("Using default relay:");
            expect(result).toContain("- wss://tenex.chat");
        });

        it("should show single relay correctly when using a non-default relay", () => {
            getRelayUrlsSpy.mockReturnValue(["wss://relay.example.com"]);

            const result = relayConfigurationFragment.template({});

            expect(result).toContain("## Nostr Relay Configuration");
            expect(result).toContain("Connected to 1 relay:");
            expect(result).toContain("- wss://relay.example.com");
        });

        it("should show multiple relays with correct plural form", () => {
            getRelayUrlsSpy.mockReturnValue([
                "wss://relay1.example.com",
                "wss://relay2.example.com",
                "wss://relay3.example.com",
            ]);

            const result = relayConfigurationFragment.template({});

            expect(result).toContain("## Nostr Relay Configuration");
            expect(result).toContain("Connected to 3 relays:");
            expect(result).toContain("- wss://relay1.example.com");
            expect(result).toContain("- wss://relay2.example.com");
            expect(result).toContain("- wss://relay3.example.com");
        });

        it("should list all relays in the configured order", () => {
            const relays = [
                "wss://first.relay.com",
                "wss://second.relay.com",
            ];
            getRelayUrlsSpy.mockReturnValue(relays);

            const result = relayConfigurationFragment.template({});

            const firstIndex = result.indexOf("wss://first.relay.com");
            const secondIndex = result.indexOf("wss://second.relay.com");

            expect(firstIndex).toBeLessThan(secondIndex);
        });
    });

    describe("fragment metadata", () => {
        it("should have correct id", () => {
            expect(relayConfigurationFragment.id).toBe("relay-configuration");
        });

        it("should have priority 4 (after global-system-prompt, before alpha-mode)", () => {
            expect(relayConfigurationFragment.priority).toBe(4);
        });
    });
});
