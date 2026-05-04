import { readFileSync } from "node:fs";
import path from "node:path";
import type { Event, EventTemplate, SimplePool } from "nostr-tools";
import {
    decrypt as nip44Decrypt,
    encrypt as nip44Encrypt,
    getConversationKey,
} from "nostr-tools/nip44";
import {
    messageText,
    waitForStoredMessage,
    type ConversationMonitor,
} from "./tenex-runtime-probe-conversations";
import {
    pmShellKillDuplicateInstructions,
    runShellKillDuplicateProbe,
    shellKillDuplicateMockScenario,
} from "./tenex-runtime-probe-shell-scenario";
import {
    runTodoStopProbe,
    todoStopMockScenario,
    todoStopPmInstructions,
} from "./tenex-runtime-probe-todo-stop";
import {
    learnCompletionText,
    learnMockScenario,
    learnPmInstructions,
    learnUserRequest,
    runLearnProbe,
} from "./tenex-runtime-probe-learn";
import {
    ragMockScenario,
    ragPmInstructions,
    ragSelfUserRequest,
    runRagDocumentsProbe,
} from "./tenex-runtime-probe-rag";
import {
    askCompletionText,
    askMockScenario,
    askPmInstructions,
    askTitle,
    askUserRequest,
    runAskProbe,
} from "./tenex-runtime-probe-ask";

export const availableScenarios = [
    "delegation-basic",
    "delegation-self",
    "delegation-crossproject",
    "same-agent-concurrency",
    "fs-read-adjustment",
    "mcp-tool-basic",
    "mcp-resource-basic",
    "acp-worker-basic",
    "acp-delegation-mcp",
    "agent-config-reload",
    "agent-config-update",
    "project-membership-reload",
    "shell-kill-duplicate",
    "root-agents-md",
    "nested-agents-md",
    "conversation-reminders",
    "todo-stop",
    "learn-tool",
    "rag-documents",
    "ask-owner",
    "sign-as-user-nip46",
    "backend-kind1-routing",
] as const;

export type ScenarioName = (typeof availableScenarios)[number];

export type MockRequestRecord = {
    agent: string;
    model: string;
    turn: number;
    matchedIndex?: number | null;
    delayMs: number;
    timestampMs: number;
    requestDebug: string;
    content?: string | null;
    toolCalls?: string[];
};

export const delegationUserRequest =
    "Please delegate to worker and ask them to choose one random color. Tell me what they picked.";
export const selfDelegationUserRequest =
    "Use the self_delegate tool to schedule a follow-on for yourself. The follow-on request must be exactly: Reply with the single word done. Do not perform the work this turn; just call self_delegate and stop.";
export const selfDelegationFollowupRequest =
    "Reply with the single word done.";
export const selfDelegationCompletionToken = "done";
export const crossProjectDelegationUserRequest =
    "Use delegate_crossproject to ask worker in project 'probe-crossproject-b' to choose one random color. Then report the color to me.";
export const crossProjectProjectADtag = "probe-crossproject-a";
export const crossProjectProjectBDtag = "probe-crossproject-b";
export const acpDelegationMcpUserRequest =
    "Use the TENEX MCP delegate tool, not the backend Task tool, to ask worker to choose one random color.";
export const delegationWorkerPrompt =
    "Choose one random color. Reply with exactly one lowercase color word and no punctuation.";
export const delegationWorkerCompletionText = "blue";
export const acpProbeModelName = "probe-acp";
export const agentConfigUpdateModelName = "mock-updated";
export const agentConfigUpdateSkills = ["read-access", "shell", "write-access"] as const;
export const rootAgentsMdInstruction = "ROOT_AGENTS_MD_PROBE";
export const worktreeAgentsMdInstruction = "WORKTREE_AGENTS_MD_SHOULD_NOT_APPEAR";
export const mcpResourceContentText = "MCP resource content: project-context-resource";
export const mcpResourceUpdateId = "subscription-update-1";
export const mcpResourceFinalText = "MCP subscription final: update received.";
export const nestedAgentsMdRootInstruction = "ROOT_AGENTS_MD_NESTED_PROBE";
export const nestedAgentsMdReadInstruction = "NESTED_AGENTS_MD_READ_PROBE";
export const nestedAgentsMdGlobInstruction = "DEEP_AGENTS_MD_GLOB_PROBE";
export const nestedAgentsMdCompletionText = "Nested AGENTS reminders observed.";
export const convProbeFirstMessage = "CONVO_PROBE_FIRST";
export const convReminderProbeMessage = "CONVO_REMINDER_PROBE";
export const convReminderCompletionText = "conversation reminders observed.";
export const signAsUserRequest =
    "Use sign_as_user to sign the TENEX runtime probe event as the project owner.";
export const signAsUserSignedContent = "SIGN_AS_USER_NIP46_PROBE_SIGNED_EVENT";
export const signAsUserExplanation =
    "TENEX runtime probe verifying sign_as_user NIP-46 signing with throwaway keys.";
export const signAsUserCompletionText = "sign_as_user probe complete";
export const backendKind1RoutingRequest = "BACKEND_KIND1_ROUTING_PROBE";
export const backendKind1RoutingCompletionText = "backend kind1 routed";

const colorWords = [
    "red", "blue", "green", "yellow", "purple", "orange", "pink", "black",
    "white", "gray", "grey", "brown", "cyan", "magenta", "teal", "lime",
    "indigo", "violet", "turquoise", "gold", "silver", "maroon", "navy",
    "cerulean", "lavender", "beige", "coral", "azure", "ochre",
    "chartreuse", "crimson", "scarlet", "amber", "emerald", "sapphire",
    "mauve", "aquamarine", "fuchsia", "olive", "plum", "salmon", "peach",
    "mint", "rose",
] as const;

const colorChoicePattern = new RegExp(
    `\\b(${colorWords.join("|")})\\b|#[0-9a-f]{3,6}\\b`,
    "i"
);

export function extractColorChoice(content: string): string | null {
    return content.match(colorChoicePattern)?.[0].toLowerCase() ?? null;
}

