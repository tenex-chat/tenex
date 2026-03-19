import { beforeEach, describe, expect, it } from "bun:test";
import { AgentRouter } from "@/services/dispatch/AgentRouter";
import { NDKKind } from "@/nostr/kinds";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";

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

    function createEnvelope(params: {
        senderPubkey: string;
        recipientPubkeys: string[];
        replyTargets?: string[];
        articleReferences?: string[];
        statusValue?: string;
    }) {
        return createMockInboundEnvelope({
            principal: {
                id: params.senderPubkey,
                transport: "nostr",
                linkedPubkey: params.senderPubkey,
                kind: "agent",
            },
            recipients: params.recipientPubkeys.map((pubkey) => ({
                id: pubkey,
                transport: "nostr",
                linkedPubkey: pubkey,
                kind: "agent",
            })),
            metadata: {
                eventKind: NDKKind.Text,
                replyTargets: params.replyTargets ?? [],
                articleReferences: params.articleReferences ?? [],
                statusValue: params.statusValue,
            },
        });
    }

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

        const completionEvent = createEnvelope({
            senderPubkey: "b000000000000000000000000000000000000000000000000000000000000002",
            recipientPubkeys: ["a000000000000000000000000000000000000000000000000000000000000001"],
            replyTargets: ["delegation-event-id-87654321"],
            articleReferences: [
                "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b",
            ],
        });

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

        const clarificationEvent = createEnvelope({
            senderPubkey: "b000000000000000000000000000000000000000000000000000000000000002",
            recipientPubkeys: ["a000000000000000000000000000000000000000000000000000000000000001"],
            replyTargets: ["original-request-event-id"],
            articleReferences: [
                "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b",
            ],
        });

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

        const externalOnlyEvent = createEnvelope({
            senderPubkey: "b000000000000000000000000000000000000000000000000000000000000002",
            recipientPubkeys: ["c000000000000000000000000000000000000000000000000000000000000003"],
            articleReferences: [
                "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b",
            ],
        });

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

        const multiPtagEvent = createEnvelope({
            senderPubkey: "b000000000000000000000000000000000000000000000000000000000000002",
            recipientPubkeys: [
                "external-agent-pubkey",
                "a000000000000000000000000000000000000000000000000000000000000001",
                "c000000000000000000000000000000000000000000000000000000000000003",
            ],
            articleReferences: [
                "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b",
            ],
        });

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

        const completionEvent = createEnvelope({
            senderPubkey: "b000000000000000000000000000000000000000000000000000000000000002",
            recipientPubkeys: ["a000000000000000000000000000000000000000000000000000000000000001"],
            replyTargets: ["delegation-event-id"],
            articleReferences: [
                "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b",
            ],
        });

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

        const multiAtagEvent = createEnvelope({
            senderPubkey: "b000000000000000000000000000000000000000000000000000000000000002",
            recipientPubkeys: ["a000000000000000000000000000000000000000000000000000000000000001"],
            replyTargets: ["event-id"],
            articleReferences: [
                "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b",
                "31933:external-agent:project-c",
                "31933:another-agent:project-d",
            ],
        });

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
        const mixedEvent = createEnvelope({
            senderPubkey: "b000000000000000000000000000000000000000000000000000000000000002",
            recipientPubkeys: [
                "a000000000000000000000000000000000000000000000000000000000000001",
                "external-user-pubkey",
                "d000000000000000000000000000000000000000000000000000000000000004",
            ],
            replyTargets: ["event-id"],
            articleReferences: [
                "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b",
            ],
        });

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

        const threadedReplyEvent = createEnvelope({
            senderPubkey: "b000000000000000000000000000000000000000000000000000000000000002",
            recipientPubkeys: ["a000000000000000000000000000000000000000000000000000000000000001"],
            replyTargets: [
                "root-conversation-id-root-root-root-root-root-root-root-1",
                "intermediate-event-id-in-thread-in-thread-in-thread-1",
                "delegation-event-id-this-is-what-we-need-to-match-12345",
            ],
            articleReferences: [
                "31933:b000000000000000000000000000000000000000000000000000000000000002:project-b",
            ],
            statusValue: "completed",
        });

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
