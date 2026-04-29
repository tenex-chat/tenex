import type { Event } from "nostr-tools";
import type { MockRequestRecord, ScenarioName } from "./tenex-runtime-probe-scenarios";

type Verdict = { name: string; ok: boolean; detail: string };

type EvaluateContext = {
    pmPubkey: string;
    workerPubkey: string;
    mcpProbeRecords?: Array<Record<string, unknown>>;
    workspaceDir?: string;
};

export function evaluate(
    name: ScenarioName,
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    if (name === "delegation-basic") {
        return evaluateDelegation(events, context);
    }
    if (name === "same-agent-concurrency") {
        return evaluateSameAgentConcurrency(events, context);
    }
    if (name === "mcp-tool-basic") {
        return evaluateMcpTool(events, requestRecords, context);
    }
    return evaluateFsReadAdjustment(events, requestRecords, context);
}

function evaluateDelegation(events: Event[], context: EvaluateContext): Verdict[] {
    const delegation = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "p", context.workerPubkey)
    );
    const delegateTool = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "delegate")
    );
    const workerCompletion = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.workerPubkey &&
            event.content.includes("Worker completed delegated probe task")
    );
    const pmObservedWorker = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.created_at >= (workerCompletion?.created_at ?? Number.MAX_SAFE_INTEGER) &&
            event.content.includes("observed")
    );
    const completedStatus = events.find(
        (event) =>
            event.kind === 1 &&
            (event.pubkey === context.pmPubkey || event.pubkey === context.workerPubkey) &&
            hasTag(event, "status", "completed")
    );

    return [
        {
            name: "PM emitted delegation event to worker",
            ok: Boolean(delegation),
            detail: "Expected kind:1 from PM with p-tag targeting worker.",
        },
        {
            name: "PM emitted delegate tool event",
            ok: Boolean(delegateTool),
            detail: "Expected kind:1 from PM with tool=delegate.",
        },
        {
            name: "Runtime routed delegation to worker",
            ok: Boolean(workerCompletion),
            detail: "Expected worker kind:1 containing scripted completion text.",
        },
        {
            name: "PM observed worker completion",
            ok: Boolean(pmObservedWorker),
            detail: "Expected worker completion to trigger a follow-up PM run.",
        },
        {
            name: "Agent completion contract includes status=completed",
            ok: Boolean(completedStatus),
            detail: "Expected final completion frame to include status=completed.",
        },
    ];
}

function evaluateSameAgentConcurrency(events: Event[], context: EvaluateContext): Verdict[] {
    const firstShell = events.filter(
        (event) => event.pubkey === context.pmPubkey && isShellTool(event, "sleep 2")
    );
    const secondShell = events.filter(
        (event) => event.pubkey === context.pmPubkey && isShellTool(event, "sleep 5")
    );
    const firstObservedSecond = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("First sleep finished while second sleep is still running")
    );
    const secondCompleted = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("Second sleep finished; returning control")
    );
    const unexpectedDefault = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("did not match expected runtime state")
    );

    return [
        {
            name: "Initial execution emitted first shell sleep",
            ok: firstShell.length === 1,
            detail: `Expected exactly one shell tool event with sleep 2, saw ${firstShell.length}.`,
        },
        {
            name: "Follow-up execution saw active first tool and emitted second shell sleep",
            ok: secondShell.length === 1,
            detail: `Expected exactly one shell tool event with sleep 5, saw ${secondShell.length}.`,
        },
        {
            name: "Original execution saw active second tool after first sleep finished",
            ok: Boolean(firstObservedSecond),
            detail:
                "Expected final first execution text proving the active-tool reminder was injected after the first tool result.",
        },
        {
            name: "Follow-up execution completed second sleep",
            ok: Boolean(secondCompleted),
            detail: "Expected final follow-up execution text after second shell result.",
        },
        {
            name: "No mock fallback responses were used",
            ok: !unexpectedDefault,
            detail: "A fallback response means a model turn missed the expected injected runtime state.",
        },
    ];
}

