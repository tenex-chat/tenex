import type { Event } from "nostr-tools";
import type { ScenarioContext } from "./tenex-runtime-probe-scenarios";

export const shellKillAgentListRequest = "what agents do you see in this project?";
export const shellKillRunRequest = "run sleep 60";
export const shellKillKillRequest = "kill the shell";
export const shellKillStatusRequest = "what are you doing?";
export const shellKillDuplicateFallback =
    "Shell kill duplicate probe did not match expected runtime state.";
export const shellKillPendingAcknowledgement =
    "I see the existing sleep shell call is still running.";

export const pmShellKillDuplicateInstructions =
    "Use shell for sleep requests. If the user asks to kill a shell, inspect active shell reminders and use kill for the listed shell task ids.";

export function shellKillDuplicateMockScenario(): unknown {
    const shellTimeout = Number(process.env.TENEX_PROBE_SHELL_TIMEOUT_SECS ?? 8);
    const shellToolCall = {
        name: "shell",
        args: {
            command: "sleep 60",
            description: "Run sleep command for 60 seconds",
            timeout: shellTimeout,
        },
    };

    return {
        responses: [
            {
                agent: "pm",
                turn: 1,
                containsAll: [
                    shellKillStatusRequest,
                    "active-shell-tasks",
                    "pending-tool-result",
                    "sleep 60",
                ],
                content: "I see one active sleep shell task in this conversation.",
            },
            {
                agent: "pm",
                turn: 1,
                containsAll: [
                    shellKillKillRequest,
                    "active-shell-tasks",
                    "pending-tool-result",
                    "sleep 60",
                ],
                content: shellKillPendingAcknowledgement,
            },
            {
                agent: "pm",
                turn: 1,
                containsAll: [shellKillKillRequest, "active-shell-tasks", "sleep 60"],
                toolCalls: [shellToolCall],
            },
            {
                agent: "pm",
                turn: 1,
                contains: shellKillRunRequest,
                toolCalls: [shellToolCall],
            },
            {
                agent: "pm",
                turn: 1,
                contains: shellKillAgentListRequest,
                content: "Project agents: pm and worker.",
            },
            {
                agent: "pm",
                turn: 2,
                contains: "shell-error",
                content: "Sleep command ended after the probe timeout.",
            },
        ],
        defaultContent: shellKillDuplicateFallback,
    };
}

export async function runShellKillDuplicateProbe(context: ScenarioContext): Promise<void> {
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 12_000);
    const shellTimeoutSecs = Number(process.env.TENEX_PROBE_SHELL_TIMEOUT_SECS ?? 8);

    const rootEvent = await publishUserEvent(context, shellKillAgentListRequest, [
        ["a", context.projectRef],
        ["p", context.pmPubkey],
    ]);
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("Project agents: pm and worker"),
        timeoutMs,
        "agent list response"
    );

    const runEvent = await publishUserEvent(context, shellKillRunRequest, [
        ["e", rootEvent.id, "", "root"],
        ["p", context.pmPubkey],
    ]);
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.pubkey === context.pmPubkey &&
            isShellSleepTool(event) &&
            hasMarkedTag(event, "e", runEvent.id, "reply"),
        timeoutMs,
        "initial sleep shell tool event"
    );
    await context.delay(1_000);

    const killEvent = await publishUserEvent(context, shellKillKillRequest, [
        ["e", rootEvent.id, "", "root"],
        ["p", context.pmPubkey],
    ]);
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes(shellKillPendingAcknowledgement) &&
            hasMarkedTag(event, "e", killEvent.id, "reply"),
        timeoutMs,
        "kill request acknowledgement of pending shell call"
    );
    await context.delay(500);

    await publishUserEvent(context, shellKillStatusRequest, [
        ["e", rootEvent.id, "", "root"],
        ["p", context.pmPubkey],
    ]);
    await context.waitForRequestRecord(
        context.requestRecordPath,
        (records) =>
            records.some(
                (record) =>
                    record.agent === "pm" &&
                    record.requestDebug.includes(shellKillStatusRequest) &&
                    record.requestDebug.includes("pending-tool-result") &&
                    activeShellTaskCount(record.requestDebug) >= 1
            ),
        timeoutMs,
        "status request with active shell task and pending tool result"
    );

    await context.delay((shellTimeoutSecs + 1) * 1_000);
}

function publishUserEvent(
    context: ScenarioContext,
    content: string,
    tags: string[][]
): Promise<Event> {
    const event = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content,
            tags,
        },
        context.userSecret
    );
    return Promise.all(context.pool.publish([context.relayUrl], event)).then(() => event);
}

function isShellSleepTool(event: Event): boolean {
    return (
        event.kind === 1 &&
        hasTag(event, "tool", "shell") &&
        (tagValue(event, "tool-args") ?? "").includes('"command":"sleep 60"')
    );
}

function activeShellTaskCount(text: string): number {
    return new Set(text.match(/shell-[0-9a-f]{12}/g) ?? []).size;
}

function hasTag(event: Event, name: string, value?: string): boolean {
    return event.tags.some((tag) => tag[0] === name && (value === undefined || tag[1] === value));
}

function hasMarkedTag(event: Event, name: string, value: string, marker: string): boolean {
    return event.tags.some((tag) => tag[0] === name && tag[1] === value && tag[3] === marker);
}

function tagValue(event: Event, name: string): string | undefined {
    return event.tags.find((tag) => tag[0] === name)?.[1];
}
