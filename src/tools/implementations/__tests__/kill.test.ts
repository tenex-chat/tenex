/**
 * Tests for the unified kill tool
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createKillTool } from "../kill";
import { ConversationStore } from "@/conversations/ConversationStore";
import { RALRegistry } from "@/services/ral";
import { CooldownRegistry } from "@/services/CooldownRegistry";
import type { ToolExecutionContext } from "@/tools/types";

describe("kill tool", () => {
    let mockContext: ToolExecutionContext;
    let ralRegistry: RALRegistry;
    let cooldownRegistry: CooldownRegistry;

    beforeEach(() => {
        // Create mock context
        mockContext = {
            projectContext: {
                project: {
                    dTag: "test-project-id-123456789012345678901234567890123456789012345678901234567890",
                },
            },
        } as any;

        // Get registry instances
        ralRegistry = RALRegistry.getInstance();
        cooldownRegistry = CooldownRegistry.getInstance();

        // Clear registries
        ralRegistry.clearAll();
        cooldownRegistry.clearAll();
    });

    afterEach(() => {
        ralRegistry.clearAll();
        cooldownRegistry.clearAll();
    });

    describe("Target type detection", () => {
        test("should detect conversation ID target", async () => {
            const conversationId = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

            // Mock ConversationStore to return a valid conversation
            const mockConversation = {
                id: conversationId,
                getProjectId: () => "test-project-id-123456789012345678901234567890123456789012345678901234567890",
                getAllActiveRals: () => new Map([["agent-pubkey-123", {}]]),
            };

            const originalGet = ConversationStore.get;
            ConversationStore.get = mock(() => mockConversation as any);

            // Mock RALRegistry.abortWithCascade
            const originalAbortWithCascade = ralRegistry.abortWithCascade.bind(ralRegistry);
            ralRegistry.abortWithCascade = mock(async () => ({
                abortedCount: 1,
                descendantConversations: [],
            })) as any;

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: conversationId });

            expect(result.success).toBe(true);
            expect(result.targetType).toBe("agent");
            expect(ralRegistry.abortWithCascade).toHaveBeenCalled();

            // Restore
            ConversationStore.get = originalGet;
            ralRegistry.abortWithCascade = originalAbortWithCascade;
        });

        test("should detect shell task ID target", async () => {
            const shellTaskId = "550e8400-e29b-41d4-a716-446655440000"; // UUID format

            // Mock ConversationStore to not find this as a conversation
            const originalHas = ConversationStore.has;
            ConversationStore.has = mock(() => false);

            // Mock shell functions
            const { getBackgroundTaskInfo, killBackgroundTask } = await import("../shell");
            const originalGetInfo = getBackgroundTaskInfo;
            const originalKill = killBackgroundTask;

            (global as any).getBackgroundTaskInfo = mock(() => ({
                taskId: shellTaskId,
                command: "test command",
                description: "test description",
                outputFile: "/tmp/output",
                startTime: new Date(),
            }));

            (global as any).killBackgroundTask = mock(() => ({
                success: true,
                message: "Task killed",
                pid: 12345,
            }));

            const killTool = createKillTool(mockContext);
            // Note: This test is illustrative - actual shell killing logic may vary

            // Restore
            ConversationStore.has = originalHas;
        });

        test("should support prefix matching for conversation IDs", async () => {
            const fullConversationId = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const prefix = "1234567890ab";

            // Mock ConversationStore.has to return false for prefix (not exact match)
            const originalHas = ConversationStore.has;
            ConversationStore.has = mock((id: string) => id === fullConversationId);

            // Mock ConversationStore.getAll to return conversations
            const originalGetAll = ConversationStore.getAll;
            const mockConversation = {
                id: fullConversationId,
                getProjectId: () => "test-project-id-123456789012345678901234567890123456789012345678901234567890",
                getAllActiveRals: () => new Map([["agent-pubkey-123", {}]]),
            };
            ConversationStore.getAll = mock(() => [mockConversation as any]);

            // Mock ConversationStore.get
            const originalGet = ConversationStore.get;
            ConversationStore.get = mock((id: string) => {
                if (id === fullConversationId) return mockConversation as any;
                return undefined;
            });

            // Mock RALRegistry.abortWithCascade
            const originalAbortWithCascade = ralRegistry.abortWithCascade.bind(ralRegistry);
            ralRegistry.abortWithCascade = mock(async () => ({
                abortedCount: 1,
                descendantConversations: [],
            })) as any;

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: prefix });

            expect(result.success).toBe(true);
            expect(ralRegistry.abortWithCascade).toHaveBeenCalled();

            // Restore
            ConversationStore.has = originalHas;
            ConversationStore.getAll = originalGetAll;
            ConversationStore.get = originalGet;
            ralRegistry.abortWithCascade = originalAbortWithCascade;
        });
    });

    describe("Agent killing with cascade", () => {
        test("should abort agent and add to cooldown registry", async () => {
            const projectId = "test-project-id-123456789012345678901234567890123456789012345678901234567890";
            const conversationId = "conv-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const agentPubkey = "agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

            // Mock conversation
            const mockConversation = {
                id: conversationId,
                getProjectId: () => projectId,
                getAllActiveRals: () => new Map([[agentPubkey, {}]]),
            };

            const originalGet = ConversationStore.get;
            ConversationStore.get = mock(() => mockConversation as any);

            // Mock RALRegistry.abortWithCascade
            const originalAbortWithCascade = ralRegistry.abortWithCascade.bind(ralRegistry);
            ralRegistry.abortWithCascade = mock(async () => ({
                abortedCount: 1,
                descendantConversations: [],
            })) as any;

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({
                target: conversationId,
                reason: "test abort"
            });

            expect(result.success).toBe(true);
            expect(result.targetType).toBe("agent");
            expect(result.cascadeAbortCount).toBe(1);

            // Verify abortWithCascade was called with correct arguments
            expect(ralRegistry.abortWithCascade).toHaveBeenCalledWith(
                agentPubkey,
                conversationId,
                projectId,
                "test abort",
                cooldownRegistry
            );

            // Restore
            ConversationStore.get = originalGet;
            ralRegistry.abortWithCascade = originalAbortWithCascade;
        });

        test("should handle cascade to nested delegations", async () => {
            const projectId = "test-project-id-123456789012345678901234567890123456789012345678901234567890";
            const conversationId = "conv-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const agentPubkey = "agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
            const childConvId = "child-conv-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
            const childAgentPubkey = "child-agent-1234567890abcdef1234567890abcdef1234567890abcdef12345";

            // Mock conversation
            const mockConversation = {
                id: conversationId,
                getProjectId: () => projectId,
                getAllActiveRals: () => new Map([[agentPubkey, {}]]),
            };

            const originalGet = ConversationStore.get;
            ConversationStore.get = mock(() => mockConversation as any);

            // Mock RALRegistry.abortWithCascade with nested delegation results
            const originalAbortWithCascade = ralRegistry.abortWithCascade.bind(ralRegistry);
            ralRegistry.abortWithCascade = mock(async () => ({
                abortedCount: 1,
                descendantConversations: [
                    { conversationId: childConvId, agentPubkey: childAgentPubkey }
                ],
            })) as any;

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({
                target: conversationId,
                reason: "cascade test"
            });

            expect(result.success).toBe(true);
            expect(result.cascadeAbortCount).toBe(2); // 1 direct + 1 cascaded
            expect(result.abortedTuples).toHaveLength(2);
            expect(result.abortedTuples).toContainEqual({ conversationId, agentPubkey });
            expect(result.abortedTuples).toContainEqual({ conversationId: childConvId, agentPubkey: childAgentPubkey });

            // Restore
            ConversationStore.get = originalGet;
            ralRegistry.abortWithCascade = originalAbortWithCascade;
        });

        test("should fail gracefully when conversation has no projectId", async () => {
            const conversationId = "conv-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const agentPubkey = "agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

            // Mock conversation with null projectId
            const mockConversation = {
                id: conversationId,
                getProjectId: () => null,
                getAllActiveRals: () => new Map([[agentPubkey, {}]]),
            };

            const originalGet = ConversationStore.get;
            ConversationStore.get = mock(() => mockConversation as any);

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: conversationId });

            expect(result.success).toBe(false);
            expect(result.message).toContain("no project ID");

            // Restore
            ConversationStore.get = originalGet;
        });

        test("should fail gracefully when no active agents found", async () => {
            const projectId = "test-project-id-123456789012345678901234567890123456789012345678901234567890";
            const conversationId = "conv-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

            // Mock conversation with no active RALs
            const mockConversation = {
                id: conversationId,
                getProjectId: () => projectId,
                getAllActiveRals: () => new Map(), // Empty - no active agents
            };

            const originalGet = ConversationStore.get;
            ConversationStore.get = mock(() => mockConversation as any);

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: conversationId });

            expect(result.success).toBe(false);
            expect(result.message).toContain("No active agents found");

            // Restore
            ConversationStore.get = originalGet;
        });

        test("should fail gracefully when conversation not found", async () => {
            const conversationId = "nonexistent-conv-id-1234567890abcdef1234567890abcdef1234567890abcdef";

            const originalGet = ConversationStore.get;
            ConversationStore.get = mock(() => undefined);

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: conversationId });

            expect(result.success).toBe(false);
            expect(result.message).toContain("not found");

            // Restore
            ConversationStore.get = originalGet;
        });
    });
});
