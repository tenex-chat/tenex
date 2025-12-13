import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { handleChatMessage } from "../reply";
import { projectContextStore } from "../../services/ProjectContextStore";

describe("Agent Phase Self-Reply", () => {
    let mockConversationCoordinator: any;
    let mockAgentExecutor: any;
    let mockProjectContext: any;

    beforeEach(() => {
        // Reset all mocks
        mock.restore();

        // Create mock conversation coordinator
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

        // Create mock project context with agents that have phases
        const pmAgent = {
            name: "pm-with-phases",
            pubkey: "pm-phases-pubkey",
            slug: "pm-with-phases",
            eventId: "pm-phases-event-id",
            phases: {
                planning: "Planning phase instructions",
                execution: "Execution phase instructions",
            },
            tools: ["delegate", "phase_add", "phase_remove"], // Has phases so can self-delegate
        };

        const regularAgent = {
            name: "regular-agent",
            pubkey: "regular-agent-pubkey",
            slug: "regular-agent",
            eventId: "regular-event-id",
            tools: ["delegate", "shell"], // No phases, cannot self-delegate
        };

        mockProjectContext = {
            pubkey: "project-pubkey",
            agents: new Map([
                ["pm-with-phases", pmAgent],
                ["regular-agent", regularAgent],
            ]),
            getAgent: (slug: string) => mockProjectContext.agents.get(slug),
            getProjectManager: () => pmAgent,
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
    });

    it("should allow agents with phases to process their own p-tag (phase transition)", async () => {
        // Create an event from PM with phases p-tagging itself
        const selfReplyEvent: NDKEvent = {
            id: "event-self-phase",
            pubkey: "pm-phases-pubkey", // PM's pubkey
            content: "Switching to execution phase",
            kind: 1111,
            tags: [
                ["E", "conv-root"],
                ["K", "11"],
                ["p", "pm-phases-pubkey"], // P-tagging itself for phase transition
            ],
            tagValue: (tag: string) => {
                if (tag === "E") return "conv-root";
                if (tag === "K") return "11";
                if (tag === "p") return "pm-phases-pubkey";
                return undefined;
            },
            getMatchingTags: (tag: string) => {
                if (tag === "p") return [["p", "pm-phases-pubkey"]];
                return [];
            },
        } as any;

        // Create a mock conversation
        const mockConversation = {
            id: "conv-root",
            history: [],
            phase: "planning",
            agentStates: new Map(),
        };

        // Update mock to return conversation
        mockConversationCoordinator.getConversationByEvent = mock(() => mockConversation);

        // Handle the event within project context
        await projectContextStore.run(mockProjectContext as any, async () => {
            await handleChatMessage(selfReplyEvent, {
                conversationCoordinator: mockConversationCoordinator,
                agentExecutor: mockAgentExecutor,
            });
        });

        // Agent executor SHOULD be called because PM has phases defined
        expect(mockAgentExecutor.execute).toHaveBeenCalledTimes(1);

        // Verify the PM was executed (allowed self-reply)
        const executionCall = (mockAgentExecutor.execute as any).mock.calls[0];
        const executionContext = executionCall[0];
        expect(executionContext.agent.slug).toBe("pm-with-phases");
    });

    it("should block self-reply for agents WITHOUT phases defined", async () => {
        // Create an event from regular agent p-tagging itself
        const selfReplyEvent: NDKEvent = {
            id: "event-regular-self",
            pubkey: "regular-agent-pubkey", // Regular agent's pubkey
            content: "Trying to reply to myself",
            kind: 1111,
            tags: [
                ["E", "conv-root"],
                ["K", "11"],
                ["p", "regular-agent-pubkey"], // P-tagging itself (not allowed)
            ],
            tagValue: (tag: string) => {
                if (tag === "E") return "conv-root";
                if (tag === "K") return "11";
                if (tag === "p") return "regular-agent-pubkey";
                return undefined;
            },
            getMatchingTags: (tag: string) => {
                if (tag === "p") return [["p", "regular-agent-pubkey"]];
                return [];
            },
        } as any;

        // Create a mock conversation
        const mockConversation = {
            id: "conv-root",
            history: [],
            phase: "chat",
            agentStates: new Map(),
        };

        // Update mock to return conversation
        mockConversationCoordinator.getConversationByEvent = mock(() => mockConversation);

        // Handle the event within project context
        await projectContextStore.run(mockProjectContext as any, async () => {
            await handleChatMessage(selfReplyEvent, {
                conversationCoordinator: mockConversationCoordinator,
                agentExecutor: mockAgentExecutor,
            });
        });

        // Agent executor should NOT be called (self-reply blocked)
        expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
    });

    it("should allow mixed routing: agent with phases self-reply + other agents", async () => {
        // Create an event from PM p-tagging both itself and another agent
        const mixedEvent: NDKEvent = {
            id: "event-mixed",
            pubkey: "pm-phases-pubkey", // PM's pubkey
            content: "Phase transition and delegation",
            kind: 1111,
            tags: [
                ["E", "conv-root"],
                ["K", "11"],
                ["p", "pm-phases-pubkey"], // P-tagging itself (allowed since agent has phases)
                ["p", "regular-agent-pubkey"], // Also p-tagging regular agent
            ],
            tagValue: (tag: string) => {
                if (tag === "E") return "conv-root";
                if (tag === "K") return "11";
                // Return first p-tag value for backward compatibility
                if (tag === "p") return "pm-phases-pubkey";
                return undefined;
            },
            getMatchingTags: (tag: string) => {
                if (tag === "p")
                    return [
                        ["p", "pm-phases-pubkey"],
                        ["p", "regular-agent-pubkey"],
                    ];
                return [];
            },
        } as any;

        // Create a mock conversation
        const mockConversation = {
            id: "conv-root",
            history: [],
            phase: "planning",
            agentStates: new Map(),
        };

        // Update mock to return conversation
        mockConversationCoordinator.getConversationByEvent = mock(() => mockConversation);

        // Handle the event within project context
        await projectContextStore.run(mockProjectContext as any, async () => {
            await handleChatMessage(mixedEvent, {
                conversationCoordinator: mockConversationCoordinator,
                agentExecutor: mockAgentExecutor,
            });
        });

        // Agent executor should be called twice (PM self-reply allowed + regular agent)
        expect(mockAgentExecutor.execute).toHaveBeenCalledTimes(2);

        // Verify both agents were executed
        const calls = (mockAgentExecutor.execute as any).mock.calls;
        const executedAgents = calls.map((call: any[]) => call[0].agent.slug);

        // Both agents should be executed
        expect(executedAgents).toContain("pm-with-phases");
        expect(executedAgents).toContain("regular-agent");
    });
});