export function includesColorChoice(content: string): boolean {
    return extractColorChoice(content) !== null;
}

export type ScenarioContext = {
    pool: SimplePool;
    events: Event[];
    relayUrl: string;
    projectDtag: string;
    projectRef: string;
    workspaceDir: string;
    agentsDir: string;
    conversationDbPath: string;
    pmPubkey: string;
    workerPubkey: string;
    backendPubkey: string;
    ownerPubkey: string;
    ownerSecret: Uint8Array;
    userSecret: Uint8Array;
    backendSecret: Uint8Array;
    requestRecordPath: string;
    sign: (template: EventTemplate, secret: Uint8Array) => Event;
    now: () => number;
    delay: (ms: number) => Promise<void>;
    waitForObservedEvent: (
        events: Event[],
        predicate: (event: Event) => boolean,
        timeoutMs: number,
        label: string
    ) => Promise<Event>;
    waitForRequestRecord: (
        file: string,
        predicate: (records: MockRequestRecord[]) => boolean,
        timeoutMs: number,
        label: string
    ) => Promise<MockRequestRecord[]>;
    monitorConversation: (
        conversationId: string,
        onEvent?: (event: Event) => void
    ) => ConversationMonitor;
    publishProjectEvent: (agentPubkeys: string[], createdAt?: number) => Promise<Event>;
    configureWorkerForAcp?: () => void;
};

export function scenarioProjectDtag(name: ScenarioName): string {
    if (name === "delegation-basic") {
        return "probe-delegation";
    }
    if (name === "delegation-self") {
        return "probe-self-delegation";
    }
    if (name === "delegation-crossproject") {
        return crossProjectProjectADtag;
    }
    if (name === "same-agent-concurrency") {
        return "probe-concurrency";
    }
    if (name === "mcp-tool-basic") {
        return "probe-mcp-tool";
    }
    if (name === "mcp-resource-basic") {
        return "probe-mcp-resource";
    }
    if (name === "acp-worker-basic") {
        return "probe-acp-worker";
    }
    if (name === "acp-delegation-mcp") {
        return "probe-acp-delegation-mcp";
    }
    if (name === "agent-config-reload") {
        return "probe-agent-config-reload";
    }
    if (name === "agent-config-update") {
        return "probe-agent-config-update";
    }
    if (name === "project-membership-reload") {
        return "probe-project-membership-reload";
    }
    if (name === "shell-kill-duplicate") {
        return "probe-shell-kill-duplicate";
    }
    if (name === "root-agents-md") {
        return "probe-root-agents-md";
    }
    if (name === "nested-agents-md") {
        return "probe-nested-agents-md";
    }
    if (name === "conversation-reminders") {
        return "probe-conversation-reminders";
    }
    if (name === "todo-stop") {
        return "probe-todo-stop";
    }
    if (name === "learn-tool") {
        return "probe-learn-tool";
    }
    if (name === "rag-documents") {
        return "probe-rag-documents";
    }
    if (name === "ask-owner") {
        return "probe-ask-owner";
    }
    if (name === "sign-as-user-nip46") {
        return "probe-sign-as-user-nip46";
    }
    if (name === "backend-kind1-routing") {
        return "probe-backend-kind1-routing";
    }
    return "probe-fs-read-adjustment";
}

export function pmInstructions(name: ScenarioName): string {
    if (name === "delegation-basic") {
        return "This is a delegation probe. Do not call todo_write. On the first turn, call only delegate to worker with the random-color task. Do not ask for clarification. The delegate tool result is not the worker's answer; never invent or choose a color yourself. If you get a same-turn response after calling delegate, say only: Delegation started. When the worker replies with a color, do not call tools and do not delegate again; repeat the exact color word in one final sentence: The worker picked <exact worker color>.";
    }
    if (name === "delegation-self") {
        return "This is a self-delegation probe. Do not call todo_write. On the first user turn, call self_delegate exactly once with request set to the verbatim text 'Reply with the single word done.' Do not produce the answer this turn — emit only the tool call. When you are re-invoked from your own self-delegation, do not call any tools and do not call self_delegate again; reply with exactly: done.";
    }
    if (name === "delegation-crossproject") {
        return "This is a cross-project delegation probe. Do not call todo_write. On the first turn call delegate_crossproject exactly once with project_id='probe-crossproject-b', recipient='worker', and a request that asks the recipient to choose one random color and report it. Do not invent a color yourself. When the cross-project worker replies with a color, do not call tools and do not delegate again; reply with exactly: The worker picked <exact worker color>.";
    }
    if (name === "same-agent-concurrency") {
        return "Use shell when asked to run sleep commands, and account for active tool reminders.";
    }
    if (name === "mcp-tool-basic") {
        return "Use the MCP probe tool when asked for project-scoped MCP validation.";
    }
    if (name === "mcp-resource-basic") {
        return `Use MCP resource tools to list, read, then subscribe to the probe resource. Do not call todo_write. Do not call no_response. After receiving a system-reminder of type mcp-resource-updated, reply with exactly this sentence verbatim and nothing else: "${mcpResourceFinalText}"`;
    }
    if (name === "acp-worker-basic") {
        return "This scenario targets the ACP worker directly; remain idle unless directly mentioned.";
    }
    if (name === "acp-delegation-mcp") {
        return "This scenario verifies TENEX MCP delegation from an ACP backend. Use the TENEX MCP delegate tool, not backend-native delegation, to delegate to worker with the random-color task. Stop after delegating; do not invent a color.";
    }
    if (name === "agent-config-reload") {
        return "This scenario verifies runtime agent config reload; remain idle unless directly mentioned.";
    }
    if (name === "agent-config-update") {
        return "This scenario verifies kind 24020 runtime agent config updates; remain idle unless directly mentioned.";
    }
    if (name === "project-membership-reload") {
        return "This scenario verifies project membership reload; answer only the exact requested probe phrase.";
    }
    if (name === "shell-kill-duplicate") {
        return pmShellKillDuplicateInstructions;
    }
    if (name === "root-agents-md") {
        return "This scenario verifies root AGENTS.md prompt injection. Answer with the exact observed probe phrase.";
    }
    if (name === "nested-agents-md") {
        return "This scenario verifies nested AGENTS.md reminders. Use fs_read first, then fs_glob after observing the nested instruction.";
    }
    if (name === "conversation-reminders") {
        return "This scenario verifies that active project conversations appear as context. When asked to list active conversations, confirm what you observe by responding: conversation reminders observed.";
    }
    if (name === "todo-stop") {
        return todoStopPmInstructions;
    }
    if (name === "learn-tool") {
        return learnPmInstructions;
    }
    if (name === "rag-documents") {
        return ragPmInstructions;
    }
    if (name === "ask-owner") {
        return askPmInstructions;
    }
    if (name === "sign-as-user-nip46") {
        return "This scenario verifies sign_as_user over NIP-46. Do not call todo_write. On the first turn, call sign_as_user exactly once with the requested unsigned event. After the tool returns, do not call tools again; reply exactly: sign_as_user probe complete.";
    }
    if (name === "backend-kind1-routing") {
        return "This scenario verifies backend-signed relay routing. Do not call tools. Reply exactly: backend kind1 routed.";
    }
    return "Use fs_read one file at a time. If the user corrects the requested total, follow the latest total before finishing.";
}

