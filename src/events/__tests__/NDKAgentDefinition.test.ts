import { beforeEach, describe, expect, it } from "bun:test";
import type NDK from "@nostr-dev-kit/ndk";
import { NDKAgentDefinition } from "../NDKAgentDefinition";

describe("NDKAgentDefinition", () => {
    let agentDef: NDKAgentDefinition;
    let mockNdk: NDK;

    beforeEach(() => {
        mockNdk = {} as NDK;
        agentDef = new NDKAgentDefinition(mockNdk);
    });

    describe("basic properties", () => {
        it("should have kind 4199", () => {
            expect(agentDef.kind).toBe(4199);
            expect(NDKAgentDefinition.kind).toBe(4199);
        });

        it("should get and set title", () => {
            agentDef.title = "Test Agent";
            expect(agentDef.title).toBe("Test Agent");
            expect(agentDef.name).toBe("Test Agent"); // name is alias for title
        });

        it("should get and set description", () => {
            agentDef.description = "A test agent for testing";
            expect(agentDef.description).toBe("A test agent for testing");
        });

        it("should get and set role", () => {
            agentDef.role = "researcher";
            expect(agentDef.role).toBe("researcher");
        });

        it("should get and set instructions", () => {
            agentDef.instructions = "Do the research carefully";
            expect(agentDef.instructions).toBe("Do the research carefully");
        });

        it("should get and set useCriteria", () => {
            agentDef.useCriteria = "Use when researching topics";
            expect(agentDef.useCriteria).toBe("Use when researching topics");
        });

        it("should get and set version", () => {
            agentDef.version = 2;
            expect(agentDef.version).toBe(2);
        });

        it("should default version to 1", () => {
            expect(agentDef.version).toBe(1);
        });

        it("should get and set slug (d-tag)", () => {
            agentDef.slug = "human-replica";
            expect(agentDef.slug).toBe("human-replica");
            // Verify it's stored as a d-tag
            const dTag = agentDef.tags.find((t) => t[0] === "d");
            expect(dTag).toEqual(["d", "human-replica"]);
        });

        it("should return undefined for slug when not set", () => {
            expect(agentDef.slug).toBeUndefined();
        });

        it("should replace existing slug when setting new value", () => {
            agentDef.slug = "old-slug";
            agentDef.slug = "new-slug";
            expect(agentDef.slug).toBe("new-slug");
            // Verify only one d-tag exists
            const dTags = agentDef.tags.filter((t) => t[0] === "d");
            expect(dTags).toHaveLength(1);
        });

        it("should clear slug when setting undefined", () => {
            agentDef.slug = "existing-slug";
            expect(agentDef.slug).toBe("existing-slug");

            agentDef.slug = undefined;
            expect(agentDef.slug).toBeUndefined();

            // Verify d-tag is removed
            const dTags = agentDef.tags.filter((t) => t[0] === "d");
            expect(dTags).toHaveLength(0);
        });
    });

    describe("getScriptETags", () => {
        it("should return empty array when no e-tags present", () => {
            const result = agentDef.getScriptETags();
            expect(result).toEqual([]);
        });

        it("should return empty array when e-tags have no script marker", () => {
            agentDef.tags = [
                ["e", "event-id-1", "relay-url"],
                ["e", "event-id-2"],
            ];

            const result = agentDef.getScriptETags();
            expect(result).toEqual([]);
        });

        it("should return script e-tags with marker", () => {
            agentDef.tags = [
                ["e", "script-event-1", "wss://relay.example.com", "script"],
                ["e", "other-event", "wss://relay.example.com", "reply"],
                ["e", "script-event-2", "", "script"],
            ];

            const result = agentDef.getScriptETags();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                eventId: "script-event-1",
                relayUrl: "wss://relay.example.com",
            });
            expect(result[1]).toEqual({
                eventId: "script-event-2",
                relayUrl: undefined, // Empty string becomes undefined
            });
        });

        it("should filter out e-tags with empty event ID", () => {
            agentDef.tags = [
                ["e", "", "relay-url", "script"],
                ["e", "valid-event", "relay-url", "script"],
            ];

            const result = agentDef.getScriptETags();

            expect(result).toHaveLength(1);
            expect(result[0].eventId).toBe("valid-event");
        });

        it("should handle mixed tag types", () => {
            agentDef.tags = [
                ["title", "Test Agent"],
                ["e", "script-event", "relay-url", "script"],
                ["p", "pubkey"],
                ["tool", "fs_read"],
                ["e", "other-event", "relay-url", "mention"],
            ];

            const result = agentDef.getScriptETags();

            expect(result).toHaveLength(1);
            expect(result[0].eventId).toBe("script-event");
        });

        it("should handle relay URL being optional (undefined)", () => {
            agentDef.tags = [
                ["e", "script-event-no-relay", undefined, "script"],
            ];

            const result = agentDef.getScriptETags();

            expect(result).toHaveLength(1);
            expect(result[0].eventId).toBe("script-event-no-relay");
            expect(result[0].relayUrl).toBeUndefined();
        });
    });
});
