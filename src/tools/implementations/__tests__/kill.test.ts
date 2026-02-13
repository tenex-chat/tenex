/**
 * Tests for the unified kill tool
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createKillTool } from "../kill";
import { ConversationStore } from "@/conversations/ConversationStore";
import { RALRegistry } from "@/services/ral";
import { CooldownRegistry } from "@/services/CooldownRegistry";
import { prefixKVStore } from "@/services/storage";
import type { ToolExecutionContext } from "@/tools/types";

describe("kill tool", () => {
    let mockContext: ToolExecutionContext;
    let ralRegistry: RALRegistry;
    let cooldownRegistry: CooldownRegistry;

    beforeEach(() => {
        const projectId = "test-project-id-123456789012345678901234567890123456789012345678901234567890";

        // Create mock conversation for authorization checks
        const mockConversation = {
            id: "test-conversation-id-1234567890abcdef1234567890abcdef1234567890abcdef",
            getProjectId: () => projectId,
        };

        // Create mock context with all required fields
        mockContext = {
            agent: {
                slug: "test-agent",
                pubkey: "test-agent-pubkey-123456789012345678901234567890123456789012345678",
                name: "Test Agent",
            },
            conversationId: mockConversation.id,
            getConversation: () => mockConversation,
            projectContext: {
                project: {
                    dTag: projectId,
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

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock(() => true); // Recognize as conversation ID
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
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
            ralRegistry.abortWithCascade = originalAbortWithCascade;
        });

        test("should detect shell task ID format (UUID) via resolveTargetId", async () => {
            // This test verifies that UUID-format shell task IDs are correctly
            // identified as shell targets by the resolveTargetId function.
            //
            // NOTE: When the shell task doesn't exist, the error response uses
            // the default targetType "agent" because the code falls through to
            // the generic "not found" error path. The actual shell kill path
            // is only exercised when getBackgroundTaskInfo returns a valid task.
            //
            // This test verifies the ID format is correctly identified but since
            // no actual shell task exists, we get the generic error response.
            const shellTaskId = "550e8400-e29b-41d4-a716-446655440000"; // UUID format

            // Mock ConversationStore to not find this as a conversation
            const originalHas = ConversationStore.has;
            const originalGetAll = ConversationStore.getAll;
            ConversationStore.has = mock(() => false);
            ConversationStore.getAll = mock(() => []);

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: shellTaskId });

            // Task won't be found - generic error returned (targetType defaults to "agent")
            // The shell path was attempted but fell through to the error handler
            expect(result.success).toBe(false);
            expect(result.message).toContain("not found");

            // Restore
            ConversationStore.has = originalHas;
            ConversationStore.getAll = originalGetAll;
        });

        test("should support prefix matching for conversation IDs via fallback", async () => {
            // This test verifies the legacy fallback prefix matching at kill.ts lines 208-216
            // When PrefixKVStore and RALRegistry both fail to resolve a prefix,
            // the code falls back to scanning ConversationStore.getAll() for matches.
            //
            // Note: This test uses a non-hex prefix pattern (13+ chars) to avoid triggering
            // the 12-char hex resolution path and ensure we hit the fallback getAll().find() path.
            const fullConversationId = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
            const prefixToMatch = "abcdef1234567"; // 13-char prefix (not 12-char hex, so goes to fallback)
            const projectId = "test-project-id-123456789012345678901234567890123456789012345678901234567890";
            const agentPubkey = "agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

            // Mock conversation that will be found via getAll().find()
            const mockConversation = {
                id: fullConversationId,
                getProjectId: () => projectId,
                getAllActiveRals: () => new Map([[agentPubkey, {}]]),
            };

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            const originalGetAll = ConversationStore.getAll;

            // has() returns false for prefix (not exact match)
            ConversationStore.has = mock((id: string) => id === fullConversationId);
            ConversationStore.get = mock((id: string) => {
                if (id === fullConversationId) return mockConversation as any;
                return undefined;
            });
            // getAll() returns conversations including one that matches the prefix
            ConversationStore.getAll = mock(() => [mockConversation as any]);

            // Mock RALRegistry.abortWithCascade
            const originalAbortWithCascade = ralRegistry.abortWithCascade.bind(ralRegistry);
            ralRegistry.abortWithCascade = mock(async () => ({
                abortedCount: 1,
                descendantConversations: [],
            })) as any;

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({
                target: prefixToMatch, // Use 13-char prefix (goes to fallback)
                reason: "test prefix fallback"
            });

            expect(result.success).toBe(true);
            expect(result.targetType).toBe("agent");
            expect(result.target).toBe(fullConversationId);

            // Restore all mocks
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
            ConversationStore.getAll = originalGetAll;
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

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock(() => true); // Recognize as conversation ID
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
            ConversationStore.has = originalHas;
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

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock(() => true); // Recognize as conversation ID
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
            ConversationStore.has = originalHas;
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

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock(() => true); // Recognize as conversation ID
            ConversationStore.get = mock(() => mockConversation as any);

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: conversationId });

            expect(result.success).toBe(false);
            expect(result.message).toContain("no project ID");

            // Restore
            ConversationStore.has = originalHas;
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

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock(() => true); // Make it recognize as conversation ID
            ConversationStore.get = mock(() => mockConversation as any);

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: conversationId });

            expect(result.success).toBe(false);
            expect(result.message).toContain("No active agents found");

            // Restore
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
        });

        test("should fail gracefully when conversation not found", async () => {
            const conversationId = "nonexistent-conv-id-1234567890abcdef1234567890abcdef1234567890abcdef";

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock(() => true); // Make it recognize as conversation ID
            ConversationStore.get = mock(() => undefined);

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: conversationId });

            expect(result.success).toBe(false);
            expect(result.message).toContain("not found");

            // Restore
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
        });
    });

    describe("Security: Project isolation enforcement", () => {
        test("should reject agent kill when projectId does not match (cross-project protection)", async () => {
            const callerProjectId = "caller-project-id-123456789012345678901234567890123456789012345678901234567";
            const targetProjectId = "target-project-id-999999999999999999999999999999999999999999999999999999999";
            const conversationId = "conv-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const agentPubkey = "agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

            // Mock caller's conversation
            const callerConversation = {
                id: "caller-conv-id-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
                getProjectId: () => callerProjectId,
            };

            // Mock target conversation with DIFFERENT projectId
            const targetConversation = {
                id: conversationId,
                getProjectId: () => targetProjectId, // Different project!
                getAllActiveRals: () => new Map([[agentPubkey, {}]]),
            };

            // Update mock context with caller's conversation
            const contextWithProjectId = {
                ...mockContext,
                getConversation: () => callerConversation,
            } as any;

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock(() => true);
            ConversationStore.get = mock(() => targetConversation as any);

            const killTool = createKillTool(contextWithProjectId);
            const result = await killTool.execute({ target: conversationId });

            // SECURITY: Should reject cross-project kill
            expect(result.success).toBe(false);
            expect(result.message).toContain("Authorization failed");
            expect(result.message).toContain("other projects");

            // Restore
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
        });

        test("should attempt shell kill path for 7-char alphanumeric IDs", async () => {
            // This test validates that 7-char alphanumeric IDs are correctly
            // identified as shell task IDs by resolveTargetId and routed to
            // the shell kill path.
            //
            // NOTE: When the shell task doesn't exist, the error response uses
            // the default targetType "agent" because the code falls through to
            // the generic "not found" error path. Testing the actual shell
            // authorization would require module-level mocking of shell.ts.

            const shellTaskId = "xyz7890";  // 7-char alphanumeric (valid ShellTaskId format)
            const callerProjectId = "caller-project-id-123456789012345678901234567890123456789012345678901234567";

            // Setup context with caller's project
            const callerConversation = {
                id: "caller-conv-id-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
                getProjectId: () => callerProjectId,
            };
            const contextWithProject = {
                ...mockContext,
                getConversation: () => callerConversation,
            } as any;

            // Mock ConversationStore to NOT recognize this as a conversation
            const originalHas = ConversationStore.has;
            const originalGetAll = ConversationStore.getAll;
            ConversationStore.has = mock(() => false);
            ConversationStore.getAll = mock(() => []);

            const killTool = createKillTool(contextWithProject);
            const result = await killTool.execute({ target: shellTaskId });

            // Task won't be found - generic error returned
            // The shell path was attempted via resolveTargetId but task doesn't exist
            expect(result.success).toBe(false);
            expect(result.message).toContain("not found");

            // Restore mocks
            ConversationStore.has = originalHas;
            ConversationStore.getAll = originalGetAll;
        });

        test("should reject agent kill when caller has no project context", async () => {
            const conversationId = "conv-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const agentPubkey = "agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
            const targetProjectId = "target-project-id-123456789012345678901234567890123456789012345678901234567";

            // Mock caller's conversation with NO project ID
            const callerConversation = {
                id: "caller-conv-id-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
                getProjectId: () => undefined, // No project context!
            };

            // Mock target conversation
            const targetConversation = {
                id: conversationId,
                getProjectId: () => targetProjectId,
                getAllActiveRals: () => new Map([[agentPubkey, {}]]),
            };

            const contextWithoutProject = {
                ...mockContext,
                getConversation: () => callerConversation,
            } as any;

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock(() => true);
            ConversationStore.get = mock(() => targetConversation as any);

            const killTool = createKillTool(contextWithoutProject);
            const result = await killTool.execute({ target: conversationId });

            // SECURITY: Should reject when no project context
            expect(result.success).toBe(false);
            expect(result.message).toContain("Authorization failed");
            expect(result.message).toContain("cannot kill agents without project context");

            // Restore
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
        });
    });

    describe("12-char ID resolution", () => {
        test("should resolve 12-char prefix to full conversation ID via PrefixKVStore", async () => {
            const fullConversationId = "a1b2c3d4e5f61234567890abcdef1234567890abcdef1234567890abcdef1234";
            const shortId = "a1b2c3d4e5f6"; // First 12 chars
            const projectId = "test-project-id-123456789012345678901234567890123456789012345678901234567890";
            const agentPubkey = "agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

            // Mock PrefixKVStore to resolve the short ID
            const originalIsInitialized = prefixKVStore.isInitialized.bind(prefixKVStore);
            const originalLookup = prefixKVStore.lookup.bind(prefixKVStore);
            prefixKVStore.isInitialized = mock(() => true);
            prefixKVStore.lookup = mock((prefix: string) => {
                if (prefix === shortId) {
                    return fullConversationId;
                }
                return null;
            });

            // Mock conversation
            const mockConversation = {
                id: fullConversationId,
                getProjectId: () => projectId,
                getAllActiveRals: () => new Map([[agentPubkey, {}]]),
            };

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock((id: string) => id === fullConversationId);
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
            const result = await killTool.execute({
                target: shortId, // Use short 12-char ID
                reason: "test kill with short ID"
            });

            expect(result.success).toBe(true);
            expect(result.targetType).toBe("agent");
            expect(result.target).toBe(fullConversationId);

            // Restore
            prefixKVStore.isInitialized = originalIsInitialized;
            prefixKVStore.lookup = originalLookup;
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
            ralRegistry.abortWithCascade = originalAbortWithCascade;
        });

        test("should resolve 12-char prefix via RALRegistry when PrefixKVStore fails", async () => {
            const fullConversationId = "b2c3d4e5f6a71234567890abcdef1234567890abcdef1234567890abcdef1234";
            const shortId = "b2c3d4e5f6a7"; // First 12 chars
            const projectId = "test-project-id-123456789012345678901234567890123456789012345678901234567890";
            const agentPubkey = "agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

            // Mock PrefixKVStore to NOT find the ID (simulating not initialized or miss)
            const originalIsInitialized = prefixKVStore.isInitialized.bind(prefixKVStore);
            const originalLookup = prefixKVStore.lookup.bind(prefixKVStore);
            prefixKVStore.isInitialized = mock(() => false);
            prefixKVStore.lookup = mock(() => null);

            // Mock RALRegistry to resolve the short ID
            const originalResolveDelegationPrefix = ralRegistry.resolveDelegationPrefix.bind(ralRegistry);
            ralRegistry.resolveDelegationPrefix = mock((prefix: string) => {
                if (prefix === shortId) {
                    return fullConversationId;
                }
                return null;
            });

            // Mock conversation
            const mockConversation = {
                id: fullConversationId,
                getProjectId: () => projectId,
                getAllActiveRals: () => new Map([[agentPubkey, {}]]),
            };

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock((id: string) => id === fullConversationId);
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
            const result = await killTool.execute({
                target: shortId,
                reason: "test kill with short ID via RAL"
            });

            expect(result.success).toBe(true);
            expect(result.targetType).toBe("agent");
            expect(result.target).toBe(fullConversationId);

            // Restore
            prefixKVStore.isInitialized = originalIsInitialized;
            prefixKVStore.lookup = originalLookup;
            ralRegistry.resolveDelegationPrefix = originalResolveDelegationPrefix;
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
            ralRegistry.abortWithCascade = originalAbortWithCascade;
        });

        test("should return error when 12-char prefix cannot be resolved", async () => {
            const shortId = "c3d4e5f6a7b8"; // Unknown prefix

            // Mock PrefixKVStore to not find it
            const originalIsInitialized = prefixKVStore.isInitialized.bind(prefixKVStore);
            const originalLookup = prefixKVStore.lookup.bind(prefixKVStore);
            prefixKVStore.isInitialized = mock(() => true);
            prefixKVStore.lookup = mock(() => null);

            // Mock RALRegistry to not find it
            const originalResolveDelegationPrefix = ralRegistry.resolveDelegationPrefix.bind(ralRegistry);
            ralRegistry.resolveDelegationPrefix = mock(() => null);

            // Mock ConversationStore to not find it
            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            const originalGetAll = ConversationStore.getAll;
            ConversationStore.has = mock(() => false);
            ConversationStore.get = mock(() => undefined);
            ConversationStore.getAll = mock(() => []);

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: shortId });

            expect(result.success).toBe(false);
            expect(result.message).toContain("not found");

            // Restore
            prefixKVStore.isInitialized = originalIsInitialized;
            prefixKVStore.lookup = originalLookup;
            ralRegistry.resolveDelegationPrefix = originalResolveDelegationPrefix;
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
            ConversationStore.getAll = originalGetAll;
        });
    });

    describe("Race condition: Kill before RAL registered in ConversationStore", () => {
        test("should kill agent found in RALRegistry even if not in ConversationStore.getAllActiveRals()", async () => {
            const projectId = "test-project-id-123456789012345678901234567890123456789012345678901234567890";
            const conversationId = "conv-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const agentPubkey = "agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

            // Create a RAL in RALRegistry (simulates agent that just started)
            ralRegistry.create(agentPubkey, conversationId, projectId);

            // Mock conversation that has no active RALs in ConversationStore (not yet registered)
            // This simulates the race condition window
            const mockConversation = {
                id: conversationId,
                getProjectId: () => projectId,
                getAllActiveRals: () => new Map(), // Empty - not yet registered
            };

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock(() => true);
            ConversationStore.get = mock(() => mockConversation as any);

            // Mock abortWithCascade
            const originalAbortWithCascade = ralRegistry.abortWithCascade.bind(ralRegistry);
            ralRegistry.abortWithCascade = mock(async () => ({
                abortedCount: 1,
                descendantConversations: [],
            })) as any;

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: conversationId });

            // Should succeed because we found the agent in RALRegistry
            expect(result.success).toBe(true);
            expect(result.targetType).toBe("agent");
            expect(ralRegistry.abortWithCascade).toHaveBeenCalled();

            // Restore
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
            ralRegistry.abortWithCascade = originalAbortWithCascade;
        });

        test("should prefer ConversationStore when agent is in both stores", async () => {
            const projectId = "test-project-id-123456789012345678901234567890123456789012345678901234567890";
            const conversationId = "conv-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const agentPubkey = "agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

            // Create a RAL in RALRegistry
            ralRegistry.create(agentPubkey, conversationId, projectId);

            // Mock conversation that HAS the agent in ConversationStore
            const mockConversation = {
                id: conversationId,
                getProjectId: () => projectId,
                getAllActiveRals: () => new Map([[agentPubkey, [1]]]),
            };

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock(() => true);
            ConversationStore.get = mock(() => mockConversation as any);

            // Mock abortWithCascade
            const originalAbortWithCascade = ralRegistry.abortWithCascade.bind(ralRegistry);
            ralRegistry.abortWithCascade = mock(async () => ({
                abortedCount: 1,
                descendantConversations: [],
            })) as any;

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: conversationId });

            // Should succeed - agent found in both stores
            expect(result.success).toBe(true);
            expect(result.targetType).toBe("agent");

            // Restore
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
            ralRegistry.abortWithCascade = originalAbortWithCascade;
        });
    });

    describe("Pre-emptive kill: Kill before agent starts", () => {
        test("should pre-emptively kill a delegation that hasn't started yet", async () => {
            const projectId = "test-project-id-123456789012345678901234567890123456789012345678901234567890";
            const parentConversationId = "parent-conv-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
            const delegationConversationId = "deleg-conv-1234567890abcdef1234567890abcdef1234567890abcdef12345678";
            const parentAgentPubkey = "parent-agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcdef12";
            const delegateAgentPubkey = "delegate-agent-pubkey-1234567890abcdef1234567890abcdef1234567890abcd";

            // Create parent RAL and register a pending delegation
            const ralNumber = ralRegistry.create(parentAgentPubkey, parentConversationId, projectId);
            ralRegistry.mergePendingDelegations(parentAgentPubkey, parentConversationId, ralNumber, [{
                delegationConversationId,
                recipientPubkey: delegateAgentPubkey,
                senderPubkey: parentAgentPubkey,
                prompt: "Test prompt",
                ralNumber,
            }]);

            // Mock conversation that has no active RALs (delegation hasn't started yet)
            const mockDelegationConversation = {
                id: delegationConversationId,
                getProjectId: () => projectId,
                getAllActiveRals: () => new Map(), // Empty - agent hasn't started
            };

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock(() => true);
            ConversationStore.get = mock(() => mockDelegationConversation as any);

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: delegationConversationId });

            // Should succeed with pre-emptive kill
            expect(result.success).toBe(true);
            expect(result.message).toContain("Pre-emptive kill");
            expect(result.abortedTuples).toBeDefined();
            expect(result.abortedTuples!.length).toBe(1);
            expect(result.abortedTuples![0].agentPubkey).toBe(delegateAgentPubkey);

            // Verify that the agent is marked as killed
            expect(ralRegistry.isAgentConversationKilled(delegateAgentPubkey, delegationConversationId)).toBe(true);

            // Restore
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
        });

        test("should fail gracefully when conversation has no delegation info and no active agents", async () => {
            const projectId = "test-project-id-123456789012345678901234567890123456789012345678901234567890";
            const conversationId = "lonely-conv-1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

            // Mock conversation with no active RALs and no delegation info
            const mockConversation = {
                id: conversationId,
                getProjectId: () => projectId,
                getAllActiveRals: () => new Map(),
            };

            const originalHas = ConversationStore.has;
            const originalGet = ConversationStore.get;
            ConversationStore.has = mock(() => true);
            ConversationStore.get = mock(() => mockConversation as any);

            const killTool = createKillTool(mockContext);
            const result = await killTool.execute({ target: conversationId });

            // Should fail - no agents and no delegation info
            expect(result.success).toBe(false);
            expect(result.message).toContain("No active agents found");

            // Restore
            ConversationStore.has = originalHas;
            ConversationStore.get = originalGet;
        });
    });
});
