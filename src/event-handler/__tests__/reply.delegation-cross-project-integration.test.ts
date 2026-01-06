import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentEventDecoder } from "@/nostr/AgentEventDecoder";
import { projectContextStore } from "@/services/projects/ProjectContextStore";

/**
 * Integration Test: Cross-Project Agent Routing via handleChatMessage
 *
 * This test validates that handleChatMessage correctly routes events from external agents
 * to local agents, even when the sender is not in the local system.
 *
 * The key issue being fixed:
 * - AgentEventDecoder.isDirectedToSystem() should return true if ANY p-tagged agent
 *   is in the local system, regardless of whether the sender is a local agent.
 * - The check "!isDirectedToSystem && isFromAgent" should not block cross-project replies.
 */

describe("Cross-Project Integration: handleChatMessage Routing", () => {
    let mockProjectContext: any;

    beforeEach(() => {
        const agentA = {
            name: "Agent A",
            pubkey: "a000000000000000000000000000000000000000000000000000000000000001",
            slug: "agent-a",
            role: "coordinator",
            phases: {},
        };

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
    });

    it("should identify event as directed-to-system when external agent p-tags local agent", async () => {
        await projectContextStore.run(mockProjectContext, async () => {
            // External agent B sends a message to local Agent A
            // This should be identified as "directed to system"

            const externalAgentEvent: NDKEvent = {
                id: "external-agent-message-1",
                pubkey: "b000000000000000000000000000000000000000000000000000000000000002", // External Agent B
                content: "Please process this request",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    // P-tag pointing to local Agent A
                    ["p", "a000000000000000000000000000000000000000000000000000000000000001"],
                    ["e", "some-event-id"],
                ],
                getMatchingTags: function (tagName: string) {
                    return this.tags.filter((tag) => tag[0] === tagName);
                },
                tagValue: function (tagName: string) {
                    const tags = this.getMatchingTags(tagName);
                    return tags.length > 0 ? tags[0][1] : undefined;
                },
            } as any;

            // Act: Check if this event is directed to the system
            const isDirectedToSystem = AgentEventDecoder.isDirectedToSystem(externalAgentEvent, mockProjectContext.agents);
            const isFromAgent = AgentEventDecoder.isEventFromAgent(externalAgentEvent, mockProjectContext.agents);

            // Assert: Should be directed to system (because Agent A is p-tagged)
            // and not from an agent (because sender is external)
            expect(isDirectedToSystem).toBe(true);
            expect(isFromAgent).toBe(false);
        });
    });

    it("should NOT block routing when event is from external agent but directed to local agent", async () => {
        await projectContextStore.run(mockProjectContext, async () => {
            // The critical logic in handleChatMessage:
            // if (!isDirectedToSystem && isFromAgent) { return; }
            //
            // This test ensures that EXTERNAL agents can send to LOCAL agents.
            // The condition should only block when:
            // - NOT directed to system AND
            // - IS from an agent
            //
            // In cross-project scenario:
            // - isDirectedToSystem = true (Agent A is p-tagged and local)
            // - isFromAgent = false (Agent B is external)
            // - Condition: !true && false = false && false = false (don't block)

            const externalAgentEvent: NDKEvent = {
                id: "cross-project-completion",
                pubkey: "b000000000000000000000000000000000000000000000000000000000000002", // External
                content: "Task completed successfully",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ["p", "a000000000000000000000000000000000000000000000000000000000000001"], // Local Agent A
                    ["e", "delegation-event-id"],
                    ["status", "completed"],
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

            const isDirectedToSystem = AgentEventDecoder.isDirectedToSystem(externalAgentEvent, mockProjectContext.agents);
            const isFromAgent = AgentEventDecoder.isEventFromAgent(externalAgentEvent, mockProjectContext.agents);

            // The problematic condition from handleChatMessage
            const shouldBlock = !isDirectedToSystem && isFromAgent;

            // Assert: Should NOT block this event
            expect(isDirectedToSystem).toBe(true);
            expect(isFromAgent).toBe(false);
            expect(shouldBlock).toBe(false); // Should NOT block
        });
    });

    it("should properly handle normal agent-to-agent communication (same project)", async () => {
        await projectContextStore.run(mockProjectContext, async () => {
            // When both agents are local, event should be directed to system
            // and should NOT be blocked (even though it's from an agent)

            const agentB = {
                name: "Agent B",
                pubkey: "b000000000000000000000000000000000000000000000000000000000000002",
                slug: "agent-b",
                role: "worker",
                phases: {},
            };
            mockProjectContext.agents.set("agent-b", agentB);

            const agentToAgentEvent: NDKEvent = {
                id: "agent-b-to-agent-a",
                pubkey: "b000000000000000000000000000000000000000000000000000000000000002", // Local Agent B
                content: "Can you help with this?",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ["p", "a000000000000000000000000000000000000000000000000000000000000001"], // Local Agent A
                    ["e", "original-event-id"],
                ],
                getMatchingTags: function (tagName: string) {
                    return this.tags.filter((tag) => tag[0] === tagName);
                },
                tagValue: function (tagName: string) {
                    const tags = this.getMatchingTags(tagName);
                    return tags.length > 0 ? tags[0][1] : undefined;
                },
            } as any;

            const isDirectedToSystem = AgentEventDecoder.isDirectedToSystem(agentToAgentEvent, mockProjectContext.agents);
            const isFromAgent = AgentEventDecoder.isEventFromAgent(agentToAgentEvent, mockProjectContext.agents);

            // Agent B is sending to Agent A (both local)
            expect(isDirectedToSystem).toBe(true);
            expect(isFromAgent).toBe(true);
            // Even though it's from an agent, it IS directed to system, so:
            // !true && true = false && true = false (don't block)
        });
    });

    it("should properly handle orphaned agent messages (agent sending without p-tags)", async () => {
        await projectContextStore.run(mockProjectContext, async () => {
            // When an agent sends without p-tags to any system member:
            // - isDirectedToSystem = false
            // - isFromAgent = true
            // - shouldBlock = true (correct behavior - add to history but don't process)

            const agentB = {
                name: "Agent B",
                pubkey: "b000000000000000000000000000000000000000000000000000000000000002",
                slug: "agent-b",
                role: "worker",
                phases: {},
            };
            mockProjectContext.agents.set("agent-b", agentB);

            const orphanedAgentEvent: NDKEvent = {
                id: "agent-orphaned-message",
                pubkey: "b000000000000000000000000000000000000000000000000000000000000002", // Local Agent B
                content: "Random message without any p-tags",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [["e", "some-event-id"]], // No p-tags
                getMatchingTags: function (tagName: string) {
                    return this.tags.filter((tag) => tag[0] === tagName);
                },
                tagValue: function (tagName: string) {
                    const tags = this.getMatchingTags(tagName);
                    return tags.length > 0 ? tags[0][1] : undefined;
                },
            } as any;

            const isDirectedToSystem = AgentEventDecoder.isDirectedToSystem(orphanedAgentEvent, mockProjectContext.agents);
            const isFromAgent = AgentEventDecoder.isEventFromAgent(orphanedAgentEvent, mockProjectContext.agents);
            const shouldBlock = !isDirectedToSystem && isFromAgent;

            // Should block orphaned agent messages
            expect(isDirectedToSystem).toBe(false);
            expect(isFromAgent).toBe(true);
            expect(shouldBlock).toBe(true); // Should block
        });
    });

    it("should NOT block external user messages (not from agent, p-tags local agent)", async () => {
        await projectContextStore.run(mockProjectContext, async () => {
            // User (not an agent) sends message to local Agent A
            // - isDirectedToSystem = true (Agent A is p-tagged)
            // - isFromAgent = false (sender is not an agent)
            // - shouldBlock = false (don't block)

            const userEvent: NDKEvent = {
                id: "user-message-to-agent",
                pubkey: "user000000000000000000000000000000000000000000000000000000000000", // Random user
                content: "Please help me with this task",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                    ["p", "a000000000000000000000000000000000000000000000000000000000000001"], // Local Agent A
                    ["e", "parent-event"],
                ],
                getMatchingTags: function (tagName: string) {
                    return this.tags.filter((tag) => tag[0] === tagName);
                },
                tagValue: function (tagName: string) {
                    const tags = this.getMatchingTags(tagName);
                    return tags.length > 0 ? tags[0][1] : undefined;
                },
            } as any;

            const isDirectedToSystem = AgentEventDecoder.isDirectedToSystem(userEvent, mockProjectContext.agents);
            const isFromAgent = AgentEventDecoder.isEventFromAgent(userEvent, mockProjectContext.agents);
            const shouldBlock = !isDirectedToSystem && isFromAgent;

            // Should NOT block user messages to agents
            expect(isDirectedToSystem).toBe(true);
            expect(isFromAgent).toBe(false);
            expect(shouldBlock).toBe(false); // Don't block
        });
    });
});
