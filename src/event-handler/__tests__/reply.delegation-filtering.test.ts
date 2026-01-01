import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { AgentExecutor } from "../../agents/execution/AgentExecutor";
import type { ConversationCoordinator } from "../../conversations";
import { handleChatMessage } from "../reply";

// Mock dependencies
mock.module("../../utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        debug: mock(() => {}),
    },
}));

describe("Delegation Event Filtering Bug", () => {
    let mockConversationCoordinator: ConversationCoordinator;
    let mockAgentExecutor: AgentExecutor;
    let mockProjectContext: any;

    beforeEach(async () => {
        // Reset mocks
        mock.restore();

        // Create mock conversation manager
        mockConversationCoordinator = {
            getConversationByEvent: mock(() => undefined),
            getConversation: mock(() => undefined),
            getTaskMapping: mock(() => undefined),
            createConversation: mock(() => Promise.resolve(undefined)),
            addEvent: mock(() => Promise.resolve()),
            updateAgentState: mock(() => Promise.resolve()),
        } as any;

        // Create mock agent executor
        mockAgentExecutor = {
            execute: mock(() => Promise.resolve()),
        } as any;

        // Create mock project context with Execution Coordinator and claude-code agents
        const execCoordAgent = {
            name: "Execution Coordinator",
            pubkey: "f8db92d0442d62ea954d55398bc3fa76fcbcde85adafdc266c908322f59f179d",
            slug: "execution-coordinator",
            eventId: "exec-coord-event-id",
        };

        const claudeCodeAgent = {
            name: "claude-code",
            pubkey: "ca884a53843ad13d057207686b52b341874c0fa37a28df202f9cf817d81d7f83",
            slug: "claude-code",
            eventId: "claude-code-event-id",
        };

        mockProjectContext = {
            pubkey: "project-pubkey",
            agents: new Map([
                ["execution-coordinator", execCoordAgent],
                ["claude-code", claudeCodeAgent],
            ]),
            getAgent: (slug: string) => mockProjectContext.agents.get(slug),
            getProjectManager: () => execCoordAgent, // Exec Coord is the PM
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
                tagValue: (tag: string) => (tag === "d" ? "test-project" : undefined),
            },
        };

        // Mock getProjectContext
        mock.module("../../services", () => ({
            getProjectContext: () => mockProjectContext,
        }));
    });

    it("delegation event from Execution Coordinator to claude-code DOES trigger claude-code execution", async () => {
        // This test reproduces the bug where:
        // 1. Execution Coordinator delegates to claude-code via delegate
        // 2. The delegation event has pubkey=exec-coord and p-tag=claude-code
        // 3. The event is FROM an agent (isFromAgent=true)
        // 4. The event IS directed to system (isDirectedToSystem=true because claude-code is a system agent)
        // 5. BUG: The event gets filtered out at line 51-66 because of the condition:
        //    if (!isDirectedToSystem && isFromAgent) - which should be false
        // 6. Expected: claude-code should be executed
        // 7. Actual: Event is only added to history, no execution happens

        const delegationEvent: NDKEvent = {
            id: "delegation-event-id",
            pubkey: "f8db92d0442d62ea954d55398bc3fa76fcbcde85adafdc266c908322f59f179d", // Exec Coordinator
            content: "Delegating task to claude-code",
            kind: 1,
            tags: [
                ["E", "conv-root"],
                ["K", "11"],
                ["p", "ca884a53843ad13d057207686b52b341874c0fa37a28df202f9cf817d81d7f83"], // claude-code
            ],
            tagValue: (tag: string) => {
                if (tag === "E") return "conv-root";
                if (tag === "K") return "11";
                return undefined;
            },
            getMatchingTags: (tag: string) => {
                if (tag === "p") {
                    return [
                        ["p", "ca884a53843ad13d057207686b52b341874c0fa37a28df202f9cf817d81d7f83"],
                    ];
                }
                if (tag === "E") return [["E", "conv-root"]];
                return [];
            },
        } as any;

        // Create a mock conversation
        const mockConversation = {
            id: "conv-root",
            history: [],
            phase: "chat",
            agentStates: new Map(),
            agentTodos: new Map(),
        };

        // Update mock to return conversation
        mockConversationCoordinator.getConversationByEvent = mock(() => mockConversation);

        // Handle the event
        await handleChatMessage(delegationEvent, {
            conversationCoordinator: mockConversationCoordinator,
            agentExecutor: mockAgentExecutor,
        });

        // BUG ASSERTION: Agent executor should be called for claude-code
        // Currently this fails because the event is filtered out
        const executeCalls = (mockAgentExecutor.execute as any).mock.calls;
        console.log("Execute calls:", executeCalls.length);
        console.log(
            "addEvent calls:",
            (mockConversationCoordinator.addEvent as any).mock.calls.length
        );

        expect(mockAgentExecutor.execute).toHaveBeenCalled();

        // Verify that claude-code was the target agent
        const executionCall = (mockAgentExecutor.execute as any).mock.calls[0];
        const executionContext = executionCall[0];
        expect(executionContext.agent.slug).toBe("claude-code");
    });

    it("EXPECTED: agent event WITHOUT p-tags should be filtered out", async () => {
        // This is the CORRECT behavior - agent events without p-tags should not trigger execution
        const agentEventNoPtags: NDKEvent = {
            id: "agent-event-no-ptags",
            pubkey: "f8db92d0442d62ea954d55398bc3fa76fcbcde85adafdc266c908322f59f179d", // Exec Coordinator
            content: "Agent status update",
            kind: 1,
            tags: [
                ["E", "conv-root"],
                ["K", "11"],
                // NO p-tags
            ],
            tagValue: (tag: string) => {
                if (tag === "E") return "conv-root";
                if (tag === "K") return "11";
                return undefined;
            },
            getMatchingTags: (tag: string) => {
                if (tag === "p") return []; // No p-tags
                if (tag === "E") return [["E", "conv-root"]];
                return [];
            },
        } as any;

        // Create a mock conversation
        const mockConversation = {
            id: "conv-root",
            history: [],
            phase: "chat",
            agentStates: new Map(),
            agentTodos: new Map(),
        };

        mockConversationCoordinator.getConversationByEvent = mock(() => mockConversation);

        // Handle the event
        await handleChatMessage(agentEventNoPtags, {
            conversationCoordinator: mockConversationCoordinator,
            agentExecutor: mockAgentExecutor,
        });

        // CORRECT: Agent executor should NOT be called
        expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
    });

    it("EXPECTED: agent event p-tagging NON-system agent should be filtered out", async () => {
        // This is the CORRECT behavior - agent events p-tagging non-system agents should not trigger execution
        const agentEventNonSystem: NDKEvent = {
            id: "agent-event-non-system",
            pubkey: "f8db92d0442d62ea954d55398bc3fa76fcbcde85adafdc266c908322f59f179d", // Exec Coordinator
            content: "Message to external user",
            kind: 1,
            tags: [
                ["E", "conv-root"],
                ["K", "11"],
                ["p", "external-user-pubkey"], // Not a system agent
            ],
            tagValue: (tag: string) => {
                if (tag === "E") return "conv-root";
                if (tag === "K") return "11";
                return undefined;
            },
            getMatchingTags: (tag: string) => {
                if (tag === "p") return [["p", "external-user-pubkey"]];
                if (tag === "E") return [["E", "conv-root"]];
                return [];
            },
        } as any;

        // Create a mock conversation
        const mockConversation = {
            id: "conv-root",
            history: [],
            phase: "chat",
            agentStates: new Map(),
            agentTodos: new Map(),
        };

        mockConversationCoordinator.getConversationByEvent = mock(() => mockConversation);

        // Handle the event
        await handleChatMessage(agentEventNonSystem, {
            conversationCoordinator: mockConversationCoordinator,
            agentExecutor: mockAgentExecutor,
        });

        // CORRECT: Agent executor should NOT be called
        expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
    });
});
