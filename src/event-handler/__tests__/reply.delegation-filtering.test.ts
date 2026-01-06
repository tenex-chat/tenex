import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { AgentExecutor } from "../../agents/execution/AgentExecutor";
import { handleChatMessage } from "../reply";
import { projectContextStore } from "@/services/projects/ProjectContextStore";

// Mock dependencies
const loggerMocks = {
    info: mock(() => {}),
    error: mock((msg: string, ...args: any[]) => console.error("LOG ERROR:", msg, ...args)),
    warn: mock(() => {}),
    debug: mock(() => {}),
};

mock.module("../../utils/logger", () => ({
    logger: loggerMocks,
}));

// Mock OpenTelemetry
mock.module("@opentelemetry/api", () => ({
    trace: {
        getActiveSpan: mock(() => ({
            addEvent: mock(() => {}),
        })),
    },
}));

// Mock AgentEventDecoder
mock.module("../../nostr/AgentEventDecoder", () => ({
    AgentEventDecoder: {
        isDirectedToSystem: mock((event: any, systemAgents: any) => {
            const pTags = event.tags?.filter((tag: any) => tag[0] === "p") || [];
            if (pTags.length === 0) return false;
            const mentionedPubkeys = pTags.map((tag: any) => tag[1]);
            const systemPubkeys = new Set([...Array.from(systemAgents.values()).map((a: any) => a.pubkey)]);
            return mentionedPubkeys.some((pubkey: string) => systemPubkeys.has(pubkey));
        }),
        isEventFromAgent: mock((event: any, systemAgents: any) => {
            const agentPubkeys = new Set(Array.from(systemAgents.values()).map((a: any) => a.pubkey));
            return agentPubkeys.has(event.pubkey);
        }),
        isDelegationCompletion: mock(() => false),
        isAgentInternalMessage: mock(() => false),
        getMentionedPubkeys: mock(() => []),
        getReplyTarget: mock(() => undefined),
    },
}));

// Mock ConversationResolver and ConversationStore
mock.module("../../conversations/services/ConversationResolver", () => ({
    ConversationResolver: class {
        async resolveConversationForEvent(event: any) {
            return {
                conversation: {
                    id: "conv-root",
                    history: [],
                    phase: "chat",
                    agentStates: new Map(),
                    agentTodos: new Map(),
                    hasEventId: () => false,
                    isAgentBlocked: () => false, // No agents blocked in filtering test
                },
                isNew: false,
            };
        }
    },
}));

mock.module("../../conversations/ConversationStore", () => ({
    ConversationStore: class MockConversationStore {
        static addEvent = mock(() => Promise.resolve());
        static get = mock(() => null);
        static getCachedEvent = mock(() => null);
        static initialize = mock(() => {});
        static projectId = "test-project";
        static systemAgentPubkeys: string[] = [];

        projectId?: string;
        conversationId?: string;

        constructor(_basePath: string) {}
        load(_projectId: string, _conversationId: string) {
            this.projectId = _projectId;
            this.conversationId = _conversationId;
        }
        addMessage(_entry: any) {}
        createRal(_agentPubkey: string) { return 1; }
        ensureRalActive(_agentPubkey: string, _ral: number) {}
        completeRal(_agentPubkey: string, _ral: number) {}
        getAllMessages() { return []; }
        getMessages(_agentPubkey: string, _ral: number) { return []; }
        getRalState(_agentPubkey: string) { return undefined; }
        addInjection(_injection: any) {}
        consumeInjections(_targetRal: any) { return []; }
        hasEventId(_eventId: string) { return false; }
        setEventId(_index: number, _eventId: string) {}
        getMetadata() { return {}; }
        setMetadata(_key: string, _value: any) {}
        updateMetadata(_updates: any) {}
        save() { return Promise.resolve(); }
        getActiveRals(_agentPubkey: string) { return []; }
        isRalActive(_agentPubkey: string, _ral: number) { return false; }
        buildMessagesForRal(_agentPubkey: string, _ral: number) { return []; }
        setTodos(_agentPubkey: string, _todos: any[]) {}
        getTodos(_agentPubkey: string) { return []; }
        getPendingInjections(_agentPubkey: string, _ral: number) { return []; }
        static reset() {}
        static getOrLoad(_conversationId: string) { return null; }
        get executionTime() { return { isActive: false, totalSeconds: 0, lastUpdated: Date.now() }; }
        set executionTime(_value: any) {}
    },
}));

// Mock DelegationCompletionHandler
mock.module("../../event-handler/DelegationCompletionHandler", () => ({
    handleDelegationCompletion: mock(() => Promise.resolve({})),
}));