export function mockScenario(name: ScenarioName): unknown {
    // The two delegation probes that re-enter the runtime through delegation
    // routing (self_delegate, delegate_crossproject) depend on real LLM
    // tool-calling behavior. A mock cassette can't drive those code paths
    // realistically, and a silent fall-through to the fs-read fixture would
    // produce confusing, misleading verdicts. Fail loudly instead.
    if (name === "delegation-self" || name === "delegation-crossproject") {
        throw new Error(
            `${name} requires a live LLM provider. Re-run with --llm ollama (or anthropic).`
        );
    }
    if (name === "delegation-basic") {
        return {
            responses: [
                {
                    agent: "pm",
                    turn: 1,
                    contains: delegationWorkerCompletionText,
                    content: "The worker picked blue.",
                },
                {
                    agent: "pm",
                    turn: 1,
                    containsAll: ["delegate to worker", "choose one random color"],
                    toolCalls: [
                        {
                            name: "delegate",
                            args: {
                                recipient: "worker",
                                prompt: delegationWorkerPrompt,
                            },
                        },
                    ],
                },
                { agent: "pm", turn: 2, content: "Delegation started." },
                {
                    agent: "worker",
                    turn: 1,
                    contains: delegationWorkerPrompt,
                    content: delegationWorkerCompletionText,
                },
            ],
            defaultContent: "Probe agent observed the latest event.",
        };
    }

    if (name === "same-agent-concurrency") {
        return {
            responses: [
                {
                    agent: "pm",
                    turn: 1,
                    containsAll: ["run second sleep", "active-tool-executions", "sleep 2"],
                    toolCalls: [
                        {
                            name: "shell",
                            args: {
                                command: "sleep 5; awk 'BEGIN{print \"second\" \"done\"}'",
                                description: "run second sleep probe",
                                timeout: 10,
                            },
                        },
                    ],
                },
                {
                    agent: "pm",
                    turn: 1,
                    contains: "start first sleep",
                    toolCalls: [
                        {
                            name: "shell",
                            args: {
                                command: "sleep 2; awk 'BEGIN{print \"first\" \"done\"}'",
                                description: "run first sleep probe",
                                timeout: 10,
                            },
                        },
                    ],
                },
                {
                    agent: "pm",
                    turn: 2,
                    containsAll: ["seconddone"],
                    content: "Second sleep finished; returning control.",
                },
                {
                    agent: "pm",
                    turn: 2,
                    containsAll: ["firstdone", "active-tool-executions", "sleep 5"],
                    content: "First sleep finished while second sleep is still running.",
                },
            ],
            defaultContent: "Probe agent did not match expected runtime state.",
        };
    }

    if (name === "mcp-tool-basic") {
        return {
            responses: [
                {
                    agent: "pm",
                    turn: 1,
                    contains: "Use the MCP probe tool with project-context",
                    toolCalls: [
                        {
                            name: "mcp__probe__answer_probe",
                            args: { prompt: "project-context" },
                        },
                    ],
                },
                {
                    agent: "pm",
                    turn: 2,
                    containsAll: ["MCP probe answered: project-context"],
                    content: "MCP probe final: tool output accepted.",
                },
            ],
            defaultContent: "MCP probe mock response did not match expected runtime state.",
        };
    }

    if (name === "mcp-resource-basic") {
        return {
            responses: [
                {
                    agent: "pm",
                    turn: 1,
                    contains: "List, read, and subscribe to the MCP probe resource",
                    toolCalls: [{ name: "mcp_list_resources", args: {} }],
                },
                {
                    agent: "pm",
                    turn: 2,
                    containsAll: ["mcp://probe/context", "Server: probe"],
                    toolCalls: [
                        {
                            name: "mcp_resource_read",
                            args: {
                                serverName: "probe",
                                resourceUri: "mcp://probe/context",
                                description: "read probe resource",
                            },
                        },
                    ],
                },
                {
                    agent: "pm",
                    turn: 3,
                    contains: mcpResourceContentText,
                    toolCalls: [
                        {
                            name: "mcp_subscribe",
                            args: {
                                serverName: "probe",
                                resourceUri: "mcp://probe/context",
                                description: "watch probe resource updates",
                            },
                        },
                    ],
                },
                {
                    agent: "pm",
                    turn: 4,
                    contains: "Successfully created MCP subscription",
                    content: "MCP subscription started.",
                },
                {
                    agent: "pm",
                    contains: mcpResourceUpdateId,
                    content: mcpResourceFinalText,
                },
            ],
            defaultContent: "MCP resource probe mock response did not match expected runtime state.",
        };
    }

    if (name === "acp-worker-basic") {
        return { responses: [], defaultContent: "ACP worker scenario uses an ACP backend." };
    }

    if (name === "acp-delegation-mcp") {
        return {
            responses: [
                {
                    agent: "worker",
                    turn: 1,
                    contains: "random color",
                    content: delegationWorkerCompletionText,
                },
            ],
            defaultContent: "ACP delegation MCP probe should only use native mock LLM for worker.",
        };
    }

    if (name === "agent-config-reload") {
        return {
            responses: [],
            defaultContent: "Agent config reload probe should not use native mock LLM.",
        };
    }

    if (name === "project-membership-reload") {
        return {
            responses: [
                {
                    agent: "pm",
                    contains: "membership check agent1",
                    content: "membership agent1 active",
                },
                {
                    agent: "worker",
                    contains: "membership check agent2",
                    content: "membership agent2 active",
                },
            ],
            defaultContent: "Project membership reload probe did not match expected runtime state.",
        };
    }

    if (name === "shell-kill-duplicate") {
        return shellKillDuplicateMockScenario();
    }

    if (name === "root-agents-md") {
        return {
            responses: [
                {
                    agent: "pm",
                    turn: 1,
                    containsAll: ["root AGENTS check", rootAgentsMdInstruction],
                    content: `${rootAgentsMdInstruction} observed.`,
                },
            ],
            defaultContent: "Root AGENTS.md probe did not match expected prompt state.",
        };
    }

    if (name === "nested-agents-md") {
        return {
            responses: [
                {
                    agent: "pm",
                    turn: 1,
                    contains: "nested AGENTS check",
                    toolCalls: [
                        {
                            name: "fs_read",
                            args: {
                                path: "src/file.txt",
                                limit: 20,
                                description: "read src file for nested AGENTS probe",
                            },
                        },
                    ],
                },
                {
                    agent: "pm",
                    turn: 2,
                    containsAll: [nestedAgentsMdReadInstruction, "src file content"],
                    toolCalls: [
                        {
                            name: "fs_glob",
                            args: {
                                pattern: "src/nested/*.txt",
                                head_limit: 10,
                                description: "glob nested files for AGENTS probe",
                            },
                        },
                    ],
                },
                {
                    agent: "pm",
                    turn: 3,
                    containsAll: [nestedAgentsMdGlobInstruction, "src/nested/file.txt"],
                    content: nestedAgentsMdCompletionText,
                },
            ],
            defaultContent: "Nested AGENTS.md probe did not match expected tool reminder state.",
        };
    }

    if (name === "conversation-reminders") {
        return {
            responses: [
                {
                    agent: "pm",
                    turn: 1,
                    contains: convReminderProbeMessage,
                    content: convReminderCompletionText,
                },
                {
                    agent: "pm",
                    turn: 1,
                    content: "first conversation done.",
                },
            ],
            defaultContent: "Conversation reminders probe did not match expected runtime state.",
        };
    }

    if (name === "todo-stop") {
        return todoStopMockScenario();
    }
    if (name === "learn-tool") {
        return learnMockScenario();
    }
    if (name === "rag-documents") {
        return ragMockScenario();
    }
    if (name === "ask-owner") {
        return askMockScenario();
    }
    if (name === "sign-as-user-nip46") {
        return {
            responses: [
                {
                    agent: "pm",
                    turn: 1,
                    contains: signAsUserRequest,
                    toolCalls: [
                        {
                            name: "sign_as_user",
                            args: {
                                description: "Sign TENEX runtime probe event",
                                explanation: signAsUserExplanation,
                                event: {
                                    kind: 1,
                                    content: signAsUserSignedContent,
                                    tags: [
                                        ["client", "tenex-runtime-probe"],
                                        ["probe", "sign-as-user"],
                                    ],
                                },
                            },
                        },
                    ],
                },
                {
                    agent: "pm",
                    turn: 2,
                    contains: signAsUserSignedContent,
                    content: signAsUserCompletionText,
                },
            ],
            defaultContent: "sign_as_user NIP-46 probe did not match expected runtime state.",
        };
    }

    if (name === "backend-kind1-routing") {
        return {
            responses: [
                {
                    agent: "pm",
                    turn: 1,
                    contains: backendKind1RoutingRequest,
                    content: backendKind1RoutingCompletionText,
                },
            ],
            defaultContent: "Backend kind:1 routing probe did not match expected runtime state.",
        };
    }

    const mockDelayMs = Number(process.env.TENEX_PROBE_MOCK_DELAY_MS ?? 750);
    return {
        defaultDelayMs: mockDelayMs,
        responses: [
            fsReadResponse(1, "read file-1.txt through file-10.txt", "file-1.txt"),
            fsReadResponse(2, "content-file-1", "file-2.txt"),
            fsReadResponse(3, "content-file-2", "file-3.txt"),
            {
                agent: "pm",
                turn: 4,
                containsAll: [
                    "actually, only read 4 times total",
                    "injected-user-messages",
                    "content-file-3",
                ],
                toolCalls: [fsReadToolCall("file-4.txt")],
            },
            {
                agent: "pm",
                turn: 5,
                containsAll: ["actually, only read 4 times total", "content-file-4"],
                content: "Read 4 files total after adjustment.",
            },
        ],
        defaultContent: "FS read adjustment probe did not match expected message state.",
    };
}

