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

    describe("markdownDescription (content field)", () => {
        it("should return undefined when content is empty", () => {
            agentDef.content = "";
            expect(agentDef.markdownDescription).toBeUndefined();
        });

        it("should return content when set", () => {
            agentDef.content = "# Agent Title\n\nThis is a detailed description.";
            expect(agentDef.markdownDescription).toBe("# Agent Title\n\nThis is a detailed description.");
        });

        it("should set content via markdownDescription setter", () => {
            agentDef.markdownDescription = "## Features\n\n- Feature 1\n- Feature 2";
            expect(agentDef.content).toBe("## Features\n\n- Feature 1\n- Feature 2");
        });

        it("should clear content when setting undefined", () => {
            agentDef.content = "Some content";
            agentDef.markdownDescription = undefined;
            expect(agentDef.content).toBe("");
        });
    });

    describe("getFileETags", () => {
        it("should return empty array when no file e-tags present", () => {
            const result = agentDef.getFileETags();
            expect(result).toEqual([]);
        });

        it("should return only e-tags with file marker", () => {
            agentDef.tags = [
                ["e", "file-event-1", "wss://relay.example.com", "file"],
                ["e", "fork-event", "wss://relay.example.com", "fork"],
                ["e", "file-event-2", "", "file"],
                ["e", "other-event", "", "script"],
            ];

            const result = agentDef.getFileETags();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                eventId: "file-event-1",
                relayUrl: "wss://relay.example.com",
            });
            expect(result[1]).toEqual({
                eventId: "file-event-2",
                relayUrl: undefined,
            });
        });
    });

    describe("getETags", () => {
        it("should return empty array when no e-tags present", () => {
            const result = agentDef.getETags();
            expect(result).toEqual([]);
        });

        it("should return all e-tags regardless of marker", () => {
            agentDef.tags = [
                ["e", "file-event-1", "wss://relay.example.com", "file"],
                ["e", "fork-event", "wss://relay2.example.com", "fork"],
                ["e", "script-event", "", "script"],
                ["e", "no-marker-event", ""],
                ["title", "Test Agent"],
            ];

            const result = agentDef.getETags();

            expect(result).toHaveLength(4);
            expect(result[0]).toEqual({
                eventId: "file-event-1",
                relayUrl: "wss://relay.example.com",
                marker: "file",
            });
            expect(result[1]).toEqual({
                eventId: "fork-event",
                relayUrl: "wss://relay2.example.com",
                marker: "fork",
            });
            expect(result[2]).toEqual({
                eventId: "script-event",
                relayUrl: undefined,
                marker: "script",
            });
            expect(result[3]).toEqual({
                eventId: "no-marker-event",
                relayUrl: undefined,
                marker: undefined,
            });
        });
    });

    describe("getForkETags", () => {
        it("should return empty array when no fork e-tags present", () => {
            const result = agentDef.getForkETags();
            expect(result).toEqual([]);
        });

        it("should return only e-tags with fork marker", () => {
            agentDef.tags = [
                ["e", "file-event", "wss://relay.example.com", "file"],
                ["e", "fork-event-1", "wss://relay1.example.com", "fork"],
                ["e", "fork-event-2", "", "fork"],
            ];

            const result = agentDef.getForkETags();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                eventId: "fork-event-1",
                relayUrl: "wss://relay1.example.com",
            });
            expect(result[1]).toEqual({
                eventId: "fork-event-2",
                relayUrl: undefined,
            });
        });
    });

    describe("getForkSource", () => {
        it("should return undefined when not a fork", () => {
            const result = agentDef.getForkSource();
            expect(result).toBeUndefined();
        });

        it("should return first fork source when present", () => {
            agentDef.tags = [
                ["e", "fork-source", "wss://relay.example.com", "fork"],
            ];

            const result = agentDef.getForkSource();

            expect(result).toEqual({
                eventId: "fork-source",
                relayUrl: "wss://relay.example.com",
            });
        });
    });

    describe("addFileReference", () => {
        it("should add file e-tag with marker", () => {
            agentDef.addFileReference("file-event-123", "wss://relay.example.com");

            const tag = agentDef.tags.find((t) => t[0] === "e" && t[3] === "file");
            expect(tag).toEqual(["e", "file-event-123", "wss://relay.example.com", "file"]);
        });

        it("should add file e-tag without relay URL", () => {
            agentDef.addFileReference("file-event-456");

            const tag = agentDef.tags.find((t) => t[0] === "e" && t[3] === "file");
            expect(tag).toEqual(["e", "file-event-456", "", "file"]);
        });

        it("should allow multiple file references", () => {
            agentDef.addFileReference("file-1");
            agentDef.addFileReference("file-2");

            const fileTags = agentDef.tags.filter((t) => t[0] === "e" && t[3] === "file");
            expect(fileTags).toHaveLength(2);
        });
    });

    describe("setForkSource", () => {
        it("should set fork source e-tag", () => {
            agentDef.setForkSource("source-event-123", "wss://relay.example.com");

            const tag = agentDef.tags.find((t) => t[0] === "e" && t[3] === "fork");
            expect(tag).toEqual(["e", "source-event-123", "wss://relay.example.com", "fork"]);
        });

        it("should set fork source without relay URL", () => {
            agentDef.setForkSource("source-event-456");

            const tag = agentDef.tags.find((t) => t[0] === "e" && t[3] === "fork");
            expect(tag).toEqual(["e", "source-event-456", "", "fork"]);
        });

        it("should replace existing fork source", () => {
            agentDef.setForkSource("old-source");
            agentDef.setForkSource("new-source");

            const forkTags = agentDef.tags.filter((t) => t[0] === "e" && t[3] === "fork");
            expect(forkTags).toHaveLength(1);
            expect(forkTags[0][1]).toBe("new-source");
        });
    });
});
