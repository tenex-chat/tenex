import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { AgentExecutor } from "../../agents/execution/AgentExecutor";
import * as executionContextFactoryModule from "@/agents/execution/ExecutionContextFactory";
import { ConversationResolver } from "@/conversations/services/ConversationResolver";
import { metadataDebounceManager } from "@/conversations/services/MetadataDebounceManager";
import { ConversationSummarizer } from "@/conversations/services/ConversationSummarizer";
import * as delegationCompletionHandlerModule from "@/services/dispatch/DelegationCompletionHandler";
import { AgentRouter } from "@/services/dispatch/AgentRouter";
import { projectContextStore } from "@/services/projects/ProjectContextStore";
import { config } from "@/services/ConfigService";
import { getCurrentBranchWithFallback } from "@/utils/git/initializeGitRepo";
import { createWorktree, listWorktrees } from "@/utils/git/worktree";
import { logger } from "@/utils/logger";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";

// Mock dependencies
const loggerMocks = {
    info: mock(() => {}),
    error: mock((msg: string, ...args: any[]) => console.error("LOG ERROR:", msg, ...args)),
    warn: mock(() => {}),
    debug: mock(() => {}),
    writeToWarnLog: mock(() => {}),
};

// NOTE: We intentionally do NOT mock ConversationStore at the module level
// because it pollutes other tests. Instead, we use spyOn for specific methods
// or work with the real implementation.

// NOTE: We intentionally do NOT mock RALRegistry at the module level
// because it pollutes other tests. The real implementation is used
// with the test-setup.ts preload resetting it before each test.

// Mock ConfigService
const createExecutionContextMock = async (params: any) => {
    const branchTag = params.triggeringEnvelope?.metadata?.branchName;
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
        triggeringEnvelope: params.triggeringEnvelope,
        agentPublisher: params.agentPublisher,
        isDelegationCompletion: params.isDelegationCompletion,
        hasPendingDelegations: params.hasPendingDelegations,
        debug: params.debug,
        mcpManager: params.mcpManager,
        getConversation: () => undefined,
    };
};