export async function runScenario(name: ScenarioName, context: ScenarioContext): Promise<void> {
    if (name === "delegation-basic") {
        await runDelegationProbe(context);
    } else if (name === "delegation-self") {
        await runSelfDelegationProbe(context);
    } else if (name === "delegation-crossproject") {
        await runCrossProjectDelegationProbe(context);
    } else if (name === "same-agent-concurrency") {
        await runSameAgentConcurrencyProbe(context);
    } else if (name === "mcp-tool-basic") {
        await runMcpToolProbe(context);
    } else if (name === "mcp-resource-basic") {
        await runMcpResourceProbe(context);
    } else if (name === "acp-worker-basic") {
        await runAcpWorkerProbe(context);
    } else if (name === "acp-delegation-mcp") {
        await runAcpDelegationMcpProbe(context);
    } else if (name === "agent-config-reload") {
        await runAgentConfigReloadProbe(context);
    } else if (name === "agent-config-update") {
        await runAgentConfigUpdateProbe(context);
    } else if (name === "project-membership-reload") {
        await runProjectMembershipReloadProbe(context);
    } else if (name === "shell-kill-duplicate") {
        await runShellKillDuplicateProbe(context);
    } else if (name === "root-agents-md") {
        await runRootAgentsMdProbe(context);
    } else if (name === "nested-agents-md") {
        await runNestedAgentsMdProbe(context);
    } else if (name === "conversation-reminders") {
        await runConversationRemindersProbe(context);
    } else if (name === "todo-stop") {
        await runTodoStopProbe(context);
    } else if (name === "learn-tool") {
        await runLearnProbe(context);
    } else if (name === "rag-documents") {
        await runRagDocumentsProbe(context);
    } else if (name === "ask-owner") {
        await runAskProbe(context);
    } else if (name === "sign-as-user-nip46") {
        await runSignAsUserProbe(context);
    } else if (name === "backend-kind1-routing") {
        await runBackendKind1RoutingProbe(context);
    } else {
        await runFsReadAdjustmentProbe(context);
    }
}

