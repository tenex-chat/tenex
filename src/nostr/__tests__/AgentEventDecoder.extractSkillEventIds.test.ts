import { describe, expect, it } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentEventDecoder } from "../AgentEventDecoder";

describe("AgentEventDecoder.extractSkillEventIds", () => {
    function createMockEvent(tags: string[][]): NDKEvent {
        const event = new NDKEvent();
        event.tags = tags;
        return event;
    }

    it("should return empty array when no skill tags present", () => {
        const event = createMockEvent([
            ["p", "somepubkey"],
            ["e", "someeventid"],
        ]);

        const result = AgentEventDecoder.extractSkillEventIds(event);

        expect(result).toEqual([]);
    });

    it("should extract single skill event ID", () => {
        const event = createMockEvent([
            ["p", "somepubkey"],
            ["skill", "skill123456789"],
        ]);

        const result = AgentEventDecoder.extractSkillEventIds(event);

        expect(result).toEqual(["skill123456789"]);
    });

    it("should extract multiple skill event IDs", () => {
        const event = createMockEvent([
            ["skill", "skill1"],
            ["p", "somepubkey"],
            ["skill", "skill2"],
            ["e", "someeventid"],
            ["skill", "skill3"],
        ]);

        const result = AgentEventDecoder.extractSkillEventIds(event);

        expect(result).toEqual(["skill1", "skill2", "skill3"]);
    });

    it("should filter out skill tags with empty values", () => {
        const event = createMockEvent([
            ["skill", "valid-skill"],
            ["skill", ""],
            ["skill"], // No value at all
        ]);

        const result = AgentEventDecoder.extractSkillEventIds(event);

        expect(result).toEqual(["valid-skill"]);
    });

    it("should not confuse skill tags with other tags", () => {
        const event = createMockEvent([
            ["nudge", "nudge123"],
            ["skill", "skill123"],
            ["e", "event123"],
            ["p", "pubkey123"],
        ]);

        const result = AgentEventDecoder.extractSkillEventIds(event);

        expect(result).toEqual(["skill123"]);
    });

    it("should handle event with no tags", () => {
        const event = createMockEvent([]);

        const result = AgentEventDecoder.extractSkillEventIds(event);

        expect(result).toEqual([]);
    });

    it("should preserve order of skill tags", () => {
        const event = createMockEvent([
            ["skill", "third"],
            ["skill", "first"],
            ["skill", "second"],
        ]);

        const result = AgentEventDecoder.extractSkillEventIds(event);

        expect(result).toEqual(["third", "first", "second"]);
    });
});

describe("AgentEventDecoder.extractNudgeEventIds", () => {
    function createMockEvent(tags: string[][]): NDKEvent {
        const event = new NDKEvent();
        event.tags = tags;
        return event;
    }

    it("should return empty array when no nudge tags present", () => {
        const event = createMockEvent([
            ["p", "somepubkey"],
            ["e", "someeventid"],
        ]);

        const result = AgentEventDecoder.extractNudgeEventIds(event);

        expect(result).toEqual([]);
    });

    it("should extract single nudge event ID", () => {
        const event = createMockEvent([
            ["p", "somepubkey"],
            ["nudge", "nudge123456789"],
        ]);

        const result = AgentEventDecoder.extractNudgeEventIds(event);

        expect(result).toEqual(["nudge123456789"]);
    });

    it("should extract multiple nudge event IDs", () => {
        const event = createMockEvent([
            ["nudge", "nudge1"],
            ["p", "somepubkey"],
            ["nudge", "nudge2"],
        ]);

        const result = AgentEventDecoder.extractNudgeEventIds(event);

        expect(result).toEqual(["nudge1", "nudge2"]);
    });

    it("should not confuse nudge tags with skill tags", () => {
        const event = createMockEvent([
            ["skill", "skill123"],
            ["nudge", "nudge123"],
        ]);

        const result = AgentEventDecoder.extractNudgeEventIds(event);

        expect(result).toEqual(["nudge123"]);
    });
});
