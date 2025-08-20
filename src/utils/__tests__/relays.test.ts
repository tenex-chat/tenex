import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getRelayUrls } from "../relays";

describe("relays", () => {
  const originalEnv = process.env;
  const originalWarn = console.warn;

  beforeEach(() => {
    // Reset env before each test
    process.env = { ...originalEnv };
    console.warn = mock(() => {});
  });

  afterEach(() => {
    // Restore original env after each test
    process.env = originalEnv;
    console.warn = originalWarn;
  });

  describe("getRelayUrls", () => {
    it("should return default relay URLs when RELAYS env is not set", () => {
      process.env.RELAYS = undefined;
      const urls = getRelayUrls();
      expect(urls).toEqual(["wss://tenex.chat"]);
    });

    it("should parse single relay URL from RELAYS env", () => {
      process.env.RELAYS = "wss://relay1.example.com";
      const urls = getRelayUrls();
      expect(urls).toEqual(["wss://relay1.example.com"]);
    });

    it("should parse multiple relay URLs from RELAYS env", () => {
      process.env.RELAYS =
        "wss://relay1.example.com,wss://relay2.example.com,wss://relay3.example.com";
      const urls = getRelayUrls();
      expect(urls).toEqual([
        "wss://relay1.example.com",
        "wss://relay2.example.com",
        "wss://relay3.example.com",
      ]);
    });

    it("should trim whitespace from relay URLs", () => {
      process.env.RELAYS = "  wss://relay1.example.com  , wss://relay2.example.com  ";
      const urls = getRelayUrls();
      expect(urls).toEqual(["wss://relay1.example.com", "wss://relay2.example.com"]);
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
      expect(urls).toEqual(["wss://relay1.example.com", "wss://relay2.example.com"]);
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
      expect(urls).toEqual(["wss://relay1.example.com", "wss://relay2.example.com"]);
    });

    it("should filter out invalid URLs and only keep valid WebSocket URLs", () => {
      process.env.RELAYS =
        "invalid-url,wss://valid.com,http://not-websocket.com,ws://also-valid.com";
      const urls = getRelayUrls();
      expect(urls).toEqual(["wss://valid.com", "ws://also-valid.com"]);
    });

    it("should accept both ws:// and wss:// protocols", () => {
      process.env.RELAYS = "ws://relay1.com,wss://relay2.com";
      const urls = getRelayUrls();
      expect(urls).toEqual(["ws://relay1.com", "wss://relay2.com"]);
    });

    it("should return defaults and warn when all URLs are invalid", () => {
      const mockWarn = mock(() => {});
      console.warn = mockWarn;

      process.env.RELAYS = "http://not-valid.com,https://also-not-valid.com,not-even-a-url";
      const urls = getRelayUrls();
      expect(urls).toEqual(["wss://tenex.chat"]);
      expect(mockWarn).toHaveBeenCalledWith(
        "No valid WebSocket URLs found in RELAYS environment variable, using defaults"
      );
    });
  });
});