function evaluateFsReadAdjustment(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const correctionText = "actually, only read 4 times total";
    const fsReadEvents = events.filter(
        (event) => event.pubkey === context.pmPubkey && isFsReadTool(event)
    );
    const readPaths = fsReadEvents
        .map(toolArgPath)
        .filter((value): value is string => Boolean(value));
    const expectedPaths = ["file-1.txt", "file-2.txt", "file-3.txt", "file-4.txt"];
    const turnThreeRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.turn === 3 &&
            record.toolCalls?.includes("fs_read")
    );
    const injectedFourthReadRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.turn === 4 &&
            record.toolCalls?.includes("fs_read") &&
            record.requestDebug.includes(correctionText) &&
            record.requestDebug.includes("injected-user-messages") &&
            record.requestDebug.includes("content-file-3")
    );
    const finalRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.turn === 5 &&
            record.content?.includes("Read 4 files total after adjustment") &&
            record.requestDebug.includes(correctionText) &&
            record.requestDebug.includes("content-file-4")
    );
    const finalEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("Read 4 files total after adjustment")
    );
    const unexpectedDefault = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("FS read adjustment probe did not match expected message state")
    );

    return [
        {
            name: "Agent read exactly the first four requested files",
            ok:
                readPaths.length === expectedPaths.length &&
                expectedPaths.every((expected, index) => readPaths[index] === expected),
            detail: `Expected ${expectedPaths.join(", ")}, saw ${readPaths.join(", ") || "<none>"}.`,
        },
        {
            name: "Correction arrived during third model generation",
            ok: Boolean(turnThreeRequest) && !turnThreeRequest?.requestDebug.includes(correctionText),
            detail:
                "Expected the third model request to have started before the correction was injected.",
        },
        {
            name: "Next agent loop received injected correction in messages array",
            ok: Boolean(injectedFourthReadRequest),
            detail:
                "Expected the fourth-read model request to contain the injected-user-messages reminder and correction text.",
        },
        {
            name: "Agent stopped after reading file 4",
            ok: Boolean(finalRequest) && Boolean(finalEvent) && !readPaths.includes("file-5.txt"),
            detail:
                "Expected a final response after file-4.txt and no fs_read call for file-5.txt.",
        },
        {
            name: "No mock fallback responses were used",
            ok: !unexpectedDefault,
            detail: "A fallback response means a model turn missed the expected injected message state.",
        },
    ];
}

function evaluateMcpTool(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const toolEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "mcp__probe__answer_probe")
    );
    const finalEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("MCP probe final: tool output accepted")
    );
    const callRecord = context.mcpProbeRecords?.find(
        (record) => record.event === "call_tool" && record.toolName === "answer_probe"
    );
    const listRecord = context.mcpProbeRecords?.find((record) => record.event === "list_tools");
    const finalRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.turn === 2 &&
            record.requestDebug.includes("MCP probe answered: project-context")
    );
    const unexpectedDefault = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("MCP probe mock response did not match expected runtime state")
    );

    return [
        {
            name: "Runtime exposed project MCP tool to agent",
            ok: Boolean(toolEvent),
            detail: "Expected PM tool event for mcp__probe__answer_probe.",
        },
        {
            name: "Runtime listed MCP tools from project server",
            ok: Boolean(listRecord),
            detail: "Expected MCP probe server log to include tools/list.",
        },
        {
            name: "MCP server ran in project working directory",
            ok: Boolean(callRecord) && callRecord?.cwd === context.workspaceDir,
            detail: `Expected MCP call cwd ${context.workspaceDir}, saw ${String(callRecord?.cwd ?? "<none>")}.`,
        },
        {
            name: "Agent received MCP tool result on next model turn",
            ok: Boolean(finalRequest) && Boolean(finalEvent),
            detail: "Expected second PM turn and final relay event after MCP tool result.",
        },
        {
            name: "No mock fallback responses were used",
            ok: !unexpectedDefault,
            detail: "A fallback response means a model turn missed the expected MCP result.",
        },
    ];
}

function isShellTool(event: Event, commandNeedle: string): boolean {
    return (
        event.kind === 1 &&
        hasTag(event, "tool", "shell") &&
        (tagValue(event, "tool-args") ?? "").includes(commandNeedle)
    );
}

function isFsReadTool(event: Event): boolean {
    return event.kind === 1 && hasTag(event, "tool", "fs_read");
}

function toolArgPath(event: Event): string | undefined {
    try {
        const args = JSON.parse(tagValue(event, "tool-args") ?? "{}") as { path?: unknown };
        return typeof args.path === "string" ? args.path : undefined;
    } catch {
        return undefined;
    }
}

function hasTag(event: Event, name: string, value?: string): boolean {
    return event.tags.some((tag) => tag[0] === name && (value === undefined || tag[1] === value));
}

function tagValue(event: Event, name: string): string | undefined {
    return event.tags.find((tag) => tag[0] === name)?.[1];
}