// Mock AgentRouter
mock.module("../../event-handler/AgentRouter", () => ({
    AgentRouter: {
        resolveDelegationTarget: mock(() => null),
        unblockAgent: mock(() => ({ unblocked: false })),
        resolveTargetAgents: mock((event: any, projectCtx: any, conversation: any) => {
            const pTags = event.tags?.filter((tag: any) => tag[0] === "p") || [];
            const agents: any[] = [];
            for (const tag of pTags) {
                const agent = projectCtx.getAgentByPubkey(tag[1]);
                if (agent && !(conversation?.isAgentBlocked(tag[1]))) {
                    agents.push(agent);
                }
            }
            return agents;
        }),
    },
}));

// Mock RALRegistry - comprehensive mock to avoid polluting other tests
mock.module("../../services/ral", () => ({
    RALRegistry: class MockRALRegistry {
        static instance: MockRALRegistry | undefined;
        static getInstance() {
            if (!MockRALRegistry.instance) {
                MockRALRegistry.instance = new MockRALRegistry();
            }
            return MockRALRegistry.instance;
        }
        create(_agentPubkey: string, _conversationId: string) { return 1; }
        clear(_agentPubkey: string, _conversationId: string) {}
        clearAll() {}
        findResumableRAL() { return null; }
        getState() { return null; }
        getRAL() { return undefined; }
        queueUserMessage() {}
        queueSystemMessage() {}
        setPendingDelegations() {}
        setCompletedDelegations() {}
        setStreaming() {}
        setCurrentTool() {}
        recordCompletion() {}
        findDelegation() { return undefined; }
        getConversationPendingDelegations() { return []; }
        getConversationCompletedDelegations() { return []; }
        shouldWakeUpExecution() { return true; }
        registerAbortController() {}
        getAndConsumeInjections() { return []; }
        getRalKeyForDelegation() { return undefined; }
        abortCurrentTool() {}
        getActiveRALs() { return []; }
        findStateWaitingForDelegation() { return undefined; }
        clearRAL() {}
    },
}));

// Mock MetadataDebounceManager
mock.module("../../conversations/services/MetadataDebounceManager", () => ({
    metadataDebounceManager: {
        markFirstPublishDone: mock(() => {}),
        onAgentStart: mock(() => {}),
        schedulePublish: mock(() => {}),
    },
}));

// Mock ConversationSummarizer
mock.module("../../conversations/services/ConversationSummarizer", () => ({
    ConversationSummarizer: class {
        constructor(projectCtx: any) {}
        async summarizeAndPublish(conversation: any) {}
    },
}));

// Mock createExecutionContext
mock.module("../../agents/execution/ExecutionContextFactory", () => ({
    createExecutionContext: mock(() => Promise.resolve({})),
}));

// Mock ConfigService
mock.module("@/services/ConfigService", () => ({
    config: {
        getConfig: mock(() => ({
            whitelistedPubkeys: [],
        })),
    },
}));

describe("Delegation Event Filtering Bug", () => {
    let mockAgentExecutor: AgentExecutor;
    let mockProjectContext: any;

    beforeEach(() => {
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
    });

    it("delegation event from Execution Coordinator to claude-code DOES trigger claude-code execution", async () => {
        await projectContextStore.run(mockProjectContext, async () => {
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

            // Handle the event
            await handleChatMessage(delegationEvent, {
                agentExecutor: mockAgentExecutor,
            });

            // ASSERTION: Agent executor should be called for claude-code
            expect(mockAgentExecutor.execute).toHaveBeenCalled();

            // Verify that claude-code was the target agent
            const executeCalls = (mockAgentExecutor.execute as any).mock.calls;
            expect(executeCalls.length).toBe(1);
        });
    });

    it("EXPECTED: agent event WITHOUT p-tags should be filtered out", async () => {
        await projectContextStore.run(mockProjectContext, async () => {
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

            // Handle the event
            await handleChatMessage(agentEventNoPtags, {
                agentExecutor: mockAgentExecutor,
            });

            // CORRECT: Agent executor should NOT be called
            expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
        });
    });

    it("EXPECTED: agent event p-tagging NON-system agent should be filtered out", async () => {
        await projectContextStore.run(mockProjectContext, async () => {
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

            // Handle the event
            await handleChatMessage(agentEventNonSystem, {
                agentExecutor: mockAgentExecutor,
            });

            // CORRECT: Agent executor should NOT be called
            expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
        });
    });
});
