import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import type { AgentProjectConfig, AgentDefaultConfig } from "@/agents/types";

/**
 * Tests for project-scoped agent configuration via kind 24020 TenexAgentConfigUpdate events.
 *
 * When an event contains an a-tag referencing a project, the configuration
 * should be stored in projectOverrides[projectDTag] (new schema) via updateProjectOverride().
 *
 * When the event has no a-tag, it writes to the default config block via updateDefaultConfig().
 */

// Track calls to storage methods
let updateProjectOverrideCalls: Array<{
    pubkey: string;
    projectDTag: string;
    override: AgentProjectConfig;
    reset: boolean;
}> = [];
let updateDefaultConfigCalls: Array<{ pubkey: string; updates: AgentDefaultConfig }> = [];
let updateGlobalIsPMCalls: Array<{ pubkey: string; isPM: boolean | undefined }> = [];
let updateProjectScopedIsPMCalls: Array<{
    pubkey: string;
    projectDTag: string;
    isPM: boolean | undefined;
}> = [];
let reloadAgentCalls: string[] = [];

// Mock modules before importing
mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

mock.module("@/agents/AgentStorage", () => ({
    agentStorage: {
        updateProjectOverride: async (
            pubkey: string,
            projectDTag: string,
            override: AgentProjectConfig,
            reset = false
        ) => {
            updateProjectOverrideCalls.push({ pubkey, projectDTag, override, reset });
            return true;
        },
        updateDefaultConfig: async (pubkey: string, updates: AgentDefaultConfig) => {
            updateDefaultConfigCalls.push({ pubkey, updates });
            return true;
        },
        updateAgentIsPM: async (pubkey: string, isPM: boolean | undefined) => {
            updateGlobalIsPMCalls.push({ pubkey, isPM });
            return true;
        },
        updateProjectScopedIsPM: async (
            pubkey: string,
            projectDTag: string,
            isPM: boolean | undefined
        ) => {
            updateProjectScopedIsPMCalls.push({ pubkey, projectDTag, isPM });
            return true;
        },
    },
}));

mock.module("@/services/projects", () => ({
    getProjectContext: () => ({
        getAgentByPubkey: (pubkey: string) => ({
            slug: "test-agent",
            pubkey,
            name: "Test Agent",
        }),
        agentRegistry: {
            reloadAgent: async (pubkey: string) => {
                reloadAgentCalls.push(pubkey);
            },
        },
        statusPublisher: null,
        // Include project with dTag for a-tag validation
        project: {
            dTag: "my-project",
            tagValue: (tag: string) => {
                if (tag === "d") return "my-project";
                return undefined;
            },
        },
    }),
}));

mock.module("@/nostr/TagExtractor", () => ({
    TagExtractor: {
        getToolTags: (event: NDKEvent) => {
            return event.tags
                .filter((tag) => tag[0] === "tool")
                .map((tag) => ({ name: tag[1] }));
        },
    },
}));

// Now import the EventHandler
import { EventHandler } from "../index";

