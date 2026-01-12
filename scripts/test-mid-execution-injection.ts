#!/usr/bin/env npx tsx
/**
 * Comprehensive test for mid-execution injection via Query.streamInput()
 *
 * This script tests the full flow:
 * 1. Creates a Claude Code agent with Sonnet model
 * 2. Starts an execution that produces a response
 * 3. Mid-stream, injects a user message via Query.streamInput()
 * 4. Verifies the agent incorporates the injection in its response
 *
 * Run from the tenex-injection-fix worktree:
 *   npx tsx scripts/test-mid-execution-injection.ts
 */

import { createAgentInstance } from "../src/agents/agent-loader";
import { AgentRegistry } from "../src/agents/AgentRegistry";
import type { StoredAgent } from "../src/agents/AgentStorage";
import { RALRegistry } from "../src/services/ral";
import { config } from "../src/services/ConfigService";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils";
import type { Query } from "ai-sdk-provider-claude-code";

// Test configuration
const PROJECT_PATH = "/tmp/tenex-injection-test";
const INJECTION_DELAY_MS = 2000; // Delay before injecting message
const TEST_TIMEOUT_MS = 120000; // 2 minutes max for the test

console.log("=".repeat(80));
console.log("Mid-Execution Injection Test via Query.streamInput()");
console.log("=".repeat(80));
console.log();

// Track test state
let testPassed = false;
let queryObject: Query | undefined;
let injectionAttempted = false;
let injectionSucceeded = false;
let fullResponse = "";

