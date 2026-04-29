import { readFileSync } from "node:fs";
import path from "node:path";
import type { Event, EventTemplate, SimplePool } from "nostr-tools";
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

export const availableScenarios = [
    "delegation-basic",
    "same-agent-concurrency",
    "fs-read-adjustment",
    "mcp-tool-basic",
    "acp-worker-basic",
    "agent-config-reload",
    "agent-config-update",
    "project-membership-reload",
    "shell-kill-duplicate",
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
const delegationWorkerPrompt =
    "Choose one random color. Reply with exactly one lowercase color word and no punctuation.";
export const delegationWorkerCompletionText = "blue";
export const agentConfigUpdateModelName = "mock-updated";
export const agentConfigUpdateSkills = ["read-access", "shell", "write-access"] as const;

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
    userSecret: Uint8Array;
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
    if (name === "same-agent-concurrency") {
        return "probe-concurrency";
    }
    if (name === "mcp-tool-basic") {
        return "probe-mcp-tool";
    }
    if (name === "acp-worker-basic") {
        return "probe-acp-worker";
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
    return "probe-fs-read-adjustment";
}

export function pmInstructions(name: ScenarioName): string {
    if (name === "delegation-basic") {
        return "This is a delegation probe. Do not call todo_write. On the first turn, call only delegate to worker with the random-color task. Do not ask for clarification. The delegate tool result is not the worker's answer; never invent or choose a color yourself. If you get a same-turn response after calling delegate, say only: Delegation started. When the worker replies with a color, do not call tools and do not delegate again; repeat the exact color word in one final sentence: The worker picked <exact worker color>.";
    }
    if (name === "same-agent-concurrency") {
        return "Use shell when asked to run sleep commands, and account for active tool reminders.";
    }
    if (name === "mcp-tool-basic") {
        return "Use the MCP probe tool when asked for project-scoped MCP validation.";
    }
    if (name === "acp-worker-basic") {
        return "This scenario targets the ACP worker directly; remain idle unless directly mentioned.";
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
    return "Use fs_read one file at a time. If the user corrects the requested total, follow the latest total before finishing.";
}

export function mockScenario(name: ScenarioName): unknown {
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

    if (name === "acp-worker-basic") {
        return { responses: [], defaultContent: "ACP worker scenario uses an ACP backend." };
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
    } else if (name === "same-agent-concurrency") {
        await runSameAgentConcurrencyProbe(context);
    } else if (name === "mcp-tool-basic") {
        await runMcpToolProbe(context);
    } else if (name === "acp-worker-basic") {
        await runAcpWorkerProbe(context);
    } else if (name === "agent-config-reload") {
        await runAgentConfigReloadProbe(context);
    } else if (name === "agent-config-update") {
        await runAgentConfigUpdateProbe(context);
    } else if (name === "project-membership-reload") {
        await runProjectMembershipReloadProbe(context);
    } else if (name === "shell-kill-duplicate") {
        await runShellKillDuplicateProbe(context);
    } else {
        await runFsReadAdjustmentProbe(context);
    }
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

async function runAcpWorkerProbe(context: ScenarioContext): Promise<void> {
    await publishAcpWorkerRequest(context);
}

async function runAgentConfigReloadProbe(context: ScenarioContext): Promise<void> {
    context.configureWorkerForAcp?.();
    await context.delay(Number(process.env.TENEX_PROBE_RELOAD_WAIT_MS ?? 1_000));
    await publishAcpWorkerRequest(context);
}

async function runAgentConfigUpdateProbe(context: ScenarioContext): Promise<void> {
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 12_000);
    const statusBefore = new Set(
        context.events.filter((event) => event.kind === 24010).map((event) => event.id)
    );
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
            event.kind === 24010 &&
            !statusBefore.has(event.id) &&
            event.tags.some(
                (tag) =>
                    tag[0] === "model" &&
                    tag[1] === agentConfigUpdateModelName &&
                    tag.slice(2).includes("worker")
            ) &&
            agentConfigUpdateSkills.every((skill) =>
                event.tags.some(
                    (tag) =>
                        tag[0] === "skill" &&
                        tag[1] === skill &&
                        tag.slice(2).includes("worker")
                )
            ),
        timeoutMs,
        "24010 status after agent config update"
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
        (event) =>
            event.kind === 24010 &&
            !beforeAddStatus.has(event.id) &&
            statusAgentSlugs(event).includes("pm") &&
            statusAgentSlugs(event).includes("worker"),
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
                    record.requestDebug.includes(`cwd: ${context.workspaceDir}`)
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
        (event) =>
            event.kind === 24010 &&
            !beforeRemoveStatus.has(event.id) &&
            statusAgentSlugs(event).includes("pm") &&
            !statusAgentSlugs(event).includes("worker"),
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
}

function statusAgentSlugs(event: Event): string[] {
    return event.tags
        .filter((tag) => tag[0] === "agent")
        .map((tag) => tag[2])
        .filter((slug): slug is string => typeof slug === "string");
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

function hasTag(event: Event, name: string, value?: string): boolean {
    return event.tags.some((tag) => tag[0] === name && (value === undefined || tag[1] === value));
}

function tagValue(event: Event, name: string): string | undefined {
    return event.tags.find((tag) => tag[0] === name)?.[1];
}