describe("Project-Scoped Config via Kind 24020 with a-tag", () => {
    let eventHandler: EventHandler;

    beforeEach(async () => {
        // Reset tracking
        updateProjectOverrideCalls = [];
        updateDefaultConfigCalls = [];
        updateGlobalIsPMCalls = [];
        updateProjectScopedIsPMCalls = [];
        reloadAgentCalls = [];

        eventHandler = new EventHandler();
        await eventHandler.initialize();
    });

    it("should use project-scoped storage when a-tag is present", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event WITH a-tag (project-scoped)
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
            ["model", "anthropic:claude-opus-4"],
            ["tool", "fs_read"],
            ["tool", "shell"],
            ["pm"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        // Should use project override method
        expect(updateProjectOverrideCalls.length).toBe(1);
        expect(updateProjectOverrideCalls[0].pubkey).toBe(agentPubkey);
        expect(updateProjectOverrideCalls[0].projectDTag).toBe("my-project");
        expect(updateProjectOverrideCalls[0].override).toEqual({
            model: "anthropic:claude-opus-4",
            tools: ["fs_read", "shell"],
        });
        expect(updateProjectOverrideCalls[0].reset).toBe(false);

        // PM should be handled via project-scoped isPM
        expect(updateProjectScopedIsPMCalls.length).toBe(1);
        expect(updateProjectScopedIsPMCalls[0].pubkey).toBe(agentPubkey);
        expect(updateProjectScopedIsPMCalls[0].projectDTag).toBe("my-project");
        expect(updateProjectScopedIsPMCalls[0].isPM).toBe(true);

        // Global methods should NOT be called
        expect(updateDefaultConfigCalls.length).toBe(0);
        expect(updateGlobalIsPMCalls.length).toBe(0);

        // Agent should be reloaded
        expect(reloadAgentCalls).toContain(agentPubkey);
    });

    it("should use global (default) storage when a-tag is absent", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event WITHOUT a-tag (global/default config)
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["model", "anthropic:claude-opus-4"],
            ["tool", "fs_read"],
            ["pm"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        // Should use default config method, NOT project-scoped
        expect(updateProjectOverrideCalls.length).toBe(0);

        expect(updateDefaultConfigCalls.length).toBe(1);
        expect(updateDefaultConfigCalls[0].updates.model).toBe("anthropic:claude-opus-4");
        expect(updateDefaultConfigCalls[0].updates.tools).toEqual(["fs_read"]);

        // PM should be handled via global isPM
        expect(updateGlobalIsPMCalls.length).toBe(1);
        expect(updateGlobalIsPMCalls[0].isPM).toBe(true);
    });

    it("should parse a-tag with complex d-tag containing colons", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event with a complex d-tag
        // Note: The a-tag project must match the current project (my-project) or it will be ignored
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
            ["model", "anthropic:claude-sonnet-4"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateProjectOverrideCalls.length).toBe(1);
        expect(updateProjectOverrideCalls[0].projectDTag).toBe("my-project");
    });

    it("should ignore a-tag for different project (validation)", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event with a-tag pointing to a DIFFERENT project
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:other-project"],
            ["model", "anthropic:claude-opus-4"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        // Should NOT process config for a different project
        expect(updateProjectOverrideCalls.length).toBe(0);
        expect(updateDefaultConfigCalls.length).toBe(0);
        expect(updateGlobalIsPMCalls.length).toBe(0);
    });

    it("should not include tools in project override when no tool tags present", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event with a-tag but no tool tags
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
            ["model", "anthropic:claude-opus-4"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateProjectOverrideCalls.length).toBe(1);
        // Override should only have model, not tools
        expect(updateProjectOverrideCalls[0].override).toEqual({
            model: "anthropic:claude-opus-4",
        });
    });

    it("should not call updateProjectScopedIsPM when pm tag is absent", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event with a-tag but no pm tag
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
            ["tool", "fs_read"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateProjectOverrideCalls.length).toBe(1);
        // PM should not be called
        expect(updateProjectScopedIsPMCalls.length).toBe(0);
    });

    it("should call updateProjectOverride with reset when reset tag is present", async () => {
        const agentPubkey = "abc123def456";

        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
            ["reset"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateProjectOverrideCalls.length).toBe(1);
        expect(updateProjectOverrideCalls[0].reset).toBe(true);
    });

    it("should send empty override when only a-tag is present with no config values", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event with a-tag but no model/tools/pm
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateProjectOverrideCalls.length).toBe(1);
        // Override should be empty (dedup will clear it)
        expect(updateProjectOverrideCalls[0].override).toEqual({});
    });

    it("should clear project-scoped PM when reset tag is present (Issue 1)", async () => {
        const agentPubkey = "abc123def456";

        // A reset tag must clear ALL project config including PM designation
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
            ["reset"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        // projectOverride should be reset
        expect(updateProjectOverrideCalls.length).toBe(1);
        expect(updateProjectOverrideCalls[0].reset).toBe(true);

        // Project-scoped PM must also be cleared
        expect(updateProjectScopedIsPMCalls.length).toBe(1);
        expect(updateProjectScopedIsPMCalls[0].pubkey).toBe(agentPubkey);
        expect(updateProjectScopedIsPMCalls[0].projectDTag).toBe("my-project");
        // undefined clears the PM designation
        expect(updateProjectScopedIsPMCalls[0].isPM).toBeUndefined();
    });

    it("should NOT call updateProjectScopedIsPM on reset when there is no a-tag (global reset would be different)", async () => {
        // This ensures reset without a-tag doesn't accidentally clear project PM
        const agentPubkey = "abc123def456";

        // Reset with no a-tag - handled by global path, not project-scoped path
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["reset"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        // Global path should not call project-scoped PM
        expect(updateProjectScopedIsPMCalls.length).toBe(0);
    });
});