async function runBackendKind1RoutingProbe(context: ScenarioContext): Promise<void> {
    const backendEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: backendKind1RoutingRequest,
            tags: [
                ["a", context.projectRef],
                ["p", context.pmPubkey],
                ["backend-kind1-routing", "1"],
            ],
        },
        context.backendSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], backendEvent));
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 15_000);
    await context.waitForRequestRecord(
        context.requestRecordPath,
        (records) =>
            records.some(
                (record) =>
                    record.agent === "pm" &&
                    record.requestDebug.includes(backendKind1RoutingRequest)
            ),
        timeoutMs,
        "PM mock LLM request for backend-authored kind:1"
    );
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes(backendKind1RoutingCompletionText) &&
            event.tags.some((tag) => tag[0] === "status" && tag[1] === "completed"),
        timeoutMs,
        "PM completion for backend-authored kind:1"
    );
}

async function runSignAsUserProbe(context: ScenarioContext): Promise<void> {
    const signer = startNip46OwnerSigner(context);
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 15_000);
    try {
        const userEvent = context.sign(
            {
                kind: 1,
                created_at: context.now(),
                content: signAsUserRequest,
                tags: [["a", context.projectRef]],
            },
            context.userSecret
        );
        await Promise.all(context.pool.publish([context.relayUrl], userEvent));
        await context.waitForRequestRecord(
            context.requestRecordPath,
            (records) =>
                records.some(
                    (record) =>
                        record.agent === "pm" &&
                        record.toolCalls?.includes("sign_as_user")
                ),
            timeoutMs,
            "PM mock LLM sign_as_user tool call"
        );
        await context.waitForObservedEvent(
            context.events,
            (event) =>
                event.kind === 24133 &&
                event.pubkey === context.pmPubkey &&
                hasEventTag(event, "p", context.ownerPubkey),
            timeoutMs,
            "NIP-46 request from PM to owner signer"
        );
        await context.waitForObservedEvent(
            context.events,
            (event) =>
                event.kind === 24133 &&
                event.pubkey === context.ownerPubkey &&
                hasEventTag(event, "p", context.pmPubkey),
            timeoutMs,
            "NIP-46 response from owner signer to PM"
        );
        await waitForStoredMessage(
            context.conversationDbPath,
            userEvent.id,
            (message) =>
                message.authorPubkey === context.pmPubkey &&
                messageText(message).includes(signAsUserCompletionText),
            timeoutMs,
            "PM completion after sign_as_user result",
            context.delay
        );
    } finally {
        signer.close();
    }
}

function startNip46OwnerSigner(context: ScenarioContext): { close: () => void } {
    const sub = context.pool.subscribeMany(
        [context.relayUrl],
        { kinds: [24133], "#p": [context.ownerPubkey] },
        {
            onevent: (event) => {
                if (event.pubkey === context.ownerPubkey) {
                    return;
                }
                void respondToNip46Request(context, event);
            },
        }
    );
    return { close: () => sub.close() };
}

async function respondToNip46Request(context: ScenarioContext, requestEvent: Event): Promise<void> {
    let response: { id: string; result: string | null; error: string | null };
    try {
        const request = decryptNip46Message(context.ownerSecret, requestEvent.pubkey, requestEvent.content);
        response = {
            id: request.id,
            result: await handleNip46Request(context, request),
            error: null,
        };
    } catch (error) {
        response = {
            id: "invalid",
            result: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    const conversationKey = getConversationKey(context.ownerSecret, requestEvent.pubkey);
    const encrypted = nip44Encrypt(JSON.stringify(response), conversationKey);
    const responseEvent = context.sign(
        {
            kind: 24133,
            created_at: context.now(),
            content: encrypted,
            tags: [["p", requestEvent.pubkey]],
        },
        context.ownerSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], responseEvent));
}

function decryptNip46Message(
    ownerSecret: Uint8Array,
    requesterPubkey: string,
    ciphertext: string
): { id: string; method: string; params?: string[] } {
    const conversationKey = getConversationKey(ownerSecret, requesterPubkey);
    const plaintext = nip44Decrypt(ciphertext, conversationKey);
    const parsed = JSON.parse(plaintext) as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.method !== "string") {
        throw new Error("invalid NIP-46 request envelope");
    }
    return {
        id: parsed.id,
        method: parsed.method,
        params: Array.isArray(parsed.params)
            ? parsed.params.filter((param): param is string => typeof param === "string")
            : [],
    };
}

