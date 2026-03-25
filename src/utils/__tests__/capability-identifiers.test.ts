import { describe, expect, it } from "bun:test";
import { assignCapabilityIdentifiers } from "@/utils/capability-identifiers";

describe("assignCapabilityIdentifiers", () => {
    it("prefers d-tags over name/title when building identifiers", () => {
        const identifiers = assignCapabilityIdentifiers([
            {
                eventId: `${"a".repeat(12)}${"0".repeat(52)}`,
                dTag: "make-poster",
                name: "Poster Builder",
                title: "Make Poster",
            },
        ]);

        expect(identifiers.get(`${"a".repeat(12)}${"0".repeat(52)}`)).toEqual({
            identifier: "make-poster",
            shortId: "aaaaaaaaaaaa",
        });
    });

    it("falls back to short id when no d-tag, name, or title exists", () => {
        const eventId = `${"b".repeat(12)}${"1".repeat(52)}`;
        const identifiers = assignCapabilityIdentifiers([{ eventId }]);

        expect(identifiers.get(eventId)).toEqual({
            identifier: "bbbbbbbbbbbb",
            shortId: "bbbbbbbbbbbb",
        });
    });

    it("falls back to short ids when slug collisions occur", () => {
        const eventId1 = `${"c".repeat(12)}${"2".repeat(52)}`;
        const eventId2 = `${"d".repeat(12)}${"3".repeat(52)}`;
        const identifiers = assignCapabilityIdentifiers([
            { eventId: eventId1, title: "Make Poster" },
            { eventId: eventId2, name: "make-poster" },
        ]);

        expect(identifiers.get(eventId1)).toEqual({
            identifier: "cccccccccccc",
            shortId: "cccccccccccc",
        });
        expect(identifiers.get(eventId2)).toEqual({
            identifier: "dddddddddddd",
            shortId: "dddddddddddd",
        });
    });
});