describe("Global (non-a-tag) 24020 - Partial Update Semantics", () => {
    let eventHandler: EventHandler;

    beforeEach(async () => {
        updateProjectOverrideCalls = [];
        updateDefaultConfigCalls = [];
        updateGlobalIsPMCalls = [];
        updateProjectScopedIsPMCalls = [];
        reloadAgentCalls = [];

        eventHandler = new EventHandler();
        await eventHandler.initialize();
    });

    it("should NOT update model when no model tag is present (Issue 2: partial update)", async () => {
        const agentPubkey = "abc123def456";

        // Event with only tool tags - no model tag
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["tool", "fs_read"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateDefaultConfigCalls.length).toBe(1);
        // model should NOT be present in updates - no model tag means no change to model
        expect(updateDefaultConfigCalls[0].updates.model).toBeUndefined();
        // tools should be present since tool tags were explicitly provided
        expect(updateDefaultConfigCalls[0].updates.tools).toEqual(["fs_read"]);
    });

    it("should NOT update tools when no tool tags are present (Issue 3: no unexpected clear)", async () => {
        const agentPubkey = "abc123def456";

        // Event with only a model tag - no tool tags
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["model", "anthropic:claude-opus-4"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateDefaultConfigCalls.length).toBe(1);
        // model should be updated since model tag was explicitly provided
        expect(updateDefaultConfigCalls[0].updates.model).toBe("anthropic:claude-opus-4");
        // tools should NOT be present - no tool tags means no change to tools
        expect(updateDefaultConfigCalls[0].updates.tools).toBeUndefined();
    });

    it("should update both model and tools when both tags are present", async () => {
        const agentPubkey = "abc123def456";

        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["model", "anthropic:claude-sonnet-4"],
            ["tool", "fs_read"],
            ["tool", "shell"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateDefaultConfigCalls.length).toBe(1);
        expect(updateDefaultConfigCalls[0].updates.model).toBe("anthropic:claude-sonnet-4");
        expect(updateDefaultConfigCalls[0].updates.tools).toEqual(["fs_read", "shell"]);
    });

    it("should update neither model nor tools when only pm tag is present", async () => {
        const agentPubkey = "abc123def456";

        // Event with only pm tag - neither model nor tools
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["pm"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateDefaultConfigCalls.length).toBe(1);
        // Neither model nor tools should be in updates
        expect(updateDefaultConfigCalls[0].updates.model).toBeUndefined();
        expect(updateDefaultConfigCalls[0].updates.tools).toBeUndefined();
        // PM should still be set
        expect(updateGlobalIsPMCalls.length).toBe(1);
        expect(updateGlobalIsPMCalls[0].isPM).toBe(true);
    });
});

/**
 * Helper to create a mock kind 24020 TenexAgentConfigUpdate event
 */
function createMockConfigUpdateEvent(
    agentPubkey: string,
    tags: string[][]
): NDKEvent {
    return {
        id: "test-event-id",
        kind: NDKKind.TenexAgentConfigUpdate,
        pubkey: "sender-pubkey",
        tags,
        content: "",
        created_at: Math.floor(Date.now() / 1000),
        tagValue: (tagName: string) => {
            const tag = tags.find((t) => t[0] === tagName);
            return tag?.[1];
        },
        getMatchingTags: (tagName: string) => {
            return tags.filter((t) => t[0] === tagName);
        },
    } as unknown as NDKEvent;
}
