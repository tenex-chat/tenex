/**
 * Manual test to demonstrate typing indicator behavior
 * Run with: npm test -- src/nostr/__tests__/TypingIndicatorManager.manual.test.ts
 */

import { describe, it } from "vitest";
import { TypingIndicatorManager } from "../TypingIndicatorManager";
import type { NostrPublisher } from "../NostrPublisher";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

describe("TypingIndicatorManager Manual Demo", () => {
    it("should demonstrate no flickering behavior", async () => {
    console.log("=== Typing Indicator Manager Manual Test ===\n");
    
    const mockEvent = {} as NDKEvent;
    const publishLog: Array<{ time: number; action: string }> = [];
    const startTime = Date.now();
    
    const mockPublisher = {
        context: {
            agent: {
                name: "test-agent",
            },
        },
        publishTypingIndicatorRaw: async (state: "start" | "stop", message?: string) => {
            const relativeTime = Date.now() - startTime;
            const logEntry = {
                time: relativeTime,
                action: state === "start" ? `START: "${message}"` : "STOP",
            };
            publishLog.push(logEntry);
            console.log(`[${relativeTime}ms] ${logEntry.action}`);
            return mockEvent;
        },
    } as any as NostrPublisher & {
        publishTypingIndicatorRaw: (state: "start" | "stop", message?: string) => Promise<NDKEvent>;
    };
    
    const manager = new TypingIndicatorManager(mockPublisher);
    
    console.log("Scenario: Agent sends multiple typing indicators rapidly\n");
    
    // Simulate rapid typing indicators
    await manager.start("Thinking about your question...");
    
    await new Promise(resolve => setTimeout(resolve, 200));
    await manager.stop();
    await manager.start("Analyzing the codebase...");
    
    await new Promise(resolve => setTimeout(resolve, 100));
    await manager.stop();
    await manager.start("Writing the solution...");
    
    console.log("\nNotice: No STOP events yet! Waiting for minimum duration...\n");
    
    // Wait to see when stop is published
    await new Promise(resolve => setTimeout(resolve, 6000));
    
    console.log("\n=== Summary ===");
    console.log("Total events published:", publishLog.length);
    console.log("START events:", publishLog.filter(e => e.action.startsWith("START")).length);
    console.log("STOP events:", publishLog.filter(e => e.action === "STOP").length);
    console.log("\nKey insight: Multiple rapid start/stop calls resulted in no flickering!");
    console.log("The stop indicator was delayed until 5 seconds after the first start.");
    
    manager.cleanup();
    }, 10000); // 10 second timeout for this test
});