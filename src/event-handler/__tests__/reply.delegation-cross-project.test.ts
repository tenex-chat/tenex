import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentRouter } from "../AgentRouter";

/**
 * Reproduction Test for Cross-Project Routing Issue
 *
 * Bug Description:
 * When an external agent (from a foreign project) sends a reply to a local agent,
 * the routing mechanism may incorrectly filter out the reply due to:
 * - The external agent's pubkey not matching any local agents
 * - The a-tag containing a foreign project ID (e.g., "31933:external_pubkey:project-b")
 * - Possible filtering logic that treats foreign a-tags as "not relevant to this project"
 *
 * Expected Behavior:
 * AgentRouter.resolveTargetAgents should route replies to local agents based on p-tags,
 * REGARDLESS of the a-tag content. The a-tag presence should not prevent routing.
 *
 * Test Coverage:
 * This test file validates that the routing mechanism correctly:
 * 1. Identifies local agents via p-tags (even when sender is external)
 * 2. Ignores foreign a-tags when determining routing targets
 * 3. Routes both completion reports and normal text replies
 * 4. Handles multiple p-tags correctly
 * 5. Respects blocked agent state even in cross-project scenarios
 */

describe("Cross-Project Delegation Routing", () => {
    let mockProjectContext: any;
    let mockConversation: any;

    beforeEach(() => {
        // Local agents in this project
        const agentA = {
            name: "Agent A",
            pubkey: "a000000000000000000000000000000000000000000000000000000000000001",
            slug: "agent-a",
            role: "coordinator",
            phases: {},
        };

        // External agent from another project (should NOT be in our local agents)
        const externalAgentB = {
            name: "Agent B (External)",
            pubkey: "b000000000000000000000000000000000000000000000000000000000000002",
            slug: "agent-b-external",
            role: "worker",
            phases: {},
        };

        // Project context with only local agents
        mockProjectContext = {
            pubkey: "project-pubkey-1111111111111111111111111111111111111111111111111111",
            agents: new Map([["agent-a", agentA]]),
            getAgent: (slug: string) => mockProjectContext.agents.get(slug),
            getAgentByPubkey: (pubkey: string) => {
                for (const agent of mockProjectContext.agents.values()) {
                    if (agent.pubkey === pubkey) {
                        return agent;
                    }
                }
                return undefined;
            },
            agentRegistry: {
                getBasePath: () => "/test/path",
            },
            getAgentSlugs: () => Array.from(mockProjectContext.agents.keys()),
            project: {
                tagValue: (tag: string) => (tag === "d" ? "project-a" : undefined),
            },
        };

        // Mock conversation store
        mockConversation = {
            id: "conv-root-xxxxxxxx",
            history: [],
            phase: "chat",
            agentStates: new Map(),
            agentTodos: new Map(),
            isAgentBlocked: () => false, // No blocked agents
        };
    });

    it("should route reply from external agent (completion report) to local p-tagged agent", () => {
        // External agent B sends a completion status to local agent A
        // Event has:
        // - pubkey: Agent B (external)
        // - p-tag: Agent A (local, should receive this)
        // - a-tag: foreign project ID (should NOT affect routing)
        // - e-tag: reference to a delegation event

        const completionEvent: NDKEvent = {
            id: "completion-event-id-12345678",
            pubkey: "b000000000000000000000000000000000000000000000000000000000000002", // Agent B
            content: "Task completed successfully: All tests passed.",
            kind: 1, // Text note
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                // P-tag pointing to Agent A (local agent)
                ["p", "a000000000000000000000000000000000000000000000000000000000000001"],
                // E-tag referencing the delegation event
                ["e", "delegation-event-id-87654321"],
                // A-tag with foreign project ID (crucial part of the bug)
                // Format: "31933:pubkey:d-tag"
                ["a", "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b"],
            ],
            getMatchingTags: function (tagName: string) {
                return this.tags.filter((tag) => tag[0] === tagName);
            },
            tagValue: function (tagName: string) {
                const tags = this.getMatchingTags(tagName);
                return tags.length > 0 ? tags[0][1] : undefined;
            },
        } as any;

        // Act: Resolve target agents for this event
        const targetAgents = AgentRouter.resolveTargetAgents(
            completionEvent,
            mockProjectContext,
            mockConversation
        );

        // Assert: Should find Agent A as target (via p-tag) despite foreign a-tag
        expect(targetAgents).toHaveLength(1);
        expect(targetAgents[0].slug).toBe("agent-a");
        expect(targetAgents[0].name).toBe("Agent A");
    });

    it("should route normal reply from external agent (clarification request) to local p-tagged agent", () => {
        // External agent B sends a question/clarification to Agent A
        // This tests normal text reply routing (not just completion events)

        const clarificationEvent: NDKEvent = {
            id: "clarification-event-id-99999999",
            pubkey: "b000000000000000000000000000000000000000000000000000000000000002", // Agent B (external)
            content: "Can you clarify the requirement for the API schema? The spec is ambiguous.",
            kind: 1, // Text note
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                // P-tag pointing to Agent A (local agent)
                ["p", "a000000000000000000000000000000000000000000000000000000000000001"],
                // E-tag referencing Agent A's original message
                ["e", "original-request-event-id"],
                // A-tag with foreign project ID
                ["a", "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b"],
            ],
            getMatchingTags: function (tagName: string) {
                return this.tags.filter((tag) => tag[0] === tagName);
            },
            tagValue: function (tagName: string) {
                const tags = this.getMatchingTags(tagName);
                return tags.length > 0 ? tags[0][1] : undefined;
            },
        } as any;

        // Act: Resolve target agents for this event
        const targetAgents = AgentRouter.resolveTargetAgents(
            clarificationEvent,
            mockProjectContext,
            mockConversation
        );

        // Assert: Should find Agent A as target
        expect(targetAgents).toHaveLength(1);
        expect(targetAgents[0].slug).toBe("agent-a");
        expect(targetAgents[0].name).toBe("Agent A");
    });

    it("should NOT route to external agents that are not in local project context", () => {
        // A message with p-tag pointing to Agent B (external)
        // Agent B is NOT in our local agents map
        // Should NOT be routed to anyone

        const externalOnlyEvent: NDKEvent = {
            id: "external-only-event-id",
            pubkey: "b000000000000000000000000000000000000000000000000000000000000002", // Agent B (external)
            content: "Status update",
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                // P-tag pointing to some other unknown agent (not in our project)
                ["p", "c000000000000000000000000000000000000000000000000000000000000003"],
                // A-tag with foreign project ID
                ["a", "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b"],
            ],
            getMatchingTags: function (tagName: string) {
                return this.tags.filter((tag) => tag[0] === tagName);
            },
            tagValue: function (tagName: string) {
                const tags = this.getMatchingTags(tagName);
                return tags.length > 0 ? tags[0][1] : undefined;
            },
        } as any;

        // Act: Resolve target agents for this event
        const targetAgents = AgentRouter.resolveTargetAgents(
            externalOnlyEvent,
            mockProjectContext,
            mockConversation
        );

        // Assert: Should NOT find any local targets
        expect(targetAgents).toHaveLength(0);
    });

    it("should respect p-tag order and route to first matching local agent when multiple p-tags exist", () => {
        // Create a second local agent
        const agentC = {
            name: "Agent C",
            pubkey: "c000000000000000000000000000000000000000000000000000000000000003",
            slug: "agent-c",
            role: "worker",
            phases: {},
        };

        mockProjectContext.agents.set("agent-c", agentC);

        const multiPtagEvent: NDKEvent = {
            id: "multi-ptag-event-id",
            pubkey: "b000000000000000000000000000000000000000000000000000000000000002", // Agent B (external)
            content: "Message to multiple agents",
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                // Multiple p-tags: external agent, then Agent A, then Agent C
                ["p", "external-agent-pubkey"],
                ["p", "a000000000000000000000000000000000000000000000000000000000000001"], // Agent A
                ["p", "c000000000000000000000000000000000000000000000000000000000000003"], // Agent C
                // A-tag with foreign project ID
                ["a", "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b"],
            ],
            getMatchingTags: function (tagName: string) {
                return this.tags.filter((tag) => tag[0] === tagName);
            },
            tagValue: function (tagName: string) {
                const tags = this.getMatchingTags(tagName);
                return tags.length > 0 ? tags[0][1] : undefined;
            },
        } as any;

        // Act: Resolve target agents for this event
        const targetAgents = AgentRouter.resolveTargetAgents(
            multiPtagEvent,
            mockProjectContext,
            mockConversation
        );

        // Assert: Should find both Agent A and Agent C (but not the external agent)
        expect(targetAgents).toHaveLength(2);
        const slugs = targetAgents.map((a) => a.slug).sort();
        expect(slugs).toEqual(["agent-a", "agent-c"]);
    });

    it("should filter blocked agents even from cross-project replies", () => {
        // Mock conversation with Agent A blocked
        const blockedAgentPubkey = "a000000000000000000000000000000000000000000000000000000000000001";
        const blockedConversation = {
            id: "conv-root-xxxxxxxx",
            history: [],
            phase: "chat",
            agentStates: new Map(),
            agentTodos: new Map(),
            isAgentBlocked: (pubkey: string) => {
                // Agent A is blocked
                return pubkey === blockedAgentPubkey;
            },
        };

        const completionEvent: NDKEvent = {
            id: "completion-blocked-agent",
            pubkey: "b000000000000000000000000000000000000000000000000000000000000002", // Agent B (external)
            content: "Task completed",
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ["p", "a000000000000000000000000000000000000000000000000000000000000001"], // Agent A (but blocked)
                ["e", "delegation-event-id"],
                ["a", "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b"],
            ],
            getMatchingTags: function (tagName: string) {
                return this.tags.filter((tag) => tag[0] === tagName);
            },
            tagValue: function (tagName: string) {
                const tags = this.getMatchingTags(tagName);
                return tags.length > 0 ? tags[0][1] : undefined;
            },
        } as any;

        // Act: Resolve target agents with blocked conversation
        const targetAgents = AgentRouter.resolveTargetAgents(
            completionEvent,
            mockProjectContext,
            blockedConversation
        );

        // Assert: Should NOT find Agent A because it's blocked
        expect(targetAgents).toHaveLength(0);
    });

    it("should route correctly with multiple a-tags (multiple foreign projects)", () => {
        // External agent sends to local agent with multiple foreign a-tags
        // Should still route to local agent based on p-tag

        const multiAtagEvent: NDKEvent = {
            id: "multi-atag-event",
            pubkey: "b000000000000000000000000000000000000000000000000000000000000002", // Agent B (external)
            content: "Status from multiple projects",
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                // P-tag pointing to local Agent A
                ["p", "a000000000000000000000000000000000000000000000000000000000000001"],
                // E-tag
                ["e", "event-id"],
                // Multiple a-tags from different foreign projects
                ["a", "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b"],
                ["a", "31933:external-agent:project-c"],
                ["a", "31933:another-agent:project-d"],
            ],
            getMatchingTags: function (tagName: string) {
                return this.tags.filter((tag) => tag[0] === tagName);
            },
            tagValue: function (tagName: string) {
                const tags = this.getMatchingTags(tagName);
                return tags.length > 0 ? tags[0][1] : undefined;
            },
        } as any;

        // Act: Resolve target agents
        const targetAgents = AgentRouter.resolveTargetAgents(
            multiAtagEvent,
            mockProjectContext,
            mockConversation
        );

        // Assert: Should still find Agent A based on p-tag
        expect(targetAgents).toHaveLength(1);
        expect(targetAgents[0].slug).toBe("agent-a");
    });

    it("should handle event with mixed local and external p-tags", () => {
        // Create a second local agent
        const agentD = {
            name: "Agent D",
            pubkey: "d000000000000000000000000000000000000000000000000000000000000004",
            slug: "agent-d",
            role: "worker",
            phases: {},
        };

        mockProjectContext.agents.set("agent-d", agentD);

        // Event with p-tags to both local agents and external agents
        const mixedEvent: NDKEvent = {
            id: "mixed-ptags-event",
            pubkey: "b000000000000000000000000000000000000000000000000000000000000002", // External sender
            content: "Message to mixed recipients",
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                // Mix of local and external p-tags
                ["p", "a000000000000000000000000000000000000000000000000000000000000001"], // Local Agent A
                ["p", "external-user-pubkey"], // External (not in our agents)
                ["p", "d000000000000000000000000000000000000000000000000000000000000004"], // Local Agent D
                ["e", "event-id"],
                ["a", "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b"],
            ],
            getMatchingTags: function (tagName: string) {
                return this.tags.filter((tag) => tag[0] === tagName);
            },
            tagValue: function (tagName: string) {
                const tags = this.getMatchingTags(tagName);
                return tags.length > 0 ? tags[0][1] : undefined;
            },
        } as any;

        // Act: Resolve target agents
        const targetAgents = AgentRouter.resolveTargetAgents(
            mixedEvent,
            mockProjectContext,
            mockConversation
        );

        // Assert: Should only find local agents (A and D), not the external user
        expect(targetAgents).toHaveLength(2);
        const slugs = targetAgents.map((a) => a.slug).sort();
        expect(slugs).toEqual(["agent-a", "agent-d"]);
    });

    it("should route threaded delegation replies (multiple e-tags in NIP-10 format)", () => {
        // This test validates the fix for threaded conversations
        // In NIP-10 format, a reply in a thread has multiple e-tags:
        // - First e-tag: root conversation ID
        // - Last e-tag: direct reply target (the delegation event)
        //
        // DelegationCompletionHandler must check ALL e-tags, not just getFirstETag()
        // because the delegation ID might be in the last position

        const threadedReplyEvent: NDKEvent = {
            id: "threaded-reply-event",
            pubkey: "b000000000000000000000000000000000000000000000000000000000000002", // External Agent B
            content: "Task completed as delegated",
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                // NIP-10 threaded format: multiple e-tags
                // First e-tag is the conversation root
                ["e", "root-conversation-id-root-root-root-root-root-root-root-1"],
                // Intermediate e-tags in the thread
                ["e", "intermediate-event-id-in-thread-in-thread-in-thread-1"],
                // Last e-tag is the direct reply target (the delegation event we need to match)
                ["e", "delegation-event-id-this-is-what-we-need-to-match-12345"],
                // P-tag to local Agent A
                ["p", "a000000000000000000000000000000000000000000000000000000000000001"],
                // Foreign project a-tag
                ["a", "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b"],
                // Status tag indicating completion
                ["status", "completed"],
            ],
            getMatchingTags: function (tagName: string) {
                return this.tags.filter((tag) => tag[0] === tagName);
            },
            tagValue: function (tagName: string) {
                const tags = this.getMatchingTags(tagName);
                return tags.length > 0 ? tags[0][1] : undefined;
            },
        } as any;

        // Act: Resolve target agents for this event
        const targetAgents = AgentRouter.resolveTargetAgents(
            threadedReplyEvent,
            mockProjectContext,
            mockConversation
        );

        // Assert: Should route to Agent A based on p-tag
        // This validates that routing works even with complex NIP-10 threaded e-tags
        expect(targetAgents).toHaveLength(1);
        expect(targetAgents[0].slug).toBe("agent-a");
        expect(targetAgents[0].name).toBe("Agent A");
    });
});