async function handleNip46Request(
    context: ScenarioContext,
    request: { method: string; params?: string[] }
): Promise<string> {
    if (request.method === "connect") {
        return "ack";
    }
    if (request.method === "get_public_key") {
        return context.ownerPubkey;
    }
    if (request.method === "ping") {
        return "pong";
    }
    if (request.method === "sign_event") {
        const unsigned = parseUnsignedEvent(request.params?.[0]);
        const signed = context.sign(
            {
                kind: unsigned.kind,
                created_at: unsigned.created_at ?? context.now(),
                content: unsigned.content,
                tags: unsigned.tags ?? [],
            },
            context.ownerSecret
        );
        return JSON.stringify(signed);
    }
    throw new Error(`unsupported NIP-46 method: ${request.method}`);
}

function parseUnsignedEvent(raw: string | undefined): {
    kind: number;
    created_at?: number;
    content: string;
    tags?: string[][];
} {
    if (!raw) {
        throw new Error("missing sign_event payload");
    }
    const parsed = JSON.parse(raw) as {
        kind?: unknown;
        created_at?: unknown;
        content?: unknown;
        tags?: unknown;
    };
    if (typeof parsed.kind !== "number" || typeof parsed.content !== "string") {
        throw new Error("invalid sign_event payload");
    }
    return {
        kind: parsed.kind,
        created_at: typeof parsed.created_at === "number" ? parsed.created_at : undefined,
        content: parsed.content,
        tags: Array.isArray(parsed.tags)
            ? parsed.tags.filter((tag): tag is string[] =>
                  Array.isArray(tag) && tag.every((part) => typeof part === "string")
              )
            : [],
    };
}

async function runConversationRemindersProbe(context: ScenarioContext): Promise<void> {
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 10_000);

    const firstEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: `${convProbeFirstMessage}: simple first message`,
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], firstEvent));
    await waitForStoredMessage(
        context.conversationDbPath,
        firstEvent.id,
        (message) => message.authorPubkey === context.pmPubkey,
        timeoutMs,
        "PM reply in first conversation",
        context.delay
    );

    const reminderProbeEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: `${convReminderProbeMessage}: list active conversations`,
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], reminderProbeEvent));
    await waitForStoredMessage(
        context.conversationDbPath,
        reminderProbeEvent.id,
        (message) => message.authorPubkey === context.pmPubkey,
        timeoutMs,
        "PM reply in second conversation",
        context.delay
    );
}

function fsReadResponse(turn: number, contains: string, file: string): unknown {
    return {
        agent: "pm",
        turn,
        contains,
        toolCalls: [fsReadToolCall(file)],
    };
}

function fsReadToolCall(file: string): unknown {
    return {
        name: "fs_read",
        args: {
            path: file,
            limit: 1,
            description: `read probe ${file}`,
        },
    };
}

async function runDelegationProbe(context: ScenarioContext): Promise<void> {
    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: delegationUserRequest,
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 8_000);
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasEventTag(event, "p", context.workerPubkey) &&
            !hasAnyEventTag(event, "tool"),
        timeoutMs,
        "PM delegation event"
    );

    const workerCompletion = await waitForStoredMessage(
        context.conversationDbPath,
        userEvent.id,
        (message) =>
            message.authorPubkey === context.workerPubkey &&
            includesColorChoice(messageText(message)),
        timeoutMs,
        "worker color completion in parent conversation store",
        context.delay
    );
    const workerColor = extractColorChoice(messageText(workerCompletion));
    await waitForStoredMessage(
        context.conversationDbPath,
        userEvent.id,
        (message) =>
            message.authorPubkey === context.pmPubkey &&
            extractColorChoice(messageText(message)) === workerColor,
        timeoutMs,
        "PM color report in parent conversation store",
        context.delay
    );
}

async function runSelfDelegationProbe(context: ScenarioContext): Promise<void> {
    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: selfDelegationUserRequest,
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 60_000);
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));

    // PM should publish a kind:1 with p-tag = its own pubkey AND a tool=self_delegate event.
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasEventTag(event, "p", context.pmPubkey) &&
            !hasAnyEventTag(event, "tool"),
        timeoutMs,
        "PM self-delegation event"
    );

    // The follow-up invocation should produce a completion containing 'done' in a
    // distinct (child) conversation, written to the conversation store.
    await waitForStoredMessage(
        context.conversationDbPath,
        userEvent.id,
        (message) =>
            message.authorPubkey === context.pmPubkey &&
            messageText(message).toLowerCase().includes(selfDelegationCompletionToken),
        timeoutMs,
        "PM follow-up completion in self-delegated conversation store",
        context.delay
    );
}

async function runCrossProjectDelegationProbe(context: ScenarioContext): Promise<void> {
    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: crossProjectDelegationUserRequest,
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 60_000);
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));

    // Send leg: PM in project A emits a delegation kind:1 to the worker in project B.
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasEventTag(event, "p", context.workerPubkey) &&
            !hasAnyEventTag(event, "tool"),
        timeoutMs,
        "PM cross-project delegation event"
    );

    // Send leg, second hop: project B's runtime dispatches to worker B, which
    // emits a color reply.
    const workerCompletion = await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.workerPubkey &&
            includesColorChoice(event.content),
        timeoutMs,
        "cross-project worker color completion"
    );
    const workerColor = extractColorChoice(workerCompletion.content);

    await waitForStoredMessage(
        context.conversationDbPath,
        userEvent.id,
        (message) =>
            message.authorPubkey === context.workerPubkey &&
            includesColorChoice(messageText(message)),
        timeoutMs,
        "cross-project worker completion in parent conversation store",
        context.delay
    );
    await waitForStoredMessage(
        context.conversationDbPath,
        userEvent.id,
        (message) =>
            message.authorPubkey === context.pmPubkey &&
            workerColor !== null &&
            extractColorChoice(messageText(message)) === workerColor,
        timeoutMs,
        "PM cross-project color report in parent conversation store",
        context.delay
    );
}

function hasEventTag(event: Event, name: string, value: string): boolean {
    return event.tags.some((tag) => tag[0] === name && tag[1] === value);
}

function hasAnyEventTag(event: Event, name: string): boolean {
    return event.tags.some((tag) => tag[0] === name);
}

