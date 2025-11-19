import { afterEach, describe, expect, it, mock } from "bun:test";
import { getRelayUrls } from "../relays";
import { config } from "@/services/ConfigService";

// Mock the entire ConfigService
mock.module("@/services/ConfigService", () => ({
    config: {
        getConfig: mock(),
    },
}));

describe("getRelayUrls", () => {
    afterEach(() => {
        // Reset mocks after each test
        (config.getConfig as jest.Mock).mockClear();
    });

    it("should return relay URLs from the config file", () => {
        const mockRelays = ["wss://relay.from.config"];
        (config.getConfig as jest.Mock).mockReturnValue({ relays: mockRelays });

        const urls = getRelayUrls();
        expect(urls).toEqual(mockRelays);
        expect(config.getConfig).toHaveBeenCalledTimes(1);
    });

    it("should return default relay URLs when config has no relays", () => {
        (config.getConfig as jest.Mock).mockReturnValue({ relays: [] });

        const urls = getRelayUrls();
        expect(urls).toEqual(["wss://tenex.chat"]);
    });

    it("should return default relay URLs when config is not available", () => {
        (config.getConfig as jest.Mock).mockImplementation(() => {
            throw new Error("Config not loaded");
        });

        const urls = getRelayUrls();
        expect(urls).toEqual(["wss://tenex.chat"]);
    });

    it("should filter out invalid relay URLs from the config", () => {
        const mockRelays = [
            "wss://valid.relay",
            "ws://another.valid.relay",
            "http://invalid.relay",
            "not-a-url",
        ];
        (config.getConfig as jest.Mock).mockReturnValue({ relays: mockRelays });

        const urls = getRelayUrls();
        expect(urls).toEqual(["wss://valid.relay", "ws://another.valid.relay"]);
    });

    it("should return default URLs when all config relays are invalid", () => {
        const mockRelays = ["http://invalid.relay", "not-a-url"];
        (config.getConfig as jest.Mock).mockReturnValue({ relays: mockRelays });

        const urls = getRelayUrls();
        expect(urls).toEqual(["wss://tenex.chat"]);
    });
});
