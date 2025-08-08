import { describe, it, expect, mock } from "bun:test";
import { TypingIndicatorManager } from "../TypingIndicatorManager";
import type { NostrPublisher } from "../NostrPublisher";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("TypingIndicatorManager Integration Test", () => {
    it("should demonstrate the typing indicator behavior", async () => {
        const mockEvent = {} as NDKEvent;
        const publishCalls: Array<{ state: string; message?: string; timestamp: number }> = [];
        
        const publishTypingIndicatorRawMock = mock(async (state: string, message?: string) => {
            publishCalls.push({
                state,
                message,
                timestamp: Date.now(),
            });
            return mockEvent;
        });
        
        const mockPublisher = {
            context: {
                agent: {
                    name: "test-agent",
                },
            },
            publishTypingIndicatorRaw: publishTypingIndicatorRawMock,
        } as any;
        
        const manager = new TypingIndicatorManager(mockPublisher);
        
        // Scenario: Rapid typing indicators that should not flicker
        const startTime = Date.now();
        
        // First typing indicator
        await manager.start("1");
        
        // Quick stop and start again (simulating rapid messages)
        await new Promise(resolve => setTimeout(resolve, 100));
        await manager.stop();
        
        await new Promise(resolve => setTimeout(resolve, 100));
        await manager.start("2");
        
        // Verify no stop was published yet (due to debouncing)
        expect(publishCalls.filter(c => c.state === "stop")).toHaveLength(0);
        expect(publishCalls.filter(c => c.state === "start")).toHaveLength(2);
        
        // Request final stop to trigger the delayed stop
        await manager.stop();
        
        // Since we started at time 0, and last start was at ~200ms,
        // we need to wait until 5000ms from the first start
        const waitTime = 5000 - (Date.now() - startTime) + 100; // +100ms buffer
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Verify the stop was eventually published
        const stopCalls = publishCalls.filter(c => c.state === "stop");
        expect(stopCalls.length).toBeGreaterThan(0);
        
        // Clean up
        manager.cleanup();
    });
});