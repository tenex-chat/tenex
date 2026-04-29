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

type ScenarioContext = {
    pool: SimplePool;
    events: Event[];
    relayUrl: string;
    projectRef: string;
    pmPubkey: string;
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
        return "Use delegate when the user asks you to hand work off.";
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
                    contains: "hand this off to worker",
                    toolCalls: [
                        {
                            name: "delegate",
                            args: {
                                recipient: "worker",
                                prompt: "Complete the probe delegation task and report success.",
                            },
                        },
                    ],
                },
                { agent: "pm", turn: 2, content: "Delegation started." },
                {
                    agent: "worker",
                    turn: 1,
                    content: "Worker completed delegated probe task.",
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
            content: "Please hand this off to worker and tell me what happened.",
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));
    await context.delay(Number(process.env.TENEX_PROBE_WAIT_MS ?? 8_000));
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
