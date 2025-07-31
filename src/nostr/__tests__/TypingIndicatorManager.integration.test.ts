import { describe, it, expect, vi } from "vitest";
import { TypingIndicatorManager } from "../TypingIndicatorManager";
import type { NostrPublisher } from "../NostrPublisher";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("TypingIndicatorManager Integration Test", () => {
    it("should demonstrate the typing indicator behavior", async () => {
        const mockEvent = {} as NDKEvent;
        const publishCalls: Array<{ state: string; message?: string; timestamp: number }> = [];
        
        const mockPublisher = {
            context: {
                agent: {
                    name: "test-agent",
                },
            },
            publishTypingIndicatorRaw: vi.fn().mockImplementation(async (state: string, message?: string) => {
                publishCalls.push({
                    state,
                    message,
                    timestamp: Date.now(),
                });
                return mockEvent;
            }),
        } as any;
        
        const manager = new TypingIndicatorManager(mockPublisher);
        
        // Scenario: Rapid typing indicators that should not flicker
        console.log("Test scenario: Rapid messages '1' and '2' within 200ms");
        
        const startTime = Date.now();
        
        // First typing indicator
        await manager.start("1");
        console.log(`Time ${Date.now() - startTime}ms: Started typing '1'`);
        
        // Quick stop and start again (simulating rapid messages)
        await new Promise(resolve => setTimeout(resolve, 100));
        await manager.stop();
        console.log(`Time ${Date.now() - startTime}ms: Requested stop`);
        
        await new Promise(resolve => setTimeout(resolve, 100));
        await manager.start("2");
        console.log(`Time ${Date.now() - startTime}ms: Started typing '2'`);
        
        // Check current state
        console.log("\nCurrent publish calls:");
        publishCalls.forEach((call, i) => {
            console.log(`  ${i + 1}. ${call.state} - "${call.message || ''}" at ${call.timestamp - startTime}ms`);
        });
        
        // Verify no stop was published yet
        expect(publishCalls.filter(c => c.state === "stop")).toHaveLength(0);
        expect(publishCalls.filter(c => c.state === "start")).toHaveLength(2);
        
        console.log("\nWaiting for 5 seconds to see if stop is published...");
        
        // Request final stop to trigger the delayed stop
        await manager.stop();
        
        // Since we started at time 0, and last start was at ~200ms,
        // we need to wait until 5000ms from the first start
        const waitTime = 5000 - (Date.now() - startTime) + 100; // +100ms buffer
        console.log(`\nWaiting ${waitTime}ms for stop to be published...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        console.log("\nFinal publish calls:");
        publishCalls.forEach((call, i) => {
            console.log(`  ${i + 1}. ${call.state} - "${call.message || ''}" at ${call.timestamp - startTime}ms`);
        });
        
        // Clean up
        manager.cleanup();
    });
});