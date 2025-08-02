import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { TypingIndicatorManager } from "../TypingIndicatorManager";
import type { NostrPublisher } from "../NostrPublisher";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { logger } from "@/utils/logger";

describe("TypingIndicatorManager", () => {
    let mockPublisher: NostrPublisher & {
        publishTypingIndicatorRaw: (state: "start" | "stop", message?: string) => Promise<NDKEvent>;
    };
    let manager: TypingIndicatorManager;
    let mockEvent: NDKEvent;
    let publishTypingIndicatorRawMock: any;

    beforeEach(() => {
        mockEvent = {} as NDKEvent;
        
        publishTypingIndicatorRawMock = mock(() => Promise.resolve(mockEvent));
        
        mockPublisher = {
            context: {
                agent: {
                    name: "test-agent",
                },
            },
            publishTypingIndicatorRaw: publishTypingIndicatorRawMock,
        } as any;
        
        manager = new TypingIndicatorManager(mockPublisher);
    });

    afterEach(() => {
        manager.cleanup();
    });

    it("should publish start typing indicator immediately", async () => {
        await manager.start("Agent is thinking...");
        
        expect(publishTypingIndicatorRawMock).toHaveBeenCalledWith(
            "start",
            "Agent is thinking..."
        );
    });

    it("should delay stop typing indicator for minimum duration", async () => {
        await manager.start("Agent is thinking...");
        
        // Request stop immediately
        await manager.stop();
        
        // Stop should not be published immediately
        expect(publishTypingIndicatorRawMock).toHaveBeenCalledTimes(1);
        
        const calls = publishTypingIndicatorRawMock.mock.calls;
        const stopCalls = calls.filter((call: any) => call[0] === "stop");
        expect(stopCalls.length).toBe(0);
        
        // Wait for minimum duration (5 seconds)
        await new Promise(resolve => setTimeout(resolve, 5100));
        
        // Now stop should have been called
        const updatedCalls = publishTypingIndicatorRawMock.mock.calls;
        const updatedStopCalls = updatedCalls.filter((call: any) => call[0] === "stop");
        expect(updatedStopCalls.length).toBe(1);
    });

    it("should not flicker when multiple start/stop calls happen rapidly", async () => {
        // Rapid sequence: start -> stop -> start -> stop
        await manager.start("1");
        await manager.stop();
        await manager.start("2");
        await manager.stop();
        
        // Only two start calls should have been made
        expect(publishTypingIndicatorRawMock).toHaveBeenCalledTimes(2);
        expect(publishTypingIndicatorRawMock.mock.calls[0]).toEqual(["start", "1"]);
        expect(publishTypingIndicatorRawMock.mock.calls[1]).toEqual(["start", "2"]);
        
        // No stop call should have been made yet
        const stopCalls = publishTypingIndicatorRawMock.mock.calls
            .filter((call: any) => call[0] === "stop");
        expect(stopCalls.length).toBe(0);
        
        // After 5 seconds, stop should be called once
        await new Promise(resolve => setTimeout(resolve, 5100));
        
        const updatedStopCalls = publishTypingIndicatorRawMock.mock.calls
            .filter((call: any) => call[0] === "stop");
        expect(updatedStopCalls.length).toBe(1);
    });

    it("should update message when already typing", async () => {
        await manager.start("First message");
        await manager.start("Second message");
        
        expect(publishTypingIndicatorRawMock).toHaveBeenCalledTimes(2);
        expect(publishTypingIndicatorRawMock.mock.calls[0]).toEqual(["start", "First message"]);
        expect(publishTypingIndicatorRawMock.mock.calls[1]).toEqual(["start", "Second message"]);
    });

    it("should force stop immediately when forceStop is called", async () => {
        await manager.start("Agent is thinking...");
        await manager.forceStop();
        
        expect(publishTypingIndicatorRawMock.mock.calls).toContainEqual(["stop"]);
        expect(publishTypingIndicatorRawMock).toHaveBeenCalledTimes(2);
    });

    it("should handle multiple stop requests gracefully", async () => {
        await manager.start("Agent is thinking...");
        
        // Multiple stop requests
        await manager.stop();
        await manager.stop();
        await manager.stop();
        
        // Wait for stop to trigger
        await new Promise(resolve => setTimeout(resolve, 5100));
        
        // Should only publish stop once
        const stopCalls = publishTypingIndicatorRawMock.mock.calls
            .filter((call: any) => call[0] === "stop");
        expect(stopCalls.length).toBe(1);
    });

    it("should respect minimum duration from first typing start", async () => {
        await manager.start("1");
        
        // Wait 2 seconds
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Start typing again (updates message but doesn't reset timer)
        await manager.start("2");
        
        // Request stop
        await manager.stop();
        
        // Should stop after 3 more seconds (5 total from first start)
        await new Promise(resolve => setTimeout(resolve, 2900));
        
        let stopCalls = publishTypingIndicatorRawMock.mock.calls
            .filter((call: any) => call[0] === "stop");
        expect(stopCalls.length).toBe(0);
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
        stopCalls = publishTypingIndicatorRawMock.mock.calls
            .filter((call: any) => call[0] === "stop");
        expect(stopCalls.length).toBe(1);
    });

    it.skip("should delay stop typing indicator for minimum duration (using fake timers)", async () => {
        // Note: Bun doesn't have built-in fake timers like Vitest
        // This test is kept for reference but skipped
        // The actual timing tests above use real timeouts
    });

    describe("error handling", () => {
        let loggerErrorSpy: any;

        beforeEach(() => {
            loggerErrorSpy = spyOn(logger, "error").mockImplementation(() => {});
        });

        afterEach(() => {
            mock.restore();
        });

        it("should handle errors during stop and reset state", async () => {
            // Make publishTypingIndicatorRaw throw for stop
            publishTypingIndicatorRawMock = mock((state: string) => {
                if (state === "stop") {
                    return Promise.reject(new Error("Network error during stop"));
                }
                return Promise.resolve(mockEvent);
            });
            mockPublisher.publishTypingIndicatorRaw = publishTypingIndicatorRawMock;

            await manager.start("Test message");
            await manager.stop();

            // Wait for stop to execute
            await new Promise(resolve => setTimeout(resolve, 5100));

            // Should log error
            expect(loggerErrorSpy).toHaveBeenCalledWith(
                "Failed to stop typing indicator",
                expect.objectContaining({
                    agent: "test-agent",
                    error: "Network error during stop",
                })
            );

            // Manager should reset state despite error
            expect(manager.isCurrentlyTyping()).toBe(false);
        });

        it("should handle errors during forceStop and reset state", async () => {
            // Make publishTypingIndicatorRaw throw for stop
            publishTypingIndicatorRawMock = mock((state: string) => {
                if (state === "stop") {
                    return Promise.reject(new Error("Network error during force stop"));
                }
                return Promise.resolve(mockEvent);
            });
            mockPublisher.publishTypingIndicatorRaw = publishTypingIndicatorRawMock;

            await manager.start("Test message");
            await manager.forceStop();

            // Should log error
            expect(loggerErrorSpy).toHaveBeenCalledWith(
                "Failed to force stop typing indicator",
                expect.objectContaining({
                    agent: "test-agent",
                    error: "Network error during force stop",
                })
            );

            // Manager should reset state despite error
            expect(manager.isCurrentlyTyping()).toBe(false);
        });
    });

    describe("race conditions", () => {
        it("should handle concurrent start calls correctly", async () => {
            // Execute multiple starts concurrently
            const promises = [
                manager.start("Message 1"),
                manager.start("Message 2"),
                manager.start("Message 3"),
            ];

            await Promise.all(promises);

            // Should be typing with state consistency
            expect(manager.isCurrentlyTyping()).toBe(true);

            // All start calls should have gone through
            expect(publishTypingIndicatorRawMock).toHaveBeenCalledTimes(3);
        });

        it("should cancel stop timer when start is called during delay", async () => {
            await manager.start("First message");
            
            // Request stop
            await manager.stop();
            
            // Wait 2 seconds (less than minimum)
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Start again (should cancel the pending stop)
            await manager.start("Second message");
            
            // Wait for original stop time to pass
            await new Promise(resolve => setTimeout(resolve, 3500));
            
            // Should still be typing (stop was cancelled)
            expect(manager.isCurrentlyTyping()).toBe(true);
            
            // Stop should not have been called
            const stopCalls = publishTypingIndicatorRawMock.mock.calls
                .filter((call: any) => call[0] === "stop");
            expect(stopCalls.length).toBe(0);
        });

        it("should handle cleanup during pending stop", async () => {
            await manager.start("Test message");
            await manager.stop();
            
            // Cleanup while stop is pending
            manager.cleanup();
            
            // Wait for stop duration
            await new Promise(resolve => setTimeout(resolve, 5100));
            
            // Stop should not have been called (timer was cleared)
            const stopCalls = publishTypingIndicatorRawMock.mock.calls
                .filter((call: any) => call[0] === "stop");
            expect(stopCalls.length).toBe(0);
        });
    });

    describe("state management", () => {
        it("should return false for isCurrentlyTyping when not started", () => {
            expect(manager.isCurrentlyTyping()).toBe(false);
        });

        it("should handle stop without prior start", async () => {
            await manager.stop();
            
            // Should not call publisher
            expect(publishTypingIndicatorRawMock).not.toHaveBeenCalled();
            expect(manager.isCurrentlyTyping()).toBe(false);
        });

        it("should handle forceStop without prior start", async () => {
            await manager.forceStop();
            
            // Should not call publisher
            expect(publishTypingIndicatorRawMock).not.toHaveBeenCalled();
            expect(manager.isCurrentlyTyping()).toBe(false);
        });

        it("should maintain message state across updates", async () => {
            await manager.start("First");
            
            // Start again without message (should keep previous)
            await manager.start();
            
            // Should use the first message for the second call
            expect(publishTypingIndicatorRawMock).toHaveBeenCalledTimes(2);
            expect(publishTypingIndicatorRawMock.mock.calls[1]).toEqual(["start", "First"]);
        });
    });

    describe("timing edge cases", () => {
        it("should handle immediate stop after exactly 5 seconds", async () => {
            await manager.start("Test");
            
            // Wait exactly 5 seconds
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Stop should execute quickly now
            await manager.stop();
            
            // Small delay for execution
            await new Promise(resolve => setTimeout(resolve, 50));
            
            const stopCalls = publishTypingIndicatorRawMock.mock.calls
                .filter((call: any) => call[0] === "stop");
            expect(stopCalls.length).toBe(1);
        });

        it("should handle rapid start/stop/forceStop sequence", async () => {
            await manager.start("Test");
            await manager.stop();
            await manager.forceStop();
            
            // ForceStop should have executed immediately
            const stopCalls = publishTypingIndicatorRawMock.mock.calls
                .filter((call: any) => call[0] === "stop");
            expect(stopCalls.length).toBe(1);
            expect(manager.isCurrentlyTyping()).toBe(false);
        });
    });
});