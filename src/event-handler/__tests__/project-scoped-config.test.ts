import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import type { ProjectScopedConfig } from "@/agents/types";

/**
 * Tests for project-scoped agent configuration via kind 24020 TenexAgentConfigUpdate events.
 *
 * When an event contains an a-tag referencing a project, the configuration
 * should be stored in projectConfigs[projectDTag] instead of global fields.
 */

// Track calls to storage methods
let updateProjectScopedConfigCalls: Array<{
    pubkey: string;
    projectDTag: string;
    config: ProjectScopedConfig;
}> = [];
let updateGlobalLLMConfigCalls: Array<{ pubkey: string; llmConfig: string }> = [];
let updateGlobalToolsCalls: Array<{ pubkey: string; tools: string[] }> = [];
let updateGlobalIsPMCalls: Array<{ pubkey: string; isPM: boolean | undefined }> = [];
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
        updateAgentLLMConfig: async (pubkey: string, llmConfig: string) => {
            updateGlobalLLMConfigCalls.push({ pubkey, llmConfig });
            return true;
        },
        updateAgentTools: async (pubkey: string, tools: string[]) => {
            updateGlobalToolsCalls.push({ pubkey, tools });
            return true;
        },
        updateAgentIsPM: async (pubkey: string, isPM: boolean | undefined) => {
            updateGlobalIsPMCalls.push({ pubkey, isPM });
            return true;
        },
        updateProjectScopedConfig: async (
            pubkey: string,
            projectDTag: string,
            config: ProjectScopedConfig
        ) => {
            updateProjectScopedConfigCalls.push({ pubkey, projectDTag, config });
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
        updateProjectScopedConfigCalls = [];
        updateGlobalLLMConfigCalls = [];
        updateGlobalToolsCalls = [];
        updateGlobalIsPMCalls = [];
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

        // Should use project-scoped config, NOT global methods
        expect(updateProjectScopedConfigCalls.length).toBe(1);
        expect(updateProjectScopedConfigCalls[0].pubkey).toBe(agentPubkey);
        expect(updateProjectScopedConfigCalls[0].projectDTag).toBe("my-project");
        expect(updateProjectScopedConfigCalls[0].config).toEqual({
            llmConfig: "anthropic:claude-opus-4",
            tools: ["fs_read", "shell"],
            isPM: true,
        });

        // Global methods should NOT be called
        expect(updateGlobalLLMConfigCalls.length).toBe(0);
        expect(updateGlobalToolsCalls.length).toBe(0);
        expect(updateGlobalIsPMCalls.length).toBe(0);

        // Agent should be reloaded
        expect(reloadAgentCalls).toContain(agentPubkey);
    });

    it("should use global storage when a-tag is absent (backward compatibility)", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event WITHOUT a-tag (global config)
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["model", "anthropic:claude-opus-4"],
            ["tool", "fs_read"],
            ["pm"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        // Should use global methods, NOT project-scoped
        expect(updateProjectScopedConfigCalls.length).toBe(0);

        expect(updateGlobalLLMConfigCalls.length).toBe(1);
        expect(updateGlobalLLMConfigCalls[0].llmConfig).toBe("anthropic:claude-opus-4");

        expect(updateGlobalToolsCalls.length).toBe(1);
        expect(updateGlobalToolsCalls[0].tools).toEqual(["fs_read"]);

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

        expect(updateProjectScopedConfigCalls.length).toBe(1);
        expect(updateProjectScopedConfigCalls[0].projectDTag).toBe("my-project");
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
        expect(updateProjectScopedConfigCalls.length).toBe(0);
        expect(updateGlobalLLMConfigCalls.length).toBe(0);
        expect(updateGlobalToolsCalls.length).toBe(0);
        expect(updateGlobalIsPMCalls.length).toBe(0);
    });

    it("should not include tools in project config when no tool tags present", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event with a-tag but no tool tags
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
            ["model", "anthropic:claude-opus-4"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateProjectScopedConfigCalls.length).toBe(1);
        // Config should only have llmConfig, not tools
        expect(updateProjectScopedConfigCalls[0].config).toEqual({
            llmConfig: "anthropic:claude-opus-4",
        });
    });

    it("should not include isPM in project config when pm tag is absent", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event with a-tag but no pm tag
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
            ["tool", "fs_read"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateProjectScopedConfigCalls.length).toBe(1);
        // Config should only have tools, not isPM
        expect(updateProjectScopedConfigCalls[0].config).toEqual({
            tools: ["fs_read"],
        });
    });

    it("should store empty project config when only a-tag is present with no config values", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event with a-tag but no model/tools/pm
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["a", "31990:owner-pubkey:my-project"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        expect(updateProjectScopedConfigCalls.length).toBe(1);
        // Config should be empty (effectively clearing project-scoped overrides)
        expect(updateProjectScopedConfigCalls[0].config).toEqual({});
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
