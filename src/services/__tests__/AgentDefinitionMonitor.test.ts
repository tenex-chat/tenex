import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { agentStorage, createStoredAgent } from "@/agents/AgentStorage";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { AgentDefinitionMonitor, type ActiveRuntimesProvider } from "../AgentDefinitionMonitor";

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
    let originalAgentsDir: string;
    let originalIndexPath: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-test-"));

        // Save and override the singleton's internal paths to use temp dir
        originalAgentsDir = (agentStorage as any).agentsDir;
        originalIndexPath = (agentStorage as any).indexPath;
        (agentStorage as any).agentsDir = tempDir;
        (agentStorage as any).indexPath = path.join(tempDir, "index.json");
        (agentStorage as any).index = null;

        await agentStorage.initialize();
    });

    afterEach(async () => {
        // Restore the singleton's original paths
        (agentStorage as any).agentsDir = originalAgentsDir;
        (agentStorage as any).indexPath = originalIndexPath;
        (agentStorage as any).index = null;

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
            delete (agent as any).definitionDTag;

            await agentStorage.saveAgent(agent);

            const ndk = createMockNDK();
            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
            );

            await monitor.start();

            const saved = await agentStorage.loadAgent(signer.pubkey);
            expect(saved).not.toBeNull();
            expect(saved!.definitionDTag).toBe("legacy-bot");
            expect(saved!.definitionAuthor).toBe("author-pubkey-abc");

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
            delete (agent as any).definitionDTag;
            delete (agent as any).definitionAuthor;

            await agentStorage.saveAgent(agent);

            const mockEvent = {
                pubkey: fakeAuthorPubkey,
                created_at: 1700000000,
            };
            const ndk = createMockNDK(mockEvent);

            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
            );

            await monitor.start();

            const saved = await agentStorage.loadAgent(signer.pubkey);
            expect(saved).not.toBeNull();
            expect(saved!.definitionDTag).toBe("orphan-bot");
            expect(saved!.definitionAuthor).toBe(fakeAuthorPubkey);
            expect(saved!.definitionCreatedAt).toBe(1700000000);

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
            delete (agent as any).definitionDTag;
            delete (agent as any).definitionAuthor;
            delete (agent as any).eventId;

            await agentStorage.saveAgent(agent);

            const ndk = createMockNDK();
            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
            );

            await monitor.start();

            const saved = await agentStorage.loadAgent(signer.pubkey);
            expect(saved).not.toBeNull();
            expect(saved!.definitionDTag).toBeUndefined();
            expect(saved!.definitionAuthor).toBeUndefined();
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
            delete (agent as any).definitionDTag;
            delete (agent as any).definitionAuthor;

            await agentStorage.saveAgent(agent);

            // fetchEvent returns null (event not found on relay)
            const ndk = createMockNDK(null);

            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
            );

            await monitor.start();

            const saved = await agentStorage.loadAgent(signer.pubkey);
            expect(saved).not.toBeNull();
            // definitionDTag should still be inferred from slug
            expect(saved!.definitionDTag).toBe("flaky-bot");
            // definitionAuthor should remain undefined since fetch returned null
            expect(saved!.definitionAuthor).toBeUndefined();

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
            delete (agent as any).definitionDTag;
            delete (agent as any).definitionAuthor;

            await agentStorage.saveAgent(agent);

            // fetchEvent throws an error (network failure, etc.)
            const ndk = createMockNDK();
            ndk.fetchEvent = mock(async () => {
                throw new Error("Network timeout");
            });

            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
            );

            await monitor.start();

            const saved = await agentStorage.loadAgent(signer.pubkey);
            expect(saved).not.toBeNull();
            // definitionDTag should still be inferred from slug despite fetchEvent throwing
            expect(saved!.definitionDTag).toBe("error-bot");
            // definitionAuthor should remain undefined since fetch threw
            expect(saved!.definitionAuthor).toBeUndefined();

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

            await agentStorage.saveAgent(agent);

            const ndk = createMockNDK();
            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
            );

            await monitor.start();

            expect(ndk.fetchEvent).not.toHaveBeenCalled();

            const saved = await agentStorage.loadAgent(signer.pubkey);
            expect(saved!.definitionDTag).toBe("complete-bot");
            expect(saved!.definitionAuthor).toBe("existing-author");
            expect(saved!.definitionCreatedAt).toBe(1600000000);

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
            delete (agent as any).definitionDTag;
            delete (agent as any).definitionAuthor;

            await agentStorage.saveAgent(agent);

            const mockEvent = {
                pubkey: fakeAuthorPubkey,
                created_at: 1700000000,
            };
            const ndk = createMockNDK(mockEvent);

            const monitor = new AgentDefinitionMonitor(
                ndk,
                { whitelistedPubkeys: [] },
                createNoopRuntimesProvider(),
            );

            await monitor.start();

            // The subscribe method should have been called since the agent was migrated
            // and now has tracking fields
            expect(ndk.subscribe).toHaveBeenCalled();

            monitor.stop();
        });
    });
});
