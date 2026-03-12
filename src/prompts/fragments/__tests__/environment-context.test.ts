import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as relaysModule from "@/nostr/relays";
import { environmentContextFragment } from "../32-environment-context";

mock.module("@/utils/logger", () => ({
    logger: {
        warn: () => {},
        info: () => {},
        error: () => {},
        debug: () => {},
    },
}));

describe("environmentContextFragment", () => {
    let getRelayUrlsSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        getRelayUrlsSpy = spyOn(relaysModule, "getRelayUrls");
    });

    afterEach(() => {
        getRelayUrlsSpy.mockRestore();
    });

    it("should expose the merged fragment metadata", () => {
        expect(environmentContextFragment.id).toBe("environment-context");
        expect(environmentContextFragment.priority).toBe(4);
    });

    it("should render the environment header and relay line", () => {
        getRelayUrlsSpy.mockReturnValue(["wss://tenex.chat"]);

        const result = environmentContextFragment.template({});

        expect(result).toContain("## Environment Context");
        expect(result).toContain("- Nostr Relay in Use: wss://tenex.chat");
    });

    it("should keep multiple relays on a single line", () => {
        getRelayUrlsSpy.mockReturnValue([
            "wss://relay1.example.com",
            "wss://relay2.example.com",
        ]);

        const result = environmentContextFragment.template({});

        expect(result).toContain(
            "- Nostr Relay in Use: wss://relay1.example.com, wss://relay2.example.com"
        );
    });

    it("should still include process metrics", () => {
        getRelayUrlsSpy.mockReturnValue(["wss://tenex.chat"]);

        const result = environmentContextFragment.template({});

        expect(result).toContain("- PID:");
        expect(result).toContain("- Process uptime:");
        expect(result).toContain("- CPU usage:");
        expect(result).toContain("- Memory usage:");
        expect(result).toContain("- System uptime:");
    });
});
