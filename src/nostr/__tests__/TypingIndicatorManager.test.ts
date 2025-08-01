import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { TypingIndicatorManager } from "../TypingIndicatorManager";
import type { NostrPublisher } from "../NostrPublisher";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

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
});