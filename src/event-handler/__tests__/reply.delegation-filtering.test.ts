import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { AgentExecutor } from "../../agents/execution/AgentExecutor";
import * as executionContextFactoryModule from "@/agents/execution/ExecutionContextFactory";
import * as delegationCompletionHandlerModule from "@/services/dispatch/DelegationCompletionHandler";
import { projectContextStore } from "@/services/projects/ProjectContextStore";
import { config } from "@/services/ConfigService";
import { getCurrentBranchWithFallback } from "@/utils/git/initializeGitRepo";
import { createWorktree, listWorktrees } from "@/utils/git/worktree";

// Mock dependencies
const loggerMocks = {
    info: mock(() => {}),
    error: mock((msg: string, ...args: any[]) => console.error("LOG ERROR:", msg, ...args)),
    warn: mock(() => {}),
    debug: mock(() => {}),
};

mock.module("@/utils/logger", () => ({
    logger: loggerMocks,
}));

// Mock AgentEventDecoder
mock.module("@/nostr/AgentEventDecoder", () => ({
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
mock.module("@/conversations/services/ConversationResolver", () => ({
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

// NOTE: We intentionally do NOT mock ConversationStore at the module level
// because it pollutes other tests. Instead, we use spyOn for specific methods
// or work with the real implementation.

// Mock AgentRouter
mock.module("@/services/dispatch/AgentRouter", () => ({
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

// NOTE: We intentionally do NOT mock RALRegistry at the module level
// because it pollutes other tests. The real implementation is used
// with the test-setup.ts preload resetting it before each test.

// Mock MetadataDebounceManager
mock.module("@/conversations/services/MetadataDebounceManager", () => ({
    metadataDebounceManager: {
        markFirstPublishDone: mock(() => {}),
        onAgentStart: mock(() => {}),
        schedulePublish: mock(() => {}),
    },
}));

// Mock ConversationSummarizer
mock.module("@/conversations/services/ConversationSummarizer", () => ({
    ConversationSummarizer: class {
        constructor(projectCtx: any) {}
        async summarizeAndPublish(conversation: any) {}
    },
}));

// Mock ConfigService
const createExecutionContextMock = async (params: any) => {
    const branchTag = params.triggeringEvent?.tags?.find((tag: string[]) => tag[0] === "branch")?.[1];
    let workingDirectory = params.projectBasePath;
    let currentBranch = "master";

    try {
        if (branchTag) {
            const worktrees = await listWorktrees(params.projectBasePath);
            const matchingWorktree = worktrees.find((wt) => wt.branch === branchTag);

            if (matchingWorktree) {
                workingDirectory = matchingWorktree.path;
                currentBranch = branchTag;
            } else {
                const baseBranch = await getCurrentBranchWithFallback(params.projectBasePath);
                workingDirectory = await createWorktree(params.projectBasePath, branchTag, baseBranch);
                currentBranch = branchTag;
            }
        } else {
            currentBranch = await getCurrentBranchWithFallback(params.projectBasePath);
        }
    } catch {
        workingDirectory = params.projectBasePath;
    }

    return {
        agent: params.agent,
        conversationId: params.conversationId,
        projectBasePath: params.projectBasePath,
        workingDirectory,
        currentBranch,
        triggeringEvent: params.triggeringEvent,
        agentPublisher: params.agentPublisher,
        isDelegationCompletion: params.isDelegationCompletion,
        hasPendingDelegations: params.hasPendingDelegations,
        debug: params.debug,
        alphaMode: false,
        mcpManager: params.mcpManager,
        getConversation: () => undefined,
    };
};

describe("Delegation Event Filtering Bug", () => {
    let handleChatMessage: typeof import("../reply").handleChatMessage;
    let ConversationStore: typeof import("@/conversations/ConversationStore").ConversationStore;
    let mockAgentExecutor: AgentExecutor;
    let mockProjectContext: any;
    let addEventSpy: ReturnType<typeof spyOn>;
    let createExecutionContextSpy: ReturnType<typeof spyOn>;
    let getConfigSpy: ReturnType<typeof spyOn>;
    let handleDelegationCompletionSpy: ReturnType<typeof spyOn>;

    beforeEach(async () => {
        if (!handleChatMessage) {
            ({ handleChatMessage } = await import("../reply"));
        }
        if (!ConversationStore) {
            ({ ConversationStore } = await import("@/conversations/ConversationStore"));
        }
        // Initialize ConversationStore to avoid "must be called before getOrLoad" errors
        ConversationStore.initialize("/tmp/test-metadata");
        // Mock addEvent to avoid actual file I/O
        addEventSpy = spyOn(ConversationStore, "addEvent").mockResolvedValue(undefined);
        createExecutionContextSpy = spyOn(executionContextFactoryModule, "createExecutionContext")
            .mockImplementation(createExecutionContextMock);
        getConfigSpy = spyOn(config, "getConfig").mockReturnValue({
            whitelistedPubkeys: [],
        });
        handleDelegationCompletionSpy = spyOn(delegationCompletionHandlerModule, "handleDelegationCompletion")
            .mockResolvedValue({ recorded: false });

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

    afterEach(() => {
        addEventSpy?.mockRestore();
        createExecutionContextSpy?.mockRestore();
        getConfigSpy?.mockRestore();
        handleDelegationCompletionSpy?.mockRestore();
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