describe("Delegation Event Filtering Bug", () => {
    let handleChatMessage: typeof import("../reply").handleChatMessage;
    let ConversationStore: typeof import("@/conversations/ConversationStore").ConversationStore;
    let mockAgentExecutor: AgentExecutor;
    let mockProjectContext: any;
    let addEnvelopeSpy: ReturnType<typeof spyOn>;
    let createExecutionContextSpy: ReturnType<typeof spyOn>;
    let getConfigSpy: ReturnType<typeof spyOn>;
    let handleDelegationCompletionSpy: ReturnType<typeof spyOn>;
    let resolveConversationSpy: ReturnType<typeof spyOn>;
    let resolveDelegationTargetSpy: ReturnType<typeof spyOn>;
    let unblockAgentSpy: ReturnType<typeof spyOn>;
    let resolveTargetAgentsSpy: ReturnType<typeof spyOn>;
    let markFirstPublishDoneSpy: ReturnType<typeof spyOn>;
    let onAgentStartSpy: ReturnType<typeof spyOn>;
    let schedulePublishSpy: ReturnType<typeof spyOn>;
    let summarizeAndPublishSpy: ReturnType<typeof spyOn>;
    let loggerInfoSpy: ReturnType<typeof spyOn>;
    let loggerErrorSpy: ReturnType<typeof spyOn>;
    let loggerWarnSpy: ReturnType<typeof spyOn>;
    let loggerDebugSpy: ReturnType<typeof spyOn>;
    let loggerWriteToWarnLogSpy: ReturnType<typeof spyOn>;
    let inboundAdapter: { toEnvelope: ReturnType<typeof mock> };

    beforeEach(async () => {
        const cacheBuster = `delegation-filtering-${Date.now()}-${Math.random()}`;
        loggerInfoSpy = spyOn(logger, "info").mockImplementation(loggerMocks.info);
        loggerErrorSpy = spyOn(logger, "error").mockImplementation(loggerMocks.error);
        loggerWarnSpy = spyOn(logger, "warn").mockImplementation(loggerMocks.warn);
        loggerDebugSpy = spyOn(logger, "debug").mockImplementation(loggerMocks.debug);
        loggerWriteToWarnLogSpy = spyOn(logger, "writeToWarnLog").mockImplementation(
            loggerMocks.writeToWarnLog
        );
        resolveConversationSpy = spyOn(
            ConversationResolver.prototype,
            "resolveConversationForEvent"
        ).mockResolvedValue({
            conversation: {
                id: "conv-root",
                history: [],
                phase: "chat",
                agentStates: new Map(),
                agentTodos: new Map(),
                hasEventId: () => false,
                isAgentBlocked: () => false,
            } as any,
            isNew: false,
        });
        resolveDelegationTargetSpy = spyOn(AgentRouter, "resolveDelegationTarget").mockReturnValue(
            null
        );
        unblockAgentSpy = spyOn(AgentRouter, "unblockAgent").mockReturnValue({ unblocked: false });
        resolveTargetAgentsSpy = spyOn(AgentRouter, "resolveTargetAgents").mockImplementation(
            (envelope: any, projectCtx: any, conversation: any) => {
                const recipientPubkeys = (envelope.recipients || [])
                    .map((recipient: any) => recipient.linkedPubkey)
                    .filter(Boolean);
                const agents: any[] = [];
                for (const pubkey of recipientPubkeys) {
                    const agent = projectCtx.getAgentByPubkey(pubkey);
                    if (agent && !(conversation?.isAgentBlocked(pubkey))) {
                        agents.push(agent);
                    }
                }
                return agents;
            }
        );
        markFirstPublishDoneSpy = spyOn(
            metadataDebounceManager,
            "markFirstPublishDone"
        ).mockImplementation(() => undefined);
        onAgentStartSpy = spyOn(metadataDebounceManager, "onAgentStart").mockImplementation(
            () => undefined
        );
        schedulePublishSpy = spyOn(metadataDebounceManager, "schedulePublish").mockImplementation(
            () => undefined
        );
        summarizeAndPublishSpy = spyOn(
            ConversationSummarizer.prototype,
            "summarizeAndPublish"
        ).mockResolvedValue(undefined);

        ({ handleChatMessage } = await import(`../reply?${cacheBuster}`));
        if (!ConversationStore) {
            ({ ConversationStore } = await import("@/conversations/ConversationStore"));
        }
        // Initialize ConversationStore to avoid "must be called before getOrLoad" errors
        ConversationStore.initialize("/tmp/test-metadata");
        // Mock addEnvelope to avoid actual file I/O
        addEnvelopeSpy = spyOn(ConversationStore, "addEnvelope").mockResolvedValue(undefined);
        createExecutionContextSpy = spyOn(executionContextFactoryModule, "createExecutionContext")
            .mockImplementation(createExecutionContextMock);
        getConfigSpy = spyOn(config, "getConfig").mockReturnValue({
            whitelistedPubkeys: [],
        });
        handleDelegationCompletionSpy = spyOn(delegationCompletionHandlerModule, "handleDelegationCompletion")
            .mockResolvedValue({ recorded: false });
        inboundAdapter = {
            toEnvelope: mock(() => createMockInboundEnvelope()),
        };

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
            projectManager: execCoordAgent,
            project: {
                dTag: "test-project",
                tagValue: (tag: string) => (tag === "d" ? "test-project" : undefined),
            },
        };
    });

    afterEach(() => {
        addEnvelopeSpy?.mockRestore();
        createExecutionContextSpy?.mockRestore();
        getConfigSpy?.mockRestore();
        handleDelegationCompletionSpy?.mockRestore();
        resolveConversationSpy?.mockRestore();
        resolveDelegationTargetSpy?.mockRestore();
        unblockAgentSpy?.mockRestore();
        resolveTargetAgentsSpy?.mockRestore();
        markFirstPublishDoneSpy?.mockRestore();
        onAgentStartSpy?.mockRestore();
        schedulePublishSpy?.mockRestore();
        summarizeAndPublishSpy?.mockRestore();
        loggerInfoSpy?.mockRestore();
        loggerErrorSpy?.mockRestore();
        loggerWarnSpy?.mockRestore();
        loggerDebugSpy?.mockRestore();
        loggerWriteToWarnLogSpy?.mockRestore();
        mock.restore();
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

            const delegationEvent: NDKEvent = { id: "delegation-event-id" } as any;
            inboundAdapter.toEnvelope.mockReturnValue(
                createMockInboundEnvelope({
                    channel: {
                        id: "conv-root",
                        transport: "nostr",
                        kind: "conversation",
                    },
                    principal: {
                        id: "f8db92d0442d62ea954d55398bc3fa76fcbcde85adafdc266c908322f59f179d",
                        transport: "nostr",
                        linkedPubkey: "f8db92d0442d62ea954d55398bc3fa76fcbcde85adafdc266c908322f59f179d",
                        kind: "agent",
                    },
                    recipients: [{
                        id: "ca884a53843ad13d057207686b52b341874c0fa37a28df202f9cf817d81d7f83",
                        transport: "nostr",
                        linkedPubkey: "ca884a53843ad13d057207686b52b341874c0fa37a28df202f9cf817d81d7f83",
                        kind: "agent",
                    }],
                    content: "Delegating task to claude-code",
                    metadata: {
                        eventKind: 1,
                    },
                })
            );

            // Handle the event
            await handleChatMessage(delegationEvent, {
                agentExecutor: mockAgentExecutor,
                inboundAdapter,
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
            const agentEventNoPtags: NDKEvent = { id: "agent-event-no-ptags" } as any;
            inboundAdapter.toEnvelope.mockReturnValue(
                createMockInboundEnvelope({
                    channel: {
                        id: "conv-root",
                        transport: "nostr",
                        kind: "conversation",
                    },
                    principal: {
                        id: "f8db92d0442d62ea954d55398bc3fa76fcbcde85adafdc266c908322f59f179d",
                        transport: "nostr",
                        linkedPubkey: "f8db92d0442d62ea954d55398bc3fa76fcbcde85adafdc266c908322f59f179d",
                        kind: "agent",
                    },
                    recipients: [],
                    content: "Agent status update",
                    metadata: {
                        eventKind: 1,
                    },
                })
            );

            // Handle the event
            await handleChatMessage(agentEventNoPtags, {
                agentExecutor: mockAgentExecutor,
                inboundAdapter,
            });

            // CORRECT: Agent executor should NOT be called
            expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
        });
    });

    it("EXPECTED: agent event p-tagging NON-system agent should be filtered out", async () => {
        await projectContextStore.run(mockProjectContext, async () => {
            // This is the CORRECT behavior - agent events p-tagging non-system agents should not trigger execution
            const agentEventNonSystem: NDKEvent = { id: "agent-event-non-system" } as any;
            inboundAdapter.toEnvelope.mockReturnValue(
                createMockInboundEnvelope({
                    channel: {
                        id: "conv-root",
                        transport: "nostr",
                        kind: "conversation",
                    },
                    principal: {
                        id: "f8db92d0442d62ea954d55398bc3fa76fcbcde85adafdc266c908322f59f179d",
                        transport: "nostr",
                        linkedPubkey: "f8db92d0442d62ea954d55398bc3fa76fcbcde85adafdc266c908322f59f179d",
                        kind: "agent",
                    },
                    recipients: [{
                        id: "external-user-pubkey",
                        transport: "nostr",
                        linkedPubkey: "external-user-pubkey",
                        kind: "human",
                    }],
                    content: "Message to external user",
                    metadata: {
                        eventKind: 1,
                    },
                })
            );

            // Handle the event
            await handleChatMessage(agentEventNonSystem, {
                agentExecutor: mockAgentExecutor,
                inboundAdapter,
            });

            // CORRECT: Agent executor should NOT be called
            expect(mockAgentExecutor.execute).not.toHaveBeenCalled();
        });
    });
});
