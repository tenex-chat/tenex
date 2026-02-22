import { describe, expect, it, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { NudgeSkillWhitelistService, type WhitelistItem } from "../NudgeWhitelistService";
import { NDKKind } from "@/nostr/kinds";

// Capture the subscription event handler so tests can emit events
let capturedEventHandler: ((event: any) => void) | null = null;

const mockFetchEvents = mock(() => Promise.resolve(new Set()));
const mockSubscriptionStop = mock();
const mockSubscribe = mock(() => {
    const sub = {
        on: mock((eventName: string, handler: (event: any) => void) => {
            if (eventName === "event") {
                capturedEventHandler = handler;
            }
        }),
        stop: mockSubscriptionStop,
    };
    return sub;
});

mock.module("@/nostr", () => ({
    getNDK: () => ({
        fetchEvents: mockFetchEvents,
        subscribe: mockSubscribe,
    }),
}));

/**
 * Emit a whitelist event through the captured subscription handler
 * and flush the debounce timer so rebuildCache runs.
 */
async function emitAndRebuild(event: any): Promise<void> {
    if (!capturedEventHandler) throw new Error("No subscription handler captured");
    capturedEventHandler(event);
    // Advance past the 500ms debounce
    await Bun.sleep(600);
}

/**
 * Emit multiple events, then flush once (batched).
 */
async function emitManyAndRebuild(events: any[]): Promise<void> {
    if (!capturedEventHandler) throw new Error("No subscription handler captured");
    for (const event of events) {
        capturedEventHandler(event);
    }
    await Bun.sleep(600);
}

describe("NudgeSkillWhitelistService", () => {
    let service: NudgeSkillWhitelistService;

    beforeEach(() => {
        capturedEventHandler = null;
        service = NudgeSkillWhitelistService.getInstance();
        service.shutdown();
        mockFetchEvents.mockClear();
        mockSubscribe.mockClear();
        mockSubscriptionStop.mockClear();
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

    describe("initialize", () => {
        it("should return immediately with empty cache", () => {
            service.initialize(["pubkey1"]);

            // Cache is initialized but empty
            expect(service.getWhitelistedNudges()).toEqual([]);
            expect(service.getWhitelistedSkills()).toEqual([]);
            expect(service.getLastUpdated()).not.toBeNull();
        });

        it("should start a subscription", () => {
            service.initialize(["pubkey1"]);
            expect(mockSubscribe).toHaveBeenCalledTimes(1);
        });

        it("should skip re-initialization with same pubkeys", () => {
            service.initialize(["pubkey1"]);
            mockSubscribe.mockClear();

            service.initialize(["pubkey1"]);
            expect(mockSubscribe).not.toHaveBeenCalled();
        });
    });

    describe("reactive cache population", () => {
        it("should populate cache when whitelist event arrives", async () => {
            const nudgeEventId = "nudge123";
            const pubkey1 = "whitelist-pubkey-1";

            const whitelistEvent = {
                id: "whitelist1",
                pubkey: pubkey1,
                created_at: 1000,
                tags: [["e", nudgeEventId]],
            };

            const nudgeEvent = {
                id: nudgeEventId,
                kind: NDKKind.AgentNudge,
                content: "Test nudge content",
                tags: [["title", "Test Nudge"]],
                tagValue: (tag: string) => tag === "title" ? "Test Nudge" : undefined,
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([nudgeEvent]))
            );

            service.initialize([pubkey1]);

            await emitAndRebuild(whitelistEvent);

            const nudges = service.getWhitelistedNudges();
            expect(nudges.length).toBe(1);
            expect(nudges[0].eventId).toBe(nudgeEventId);
            expect(nudges[0].name).toBe("Test Nudge");
        });

        it("should batch-fetch only unfetched referenced events", async () => {
            const pubkey1 = "pubkey1";

            const whitelistEvent1 = {
                id: "wl1",
                pubkey: pubkey1,
                created_at: 1000,
                tags: [["e", "nudge1"], ["e", "nudge2"]],
            };

            const nudgeEvent1 = {
                id: "nudge1",
                kind: NDKKind.AgentNudge,
                content: "Nudge 1",
                tags: [],
                tagValue: () => undefined,
            };
            const nudgeEvent2 = {
                id: "nudge2",
                kind: NDKKind.AgentNudge,
                content: "Nudge 2",
                tags: [],
                tagValue: () => undefined,
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([nudgeEvent1, nudgeEvent2]))
            );

            service.initialize([pubkey1]);
            await emitAndRebuild(whitelistEvent1);

            expect(service.getWhitelistedNudges().length).toBe(2);

            // Now emit a new whitelist event that still references nudge1 but adds nudge3
            mockFetchEvents.mockClear();

            const nudgeEvent3 = {
                id: "nudge3",
                kind: NDKKind.AgentNudge,
                content: "Nudge 3",
                tags: [],
                tagValue: () => undefined,
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([nudgeEvent3]))
            );

            const whitelistEvent2 = {
                id: "wl2",
                pubkey: pubkey1,
                created_at: 2000,
                tags: [["e", "nudge1"], ["e", "nudge3"]],
            };

            await emitAndRebuild(whitelistEvent2);

            // Should have fetched only nudge3 (nudge1 already cached)
            expect(mockFetchEvents).toHaveBeenCalledTimes(1);
            const fetchCall = mockFetchEvents.mock.calls[0][0] as any;
            expect(fetchCall.ids).toEqual(["nudge3"]);

            // Cache should contain nudge1 and nudge3 (nudge2 no longer referenced)
            expect(service.getWhitelistedNudges().length).toBe(2);
            expect(service.isNudgeWhitelisted("nudge1")).toBe(true);
            expect(service.isNudgeWhitelisted("nudge3")).toBe(true);
            expect(service.isNudgeWhitelisted("nudge2")).toBe(false);
        });
    });

    describe("whitelistedBy tracking", () => {
        it("should track multiple pubkeys that whitelist the same event", async () => {
            const nudgeEventId = "nudge123";
            const pubkey1 = "whitelist-pubkey-1";
            const pubkey2 = "whitelist-pubkey-2";

            const whitelistEvent1 = {
                id: "whitelist1",
                pubkey: pubkey1,
                created_at: 1000,
                tags: [["e", nudgeEventId]],
            };
            const whitelistEvent2 = {
                id: "whitelist2",
                pubkey: pubkey2,
                created_at: 1000,
                tags: [["e", nudgeEventId]],
            };

            const nudgeEvent = {
                id: nudgeEventId,
                kind: NDKKind.AgentNudge,
                content: "Test nudge content",
                tags: [["title", "Test Nudge"]],
                tagValue: (tag: string) => tag === "title" ? "Test Nudge" : undefined,
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([nudgeEvent]))
            );

            service.initialize([pubkey1, pubkey2]);

            // Emit both, then flush once
            await emitManyAndRebuild([whitelistEvent1, whitelistEvent2]);

            const nudges = service.getWhitelistedNudges();
            expect(nudges.length).toBe(1);
            expect(nudges[0].whitelistedBy).toContain(pubkey1);
            expect(nudges[0].whitelistedBy).toContain(pubkey2);
            expect(nudges[0].whitelistedBy.length).toBe(2);
        });
    });

    describe("replaceable semantics", () => {
        it("should skip older events from the same author", async () => {
            const pubkey1 = "pubkey1";

            const olderEvent = {
                id: "wl-old",
                pubkey: pubkey1,
                created_at: 1000,
                tags: [["e", "nudge-old"]],
            };

            const newerEvent = {
                id: "wl-new",
                pubkey: pubkey1,
                created_at: 2000,
                tags: [["e", "nudge-new"]],
            };

            const nudgeNew = {
                id: "nudge-new",
                kind: NDKKind.AgentNudge,
                content: "New nudge",
                tags: [],
                tagValue: () => undefined,
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([nudgeNew]))
            );

            service.initialize([pubkey1]);

            // Emit the newer event first, then the older one
            await emitManyAndRebuild([newerEvent, olderEvent]);

            // Should only reference nudge-new (the newer event's tags)
            const nudges = service.getWhitelistedNudges();
            expect(nudges.length).toBe(1);
            expect(nudges[0].eventId).toBe("nudge-new");
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
                created_at: 1000,
                tags: [["e", "nudge-id"], ["e", "skill-id"]],
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([nudgeEvent, skillEvent]))
            );

            service.initialize(["pubkey1"]);
            await emitAndRebuild(whitelistEvent);

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
                kind: 1,
                content: "Invalid content",
                tags: [],
                tagValue: () => undefined,
            };

            const whitelistEvent = {
                id: "whitelist",
                pubkey: "pubkey1",
                created_at: 1000,
                tags: [["e", "invalid-id"]],
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([invalidEvent]))
            );

            service.initialize(["pubkey1"]);
            await emitAndRebuild(whitelistEvent);

            expect(service.getWhitelistedNudges().length).toBe(0);
            expect(service.getWhitelistedSkills().length).toBe(0);
            expect(service.getAllWhitelistedItems().length).toBe(0);
        });
    });

    describe("description handling", () => {
        it("should store full content without truncation", async () => {
            const longContent = "A".repeat(500);

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
                created_at: 1000,
                tags: [["e", "nudge-id"]],
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([nudgeEvent]))
            );

            service.initialize(["pubkey1"]);
            await emitAndRebuild(whitelistEvent);

            const nudges = service.getWhitelistedNudges();
            expect(nudges.length).toBe(1);
            expect(nudges[0].description).toBe(longContent);
            expect(nudges[0].description?.length).toBe(500);
        });
    });

    describe("cache operations", () => {
        it("should return empty arrays when not initialized", () => {
            expect(service.getWhitelistedNudges()).toEqual([]);
            expect(service.getWhitelistedSkills()).toEqual([]);
            expect(service.getAllWhitelistedItems()).toEqual([]);
        });

        it("should return null for lastUpdated when not initialized", () => {
            expect(service.getLastUpdated()).toBeNull();
        });

        it("should clear cache on shutdown", () => {
            service.initialize(["pubkey1"]);
            service.shutdown();
            expect(service.getLastUpdated()).toBeNull();
        });
    });

    describe("fetch timeout handling", () => {
        it("should continue with cached events when fetch times out", async () => {
            const pubkey1 = "pubkey1";

            // First event arrives and its referenced event fetches successfully
            const nudgeEvent1 = {
                id: "nudge1",
                kind: NDKKind.AgentNudge,
                content: "Nudge 1",
                tags: [],
                tagValue: () => undefined,
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([nudgeEvent1]))
            );

            service.initialize([pubkey1]);

            const wl1 = {
                id: "wl1",
                pubkey: pubkey1,
                created_at: 1000,
                tags: [["e", "nudge1"]],
            };
            await emitAndRebuild(wl1);
            expect(service.getWhitelistedNudges().length).toBe(1);

            // Now the fetch hangs forever — simulate timeout
            mockFetchEvents.mockImplementation(() =>
                new Promise(() => {}) // never resolves
            );

            const wl2 = {
                id: "wl2",
                pubkey: pubkey1,
                created_at: 2000,
                tags: [["e", "nudge1"], ["e", "nudge-unreachable"]],
            };

            // Emit event and wait for debounce + timeout (10s timeout in code, but the
            // test mock never resolves so Promise.race will fire the timeout)
            capturedEventHandler!(wl2);
            // Wait for debounce (500ms) + fetch timeout (10s) + small buffer
            await Bun.sleep(11_000);

            // nudge1 is still in cache from before; nudge-unreachable was not fetched
            const nudges = service.getWhitelistedNudges();
            expect(nudges.length).toBe(1);
            expect(nudges[0].eventId).toBe("nudge1");
        }, 15_000);
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
                created_at: 1000,
                tags: [["e", "nudge-id"]],
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([nudgeEvent]))
            );

            service.initialize(["pubkey1"]);
            await emitAndRebuild(whitelistEvent);

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
                created_at: 1000,
                tags: [["e", "skill-id"]],
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([skillEvent]))
            );

            service.initialize(["pubkey1"]);
            await emitAndRebuild(whitelistEvent);

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
                created_at: 1000,
                tags: [["e", "nudge-id"]],
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([nudgeEvent]))
            );

            service.initialize(["pubkey1"]);
            await emitAndRebuild(whitelistEvent);

            const nudge = service.getNudge("nudge-id");
            expect(nudge).toBeDefined();
            expect(nudge?.name).toBe("Test Nudge");
            expect(nudge?.eventId).toBe("nudge-id");
        });

        it("should return undefined for unknown nudge", () => {
            service.initialize(["pubkey1"]);
            const nudge = service.getNudge("unknown");
            expect(nudge).toBeUndefined();
        });
    });

    describe("shutdown", () => {
        it("should clear all state", async () => {
            const nudgeEvent = {
                id: "nudge-id",
                kind: NDKKind.AgentNudge,
                content: "Content",
                tags: [],
                tagValue: () => undefined,
            };

            mockFetchEvents.mockImplementation(() =>
                Promise.resolve(new Set([nudgeEvent]))
            );

            service.initialize(["pubkey1"]);

            const wl = {
                id: "wl1",
                pubkey: "pubkey1",
                created_at: 1000,
                tags: [["e", "nudge-id"]],
            };
            await emitAndRebuild(wl);

            expect(service.getWhitelistedNudges().length).toBe(1);

            service.shutdown();

            expect(service.getLastUpdated()).toBeNull();
            expect(service.getWhitelistedNudges()).toEqual([]);
            expect(service.getWhitelistedSkills()).toEqual([]);
            expect(service.getAllWhitelistedItems()).toEqual([]);
        });
    });
});