async function runSameAgentConcurrencyProbe(context: ScenarioContext): Promise<void> {
    const firstUserEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: "start first sleep now",
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], firstUserEvent));
    await context.waitForObservedEvent(
        context.events,
        (event) => event.pubkey === context.pmPubkey && isShellTool(event, "sleep 2"),
        10_000,
        "first shell tool event"
    );
    await context.delay(300);

    const secondUserEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: "run second sleep now",
            tags: [
                ["e", firstUserEvent.id, "", "root"],
                ["p", context.pmPubkey],
            ],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], secondUserEvent));
    await context.delay(Number(process.env.TENEX_PROBE_WAIT_MS ?? 12_000));
}

async function runFsReadAdjustmentProbe(context: ScenarioContext): Promise<void> {
    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content:
                "Use fs_read to read file-1.txt through file-10.txt. Read one file per tool call.",
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));
    await context.waitForObservedEvent(
        context.events,
        (event) => event.pubkey === context.pmPubkey && isFsReadTool(event, "file-2.txt"),
        10_000,
        "second fs_read tool event"
    );
    await context.waitForRequestRecord(
        context.requestRecordPath,
        (records) =>
            records.some(
                (record) =>
                    record.agent === "pm" &&
                    record.turn === 3 &&
                    record.toolCalls?.includes("fs_read")
            ),
        10_000,
        "third PM model request"
    );

    const correctionEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: "actually, only read 4 times total",
            tags: [
                ["e", userEvent.id, "", "root"],
                ["p", context.pmPubkey],
            ],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], correctionEvent));
    await context.delay(Number(process.env.TENEX_PROBE_WAIT_MS ?? 8_000));
}

async function runMcpToolProbe(context: ScenarioContext): Promise<void> {
    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: "Use the MCP probe tool with project-context.",
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.pubkey === context.pmPubkey &&
            event.kind === 1 &&
            hasTag(event, "tool", "mcp__probe__answer_probe"),
        10_000,
        "MCP tool event"
    );
    await context.delay(Number(process.env.TENEX_PROBE_WAIT_MS ?? 5_000));
}

async function runMcpResourceProbe(context: ScenarioContext): Promise<void> {
    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: "List, read, and subscribe to the MCP probe resource.",
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));
    const waitMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 12_000);
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.pubkey === context.pmPubkey &&
            event.kind === 1 &&
            hasTag(event, "tool", "mcp_subscribe"),
        waitMs,
        "MCP resource subscription tool event"
    );
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.pubkey === context.pmPubkey &&
            event.kind === 1 &&
            event.content.includes(mcpResourceFinalText),
        waitMs,
        "MCP resource subscription update completion"
    );
}

async function runRootAgentsMdProbe(context: ScenarioContext): Promise<void> {
    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: "root AGENTS check",
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));
    await context.waitForRequestRecord(
        context.requestRecordPath,
        (records) =>
            records.some(
                (record) =>
                    record.agent === "pm" &&
                    record.requestDebug.includes(rootAgentsMdInstruction)
            ),
        Number(process.env.TENEX_PROBE_WAIT_MS ?? 10_000),
        "PM prompt with root AGENTS.md"
    );
}

async function runNestedAgentsMdProbe(context: ScenarioContext): Promise<void> {
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 10_000);
    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: "nested AGENTS check",
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));
    await context.waitForObservedEvent(
        context.events,
        (event) => event.pubkey === context.pmPubkey && isFsReadTool(event, "src/file.txt"),
        timeoutMs,
        "nested AGENTS fs_read tool event"
    );
    await context.waitForObservedEvent(
        context.events,
        (event) => event.pubkey === context.pmPubkey && isFsGlobTool(event, "src/nested/*.txt"),
        timeoutMs,
        "nested AGENTS fs_glob tool event"
    );
    await context.waitForRequestRecord(
        context.requestRecordPath,
        (records) =>
            records.some(
                (record) =>
                    record.agent === "pm" &&
                    record.turn === 3 &&
                    record.requestDebug.includes(nestedAgentsMdGlobInstruction)
            ),
        timeoutMs,
        "PM request with nested AGENTS.md glob reminder"
    );
}

async function runAcpWorkerProbe(context: ScenarioContext): Promise<void> {
    await publishAcpWorkerRequest(context);
}

async function runAcpDelegationMcpProbe(context: ScenarioContext): Promise<void> {
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 12_000);
    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: acpDelegationMcpUserRequest,
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasEventTag(event, "p", context.workerPubkey) &&
            !hasAnyEventTag(event, "tool"),
        timeoutMs,
        "ACP PM delegation event"
    );
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "delegate"),
        timeoutMs,
        "ACP PM delegate tool event"
    );
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.workerPubkey &&
            includesColorChoice(event.content),
        timeoutMs,
        "worker color completion from ACP MCP delegation"
    );
}

async function runAgentConfigReloadProbe(context: ScenarioContext): Promise<void> {
    context.configureWorkerForAcp?.();
    await context.delay(Number(process.env.TENEX_PROBE_RELOAD_WAIT_MS ?? 1_000));
    await publishAcpWorkerRequest(context);
}

async function runAgentConfigUpdateProbe(context: ScenarioContext): Promise<void> {
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 12_000);
    const updateEvent = context.sign(
        {
            kind: 24020,
            created_at: context.now(),
            content: "",
            tags: [
                ["a", context.projectRef],
                ["client", "tenex-runtime-probe"],
                ["p", context.workerPubkey],
                ["model", agentConfigUpdateModelName],
                ...agentConfigUpdateSkills.map((skill) => ["skill", skill]),
                ["mcp"],
            ],
        },
        context.userSecret
    );

    await Promise.all(context.pool.publish([context.relayUrl], updateEvent));
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 34011 &&
            event.pubkey === context.workerPubkey &&
            event.tags.some(
                (tag) => tag[0] === "model" && tag[1] === agentConfigUpdateModelName
            ),
        timeoutMs,
        "34011 worker config after agent config update"
    );

    const workerAgentPath = path.join(context.agentsDir, `${context.workerPubkey}.json`);
    const workerAgent = JSON.parse(readFileSync(workerAgentPath, "utf8")) as {
        default?: { model?: string; skills?: string[]; mcp?: string[] };
    };
    if (workerAgent.default?.model !== agentConfigUpdateModelName) {
        throw new Error(`worker default model was ${workerAgent.default?.model ?? "<missing>"}`);
    }
    for (const skill of agentConfigUpdateSkills) {
        if (!workerAgent.default?.skills?.includes(skill)) {
            throw new Error(`worker default skills missing ${skill}`);
        }
    }
    if (workerAgent.default?.mcp !== undefined) {
        throw new Error("worker default mcp should have been cleared by empty mcp tag");
    }
}

