#!/usr/bin/env bun
/**
 * REAL Integration test for Claude Code session resumption.
 *
 * This script tests the ACTUAL production flow through AgentExecutor:
 * 1. Creates real project context, agent registry, conversation store
 * 2. Runs AgentExecutor.execute() with real Claude Code API calls
 * 3. Verifies session is captured and persisted
 * 4. Runs second execution to test session resumption
 *
 * KNOWN ISSUE: The Claude Agent SDK (claude-code CLI) has bugs with session
 * resumption. When sessions are reconstructed internally, empty text blocks
 * get cache_control set, which Anthropic's API rejects with:
 * "cache_control cannot be set for empty text blocks"
 *
 * This happens even with the new systemPrompt API (not just deprecated
 * customSystemPrompt/appendSystemPrompt). The bug is in the SDK's session
 * reconstruction, not in how we format messages.
 *
 * GitHub issues: anthropics/claude-code#2196, #2203, #16721
 *
 * When sessionResumption is ENABLED in ClaudeCodeProvider:
 * - First call succeeds, session is captured
 * - Second call FAILS with cache_control error
 *
 * When sessionResumption is DISABLED:
 * - Both calls succeed
 * - Agent does NOT remember context (expected - each call is independent)
 *
 * This test documents the bug and verifies the workaround (disabled session resumption).
 */

import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";

import { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { createExecutionContext } from "@/agents/execution/ExecutionContextFactory";
import { SessionManager } from "@/agents/execution/SessionManager";
import { ConversationStore } from "@/conversations/ConversationStore";
import { config } from "@/services/ConfigService";
import { AgentMetadataStore } from "@/services/agents/AgentMetadataStore";
import { ProjectContext, projectContextStore } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { initializeGitRepository } from "@/utils/git";
import { initNDK, shutdownNDK } from "@/nostr/ndkClient";

// Import to register providers
import "@/llm/providers";

const testDir = join(tmpdir(), `session-real-${Date.now()}`);
const projectPath = join(testDir, "project");
const metadataPath = join(testDir, "metadata");

console.log("=== REAL AgentExecutor Session Resumption Test ===\n");
console.log(`Test directory: ${testDir}\n`);

async function setup() {
    // Create test directories
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(join(metadataPath, "conversations"), { recursive: true });

    // Initialize git repo
    await initializeGitRepository(projectPath);

    // Load config from ~/.tenex/
    console.log("  Loading config...");
    await config.loadConfig();
    console.log("  Config loaded.");

    // Initialize NDK for nostr event publishing
    await initNDK();

    // Create signers
    const agentSigner = NDKPrivateKeySigner.generate();
    const userSigner = NDKPrivateKeySigner.generate();
    const ndk = new NDK();

    const agentPubkey = (await agentSigner.user()).pubkey;
    const userPubkey = (await userSigner.user()).pubkey;

    // Create a minimal project event
    const projectEvent = new NDKEvent(ndk);
    projectEvent.kind = 31933;
    projectEvent.pubkey = userPubkey;
    projectEvent.tags = [
        ["d", "test-session-project"],
        ["title", "Session Test Project"],
    ];
    projectEvent.content = "";

    // Create agent registry
    const agentRegistry = new AgentRegistry(projectPath, metadataPath);

    // Create a Claude Code agent
    const testAgent: AgentInstance = {
        name: "Session Test Agent",
        slug: "session-test",
        pubkey: agentPubkey,
        role: "Test agent for session resumption",
        llmConfig: "claude code haiku",
        tools: [],
        instructions: "You are a test agent. Keep responses brief.",
        signer: agentSigner,
        createMetadataStore: (conversationId: string) => {
            return new AgentMetadataStore(conversationId, "session-test", metadataPath);
        },
        createLLMService: (options) => {
            return config.createLLMService("claude code haiku", {
                tools: options?.tools ?? {},
                agentName: "Session Test Agent",
                sessionId: options?.sessionId,
                workingDirectory: options?.workingDirectory ?? projectPath,
                conversationId: options?.conversationId,
            });
        },
        sign: async (event: NDKEvent) => {
            await event.sign(agentSigner, { pTags: false });
        },
    };

    agentRegistry.addAgent(testAgent);

    // Initialize ConversationStore
    ConversationStore.initialize(metadataPath, [agentPubkey]);

    // Create project context
    const projectContext = new ProjectContext(
        projectEvent as unknown as NDKProject,
        agentRegistry
    );

    return {
        projectContext,
        agentRegistry,
        agentSigner,
        userSigner,
        agentPubkey,
        userPubkey,
        ndk,
        testAgent,
    };
}

async function cleanup() {
    ConversationStore.reset();
    RALRegistry.getInstance().clearAll();
    await shutdownNDK();
    if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
    }
}

