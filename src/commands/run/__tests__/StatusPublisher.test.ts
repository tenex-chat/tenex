import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { StatusPublisher } from "../StatusPublisher";
import { STATUS_INTERVAL_MS, STATUS_KIND } from "../constants";

// Mock dependencies
const mockPublish = mock(async () => {});
const mockSign = mock(async () => {});
const mockNDKEvent = mock((ndk: any) => ({
    kind: undefined as number | undefined,
    content: "",
    tags: [] as Array<string[]>,
    tag: mock((project: any) => {}),
    sign: mockSign,
    publish: mockPublish,
}));

mock.module("@nostr-dev-kit/ndk", () => ({
    NDKEvent: mockNDKEvent,
}));

const mockGetNDK = mock(() => ({}));
mock.module("@/nostr/ndkClient", () => ({
    getNDK: mockGetNDK,
}));

const mockProjectContext = {
    project: { id: "test-project" },
    signer: { id: "test-signer" },
    agents: new Map([
        ["agent1", { pubkey: "pubkey1", name: "Agent 1" }],
        ["agent2", { pubkey: "pubkey2", name: "Agent 2" }],
    ]),
};

const mockGetProjectContext = mock(() => mockProjectContext);
const mockIsProjectContextInitialized = mock(() => true);

mock.module("@/services", () => ({
    getProjectContext: mockGetProjectContext,
    isProjectContextInitialized: mockIsProjectContextInitialized,
    configService: {
        loadConfig: mock(async () => ({
            llms: {
                configurations: {
                    "config1": { model: "gpt-4", provider: "openai" },
                    "config2": { model: "claude-3", provider: "anthropic" },
                },
                defaults: {
                    "agent1": "config1",
                    "agent2": "config2",
                },
            },
        })),
    },
}));

describe("StatusPublisher", () => {
    let publisher: StatusPublisher;
    let intervalSpy: NodeJS.Timeout | undefined;

    beforeEach(() => {
        publisher = new StatusPublisher();
        // Clear all mock calls
        mockPublish.mockClear();
        mockSign.mockClear();
        mockNDKEvent.mockClear();
    });

    afterEach(() => {
        // Clean up any intervals
        publisher.stopPublishing();
        if (intervalSpy) {
            clearInterval(intervalSpy);
        }
    });

    describe("startPublishing", () => {
        it("should publish an initial status event", async () => {
            await publisher.startPublishing("/test/project");

            // Verify NDKEvent was created and configured
            expect(mockNDKEvent).toHaveBeenCalledTimes(1);
            expect(mockSign).toHaveBeenCalledTimes(1);
            expect(mockPublish).toHaveBeenCalledTimes(1);
        });

        it("should set up interval for periodic publishing", async () => {
            await publisher.startPublishing("/test/project");

            // Initial call
            expect(mockPublish).toHaveBeenCalledTimes(1);

            // Wait for one interval
            await new Promise(resolve => setTimeout(resolve, STATUS_INTERVAL_MS + 100));

            // Should have published again
            expect(mockPublish.mock.calls.length).toBeGreaterThan(1);

            publisher.stopPublishing();
        });
    });

    describe("stopPublishing", () => {
        it("should clear the interval when called", async () => {
            await publisher.startPublishing("/test/project");
            
            // Initial call
            expect(mockPublish).toHaveBeenCalledTimes(1);

            publisher.stopPublishing();

            // Wait for what would be an interval
            await new Promise(resolve => setTimeout(resolve, STATUS_INTERVAL_MS + 100));

            // Should still only have the initial call
            expect(mockPublish).toHaveBeenCalledTimes(1);
        });

        it("should handle being called multiple times", () => {
            expect(() => {
                publisher.stopPublishing();
                publisher.stopPublishing();
            }).not.toThrow();
        });
    });

    describe("publishStatusEvent", () => {
        it("should include agent pubkeys in tags", async () => {
            await publisher.startPublishing("/test/project");

            const eventInstance = mockNDKEvent.mock.results[0].value;
            
            // Check that agent tags were added
            const agentTags = eventInstance.tags.filter((tag: string[]) => tag[0] === "agent");
            expect(agentTags).toHaveLength(2);
            expect(agentTags).toContainEqual(["agent", "pubkey1", "agent1"]);
            expect(agentTags).toContainEqual(["agent", "pubkey2", "agent2"]);
        });

        it("should include model configurations in tags", async () => {
            await publisher.startPublishing("/test/project");

            const eventInstance = mockNDKEvent.mock.results[0].value;
            
            // Check that model tags were added
            const modelTags = eventInstance.tags.filter((tag: string[]) => tag[0] === "model");
            expect(modelTags.length).toBeGreaterThan(0);
            expect(modelTags).toContainEqual(["model", "gpt-4", "config1"]);
            expect(modelTags).toContainEqual(["model", "claude-3", "config2"]);
        });

        it("should set correct event kind", async () => {
            await publisher.startPublishing("/test/project");

            const eventInstance = mockNDKEvent.mock.results[0].value;
            expect(eventInstance.kind).toBe(STATUS_KIND);
        });

        it("should handle errors gracefully", async () => {
            // Make publish throw an error
            mockPublish.mockImplementationOnce(async () => {
                throw new Error("Publishing failed");
            });

            // Should not throw
            await expect(publisher.startPublishing("/test/project")).resolves.not.toThrow();
        });
    });

    describe("error handling", () => {
        it("should continue publishing even if project context is not initialized", async () => {
            mockIsProjectContextInitialized.mockReturnValueOnce(false);

            await expect(publisher.startPublishing("/test/project")).resolves.not.toThrow();
            expect(mockPublish).toHaveBeenCalledTimes(1);
        });

        it("should handle missing LLM configuration gracefully", async () => {
            const { configService } = await import("@/services");
            configService.loadConfig = mock(async () => ({ llms: undefined }));

            await expect(publisher.startPublishing("/test/project")).resolves.not.toThrow();
            expect(mockPublish).toHaveBeenCalledTimes(1);
        });
    });
});