async function runProjectMembershipReloadProbe(context: ScenarioContext): Promise<void> {
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 12_000);
    const initialEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: "membership check agent1",
            tags: [["p", context.pmPubkey]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], initialEvent));
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("membership agent1 active"),
        timeoutMs,
        "initial agent1 completion"
    );

    const beforeAddStatus = new Set(
        context.events.filter((event) => event.kind === 24010).map((event) => event.id)
    );
    await context.publishProjectEvent([context.pmPubkey, context.workerPubkey], context.now() + 1);
    await context.waitForObservedEvent(
        context.events,
        (event) => event.kind === 24010 && !beforeAddStatus.has(event.id),
        timeoutMs,
        "project status after adding agent2"
    );

    const workerEvent = context.sign(
        {
            kind: 1,
            created_at: context.now() + 2,
            content: "membership check agent2",
            tags: [["p", context.workerPubkey]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], workerEvent));
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.workerPubkey &&
            event.content.includes("membership agent2 active"),
        timeoutMs,
        "agent2 completion after membership add"
    );
    await context.waitForRequestRecord(
        context.requestRecordPath,
        (records) =>
            records.some(
                (record) =>
                    record.agent === "worker" &&
                    (record.requestDebug.includes("cwd: $PROJECT_BASE") ||
                        record.requestDebug.includes(`cwd: ${context.workspaceDir}`))
            ),
        timeoutMs,
        "agent2 prompt with project workspace cwd"
    );

    await context.delay(1_100);
    const beforeRemoveStatus = new Set(
        context.events.filter((event) => event.kind === 24010).map((event) => event.id)
    );
    await context.publishProjectEvent([context.pmPubkey], context.now() + 3);
    await context.waitForObservedEvent(
        context.events,
        (event) => event.kind === 24010 && !beforeRemoveStatus.has(event.id),
        timeoutMs,
        "project status after removing agent2"
    );

    const removedWorkerEvent = context.sign(
        {
            kind: 1,
            created_at: context.now() + 4,
            content: "membership check agent2 after removal",
            tags: [["p", context.workerPubkey]],
        },
        context.userSecret
    );
    const repliesBefore = context.events.filter(
        (event) => event.kind === 1 && repliesTo(event, removedWorkerEvent.id)
    ).length;
    await Promise.all(context.pool.publish([context.relayUrl], removedWorkerEvent));
    await context.delay(Number(process.env.TENEX_PROBE_REMOVAL_WAIT_MS ?? 1_500));
    const repliesAfter = context.events.filter(
        (event) => event.kind === 1 && repliesTo(event, removedWorkerEvent.id)
    ).length;
    if (repliesAfter !== repliesBefore) {
        throw new Error("removed agent2 direct p-tagged event was still dispatched");
    }

    const removedWorkerScopedEvent = context.sign(
        {
            kind: 1,
            created_at: context.now() + 5,
            content: "membership scoped removed worker after removal",
            tags: [
                ["a", context.projectRef],
                ["p", context.workerPubkey],
            ],
        },
        context.userSecret
    );
    const scopedRepliesBefore = context.events.filter(
        (event) => event.kind === 1 && repliesTo(event, removedWorkerScopedEvent.id)
    ).length;
    await Promise.all(context.pool.publish([context.relayUrl], removedWorkerScopedEvent));
    await context.delay(Number(process.env.TENEX_PROBE_REMOVAL_WAIT_MS ?? 1_500));
    const scopedRepliesAfter = context.events.filter(
        (event) => event.kind === 1 && repliesTo(event, removedWorkerScopedEvent.id)
    ).length;
    if (scopedRepliesAfter !== scopedRepliesBefore) {
        throw new Error("removed agent2 project-scoped p-tagged event was still dispatched");
    }
}

function repliesTo(event: Event, parentId: string): boolean {
    return event.tags.some((tag) => tag[0] === "e" && tag[1] === parentId);
}

async function publishAcpWorkerRequest(context: ScenarioContext): Promise<void> {
    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: "ACP worker: reply with the exact phrase haiku acp worker completed.",
            tags: [
                ["a", context.projectRef],
                ["p", context.workerPubkey],
            ],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.workerPubkey &&
            event.content.toLowerCase().includes("haiku acp worker completed") &&
            hasTag(event, "status", "completed"),
        Number(process.env.TENEX_PROBE_WAIT_MS ?? 20_000),
        "ACP worker completion"
    );
}

function isShellTool(event: Event, commandNeedle: string): boolean {
    return (
        event.kind === 1 &&
        hasTag(event, "tool", "shell") &&
        (tagValue(event, "tool-args") ?? "").includes(commandNeedle)
    );
}

function isFsReadTool(event: Event, pathNeedle: string): boolean {
    return (
        event.kind === 1 &&
        hasTag(event, "tool", "fs_read") &&
        (tagValue(event, "tool-args") ?? "").includes(pathNeedle)
    );
}

function isFsGlobTool(event: Event, patternNeedle: string): boolean {
    return (
        event.kind === 1 &&
        hasTag(event, "tool", "fs_glob") &&
        (tagValue(event, "tool-args") ?? "").includes(patternNeedle)
    );
}

function hasTag(event: Event, name: string, value?: string): boolean {
    return event.tags.some((tag) => tag[0] === name && (value === undefined || tag[1] === value));
}

function tagValue(event: Event, name: string): string | undefined {
    return event.tags.find((tag) => tag[0] === name)?.[1];
}
