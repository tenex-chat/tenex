import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getRelayUrls } from "../relays";
import { configService } from "@/services/ConfigService";

// Mock the configService
mock.module("@/services/ConfigService", () => ({
    configService: {
        loadTenexConfig: mock(async () => ({ relays: [] })),
        saveGlobalConfig: mock(async () => {}),
        getGlobalPath: mock(() => "/fake/home/.tenex"),
    },
}));

describe("relays", () => {
    beforeEach(() => {
        // Clear mock history before each test
        (configService.loadTenexConfig as any).mockClear();
        (configService.saveGlobalConfig as any).mockClear();
    });

    it("should return relays from config if they exist and are valid", async () => {
        const mockRelays = ["wss://relay1.example.com", "wss://relay2.example.com"];
        (configService.loadTenexConfig as any).mockResolvedValue({ relays: mockRelays });

        const urls = await getRelayUrls();

        expect(urls).toEqual(mockRelays);
        expect(configService.loadTenexConfig).toHaveBeenCalledWith("/fake/home/.tenex");
        expect(configService.saveGlobalConfig).not.toHaveBeenCalled();
    });

    it("should save and return default relays if config has no relays", async () => {
        (configService.loadTenexConfig as any).mockResolvedValue({ relays: [] });

        const urls = await getRelayUrls();

        expect(urls).toEqual(["wss://tenex.chat"]);
        expect(configService.loadTenexConfig).toHaveBeenCalledWith("/fake/home/.tenex");
        expect(configService.saveGlobalConfig).toHaveBeenCalledWith({
            relays: ["wss://tenex.chat"],
        });
    });

    it("should save and return default relays if relays property is missing", async () => {
        (configService.loadTenexConfig as any).mockResolvedValue({});

        const urls = await getRelayUrls();

        expect(urls).toEqual(["wss://tenex.chat"]);
        expect(configService.saveGlobalConfig).toHaveBeenCalledWith({
            relays: ["wss://tenex.chat"],
        });
    });

    it("should filter out invalid relay URLs from config", async () => {
        const mockRelays = [
            "wss://valid.com",
            "ws://valid.com",
            "http://invalid.com",
            "not-a-url",
        ];
        (configService.loadTenexConfig as any).mockResolvedValue({ relays: mockRelays });

        const urls = await getRelayUrls();

        expect(urls).toEqual(["wss://valid.com", "ws://valid.com"]);
    });

    it("should save defaults if all configured relays are invalid", async () => {
        const mockRelays = ["http://invalid.com", "not-a-url"];
        (configService.loadTenexConfig as any).mockResolvedValue({ relays: mockRelays });

        const urls = await getRelayUrls();

        expect(urls).toEqual(["wss://tenex.chat"]);
        expect(configService.saveGlobalConfig).toHaveBeenCalledWith({
            relays: ["wss://tenex.chat"],
        });
    });

    it("should return default relays if loading config fails", async () => {
        (configService.loadTenexConfig as any).mockRejectedValue(new Error("Failed to load"));

        const urls = await getRelayUrls();

        expect(urls).toEqual(["wss://tenex.chat"]);
        expect(configService.saveGlobalConfig).not.toHaveBeenCalled();
    });

    it("should return default relays if saving config fails", async () => {
        (configService.loadTenexConfig as any).mockResolvedValue({ relays: [] });
        (configService.saveGlobalConfig as any).mockRejectedValue(new Error("Failed to save"));

        const urls = await getRelayUrls();

        // Still returns defaults to the caller, even if saving failed
        expect(urls).toEqual(["wss://tenex.chat"]);
    });
});