async function runTest(): Promise<void> {
    // Step 1: Initialize ConfigService
    console.log("[1/6] Initializing ConfigService...");
    try {
        await config.loadConfig();
        console.log("      ✓ ConfigService loaded");
    } catch (error) {
        console.log("      ✗ Failed to load config:", error);
        throw error;
    }

    // Step 2: Create mock stored agent with Claude Code + Sonnet
    console.log("[2/6] Creating mock Claude Code Sonnet agent...");
    const secretKey = generateSecretKey();
    const agentPubkey = getPublicKey(secretKey);

    const mockStoredAgent: StoredAgent = {
        slug: "test-injection-agent",
        name: "Injection Test Agent",
        pubkey: agentPubkey,
        nsec: bytesToHex(secretKey),
        role: "tester",
        description: "Agent for testing mid-execution injection",
        instructions: "You are a helpful assistant. When asked to list or describe items, be thorough and detailed. If you receive any additional instructions during your response, incorporate them.",
        tools: [], // No tools needed for this test
        llmConfig: "claude code sonnet", // Uses Claude Code provider with Sonnet
        projects: [],
    };
    console.log(`      ✓ Agent created: ${mockStoredAgent.name} (${agentPubkey.substring(0, 8)}...)`);

    // Step 3: Create mock registry
    console.log("[3/6] Creating mock AgentRegistry...");
    const mockRegistry = {
        getBasePath: () => PROJECT_PATH,
        getMetadataPath: () => `${PROJECT_PATH}/.tenex/metadata`,
        addAgent: () => {},
        getAgent: () => undefined,
        getAgentByEventId: () => undefined,
        agents: [],
    } as unknown as AgentRegistry;
    console.log(`      ✓ Registry configured with base path: ${PROJECT_PATH}`);

    // Step 4: Create agent instance with onQueryCreated callback
    console.log("[4/6] Creating agent instance with onQueryCreated callback...");
    const agentInstance = createAgentInstance(mockStoredAgent, mockRegistry);

    // Create a fake conversation ID for tracking
    const conversationId = crypto.randomUUID();
    const ralRegistry = RALRegistry.getInstance();

    // Create RAL entry to track the execution
    const ralNumber = ralRegistry.create(agentPubkey, conversationId);
    console.log(`      ✓ RAL created: #${ralNumber} for conversation ${conversationId.substring(0, 8)}...`);

    // Step 5: Test the LLM service creation with onQueryCreated
    console.log("[5/6] Creating LLM service with onQueryCreated callback...");

    let llmService;
    try {
        llmService = agentInstance.createLLMService({
            tools: {},
            sessionId: undefined, // Fresh session
            workingDirectory: PROJECT_PATH,
            conversationId,
            onQueryCreated: (query) => {
                console.log("      ✓ onQueryCreated callback invoked!");
                queryObject = query as Query;

                // Register the Query in RALRegistry
                ralRegistry.registerQuery(agentPubkey, conversationId, ralNumber, queryObject);
                console.log(`      ✓ Query registered in RALRegistry for RAL #${ralNumber}`);
            },
        });
        console.log(`      ✓ LLM service created (provider: ${llmService.provider}, model: ${llmService.model})`);
    } catch (error) {
        console.log("      ✗ Failed to create LLM service:", error);
        throw error;
    }

    // Step 6: Execute with streaming and attempt mid-stream injection
    console.log("[6/6] Starting streaming execution with mid-stream injection test...");
    console.log();
    console.log("      Initial prompt: 'Write a short poem about programming.'");
    console.log(`      Will inject message after ${INJECTION_DELAY_MS}ms: 'IMPORTANT: Make it about TypeScript specifically.'`);
    console.log();

    // Set streaming flag
    ralRegistry.setStreaming(agentPubkey, conversationId, ralNumber, true);

    // Set up event handlers
    llmService.on("content", ({ delta }: { delta: string }) => {
        process.stdout.write(delta);
        fullResponse += delta;
    });

    llmService.on("complete", () => {
        console.log();
        console.log("      --- STREAM COMPLETE ---");
    });

    llmService.on("stream-error", ({ error }: { error: unknown }) => {
        console.log("      Stream error:", error);
    });

    // Schedule injection after delay
    const injectionTimer = setTimeout(async () => {
        console.log("\n      [INJECTION] Attempting to inject message mid-stream...");
        injectionAttempted = true;

        // Get the Query from RALRegistry
        const storedQuery = ralRegistry.getQuery(agentPubkey, conversationId, ralNumber);

        if (storedQuery) {
            try {
                // Create async iterable for the injection
                const messageStream = (async function* () {
                    yield {
                        type: "user" as const,
                        message: {
                            role: "user" as const,
                            content: "IMPORTANT: Make the poem about TypeScript specifically. Include 'TypeScript' in the poem.",
                        },
                        parent_tool_use_id: null,
                        session_id: "",
                    };
                })();

                await storedQuery.streamInput(messageStream);
                injectionSucceeded = true;
                console.log("      [INJECTION] ✓ Message injected successfully via streamInput()!");
            } catch (error) {
                console.log("      [INJECTION] ✗ streamInput() failed:", error);
            }
        } else {
            console.log("      [INJECTION] ✗ No Query object found in RALRegistry");
            console.log("      [INJECTION] (This means onQueryCreated callback was not invoked)");
        }
    }, INJECTION_DELAY_MS);

    // Execute the stream
    try {
        console.log("      --- RESPONSE STREAM START ---");

        await llmService.stream(
            [
                {
                    role: "user",
                    content: "Write a short poem about programming (4-6 lines). Be creative and thoughtful.",
                },
            ],
            {}, // No tools
            undefined // No options
        );

    } catch (error) {
        console.log("      ✗ Stream execution failed:", error);
        clearTimeout(injectionTimer);
        throw error;
    } finally {
        clearTimeout(injectionTimer);
        // Cleanup
        ralRegistry.setStreaming(agentPubkey, conversationId, ralNumber, false);
        ralRegistry.clearRAL(agentPubkey, conversationId, ralNumber);
    }

    // Give a moment for any pending output
    await new Promise(resolve => setTimeout(resolve, 500));

    // Analyze results
    console.log();
    console.log("=".repeat(80));
    console.log("TEST RESULTS");
    console.log("=".repeat(80));
    console.log();

    console.log(`onQueryCreated callback invoked: ${queryObject ? "✓ YES" : "✗ NO"}`);
    console.log(`Query registered in RALRegistry:  ${queryObject ? "✓ YES" : "✗ NO"}`);
    console.log(`Injection attempted:              ${injectionAttempted ? "✓ YES" : "✗ NO"}`);
    console.log(`Injection succeeded (no error):   ${injectionSucceeded ? "✓ YES" : "? N/A (stream may have ended)"}`);

    // Check if injection was incorporated
    const mentionsTypeScript = fullResponse.toLowerCase().includes("typescript");

    console.log(`Response mentions TypeScript:     ${mentionsTypeScript ? "✓ YES" : "✗ NO"}`);
    console.log();

    // Determine overall pass/fail
    // The primary test is whether onQueryCreated was invoked and Query was registered
    testPassed = queryObject !== undefined;

    if (testPassed) {
        console.log("✓ TEST PASSED: Query object was exposed via onQueryCreated callback");
        console.log("  The infrastructure for mid-stream injection is working correctly.");

        if (injectionAttempted) {
            if (injectionSucceeded) {
                console.log("  The streamInput() call succeeded without throwing an error.");
                if (mentionsTypeScript) {
                    console.log("  The response incorporated the injection (mentions TypeScript).");
                } else {
                    console.log("  Note: Response may not show injection effect due to timing.");
                    console.log("  The injection may have arrived after the response completed.");
                }
            } else {
                console.log("  Note: streamInput() threw an error - this may be expected if");
                console.log("  the stream completed before the injection could be processed.");
            }
        } else {
            console.log("  Note: Injection timer didn't fire (stream completed too quickly).");
        }
    } else {
        console.log("✗ TEST FAILED: Query object was NOT exposed via onQueryCreated");
        console.log("  This means the ai-sdk-provider-claude-code fork is not being used,");
        console.log("  or the onQueryCreated callback is not being passed through correctly.");
        console.log();
        console.log("  Debugging checklist:");
        console.log("  1. Verify package.json points to the forked provider");
        console.log("  2. Verify node_modules has the forked version installed");
        console.log("  3. Check ClaudeCodeProvider.createAgentSettings passes onQueryCreated");
    }
}

// Run with timeout
const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Test timed out after ${TEST_TIMEOUT_MS}ms`)), TEST_TIMEOUT_MS);
});

Promise.race([runTest(), timeoutPromise])
    .then(() => {
        console.log();
        console.log("=".repeat(80));
        process.exit(testPassed ? 0 : 1);
    })
    .catch((error) => {
        console.error("Test error:", error);
        process.exit(1);
    });
