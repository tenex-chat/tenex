import type { Event, EventTemplate, SimplePool } from "nostr-tools";

export const availableScenarios = [
    "delegation-basic",
    "same-agent-concurrency",
    "fs-read-adjustment",
    "mcp-tool-basic",
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

type ScenarioContext = {
    pool: SimplePool;
    events: Event[];
    relayUrl: string;
    projectRef: string;
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
    return "Use fs_read one file at a time. If the user corrects the requested total, follow the latest total before finishing.";
}

export function mockScenario(name: ScenarioName): unknown {
    if (name === "delegation-basic") {
        return {
            responses: [
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
                {
                    agent: "pm",
                    turn: 1,
                    contains: delegationWorkerCompletionText,
                    content: "The worker picked blue.",
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
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 8_000);
    const workerCompletion = await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.workerPubkey &&
            includesColorChoice(event.content),
        timeoutMs,
        "worker random-color completion"
    );
    const workerColor = extractColorChoice(workerCompletion.content);
    await waitForPmColorReport(
        context,
        workerCompletion.created_at,
        workerColor,
        timeoutMs
    );
}

function hasEventTag(event: Event, name: string, value: string): boolean {
    return event.tags.some((tag) => tag[0] === name && tag[1] === value);
}

async function waitForPmColorReport(
    context: ScenarioContext,
    sinceCreatedAt: number,
    expectedColor: string | null,
    timeoutMs: number
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const report = context.events.find(
            (event) =>
                event.kind === 1 &&
                event.pubkey === context.pmPubkey &&
                event.created_at >= sinceCreatedAt &&
                !hasEventTag(event, "tool", "delegate") &&
                extractColorChoice(event.content) !== null
        );
        if (report) {
            const actualColor = extractColorChoice(report.content);
            if (actualColor === expectedColor) {
                return;
            }
            throw new Error(
                `PM reported ${actualColor ?? "<none>"} instead of ${expectedColor ?? "<none>"}: ${report.content}`
            );
        }
        await context.delay(100);
    }
    throw new Error(`did not observe PM random-color follow-up within ${timeoutMs}ms`);
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
