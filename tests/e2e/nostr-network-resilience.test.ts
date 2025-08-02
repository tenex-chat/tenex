import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import path from "node:path";
import {
    setupE2ETest,
    cleanupE2ETest,
    createConversation,
    executeAgent,
    getConversationState,
    type E2ETestContext
} from "./test-harness";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// Track network calls for verification
const networkCalls = {
    publish: [] as Array<{ event: any; success: boolean; error?: Error }>,
    connect: [] as Array<{ relay: string; success: boolean }>,
    sign: [] as Array<{ event: any }>
};

// Mock state for controlling network behavior
let failureMode: "none" | "publish" | "intermittent" | "timeout" = "none";
let failureCount = 0;
const MAX_FAILURES = 2; // For intermittent failures

// Mock NDKEvent to simulate network conditions
const mockPublish = mock(async function(this: any) {
    const shouldFail = 
        failureMode === "publish" ||
        (failureMode === "intermittent" && failureCount < MAX_FAILURES) ||
        failureMode === "timeout";
    
    if (shouldFail) {
        failureCount++;
        const error = failureMode === "timeout" 
            ? new Error("Network timeout: Failed to publish event")
            : new Error("Network error: Unable to reach relay");
            
        networkCalls.publish.push({ 
            event: this, 
            success: false, 
            error 
        });
        
        // Simulate timeout delay
        if (failureMode === "timeout") {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        throw error;
    }
    
    // Successful publish
    networkCalls.publish.push({ event: this, success: true });
    
    // Simulate network delay for realistic behavior
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Set a fake ID to simulate successful publish
    this.id = `test-event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
});

const mockSign = mock(async function(this: any, signer?: any) {
    networkCalls.sign.push({ event: this });
    // Set basic event properties
    this.sig = "mock-signature";
    this.pubkey = signer?.pubkey || "mock-pubkey";
});

// Mock NDK module
mock.module("@nostr-dev-kit/ndk", () => {
    return {
        NDKEvent: class MockNDKEvent {
            id?: string;
            sig?: string;
            pubkey?: string;
            content?: string;
            tags?: string[][];
            created_at?: number;
            kind?: number;
            
            constructor(ndk?: any, event?: any) {
                if (event) {
                    Object.assign(this, event);
                }
                this.created_at = Math.floor(Date.now() / 1000);
            }
            
            tag(tag: string[]): void {
                if (!this.tags) this.tags = [];
                this.tags.push(tag);
            }
            
            sign = mockSign;
            publish = mockPublish;
        },
        NDK: class MockNDK {
            explicitRelayUrls?: string[];
            
            constructor(options?: any) {
                this.explicitRelayUrls = options?.explicitRelayUrls;
            }
            
            async connect(): Promise<void> {
                networkCalls.connect.push({ 
                    relay: this.explicitRelayUrls?.[0] || "default",
                    success: true 
                });
                // Simulate connection delay
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    };
});

// Helper functions to control failure modes
const setFailureMode = (mode: typeof failureMode) => {
    failureMode = mode;
    failureCount = 0;
};

const resetFailureMode = () => {
    failureMode = "none";
    failureCount = 0;
};

const clearNetworkCalls = () => {
    networkCalls.publish = [];
    networkCalls.connect = [];
    networkCalls.sign = [];
};

describe("E2E: Nostr Network Resilience", () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        // Reset test state
        clearNetworkCalls();
        resetFailureMode();
        
        logger.info("Setting up E2E test environment for network resilience");
        context = await setupE2ETest(['network-resilience']);
    });
    
    afterEach(async () => {
        logger.info("Cleaning up E2E test environment");
        resetFailureMode();
        await cleanupE2ETest(context);
    });

    it("should handle complete network failure during agent response publishing", async () => {
        logger.info("Testing complete network failure scenario");
        
        // Create conversation
        const conversation = await createConversation(
            context,
            "Network Test",
            "Help me create a simple authentication system"
        );
        
        // Set network to fail all publish attempts
        setFailureMode("publish");
        
        // Execute agent - should handle network failures gracefully
        await executeAgent(
            context,
            "Orchestrator",
            conversation,
            "Help me create a simple authentication system"
        );
        
        // Verify conversation state was still updated despite network failures
        const state = await getConversationState(context, conversation);
        expect(state.phase).toBe("plan");
        expect(state.messages.length).toBeGreaterThan(1);
        
        // Verify network failures were attempted
        expect(networkCalls.publish.some(c => !c.success)).toBe(true);
        expect(networkCalls.publish.filter(c => !c.success).length).toBeGreaterThan(0);
        
        // Verify agent response was saved locally even though publish failed
        const lastMessage = state.messages[state.messages.length - 1];
        expect(lastMessage.role).toBe("assistant");
        expect(lastMessage.content).toContain("authentication");
    }, 30000);

    it("should recover from intermittent network failures", async () => {
        logger.info("Testing intermittent network failure recovery");
        
        const conversation = await createConversation(
            context,
            "Intermittent Test",
            "Create a payment processing system"
        );
        
        // Set network to fail intermittently (first 2 attempts fail, then succeed)
        setFailureMode("intermittent");
        
        // Execute multiple agent interactions
        await executeAgent(
            context,
            "Orchestrator",
            conversation,
            "Create a payment processing system"
        );
        
        // Continue to planning phase
        let state = await getConversationState(context, conversation);
        if (state.phase === "plan") {
            await executeAgent(context, "Planner", conversation);
        }
        
        // Verify recovery from failures
        const failures = networkCalls.publish.filter(c => !c.success);
        const successes = networkCalls.publish.filter(c => c.success);
        
        expect(failures.length).toBe(2); // First 2 attempts failed
        expect(successes.length).toBeGreaterThan(0); // Subsequent attempts succeeded
        
        // Verify conversation progressed despite intermittent failures
        state = await getConversationState(context, conversation);
        expect(state.phase).toBe("implementation");
        expect(state.phaseTransitions.length).toBeGreaterThan(0);
    }, 30000);

    it("should handle network timeouts gracefully", async () => {
        logger.info("Testing network timeout handling");
        
        const conversation = await createConversation(
            context,
            "Timeout Test",
            "Build a notification system"
        );
        
        // Set network to timeout
        setFailureMode("timeout");
        
        // Execute agent with timeout scenario
        const startTime = Date.now();
        await executeAgent(
            context,
            "Orchestrator",
            conversation,
            "Build a notification system"
        );
        const duration = Date.now() - startTime;
        
        // Should not hang indefinitely despite timeouts
        expect(duration).toBeLessThan(10000); // Should complete within 10 seconds
        
        // Verify timeout errors were encountered
        const timeoutErrors = networkCalls.publish.filter(c => 
            !c.success && c.error?.message.includes("timeout")
        );
        expect(timeoutErrors.length).toBeGreaterThan(0);
        
        // Verify conversation state is still consistent
        const state = await getConversationState(context, conversation);
        expect(state.messages.length).toBeGreaterThan(0);
        expect(state.phase).toBeDefined();
    }, 30000);

    it("should maintain message ordering during network failures", async () => {
        logger.info("Testing message ordering integrity");
        
        const conversation = await createConversation(
            context,
            "Ordering Test",
            "Create a user management system"
        );
        
        // Clear network state
        clearNetworkCalls();
        resetFailureMode();
        
        // Execute initial interaction successfully
        await executeAgent(
            context,
            "Orchestrator",
            conversation,
            "Create a user management system"
        );
        
        const initialState = await getConversationState(context, conversation);
        const initialMessageCount = initialState.messages.length;
        
        // Now set network to fail
        setFailureMode("publish");
        
        // Continue execution with network failures
        await executeAgent(context, initialState.currentAgent || "Planner", conversation);
        
        // Reset network to working
        resetFailureMode();
        
        // Continue execution
        const currentState = await getConversationState(context, conversation);
        await executeAgent(context, currentState.currentAgent || "Executor", conversation);
        
        // Verify message ordering is maintained
        const finalState = await getConversationState(context, conversation);
        expect(finalState.messages.length).toBeGreaterThan(initialMessageCount);
        
        // Messages should be in chronological order
        for (let i = 1; i < finalState.messages.length; i++) {
            const prevTimestamp = new Date(finalState.messages[i - 1].timestamp).getTime();
            const currTimestamp = new Date(finalState.messages[i].timestamp).getTime();
            expect(currTimestamp).toBeGreaterThanOrEqual(prevTimestamp);
        }
        
        // Verify no duplicate messages
        const messageContents = finalState.messages.map(m => m.content);
        const uniqueContents = new Set(messageContents);
        expect(messageContents.length).toBe(uniqueContents.size);
    }, 45000);

    it("should handle typing indicator failures without affecting main flow", async () => {
        logger.info("Testing typing indicator resilience");
        
        const conversation = await createConversation(
            context,
            "Typing Indicator Test",
            "Build a real-time chat application"
        );
        
        // Track typing indicator events specifically
        clearNetworkCalls();
        
        // Execute with normal network
        await executeAgent(
            context,
            "Orchestrator",
            conversation,
            "Build a real-time chat application"
        );
        
        // Check for typing indicator events
        const typingEvents = networkCalls.sign.filter(c => 
            c.event?.tags?.some((tag: string[]) => 
                tag[0] === "state" && (tag[1] === "start" || tag[1] === "stop")
            )
        );
        
        expect(typingEvents.length).toBeGreaterThan(0);
        
        // Now test with failing typing indicators
        setFailureMode("intermittent");
        
        const state = await getConversationState(context, conversation);
        await executeAgent(context, state.currentAgent || "Planner", conversation);
        
        // Main flow should continue despite typing indicator failures
        const finalState = await getConversationState(context, conversation);
        expect(finalState.phase).toBe("implementation");
        expect(finalState.messages.length).toBeGreaterThan(state.messages.length);
    }, 30000);

    it("should handle concurrent publishing during network instability", async () => {
        logger.info("Testing concurrent publishing with network issues");
        
        // Create multiple conversations
        const conversations = await Promise.all([
            createConversation(context, "Concurrent Test 1", "Build feature A"),
            createConversation(context, "Concurrent Test 2", "Build feature B")
        ]);
        
        // Set intermittent failures
        setFailureMode("intermittent");
        
        // Execute agents concurrently
        const executions = conversations.map(conv =>
            executeAgent(context, "Orchestrator", conv, `Build feature for ${conv}`)
        );
        
        await Promise.all(executions);
        
        // Verify both conversations progressed despite network issues
        const states = await Promise.all(
            conversations.map(conv => getConversationState(context, conv))
        );
        
        states.forEach(state => {
            expect(state.messages.length).toBeGreaterThan(1);
            expect(state.phase).toBe("plan");
        });
        
        // Verify network calls show recovery pattern
        const publishAttempts = networkCalls.publish.length;
        const failures = networkCalls.publish.filter(c => !c.success).length;
        const successes = networkCalls.publish.filter(c => c.success).length;
        
        expect(publishAttempts).toBeGreaterThan(failures);
        expect(successes).toBeGreaterThan(0);
        
        // Verify no cross-contamination between conversations
        states.forEach((state, idx) => {
            const otherIdx = idx === 0 ? 1 : 0;
            state.messages.forEach(msg => {
                expect(msg.content).not.toContain(`feature ${conversations[otherIdx]}`);
            });
        });
    }, 45000);
});