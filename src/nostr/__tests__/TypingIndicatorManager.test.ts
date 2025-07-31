import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TypingIndicatorManager } from "../TypingIndicatorManager";
import type { NostrPublisher } from "../NostrPublisher";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("TypingIndicatorManager", () => {
    let mockPublisher: NostrPublisher & {
        publishTypingIndicatorRaw: (state: "start" | "stop", message?: string) => Promise<NDKEvent>;
    };
    let manager: TypingIndicatorManager;
    let mockEvent: NDKEvent;

    beforeEach(() => {
        vi.useFakeTimers();
        
        mockEvent = {} as NDKEvent;
        
        mockPublisher = {
            context: {
                agent: {
                    name: "test-agent",
                },
            },
            publishTypingIndicatorRaw: vi.fn().mockResolvedValue(mockEvent),
        } as any;
        
        manager = new TypingIndicatorManager(mockPublisher);
    });

    afterEach(() => {
        vi.useRealTimers();
        manager.cleanup();
    });

    it("should publish start typing indicator immediately", async () => {
        await manager.start("Agent is thinking...");
        
        expect(mockPublisher.publishTypingIndicatorRaw).toHaveBeenCalledWith(
            "start",
            "Agent is thinking..."
        );
    });

    it("should delay stop typing indicator for minimum duration", async () => {
        await manager.start("Agent is thinking...");
        
        // Request stop immediately
        await manager.stop();
        
        // Stop should not be published immediately
        expect(mockPublisher.publishTypingIndicatorRaw).toHaveBeenCalledTimes(1);
        expect(mockPublisher.publishTypingIndicatorRaw).not.toHaveBeenCalledWith("stop");
        
        // Advance time less than minimum duration
        vi.advanceTimersByTime(3000); // 3 seconds
        expect(mockPublisher.publishTypingIndicatorRaw).not.toHaveBeenCalledWith("stop");
        
        // Advance time to reach minimum duration
        vi.advanceTimersByTime(2000); // Total 5 seconds
        await vi.runOnlyPendingTimersAsync();
        
        expect(mockPublisher.publishTypingIndicatorRaw).toHaveBeenCalledWith("stop");
    });

    it("should not flicker when multiple start/stop calls happen rapidly", async () => {
        // Rapid sequence: start -> stop -> start -> stop
        await manager.start("1");
        await manager.stop();
        await manager.start("2");
        await manager.stop();
        
        // Only two start calls should have been made
        expect(mockPublisher.publishTypingIndicatorRaw).toHaveBeenCalledTimes(2);
        expect(mockPublisher.publishTypingIndicatorRaw).toHaveBeenNthCalledWith(1, "start", "1");
        expect(mockPublisher.publishTypingIndicatorRaw).toHaveBeenNthCalledWith(2, "start", "2");
        
        // No stop call should have been made yet
        expect(mockPublisher.publishTypingIndicatorRaw).not.toHaveBeenCalledWith("stop");
        
        // After 5 seconds, stop should be called once
        vi.advanceTimersByTime(5000);
        await vi.runOnlyPendingTimersAsync();
        
        const stopCalls = (mockPublisher.publishTypingIndicatorRaw as any).mock.calls
            .filter((call: any) => call[0] === "stop");
        expect(stopCalls).toHaveLength(1);
    });

    it("should update message when already typing", async () => {
        await manager.start("First message");
        await manager.start("Second message");
        
        expect(mockPublisher.publishTypingIndicatorRaw).toHaveBeenCalledTimes(2);
        expect(mockPublisher.publishTypingIndicatorRaw).toHaveBeenNthCalledWith(1, "start", "First message");
        expect(mockPublisher.publishTypingIndicatorRaw).toHaveBeenNthCalledWith(2, "start", "Second message");
    });

    it("should force stop immediately when forceStop is called", async () => {
        await manager.start("Agent is thinking...");
        await manager.forceStop();
        
        expect(mockPublisher.publishTypingIndicatorRaw).toHaveBeenCalledWith("stop");
        expect(mockPublisher.publishTypingIndicatorRaw).toHaveBeenCalledTimes(2);
    });

    it("should handle multiple stop requests gracefully", async () => {
        await manager.start("Agent is thinking...");
        
        // Multiple stop requests
        await manager.stop();
        await manager.stop();
        await manager.stop();
        
        // Advance time to trigger stop
        vi.advanceTimersByTime(5000);
        await vi.runOnlyPendingTimersAsync();
        
        // Should only publish stop once
        const stopCalls = (mockPublisher.publishTypingIndicatorRaw as any).mock.calls
            .filter((call: any) => call[0] === "stop");
        expect(stopCalls).toHaveLength(1);
    });

    it("should respect minimum duration from first typing start", async () => {
        await manager.start("1");
        
        // Wait 2 seconds
        vi.advanceTimersByTime(2000);
        
        // Start typing again (updates message but doesn't reset timer)
        await manager.start("2");
        
        // Request stop
        await manager.stop();
        
        // Should stop after 3 more seconds (5 total from first start)
        vi.advanceTimersByTime(2999);
        expect(mockPublisher.publishTypingIndicatorRaw).not.toHaveBeenCalledWith("stop");
        
        vi.advanceTimersByTime(1);
        await vi.runOnlyPendingTimersAsync();
        expect(mockPublisher.publishTypingIndicatorRaw).toHaveBeenCalledWith("stop");
    });
});