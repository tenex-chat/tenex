import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { NudgeSkillWhitelistService, type WhitelistItem } from "../NudgeWhitelistService";
import { NDKKind } from "@/nostr/kinds";

// Mock getNDK
const mockFetchEvents = mock(() => Promise.resolve(new Set()));
const mockSubscribe = mock(() => ({
    on: mock(),
    stop: mock(),
}));

mock.module("@/nostr", () => ({
    getNDK: () => ({
        fetchEvents: mockFetchEvents,
        subscribe: mockSubscribe,
    }),
}));

describe("NudgeSkillWhitelistService", () => {
    let service: NudgeSkillWhitelistService;

    beforeEach(() => {
        // Reset singleton for clean tests
        service = NudgeSkillWhitelistService.getInstance();
        service.shutdown();
        mockFetchEvents.mockClear();
        mockSubscribe.mockClear();
    });

    afterEach(() => {
        service.shutdown();
    });

    describe("getInstance", () => {
        it("should return singleton instance", () => {
            const instance1 = NudgeSkillWhitelistService.getInstance();
            const instance2 = NudgeSkillWhitelistService.getInstance();
            expect(instance1).toBe(instance2);
        });
    });

    describe("refresh race condition guard", () => {
        it("should coalesce concurrent refresh calls", async () => {
            const pubkeys = ["pubkey1", "pubkey2"];

            // Mock slow fetch to test coalescing
            let fetchCallCount = 0;
            mockFetchEvents.mockImplementation(() => {
                fetchCallCount++;
                return new Promise(resolve =>
                    setTimeout(() => resolve(new Set()), 50)
                );
            });

            await service.initialize(pubkeys);

            // Reset count after initialize
            fetchCallCount = 0;

            // Fire multiple concurrent refreshes
            const promises = [
                service.refresh(),
                service.refresh(),
                service.refresh(),
            ];

            await Promise.all(promises);

            // Should only have done one actual refresh due to coalescing
            // (fetchEvents is called twice per refresh: whitelist events, then referenced events)
            expect(fetchCallCount).toBeLessThanOrEqual(2);
        });
    });

    describe("whitelistedBy tracking", () => {
        it("should track multiple pubkeys that whitelist the same event", async () => {
            const nudgeEventId = "nudge123";
            const pubkey1 = "whitelist-pubkey-1";
            const pubkey2 = "whitelist-pubkey-2";

            // Create mock whitelist events from two different pubkeys
            const whitelistEvent1 = {
                id: "whitelist1",
                pubkey: pubkey1,
                tags: [["e", nudgeEventId]],
            };
            const whitelistEvent2 = {
                id: "whitelist2",
                pubkey: pubkey2,
                tags: [["e", nudgeEventId]],
            };

            // Create mock nudge event
            const nudgeEvent = {
                id: nudgeEventId,
                kind: NDKKind.AgentNudge,
                content: "Test nudge content",
                tags: [["title", "Test Nudge"]],
                tagValue: (tag: string) => {
                    if (tag === "title") return "Test Nudge";
                    return undefined;
                },
            };

            // First call returns whitelist events, second call returns referenced events
            let callCount = 0;
            mockFetchEvents.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve(new Set([whitelistEvent1, whitelistEvent2]));
                }
                return Promise.resolve(new Set([nudgeEvent]));
            });

            await service.initialize([pubkey1, pubkey2]);

            const nudges = service.getWhitelistedNudges();
            expect(nudges.length).toBe(1);

            // Should track BOTH pubkeys that whitelisted this nudge
            expect(nudges[0].whitelistedBy).toContain(pubkey1);
            expect(nudges[0].whitelistedBy).toContain(pubkey2);
            expect(nudges[0].whitelistedBy.length).toBe(2);
        });
    });

    describe("WhitelistItem type safety", () => {
        it("should create items with correct kind types", async () => {
            const nudgeEvent = {
                id: "nudge-id",
                kind: NDKKind.AgentNudge,
                content: "Nudge content",
                tags: [],
                tagValue: () => undefined,
            };
            const skillEvent = {
                id: "skill-id",
                kind: NDKKind.AgentSkill,
                content: "Skill content",
                tags: [],
                tagValue: () => undefined,
            };

            const whitelistEvent = {
                id: "whitelist",
                pubkey: "pubkey1",
                tags: [["e", "nudge-id"], ["e", "skill-id"]],
            };

            let callCount = 0;
            mockFetchEvents.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve(new Set([whitelistEvent]));
                }
                return Promise.resolve(new Set([nudgeEvent, skillEvent]));
            });

            await service.initialize(["pubkey1"]);

            const nudges = service.getWhitelistedNudges();
            const skills = service.getWhitelistedSkills();

            expect(nudges.length).toBe(1);
            expect(nudges[0].kind).toBe(NDKKind.AgentNudge);

            expect(skills.length).toBe(1);
            expect(skills[0].kind).toBe(NDKKind.AgentSkill);
        });

        it("should ignore events with invalid kinds", async () => {
            const invalidEvent = {
                id: "invalid-id",
                kind: 1, // Not a nudge or skill kind
                content: "Invalid content",
                tags: [],
                tagValue: () => undefined,
            };

            const whitelistEvent = {
                id: "whitelist",
                pubkey: "pubkey1",
                tags: [["e", "invalid-id"]],
            };

            let callCount = 0;
            mockFetchEvents.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve(new Set([whitelistEvent]));
                }
                return Promise.resolve(new Set([invalidEvent]));
            });

            await service.initialize(["pubkey1"]);

            const nudges = service.getWhitelistedNudges();
            const skills = service.getWhitelistedSkills();
            const all = service.getAllWhitelistedItems();

            expect(nudges.length).toBe(0);
            expect(skills.length).toBe(0);
            expect(all.length).toBe(0);
        });
    });

    describe("description handling", () => {
        it("should store full content without truncation", async () => {
            const longContent = "A".repeat(500); // Longer than 200 chars

            const nudgeEvent = {
                id: "nudge-id",
                kind: NDKKind.AgentNudge,
                content: longContent,
                tags: [],
                tagValue: () => undefined,
            };

            const whitelistEvent = {
                id: "whitelist",
                pubkey: "pubkey1",
                tags: [["e", "nudge-id"]],
            };

            let callCount = 0;
            mockFetchEvents.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve(new Set([whitelistEvent]));
                }
                return Promise.resolve(new Set([nudgeEvent]));
            });

            await service.initialize(["pubkey1"]);

            const nudges = service.getWhitelistedNudges();
            expect(nudges.length).toBe(1);
            // Service should store FULL content (truncation happens in presentation)
            expect(nudges[0].description).toBe(longContent);
            expect(nudges[0].description?.length).toBe(500);
        });
    });

    describe("cache operations", () => {
        it("should return empty arrays when cache is null", () => {
            expect(service.getWhitelistedNudges()).toEqual([]);
            expect(service.getWhitelistedSkills()).toEqual([]);
            expect(service.getAllWhitelistedItems()).toEqual([]);
        });

        it("should return null for lastUpdated when cache is null", () => {
            expect(service.getLastUpdated()).toBeNull();
        });

        it("should clear cache on shutdown", async () => {
            mockFetchEvents.mockImplementation(() => Promise.resolve(new Set()));
            await service.initialize(["pubkey1"]);

            service.shutdown();

            expect(service.getLastUpdated()).toBeNull();
        });
    });

    describe("isNudgeWhitelisted / isSkillWhitelisted", () => {
        it("should check nudge whitelist status", async () => {
            const nudgeEvent = {
                id: "nudge-id",
                kind: NDKKind.AgentNudge,
                content: "Content",
                tags: [],
                tagValue: () => undefined,
            };

            const whitelistEvent = {
                id: "whitelist",
                pubkey: "pubkey1",
                tags: [["e", "nudge-id"]],
            };

            let callCount = 0;
            mockFetchEvents.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve(new Set([whitelistEvent]));
                }
                return Promise.resolve(new Set([nudgeEvent]));
            });

            await service.initialize(["pubkey1"]);

            expect(service.isNudgeWhitelisted("nudge-id")).toBe(true);
            expect(service.isNudgeWhitelisted("unknown-id")).toBe(false);
        });

        it("should check skill whitelist status", async () => {
            const skillEvent = {
                id: "skill-id",
                kind: NDKKind.AgentSkill,
                content: "Content",
                tags: [],
                tagValue: () => undefined,
            };

            const whitelistEvent = {
                id: "whitelist",
                pubkey: "pubkey1",
                tags: [["e", "skill-id"]],
            };

            let callCount = 0;
            mockFetchEvents.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve(new Set([whitelistEvent]));
                }
                return Promise.resolve(new Set([skillEvent]));
            });

            await service.initialize(["pubkey1"]);

            expect(service.isSkillWhitelisted("skill-id")).toBe(true);
            expect(service.isSkillWhitelisted("unknown-id")).toBe(false);
        });
    });

    describe("getNudge", () => {
        it("should return nudge by event ID", async () => {
            const nudgeEvent = {
                id: "nudge-id",
                kind: NDKKind.AgentNudge,
                content: "Test content",
                tags: [["title", "Test Nudge"]],
                tagValue: (tag: string) => tag === "title" ? "Test Nudge" : undefined,
            };

            const whitelistEvent = {
                id: "whitelist",
                pubkey: "pubkey1",
                tags: [["e", "nudge-id"]],
            };

            let callCount = 0;
            mockFetchEvents.mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve(new Set([whitelistEvent]));
                }
                return Promise.resolve(new Set([nudgeEvent]));
            });

            await service.initialize(["pubkey1"]);

            const nudge = service.getNudge("nudge-id");
            expect(nudge).toBeDefined();
            expect(nudge?.name).toBe("Test Nudge");
            expect(nudge?.eventId).toBe("nudge-id");
        });

        it("should return undefined for unknown nudge", async () => {
            mockFetchEvents.mockImplementation(() => Promise.resolve(new Set()));
            await service.initialize(["pubkey1"]);

            const nudge = service.getNudge("unknown");
            expect(nudge).toBeUndefined();
        });
    });
});
