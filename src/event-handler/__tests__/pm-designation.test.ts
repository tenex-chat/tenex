import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";

/**
 * Tests for PM designation via kind 24020 TenexAgentConfigUpdate events.
 *
 * When an agent's config update event contains the ["pm"] tag,
 * that agent should be flagged as the PM for all projects where it exists.
 */

// Track calls to storage methods
let updateIsPMCalls: Array<{ pubkey: string; isPM: boolean | undefined }> = [];
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
        updateDefaultConfig: async () => true,
        updateAgentIsPM: async (pubkey: string, isPM: boolean | undefined) => {
            updateIsPMCalls.push({ pubkey, isPM });
            return true;
        },
        updateProjectOverride: async () => true,
        updateProjectScopedIsPM: async () => true,
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
        getToolTags: () => [],
    },
}));

// Now import the EventHandler
import { EventHandler } from "../index";

describe("PM Designation via Kind 24020", () => {
    let eventHandler: EventHandler;

    beforeEach(async () => {
        // Reset tracking
        updateIsPMCalls = [];
        reloadAgentCalls = [];

        eventHandler = new EventHandler();
        await eventHandler.initialize();
    });

    it("should set isPM flag when event contains ['pm'] tag", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event with ["pm"] tag
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["pm"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        // Verify updateAgentIsPM was called with true
        expect(updateIsPMCalls.length).toBe(1);
        expect(updateIsPMCalls[0].pubkey).toBe(agentPubkey);
        expect(updateIsPMCalls[0].isPM).toBe(true);

        // Verify agent was reloaded
        expect(reloadAgentCalls).toContain(agentPubkey);
    });

    it("should call updateAgentIsPM with false when event does not contain ['pm'] tag", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event WITHOUT ["pm"] tag
        // Kind 24020 events are authoritative snapshots - absence of ["pm"] tag clears the designation
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["model", "anthropic:claude-sonnet-4"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        // Verify updateAgentIsPM WAS called with false (clearing the designation)
        expect(updateIsPMCalls.length).toBe(1);
        expect(updateIsPMCalls[0].pubkey).toBe(agentPubkey);
        expect(updateIsPMCalls[0].isPM).toBe(false);
    });

    it("should handle ['pm'] tag alongside other configuration tags", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock event with both model change and pm designation
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["model", "anthropic:claude-opus-4"],
            ["pm"],
            ["tool", "fs_read"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        // Verify isPM was set
        expect(updateIsPMCalls.length).toBe(1);
        expect(updateIsPMCalls[0].isPM).toBe(true);
    });

    it("should clear isPM flag when event does not contain ['pm'] tag (authoritative snapshot)", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock kind 24020 event WITHOUT ["pm"] tag
        // This should clear the PM designation since kind 24020 events are authoritative snapshots
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["model", "anthropic:claude-sonnet-4"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        // Verify updateAgentIsPM was called with false (to clear the designation)
        expect(updateIsPMCalls.length).toBe(1);
        expect(updateIsPMCalls[0].pubkey).toBe(agentPubkey);
        expect(updateIsPMCalls[0].isPM).toBe(false);
    });

    it("should clear isPM flag when config update has tools but no pm tag", async () => {
        const agentPubkey = "abc123def456";

        // Create a mock event with tools but no PM tag - simulates removing PM while keeping tools
        const mockEvent = createMockConfigUpdateEvent(agentPubkey, [
            ["p", agentPubkey],
            ["tool", "fs_read"],
            ["tool", "fs_write"],
        ]);

        await eventHandler.handleEvent(mockEvent);

        // Verify updateAgentIsPM was called with false
        expect(updateIsPMCalls.length).toBe(1);
        expect(updateIsPMCalls[0].pubkey).toBe(agentPubkey);
        expect(updateIsPMCalls[0].isPM).toBe(false);
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