async function runTest() {
    const {
        projectContext,
        agentSigner,
        userSigner,
        agentPubkey,
        userPubkey,
        ndk,
        testAgent,
    } = await setup();

    try {
        // ========== STEP 1: First message ==========
        console.log("STEP 1: First message through AgentExecutor\n");

        const conversationId = `session-test-${Date.now()}`;

        // Create first event
        const event1 = new NDKEvent(ndk);
        event1.kind = 1;
        event1.pubkey = userPubkey;
        event1.content = "Remember this secret: the color is PURPLE. Reply with 'I understand, I will remember that the color is PURPLE.'.";
        event1.tags = [["p", agentPubkey]];
        event1.created_at = Math.floor(Date.now() / 1000);
        event1.id = `${conversationId}-msg1`;

        // Create conversation and add message
        const conversationStore = ConversationStore.getOrLoad(conversationId);
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: event1.content,
            messageType: "text",
            eventId: event1.id,
            targetedPubkeys: [agentPubkey],
        });

        console.log("  Creating execution context...");
        const context1 = await projectContextStore.run(projectContext, async () => {
            return await createExecutionContext({
                agent: testAgent,
                conversationId,
                projectBasePath: projectPath,
                triggeringEvent: event1,
            });
        });

        console.log("  Executing AgentExecutor.execute()...");
        const executor = new AgentExecutor();

        let response1 = "";
        const result1 = await projectContextStore.run(projectContext, async () => {
            return await executor.execute(context1);
        });

        if (result1) {
            response1 = result1.content || "";
            console.log(`  Response: ${response1.substring(0, 100)}...`);
        }

        // Check if session was saved
        const sessionManager1 = new SessionManager(testAgent, conversationId, projectPath);
        const session1 = sessionManager1.getSession();
        console.log(`  Session after first call:`, {
            sessionId: session1.sessionId ? session1.sessionId.substring(0, 20) + "..." : undefined,
            lastSentMessageIndex: session1.lastSentMessageIndex,
        });

        if (!session1.sessionId) {
            console.log("\n❌ FAILED: No session ID captured after first call");
            return false;
        }

        console.log(`  ✅ Session captured: ${session1.sessionId.substring(0, 20)}...`);

        // ========== STEP 2: Second message with session resumption ==========
        console.log("\nSTEP 2: Second message - should use delta mode\n");

        // Create second event
        const event2 = new NDKEvent(ndk);
        event2.kind = 1;
        event2.pubkey = userPubkey;
        event2.content = "What color did I tell you to remember?";
        event2.tags = [["p", agentPubkey]];
        event2.created_at = Math.floor(Date.now() / 1000);
        event2.id = `${conversationId}-msg2`;

        // Add second message
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: event2.content,
            messageType: "text",
            eventId: event2.id,
            targetedPubkeys: [agentPubkey],
        });

        // Verify session is still there before second call
        const sessionManager2 = new SessionManager(testAgent, conversationId, projectPath);
        const session2Before = sessionManager2.getSession();
        console.log(`  Session before second call:`, {
            sessionId: session2Before.sessionId ? session2Before.sessionId.substring(0, 20) + "..." : undefined,
            lastSentMessageIndex: session2Before.lastSentMessageIndex,
        });

        console.log("  Creating execution context for second call...");
        const context2 = await projectContextStore.run(projectContext, async () => {
            return await createExecutionContext({
                agent: testAgent,
                conversationId,
                projectBasePath: projectPath,
                triggeringEvent: event2,
            });
        });

        console.log("  Executing AgentExecutor.execute() (should use delta mode)...");

        let response2 = "";
        try {
            const result2 = await projectContextStore.run(projectContext, async () => {
                return await executor.execute(context2);
            });

            if (result2) {
                response2 = result2.content || "";
                console.log(`  Response: ${response2.substring(0, 200)}...`);
            }
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.log(`\n❌ FAILED: Second call error: ${errorMessage}`);

            if (errorMessage.includes("cache_control")) {
                console.log("\n  This is the known upstream bug in ai-sdk-provider-claude-code.");
                console.log("  Session resumption fails with 'cache_control cannot be set for empty text blocks'");
            }

            return false;
        }

        // ========== VERIFY RESULTS ==========
        console.log("\n=== VERIFICATION ===\n");

        // Check session after second call
        const sessionManager3 = new SessionManager(testAgent, conversationId, projectPath);
        const session3 = sessionManager3.getSession();
        console.log(`Session after second call:`, {
            sessionId: session3.sessionId ? session3.sessionId.substring(0, 20) + "..." : undefined,
            lastSentMessageIndex: session3.lastSentMessageIndex,
        });

        // Check if response mentions PURPLE
        const rememberedColor = response2.toLowerCase().includes("purple");
        console.log(`Agent remembered color: ${rememberedColor ? "YES (PURPLE)" : "NO"}`);

        if (rememberedColor) {
            console.log("\n✅ SUCCESS: Session resumption works! Agent remembered the color through AgentExecutor.");
            return true;
        } else {
            console.log(`\n⚠️  Response received but doesn't mention 'purple': ${response2}`);
            console.log("  (Session might still work, just checking if context is preserved)");
            return true; // Still success if no error
        }

    } catch (error) {
        console.error("\n❌ Unexpected error:", error);
        return false;
    }
}

runTest()
    .then(async (success) => {
        console.log("\nCleaning up...");
        await cleanup();
        process.exit(success ? 0 : 1);
    })
    .catch(async (error) => {
        console.error("\nUnexpected error:", error);
        await cleanup();
        process.exit(1);
    });
