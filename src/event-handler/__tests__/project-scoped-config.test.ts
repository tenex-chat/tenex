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
        // loadAgent returns a mock agent with empty defaults (so delta = full list as additions)
        loadAgent: async (_pubkey: string) => ({
            slug: "test-agent",
            name: "Test Agent",
            role: "assistant",
            nsec: "nsec1abc",
            projects: ["my-project"],
            default: { tools: [] }, // Empty defaults so all tools from event become additions
        }),
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
        // Mirrors actual TagExtractor.getToolTags() which filters out empty tool names.
        // This ensures tests reflect the production behavior where ["tool", ""] tags are
        // excluded from the returned array — exercising the raw-tag-presence guard.
        getToolTags: (event: NDKEvent) => {
            return event.tags
                .filter((tag) => tag[0] === "tool")
                .map((tag) => ({ name: tag[1] }))
                .filter((tool): tool is { name: string } => !!tool.name);
        },
    },
}));

// Now import the EventHandler and the mocked agentStorage
import { EventHandler } from "../index";
import { agentStorage } from "@/agents/AgentStorage";

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
        // Tools are stored as delta against defaults.
        // Mock agent has empty defaults [], so all tools from the event become additions (+)
        expect(updateProjectOverrideCalls[0].override).toEqual({
            model: "anthropic:claude-opus-4",
            tools: ["+fs_read", "+shell"],
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

describe("Project-Scoped 24020 Delta Conversion (Issue 2: full list → delta storage)", () => {
    /**
     * These tests verify the correct behavior per behavioral clarification:
     * - 24020 events ALWAYS carry a FULL tool list (no delta notation in events)
     * - Delta notation is a STORAGE-LAYER ONLY concept
     * - The implementation must convert the event's full list into a storage delta
     *
     * The mock agent has empty defaults [], so all tools from the event become additions (+).
     * For testing with non-empty defaults, the mock `loadAgent` needs to be overridden.
     */

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

    it("should convert full tool list to delta additions when defaults are empty", async () => {
        const agentPubkey = "abc123def456";

        // Agent has empty defaults (set by mock loadAgent)
        // Event sends a full list: [fs_read, shell]
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
            ["tool", "fs_read"],
            ["tool", "shell"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateProjectOverrideCalls.length).toBe(1);
        // Tools stored as delta: [+fs_read, +shell] (all additions relative to empty defaults)
        expect(updateProjectOverrideCalls[0].override.tools).toEqual(["+fs_read", "+shell"]);
    });

    it("should produce empty delta (no tools override) when full list matches defaults", async () => {
        const agentPubkey = "abc123def456";

        // Agent has empty defaults, event sends empty tool list
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
            // No tool tags → newToolNames is empty → no tools in override
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateProjectOverrideCalls.length).toBe(1);
        // No tool override when no tools specified in event
        expect(updateProjectOverrideCalls[0].override.tools).toBeUndefined();
    });

    it("should NOT store delta notation in default config (full list for defaults)", async () => {
        const agentPubkey = "abc123def456";

        // Global (no a-tag) 24020 event - should store full list, not delta
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["tool", "fs_read"],
            ["tool", "shell"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateDefaultConfigCalls.length).toBe(1);
        // Default config stores the FULL list (no + or - prefixes)
        expect(updateDefaultConfigCalls[0].updates.tools).toEqual(["fs_read", "shell"]);
        // Verify no delta notation in the stored defaults
        const tools = updateDefaultConfigCalls[0].updates.tools ?? [];
        for (const tool of tools) {
            expect(tool.startsWith("+")).toBe(false);
            expect(tool.startsWith("-")).toBe(false);
        }
    });

    it("should not include tools in override when delta would be empty (tools match defaults)", async () => {
        // This tests the optimization: if computing delta yields [], no tools override is needed
        const agentPubkey = "abc123def456";

        // Agent has empty defaults, event sends no tools (empty list)
        // → delta is empty → no tools key in override
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
            ["model", "anthropic:claude-opus-4"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateProjectOverrideCalls.length).toBe(1);
        // Only model, no tools
        expect(updateProjectOverrideCalls[0].override).toEqual({
            model: "anthropic:claude-opus-4",
        });
        expect(updateProjectOverrideCalls[0].override.tools).toBeUndefined();
    });

    it("should produce removal delta when desired list omits a tool from non-empty defaults", async () => {
        // Exercise the removal path: a tool in defaults that is NOT in the desired list
        // should produce a "-tool" entry in the stored delta.
        const agentPubkey = "abc123def456";

        // Override loadAgent to return an agent with non-empty defaults
        const originalLoadAgent = agentStorage.loadAgent;
        agentStorage.loadAgent = async (_pubkey: string) => ({
            slug: "test-agent",
            name: "Test Agent",
            role: "assistant",
            nsec: "nsec1abc",
            projects: ["my-project"],
            default: { tools: ["fs_read", "shell", "agents_write"] },
        });

        try {
            // Event sends desired list that drops "agents_write" and keeps "fs_read" + "shell"
            const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
                ["p", agentPubkey],
                ["a", "31990:owner-pubkey:my-project"],
                ["tool", "fs_read"],
                ["tool", "shell"],
            ]);

            await eventHandler.handleEvent(mockEvent);

            expect(updateProjectOverrideCalls.length).toBe(1);
            const storedTools = updateProjectOverrideCalls[0].override.tools ?? [];
            // "agents_write" was in defaults but not in the desired list → removal entry
            expect(storedTools).toContain("-agents_write");
            // "fs_read" and "shell" match defaults → no addition entries needed
            expect(storedTools).not.toContain("+fs_read");
            expect(storedTools).not.toContain("+shell");
        } finally {
            agentStorage.loadAgent = originalLoadAgent;
        }
    });

    it("should produce no tools delta when desired list exactly matches non-empty defaults", async () => {
        // Exercise the "tool matches defaults" path: when the desired list equals the
        // defaults exactly, no delta is needed and tools should be omitted from the override.
        const agentPubkey = "abc123def456";

        // Override loadAgent to return an agent with non-empty defaults
        const originalLoadAgent = agentStorage.loadAgent;
        agentStorage.loadAgent = async (_pubkey: string) => ({
            slug: "test-agent",
            name: "Test Agent",
            role: "assistant",
            nsec: "nsec1abc",
            projects: ["my-project"],
            default: { tools: ["fs_read", "shell"] },
        });

        try {
            // Event sends exactly the same tool list as the defaults
            const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
                ["p", agentPubkey],
                ["a", "31990:owner-pubkey:my-project"],
                ["tool", "fs_read"],
                ["tool", "shell"],
            ]);

            await eventHandler.handleEvent(mockEvent);

            expect(updateProjectOverrideCalls.length).toBe(1);
            // Delta is empty → no tools override stored
            expect(updateProjectOverrideCalls[0].override.tools).toBeUndefined();
        } finally {
            agentStorage.loadAgent = originalLoadAgent;
        }
    });

    it('should clear all project-scoped tools when tool tags are present with empty values ("clear all" intent)', async () => {
        // Regression test for the "clear all tools" bug:
        // TagExtractor.getToolTags() filters out empty tool names, so ["tool", ""] events
        // produce newToolNames=[] AND toolTags.length=0, making the guard skip delta computation.
        // The fix uses event.tags.some() to detect tool tag PRESENCE regardless of value.
        const agentPubkey = "abc123def456";

        // Agent has non-empty defaults that should be cleared
        const originalLoadAgent = agentStorage.loadAgent;
        agentStorage.loadAgent = async (_pubkey: string) => ({
            slug: "test-agent",
            name: "Test Agent",
            role: "assistant",
            nsec: "nsec1abc",
            projects: ["my-project"],
            default: { tools: ["fs_read", "shell"] },
        });

        try {
            // Event with ["tool", ""] — signals "clear all tools for this project"
            // TagExtractor filters this to empty array, but raw tag IS present
            const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
                ["p", agentPubkey],
                ["a", "31990:owner-pubkey:my-project"],
                ["tool", ""],
            ]);

            await eventHandler.handleEvent(mockEvent);

            expect(updateProjectOverrideCalls.length).toBe(1);
            // newToolNames = [] (empty after filtering), defaults = ["fs_read", "shell"]
            // Delta = ["-fs_read", "-shell"] — removals for all default tools
            const storedTools = updateProjectOverrideCalls[0].override.tools ?? [];
            expect(storedTools).toContain("-fs_read");
            expect(storedTools).toContain("-shell");
        } finally {
            agentStorage.loadAgent = originalLoadAgent;
        }
    });
});

describe("Global (non-a-tag) 24020 - Empty Model Tag Guard", () => {
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

    it("should NOT persist an empty model string when model tag has empty value", async () => {
        // Regression test for the empty model guard:
        // event.tagValue("model") returns "" for ["model", ""] tags.
        // Without the guard, defaultUpdates.model = "" would be stored, overwriting the model.
        const agentPubkey = "abc123def456";

        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["model", ""], // Empty model tag — should be treated as no-op
            ["tool", "fs_read"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateDefaultConfigCalls.length).toBe(1);
        // model should NOT be set — empty tag value is a no-op, not a clear
        expect(updateDefaultConfigCalls[0].updates.model).toBeUndefined();
        // tools should still be updated normally
        expect(updateDefaultConfigCalls[0].updates.tools).toEqual(["fs_read"]);
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
