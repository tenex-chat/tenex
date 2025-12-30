import { describe, expect, it, beforeEach } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";
import { AgentRouter } from "../AgentRouter";
import type { ProjectContext } from "@/services/projects";
import type { AgentInstance } from "@/agents/types";
import type { ConversationStore } from "@/conversations/ConversationStore";
import { RALRegistry } from "@/services/ral";

/**
 * Stop Signal (kind 24134) Tests
 *
 * When a stop signal is received:
 * 1. The p-tagged agent should be blocked in the referenced conversation
 * 2. The blocked agent cannot be retriggered in that conversation
 * 3. Only whitelisted pubkeys can unblock the agent
 * 4. The agent continues to work in other conversations
 */
describe("Stop Signal (kind 24134)", () => {
    // Mock data
    const agentPubkey = "agent123pubkey000000000000000000000000000000000000000000000000";
    const conversationId = "conv123id0000000000000000000000000000000000000000000000000000";
    const conversationId2 = "conv789id0000000000000000000000000000000000000000000000000000";
    const userPubkey = "user456pubkey000000000000000000000000000000000000000000000000";
    const whitelistedPubkey = "whitelist000000000000000000000000000000000000000000000000000";

    const mockAgent: AgentInstance = {
        pubkey: agentPubkey,
        slug: "test-agent",
        name: "Test Agent",
        description: "A test agent",
        systemPrompt: "You are a test agent",
        model: "gpt-4",
        tools: [],
        toolNames: [],
    };

    let mockProjectContext: ProjectContext;
    let blockedAgents: Set<string>;

    function createMockConversationStore(id: string, blocked: Set<string>): ConversationStore {
        return {
            id,
            isAgentBlocked: (pubkey: string) => blocked.has(pubkey),
            blockAgent: (pubkey: string) => { blocked.add(pubkey); },
            unblockAgent: (pubkey: string) => { blocked.delete(pubkey); },
        } as unknown as ConversationStore;
    }

    beforeEach(() => {
        // Create fresh blocked agents set for each test
        blockedAgents = new Set<string>();

        mockProjectContext = {
            agents: new Map([[agentPubkey, mockAgent]]),
            getAgentByPubkey: (pubkey: string) =>
                pubkey === agentPubkey ? mockAgent : undefined,
            getAgentSlugs: () => ["test-agent"],
        } as unknown as ProjectContext;
    });

    describe("Agent blocking in conversation", () => {
        it("blocks a p-tagged agent when stop signal is received", () => {
            // Given: A stop signal event p-tagging an agent and e-tagging a conversation
            const stopEvent = new NDKEvent();
            stopEvent.kind = NDKKind.TenexStopCommand;
            stopEvent.pubkey = userPubkey;
            stopEvent.tags = [
                ["p", agentPubkey],
                ["e", conversationId],
            ];

            const mockConversation = createMockConversationStore(conversationId, blockedAgents);

            // When: The stop signal is processed
            const result = AgentRouter.processStopSignal(
                stopEvent,
                mockConversation,
                mockProjectContext
            );

            // Then: The agent should be blocked in this conversation
            expect(result.blocked).toBe(true);
            expect(blockedAgents.has(agentPubkey)).toBe(true);
        });
    });

    describe("Blocked agent routing", () => {
        it("does not route to a blocked agent", () => {
            // Given: An agent that is blocked in the conversation
            blockedAgents.add(agentPubkey);
            const mockConversation = createMockConversationStore(conversationId, blockedAgents);

            // And: A chat message p-tagging that agent
            const chatEvent = new NDKEvent();
            chatEvent.kind = NDKKind.GenericReply;
            chatEvent.pubkey = userPubkey;
            chatEvent.tags = [["p", agentPubkey]];

            // When: We resolve target agents
            const targetAgents = AgentRouter.resolveTargetAgents(
                chatEvent,
                mockProjectContext,
                mockConversation
            );

            // Then: The blocked agent should not be in the list
            expect(targetAgents).toHaveLength(0);
        });

        it("routes to non-blocked agents in same conversation", () => {
            // Given: One agent is blocked, another is not
            const agent2Pubkey = "agent789pubkey000000000000000000000000000000000000000000000000";
            const mockAgent2: AgentInstance = {
                ...mockAgent,
                pubkey: agent2Pubkey,
                slug: "test-agent-2",
                name: "Test Agent 2",
            };

            mockProjectContext.agents.set(agent2Pubkey, mockAgent2);
            (mockProjectContext as any).getAgentByPubkey = (pubkey: string) => {
                if (pubkey === agentPubkey) return mockAgent;
                if (pubkey === agent2Pubkey) return mockAgent2;
                return undefined;
            };

            // Block only the first agent
            blockedAgents.add(agentPubkey);
            const mockConversation = createMockConversationStore(conversationId, blockedAgents);

            // And: A chat message p-tagging both agents
            const chatEvent = new NDKEvent();
            chatEvent.kind = NDKKind.GenericReply;
            chatEvent.pubkey = userPubkey;
            chatEvent.tags = [
                ["p", agentPubkey],
                ["p", agent2Pubkey],
            ];

            // When: We resolve target agents
            const targetAgents = AgentRouter.resolveTargetAgents(
                chatEvent,
                mockProjectContext,
                mockConversation
            );

            // Then: Only the non-blocked agent should be routed
            expect(targetAgents).toHaveLength(1);
            expect(targetAgents[0].pubkey).toBe(agent2Pubkey);
        });
    });

    describe("Whitelisted pubkey unblocking", () => {
        it("allows whitelisted pubkey to unblock an agent", () => {
            // Given: An agent is blocked in a conversation
            blockedAgents.add(agentPubkey);
            const mockConversation = createMockConversationStore(conversationId, blockedAgents);

            // And: A whitelist is configured
            const whitelist = new Set([whitelistedPubkey]);

            // When: A whitelisted user sends a message p-tagging the blocked agent
            const chatEvent = new NDKEvent();
            chatEvent.kind = NDKKind.GenericReply;
            chatEvent.pubkey = whitelistedPubkey;
            chatEvent.tags = [["p", agentPubkey]];

            // Then: The agent should be unblocked
            const result = AgentRouter.unblockAgent(
                chatEvent,
                mockConversation,
                mockProjectContext,
                whitelist
            );

            expect(result.unblocked).toBe(true);
            expect(blockedAgents.has(agentPubkey)).toBe(false);
        });

        it("does not allow non-whitelisted pubkey to unblock an agent", () => {
            // Given: An agent is blocked in a conversation
            blockedAgents.add(agentPubkey);
            const mockConversation = createMockConversationStore(conversationId, blockedAgents);

            // And: A whitelist that does NOT include the sender
            const whitelist = new Set([whitelistedPubkey]);

            // When: A non-whitelisted user sends a message p-tagging the blocked agent
            const chatEvent = new NDKEvent();
            chatEvent.kind = NDKKind.GenericReply;
            chatEvent.pubkey = userPubkey; // Not in whitelist
            chatEvent.tags = [["p", agentPubkey]];

            // Then: The agent should remain blocked
            const result = AgentRouter.unblockAgent(
                chatEvent,
                mockConversation,
                mockProjectContext,
                whitelist
            );

            expect(result.unblocked).toBe(false);
            expect(blockedAgents.has(agentPubkey)).toBe(true);
        });
    });

    describe("Conversation isolation", () => {
        it("blocked agent in one conversation can still work in other conversations", () => {
            // Given: Agent is blocked in conversation 1
            blockedAgents.add(agentPubkey);

            // And: A second conversation where agent is NOT blocked
            const blockedAgents2 = new Set<string>(); // Empty - agent not blocked here
            const conversation2 = createMockConversationStore(conversationId2, blockedAgents2);

            // When: Routing in conversation 2
            const chatEvent = new NDKEvent();
            chatEvent.kind = NDKKind.GenericReply;
            chatEvent.pubkey = userPubkey;
            chatEvent.tags = [["p", agentPubkey]];

            const targetAgents = AgentRouter.resolveTargetAgents(
                chatEvent,
                mockProjectContext,
                conversation2
            );

            // Then: Agent should be routed in conversation 2
            expect(targetAgents).toHaveLength(1);
            expect(targetAgents[0].pubkey).toBe(agentPubkey);
        });
    });

    describe("RAL abortion on stop signal", () => {
        it("aborts all running RALs for the blocked agent in conversation", () => {
            // Given: RALRegistry has active RALs for the agent
            const ralRegistry = RALRegistry.getInstance();
            ralRegistry.clearAll(); // Clean state

            // Create a RAL with an abort controller
            const abortController = new AbortController();
            const ralNumber = ralRegistry.create(agentPubkey, conversationId, "trigger-event-id");
            ralRegistry.registerAbortController(agentPubkey, conversationId, ralNumber, abortController);

            const mockConversation = createMockConversationStore(conversationId, blockedAgents);

            // When: Stop signal is processed
            const stopEvent = new NDKEvent();
            stopEvent.kind = NDKKind.TenexStopCommand;
            stopEvent.pubkey = userPubkey;
            stopEvent.tags = [
                ["p", agentPubkey],
                ["e", conversationId],
            ];

            // Process stop signal and abort RALs
            AgentRouter.processStopSignal(stopEvent, mockConversation, mockProjectContext);
            ralRegistry.abortAllForAgent(agentPubkey, conversationId);

            // Then: The abort controller should be aborted
            expect(abortController.signal.aborted).toBe(true);
        });
    });
});
