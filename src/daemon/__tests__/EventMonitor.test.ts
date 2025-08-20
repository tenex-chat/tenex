import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import type { NDKEvent, NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import { EventMonitor } from "../EventMonitor";
import type { IProcessManager } from "../ProcessManager";
import type { IProjectManager } from "../ProjectManager";
import * as ndkClient from "@/nostr/ndkClient";
import { logger } from "@/utils/logger";

// Mock nostr-tools at module level
mock.module("nostr-tools", () => ({
    nip19: {
        naddrEncode: () => "naddr1test123"
    }
}));

// Mock types
interface MockNDK {
    subscribe: (filter: NDKFilter, options?: Record<string, unknown>) => NDKSubscription;
}

interface MockSubscription extends NDKSubscription {
    on: (event: string, handler: (event: NDKEvent) => void) => void;
    stop: () => void;
    eventHandlers: Map<string, ((event: NDKEvent) => void)[]>;
}

// Extend EventMonitor to expose private method for testing
class TestableEventMonitor extends EventMonitor {
    public async testHandleEvent(event: NDKEvent): Promise<void> {
        // Access private method for testing
        return (this as unknown as { handleEvent: (event: NDKEvent) => Promise<void> }).handleEvent(event);
    }
}

describe("EventMonitor", () => {
    let eventMonitor: TestableEventMonitor;
    let mockProjectManager: IProjectManager;
    let mockProcessManager: IProcessManager;
    let mockNDK: MockNDK;
    let mockSubscription: MockSubscription;
    let loggerErrorSpy: ReturnType<typeof mock>;
    let loggerInfoSpy: ReturnType<typeof mock>;

    beforeEach(() => {

        // Create mock implementations
        mockProjectManager = {
            ensureProjectExists: mock(() => Promise.resolve("/test/project/path")),
            getProjectPath: mock(() => "/test/project/path"),
            updateProject: mock(() => Promise.resolve()),
        };

        mockProcessManager = {
            spawnProjectRun: mock(() => Promise.resolve()),
            isProjectRunning: mock(() => Promise.resolve(false)),
            stopProject: mock(() => Promise.resolve()),
            stopAll: mock(() => Promise.resolve()),
        };

        // Create mock subscription with event handlers
        mockSubscription = {
            on: mock((event: string, handler: (event: NDKEvent) => void) => {
                if (!mockSubscription.eventHandlers) {
                    mockSubscription.eventHandlers = new Map();
                }
                if (!mockSubscription.eventHandlers.has(event)) {
                    mockSubscription.eventHandlers.set(event, []);
                }
                mockSubscription.eventHandlers.get(event)!.push(handler);
            }),
            stop: mock(() => {}),
            eventHandlers: new Map(),
        } as MockSubscription;

        // Create mock NDK
        mockNDK = {
            subscribe: mock(() => mockSubscription),
        };

        // Mock getNDK to return our mock
        spyOn(ndkClient, "getNDK").mockReturnValue(mockNDK as any);

        // Spy on logger methods
        loggerErrorSpy = spyOn(logger, "error").mockImplementation(() => {});
        loggerInfoSpy = spyOn(logger, "info").mockImplementation(() => {});

        // Create EventMonitor instance
        eventMonitor = new TestableEventMonitor(mockProjectManager, mockProcessManager);
    });

    afterEach(() => {
        mock.restore();
    });

    describe("start", () => {
        it("should create a subscription with correct filter", async () => {
            const whitelistedPubkeys = ["pubkey1", "pubkey2"];

            await eventMonitor.start(whitelistedPubkeys);

            expect(mockNDK.subscribe).toHaveBeenCalledWith(
                {
                    authors: whitelistedPubkeys,
                    limit: 0,
                },
                {
                    closeOnEose: false,
                    groupable: false,
                }
            );
        });

        it("should register event handler", async () => {
            await eventMonitor.start(["pubkey1"]);

            expect(mockSubscription.on).toHaveBeenCalledWith("event", expect.any(Function));
        });
    });

    describe("stop", () => {
        it("should stop subscription when active", async () => {
            await eventMonitor.start(["pubkey1"]);
            await eventMonitor.stop();

            expect(mockSubscription.stop).toHaveBeenCalled();
        });

        it("should handle stop when no subscription exists", async () => {
            // Don't start, just stop
            await expect(eventMonitor.stop()).resolves.toBeUndefined();
        });
    });

    describe("handleEvent", () => {
        const createMockEvent = (tags: string[][], pubkey: string = "testpubkey"): NDKEvent => {
            return {
                id: "event123",
                kind: 1,
                tags,
                pubkey,
                content: "test content",
            } as NDKEvent;
        };

        it("should ignore events without project 'a' tag", async () => {
            const event = createMockEvent([["p", "somepubkey"]]);

            await eventMonitor.testHandleEvent(event);

            expect(mockProcessManager.isProjectRunning).not.toHaveBeenCalled();
            expect(mockProcessManager.spawnProjectRun).not.toHaveBeenCalled();
        });

        it("should process events with valid project 'a' tag", async () => {
            const event = createMockEvent([["a", "30311:pubkey123:myproject"]]);

            // Add debug spy for getNDK
            const getNDKSpy = spyOn(ndkClient, "getNDK");
            getNDKSpy.mockReturnValue(mockNDK as any);

            await eventMonitor.testHandleEvent(event);

            expect(mockProcessManager.isProjectRunning).toHaveBeenCalledWith("myproject");
            expect(mockProjectManager.ensureProjectExists).toHaveBeenCalledWith(
                "myproject",
                expect.any(String),
                expect.anything()
            );
            expect(mockProcessManager.spawnProjectRun).toHaveBeenCalledWith(
                "/test/project/path",
                "myproject"
            );
        });

        it("should skip events for already running projects", async () => {
            mockProcessManager.isProjectRunning = mock(() => Promise.resolve(true));
            const event = createMockEvent([["a", "30311:pubkey123:myproject"]]);

            await eventMonitor.testHandleEvent(event);

            expect(mockProcessManager.isProjectRunning).toHaveBeenCalledWith("myproject");
            expect(mockProjectManager.ensureProjectExists).not.toHaveBeenCalled();
            expect(mockProcessManager.spawnProjectRun).not.toHaveBeenCalled();
        });

        it("should handle invalid project tag format", async () => {
            const event = createMockEvent([["a", "invalid-format"]]);

            await eventMonitor.testHandleEvent(event);

            expect(mockProcessManager.isProjectRunning).not.toHaveBeenCalled();
        });

        it("should handle errors in project startup", async () => {
            mockProjectManager.ensureProjectExists = mock(() => 
                Promise.reject(new Error("Project creation failed"))
            );
            const event = createMockEvent([["a", "30311:pubkey123:myproject"]]);

            await eventMonitor.testHandleEvent(event);

            expect(loggerErrorSpy).toHaveBeenCalledWith(
                "Failed to start project",
                expect.objectContaining({
                    error: expect.any(Error),
                    projectIdentifier: "myproject",
                })
            );
        });

        it("should handle errors in event processing", async () => {
            mockProcessManager.isProjectRunning = mock(() => 
                Promise.reject(new Error("Check failed"))
            );
            const event = createMockEvent([["a", "30311:pubkey123:myproject"]]);

            await expect(eventMonitor.testHandleEvent(event)).rejects.toThrow("Check failed");
        });

        it("should reconstruct correct naddr from project tag", async () => {
            const pubkey = "9fb79b5e4ba38c2a0b9c2a8d5e3f6a8b";
            const event = createMockEvent([["a", `30311:${pubkey}:myproject`]], pubkey);

            await eventMonitor.testHandleEvent(event);

            // Verify ensureProjectExists was called with correct naddr format
            expect(mockProjectManager.ensureProjectExists).toHaveBeenCalledWith(
                "myproject",
                expect.stringMatching(/^naddr1/), // Should start with naddr1
                expect.anything()
            );
        });
    });

    describe("edge cases", () => {
        const createMockEvent = (tags: string[][], pubkey: string = "testpubkey"): NDKEvent => {
            return {
                id: "event123",
                kind: 1,
                tags,
                pubkey,
                content: "test content",
            } as NDKEvent;
        };

        it("should handle multiple 'a' tags (use first one)", async () => {
            const event = createMockEvent([
                ["a", "30311:pubkey123:project1"],
                ["a", "30311:pubkey456:project2"],
            ]);

            await eventMonitor.testHandleEvent(event);

            expect(mockProcessManager.isProjectRunning).toHaveBeenCalledWith("project1");
            expect(mockProcessManager.isProjectRunning).not.toHaveBeenCalledWith("project2");
        });

        it("should handle concurrent events for same project", async () => {
            const event1 = createMockEvent([["a", "30311:pubkey123:myproject"]]);
            const event2 = createMockEvent([["a", "30311:pubkey123:myproject"]]);

            // First call returns false, second returns true (simulating race condition)
            let callCount = 0;
            mockProcessManager.isProjectRunning = mock(() => {
                callCount++;
                return Promise.resolve(callCount > 1);
            });

            // Trigger both events concurrently
            await Promise.all([
                eventMonitor.testHandleEvent(event1),
                eventMonitor.testHandleEvent(event2),
            ]);

            // Should only spawn once due to the isProjectRunning check
            expect(mockProcessManager.spawnProjectRun).toHaveBeenCalledTimes(1);
        });
    });

    describe("subscription lifecycle", () => {
        it("should handle event errors without crashing", async () => {
            await eventMonitor.start(["pubkey1"]);

            // Get the event handler
            const handlers = mockSubscription.eventHandlers.get("event");
            expect(handlers).toBeDefined();
            expect(handlers!.length).toBe(1);

            // Create an event that will cause an error
            const errorEvent = {
                id: "error-event",
                kind: 1,
                tags: [["a", "30311:pubkey:project"]],
                pubkey: "pubkey",
            } as NDKEvent;

            // Mock handleEvent to throw
            mockProcessManager.isProjectRunning = mock(() => {
                throw new Error("Sync error");
            });

            // The handler should catch the error
            expect(() => handlers![0](errorEvent)).not.toThrow();

            // Wait for async error handling
            await new Promise(resolve => setTimeout(resolve, 10));

            // Error should be logged
            expect(loggerErrorSpy).toHaveBeenCalledWith(
                "Error handling event",
                expect.objectContaining({
                    error: expect.any(Error),
                    event: "error-event",
                })
            );
        });
    });
});