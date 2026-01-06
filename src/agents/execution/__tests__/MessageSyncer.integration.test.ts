/**
 * E2E Integration Test: Tool Error Handling
 *
 * This tests that when a tool throws an error (e.g., ENOENT), the agent:
 * 1. Receives the error in context via MessageSyncer
 * 2. Does NOT loop infinitely
 * 3. Handles the error gracefully
 *
 * Prerequisites:
 * - Configured LLM provider running (from ~/.tenex/llms.json)
 * - ~/.tenex/config.json exists
 *
 * Run with: bun test src/agents/execution/__tests__/MessageSyncer.integration.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";

import { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { createExecutionContext } from "@/agents/execution/ExecutionContextFactory";
import { ConversationStore } from "@/conversations/ConversationStore";
import { EventHandler } from "@/event-handler";
import { config } from "@/services/ConfigService";
import { AgentMetadataStore } from "@/services/agents/AgentMetadataStore";
import { ProjectContext, projectContextStore } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { initializeGitRepository } from "@/utils/git";
import { initNDK, shutdownNDK } from "@/nostr/ndkClient";

describe("MessageSyncer E2E - Tool Error Handling", () => {
    const testDir = join(tmpdir(), `tenex-e2e-${Date.now()}`);
    const projectPath = join(testDir, "project");
    const metadataPath = join(testDir, "metadata");

    let projectContext: ProjectContext;
    let eventHandler: EventHandler;
    let agentSigner: NDKPrivateKeySigner;
    let userSigner: NDKPrivateKeySigner;
    let ndk: NDK;

    beforeAll(async () => {
        // Create test directories
        mkdirSync(projectPath, { recursive: true });
        mkdirSync(join(metadataPath, "conversations"), { recursive: true });

        // Initialize git repo
        await initializeGitRepository(projectPath);

        // Load real config from ~/.tenex/
        await config.loadConfig();

        // Initialize NDK for nostr event publishing
        await initNDK();

        // Create signers
        agentSigner = NDKPrivateKeySigner.generate();
        userSigner = NDKPrivateKeySigner.generate();
        ndk = new NDK();

        const agentPubkey = (await agentSigner.user()).pubkey;

        // Create a minimal project event
        const projectEvent = new NDKEvent(ndk);
        projectEvent.kind = 31933;
        projectEvent.pubkey = (await userSigner.user()).pubkey;
        projectEvent.tags = [
            ["d", "test-project"],
            ["title", "Test Project"],
        ];
        projectEvent.content = "";

        // Create agent registry with a test agent that uses configured LLM
        const agentRegistry = new AgentRegistry(projectPath, metadataPath);

        // Get the default LLM config from loaded config
        const llmConfigs = config.getConfig().llms;
        const defaultLlm = llmConfigs?.default || "anthropic:claude-sonnet-4-20250514";

        // Create a proper AgentInstance
        const testAgent: AgentInstance = {
            name: "test-agent",
            slug: "test",
            pubkey: agentPubkey,
            role: "Test agent for e2e testing",
            llmConfig: defaultLlm,
            tools: ["read_path"],
            instructions: "You are a test agent. When asked to read a file, use the read_path tool. If the file doesn't exist, explain the error to the user.",
            signer: agentSigner,
            createMetadataStore: (conversationId: string) => {
                return new AgentMetadataStore(conversationId, "test", metadataPath);
            },
            createLLMService: (options) => {
                return config.createLLMService(defaultLlm, {
                    tools: options?.tools ?? {},
                    agentName: "test-agent",
                    sessionId: options?.sessionId,
                    workingDirectory: options?.workingDirectory ?? projectPath,
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
        projectContext = new ProjectContext(
            projectEvent as unknown as NDKProject,
            agentRegistry
        );

        // Initialize event handler
        eventHandler = new EventHandler();
        await eventHandler.initialize();
    });

    afterAll(async () => {
        // Cleanup
        ConversationStore.reset();
        RALRegistry.getInstance().clearAll();
        await shutdownNDK();
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    test("agent sees tool error when reading non-existent file", async () => {
        const agentPubkey = (await agentSigner.user()).pubkey;
        const userPubkey = (await userSigner.user()).pubkey;

        // Create a kind:1 event requesting to read a non-existent file
        // Use a path inside the project directory but that doesn't exist
        const nonExistentFile = join(projectPath, "nonexistent", "deeply", "nested", "file.txt");
        const event = new NDKEvent(ndk);
        event.kind = 1;
        event.pubkey = userPubkey;
        event.content = `Please read the file ${nonExistentFile} and tell me what's in it`;
        event.tags = [["p", agentPubkey]]; // Direct to our test agent
        event.created_at = Math.floor(Date.now() / 1000);
        event.id = `test-event-${Date.now()}`;

        // Create conversation
        const conversationId = event.id;
        const conversationStore = ConversationStore.getOrLoad(conversationId);
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: event.content,
            messageType: "text",
            eventId: event.id,
            targetedPubkeys: [agentPubkey],
        });

        // Create execution context
        const context = await projectContextStore.run(projectContext, async () => {
            return await createExecutionContext({
                agent: projectContext.agents.get("test")!,
                conversationId,
                projectBasePath: projectPath,
                triggeringEvent: event,
            });
        });

        // Execute agent
        const executor = new AgentExecutor();
        const toolCallCount = { value: 0 };
        const toolErrorSeen = { value: false };

        const startTime = Date.now();
        const maxWaitMs = 120_000; // 2 minute max

        try {
            await projectContextStore.run(projectContext, async () => {
                const result = await executor.execute(context, undefined, {
                    onToolCall: (toolName) => {
                        toolCallCount.value++;
                        console.log(`  Tool call #${toolCallCount.value}: ${toolName}`);
                    },
                    onToolResult: (toolName, result, error) => {
                        if (error) {
                            toolErrorSeen.value = true;
                            console.log(`  Tool error: ${toolName}`);
                        }
                    },
                });

                console.log(`  Execution completed with kind: ${result.kind}`);
            });
        } catch (error) {
            // Execution errors are acceptable for this test
            console.log(`  Execution error: ${error}`);
        }

        const duration = Date.now() - startTime;
        console.log(`  Duration: ${(duration / 1000).toFixed(1)}s`);

        // Verify results
        const messages = conversationStore.getAllMessages();
        const toolCalls = messages.filter((m) => m.messageType === "tool-call");
        const toolResults = messages.filter((m) => m.messageType === "tool-result");

        console.log(`  Tool calls in store: ${toolCalls.length}`);
        console.log(`  Tool results in store: ${toolResults.length}`);

        // Check that tool result with error exists in ConversationStore
        const hasErrorResult = toolResults.some((m) => {
            const toolData = m.toolData as any[];
            if (!toolData?.[0]?.output) return false;
            const output = toolData[0].output;
            const value = output.value || output.text || "";
            const valueStr = typeof value === "string" ? value : JSON.stringify(value);
            return valueStr.includes("ENOENT") || valueStr.includes("no such file");
        });

        // Assertions
        // 1. Agent didn't loop infinitely (< 5 attempts to read the same file)
        expect(toolCallCount.value).toBeLessThan(5);

        // 2. Tool result with error is in ConversationStore
        // This is the key assertion - MessageSyncer should have synced it
        expect(toolResults.length).toBeGreaterThan(0);

        // 3. The error content is present (ENOENT or similar)
        expect(hasErrorResult).toBe(true);

        // 4. Execution completed in reasonable time (not stuck in loop)
        expect(duration).toBeLessThan(maxWaitMs);

        console.log("✅ Test passed: Agent saw tool error and didn't loop infinitely");
    }, 180_000); // 3 minute test timeout
});
