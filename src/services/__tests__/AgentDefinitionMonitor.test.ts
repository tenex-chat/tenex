import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStorage, createStoredAgent } from "../../agents/AgentStorage";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { AgentDefinitionMonitor, type ActiveRuntimesProvider } from "../AgentDefinitionMonitor";
import { SkillService } from "@/services/skill/SkillService";

// Minimal mock NDK for testing
function createMockNDK(fetchEventResult?: any) {
    return {
        subscribe: mock(() => ({
            on: mock(() => {}),
            stop: mock(() => {}),
        })),
        fetchEvent: mock(async () => fetchEventResult ?? null),
    } as any;
}

function createNoopRuntimesProvider(): ActiveRuntimesProvider {
    return () => new Map();
}

describe("AgentDefinitionMonitor", () => {
    let tempDir: string;
    let storage: AgentStorage;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-test-"));
        storage = new AgentStorage();

        // Override the storage instance to use an isolated temp dir
        (storage as any).agentsDir = tempDir;
        (storage as any).indexPath = path.join(tempDir, "index.json");
        (storage as any).index = null;

        await storage.initialize();
    });

    afterEach(async () => {
        mock.restore();
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    describe("bootstrapLegacyAgents", () => {
        it("should infer definitionDTag from slug for agents with eventId but missing dTag", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "legacy-bot",
                name: "Legacy Bot",
                role: "assistant",
                eventId: "abc123def456",
                definitionAuthor: "author-pubkey-abc",
            });
            // Explicitly ensure definitionDTag is missing
            (agent as any).definitionDTag = undefined;

            await storage.saveAgent(agent);

            const ndk = createMockNDK();
            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
                storage,
            );

            await monitor.start();

            const saved = await storage.loadAgent(signer.pubkey);
            expect(saved).not.toBeNull();
            expect(saved?.definitionDTag).toBe("legacy-bot");
            expect(saved?.definitionAuthor).toBe("author-pubkey-abc");

            monitor.stop();
        });

        it("should recover definitionAuthor from relay when missing", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const fakeEventId = "event123abc";
            const fakeAuthorPubkey = "recovered-author-pubkey";

            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "orphan-bot",
                name: "Orphan Bot",
                role: "assistant",
                eventId: fakeEventId,
            });
            (agent as any).definitionDTag = undefined;
            (agent as any).definitionAuthor = undefined;

            await storage.saveAgent(agent);

            const mockEvent = {
                pubkey: fakeAuthorPubkey,
                created_at: 1700000000,
            };
            const ndk = createMockNDK(mockEvent);

            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
                storage,
            );

            await monitor.start();

            const saved = await storage.loadAgent(signer.pubkey);
            expect(saved).not.toBeNull();
            expect(saved?.definitionDTag).toBe("orphan-bot");
            expect(saved?.definitionAuthor).toBe(fakeAuthorPubkey);
            expect(saved?.definitionCreatedAt).toBe(1700000000);

            expect(ndk.fetchEvent).toHaveBeenCalledWith(fakeEventId);

            monitor.stop();
        });

        it("should skip agents without eventId", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "local-only",
                name: "Local Only",
                role: "assistant",
            });
            (agent as any).definitionDTag = undefined;
            (agent as any).definitionAuthor = undefined;
            (agent as any).eventId = undefined;

            await storage.saveAgent(agent);

            const ndk = createMockNDK();
            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
                storage,
            );

            await monitor.start();

            const saved = await storage.loadAgent(signer.pubkey);
            expect(saved).not.toBeNull();
            expect(saved?.definitionDTag).toBeUndefined();
            expect(saved?.definitionAuthor).toBeUndefined();
            expect(ndk.fetchEvent).not.toHaveBeenCalled();

            monitor.stop();
        });

        it("should handle relay fetch failure gracefully", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "flaky-bot",
                name: "Flaky Bot",
                role: "assistant",
                eventId: "event-that-fails",
            });
            (agent as any).definitionDTag = undefined;
            (agent as any).definitionAuthor = undefined;

            await storage.saveAgent(agent);

            // fetchEvent returns null (event not found on relay)
            const ndk = createMockNDK(null);

            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
                storage,
            );

            await monitor.start();

            const saved = await storage.loadAgent(signer.pubkey);
            expect(saved).not.toBeNull();
            // definitionDTag should still be inferred from slug
            expect(saved?.definitionDTag).toBe("flaky-bot");
            // definitionAuthor should remain undefined since fetch returned null
            expect(saved?.definitionAuthor).toBeUndefined();

            monitor.stop();
        });

        it("should handle fetchEvent throwing an error gracefully and still infer dTag from slug", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "error-bot",
                name: "Error Bot",
                role: "assistant",
                eventId: "event-that-throws",
            });
            (agent as any).definitionDTag = undefined;
            (agent as any).definitionAuthor = undefined;

            await storage.saveAgent(agent);

            // fetchEvent throws an error (network failure, etc.)
            const ndk = createMockNDK();
            ndk.fetchEvent = mock(async () => {
                throw new Error("Network timeout");
            });

            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
                storage,
            );

            await monitor.start();

            const saved = await storage.loadAgent(signer.pubkey);
            expect(saved).not.toBeNull();
            // definitionDTag should still be inferred from slug despite fetchEvent throwing
            expect(saved?.definitionDTag).toBe("error-bot");
            // definitionAuthor should remain undefined since fetch threw
            expect(saved?.definitionAuthor).toBeUndefined();

            expect(ndk.fetchEvent).toHaveBeenCalledWith("event-that-throws");

            monitor.stop();
        });

        it("should not touch agents that already have both tracking fields", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "complete-bot",
                name: "Complete Bot",
                role: "assistant",
                eventId: "complete-event-id",
                definitionDTag: "complete-bot",
                definitionAuthor: "existing-author",
                definitionCreatedAt: 1600000000,
            });

            await storage.saveAgent(agent);

            const ndk = createMockNDK();
            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
                storage,
            );

            await monitor.start();

            expect(ndk.fetchEvent).not.toHaveBeenCalled();

            const saved = await storage.loadAgent(signer.pubkey);
            expect(saved?.definitionDTag).toBe("complete-bot");
            expect(saved?.definitionAuthor).toBe("existing-author");
            expect(saved?.definitionCreatedAt).toBe(1600000000);

            monitor.stop();
        });

        it("should report migrated agents as monitored (subscribe is called)", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const fakeAuthorPubkey = "migrated-author";
            const agent = createStoredAgent({
                nsec: signer.nsec,
                slug: "soon-monitored",
                name: "Soon Monitored",
                role: "assistant",
                eventId: "soon-event-id",
            });
            (agent as any).definitionDTag = undefined;
            (agent as any).definitionAuthor = undefined;

            await storage.saveAgent(agent);

            const mockEvent = {
                pubkey: fakeAuthorPubkey,
                created_at: 1700000000,
            };
            const ndk = createMockNDK(mockEvent);

            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
                storage,
            );

            await monitor.start();

            // The subscribe method should have been called since the agent was migrated
            // and now has tracking fields
            expect(ndk.subscribe).toHaveBeenCalled();

            monitor.stop();
        });
    });

    describe("upgradeAgent skill handling", () => {
        function createDefinitionEvent(params: {
            id: string;
            pubkey?: string;
            createdAt?: number;
            tags?: string[][];
        }): NDKEvent {
            const event = new NDKEvent();
            event.id = params.id;
            event.pubkey = params.pubkey ?? "definition-author";
            event.created_at = params.createdAt ?? 1_700_000_000;
            event.tags = params.tags ?? [["title", "Updated Agent"]];
            return event;
        }

        it("overwrites stored skills with hydrated local IDs", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const storedAgent = createStoredAgent({
                nsec: signer.nsec,
                slug: "skill-bot",
                name: "Skill Bot",
                role: "assistant",
                eventId: "old-event-id",
                definitionDTag: "skill-bot",
                definitionAuthor: "definition-author",
                definitionCreatedAt: 1_600_000_000,
                defaultConfig: {
                    model: "anthropic:claude-sonnet-4",
                    skills: ["old-skill"],
                },
            });
            await storage.saveAgent(storedAgent);

            const fetchSkills = mock(async () => ({
                skills: [
                    {
                        identifier: "make-posters",
                        eventId: "skill-event-1",
                        content: "poster instructions",
                        installedFiles: [],
                    },
                    {
                        identifier: "edit-videos",
                        eventId: "skill-event-2",
                        content: "video instructions",
                        installedFiles: [],
                    },
                ],
                content: "",
            }));
            spyOn(SkillService, "getInstance").mockReturnValue({
                fetchSkills,
            } as unknown as SkillService);

            const monitor = new AgentDefinitionMonitor(
                createMockNDK(),
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
                storage,
            );

            await (monitor as any).upgradeAgent(
                storedAgent,
                {
                    pubkey: signer.pubkey,
                    slug: "skill-bot",
                    definitionDTag: "skill-bot",
                    definitionAuthor: "definition-author",
                },
                createDefinitionEvent({
                    id: "new-event-id",
                    tags: [
                        ["title", "Skill Bot"],
                        ["skill", "skill-event-1"],
                        ["skill", "skill-event-2"],
                    ],
                })
            );

            const saved = await storage.loadAgent(signer.pubkey);
            expect(saved?.default?.skills).toEqual([
                "make-posters",
                "edit-videos",
            ]);
        });

        it("clears stored skills when a newer definition omits skill tags", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const storedAgent = createStoredAgent({
                nsec: signer.nsec,
                slug: "skill-bot",
                name: "Skill Bot",
                role: "assistant",
                eventId: "old-event-id",
                definitionDTag: "skill-bot",
                definitionAuthor: "definition-author",
                definitionCreatedAt: 1_600_000_000,
                defaultConfig: {
                    model: "anthropic:claude-sonnet-4",
                    skills: ["old-skill"],
                },
            });
            await storage.saveAgent(storedAgent);

            const monitor = new AgentDefinitionMonitor(
                createMockNDK(),
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
                storage,
            );

            await (monitor as any).upgradeAgent(
                storedAgent,
                {
                    pubkey: signer.pubkey,
                    slug: "skill-bot",
                    definitionDTag: "skill-bot",
                    definitionAuthor: "definition-author",
                },
                createDefinitionEvent({
                    id: "new-event-id",
                    tags: [["title", "Skill Bot"]],
                })
            );

            const saved = await storage.loadAgent(signer.pubkey);
            expect(saved?.default?.skills).toBeUndefined();
            expect(saved?.default?.model).toBe("anthropic:claude-sonnet-4");
        });

        it("persists the resolved subset when some skill events fail to hydrate", async () => {
            const signer = NDKPrivateKeySigner.generate();
            const storedAgent = createStoredAgent({
                nsec: signer.nsec,
                slug: "skill-bot",
                name: "Skill Bot",
                role: "assistant",
                eventId: "old-event-id",
                definitionDTag: "skill-bot",
                definitionAuthor: "definition-author",
                definitionCreatedAt: 1_600_000_000,
                defaultConfig: {
                    model: "anthropic:claude-sonnet-4",
                },
            });
            await storage.saveAgent(storedAgent);

            const fetchSkills = mock(async () => ({
                skills: [
                    {
                        identifier: "make-posters",
                        eventId: "skill-event-1",
                        content: "poster instructions",
                        installedFiles: [],
                    },
                ],
                content: "",
            }));
            spyOn(SkillService, "getInstance").mockReturnValue({
                fetchSkills,
            } as unknown as SkillService);

            const monitor = new AgentDefinitionMonitor(
                createMockNDK(),
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
                storage,
            );

            await (monitor as any).upgradeAgent(
                storedAgent,
                {
                    pubkey: signer.pubkey,
                    slug: "skill-bot",
                    definitionDTag: "skill-bot",
                    definitionAuthor: "definition-author",
                },
                createDefinitionEvent({
                    id: "new-event-id",
                    tags: [
                        ["title", "Skill Bot"],
                        ["skill", "skill-event-1"],
                        ["skill", "skill-event-2"],
                    ],
                })
            );

            const saved = await storage.loadAgent(signer.pubkey);
            expect(saved?.default?.skills).toEqual(["make-posters"]);
        });
    });
});
