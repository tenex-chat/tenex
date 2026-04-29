import type { Event } from "nostr-tools";
import type { MockRequestRecord } from "./tenex-runtime-probe-scenarios";
import {
    shellKillAgentListRequest,
    shellKillDuplicateFallback,
    shellKillKillRequest,
    shellKillPendingAcknowledgement,
    shellKillRunRequest,
    shellKillStatusRequest,
} from "./tenex-runtime-probe-shell-scenario";

type Verdict = { name: string; ok: boolean; detail: string };

type EvaluateContext = {
    pmPubkey: string;
};

export function evaluateShellKillDuplicate(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const agentListResponse = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("Project agents: pm and worker")
    );
    const runEvent = events.find(
        (event) => event.kind === 1 && event.content === shellKillRunRequest
    );
    const killEvent = events.find(
        (event) => event.kind === 1 && event.content === shellKillKillRequest
    );
    const shellEvents = events.filter(
        (event) => event.pubkey === context.pmPubkey && shellCommand(event) === "sleep 60"
    );
    const runShell = runEvent
        ? shellEvents.find((event) => hasMarkedTag(event, "e", runEvent.id, "reply"))
        : undefined;
    const killShell = killEvent
        ? shellEvents.find((event) => hasMarkedTag(event, "e", killEvent.id, "reply"))
        : undefined;
    const killAcknowledgement = killEvent
        ? events.find(
              (event) =>
                  event.kind === 1 &&
                  event.pubkey === context.pmPubkey &&
                  event.content.includes(shellKillPendingAcknowledgement) &&
                  hasMarkedTag(event, "e", killEvent.id, "reply")
          )
        : undefined;
    const killRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.requestDebug.includes(shellKillKillRequest) &&
            record.requestDebug.includes("active-shell-tasks")
    );
    const statusRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.requestDebug.includes(shellKillStatusRequest) &&
            record.requestDebug.includes("active-shell-tasks")
    );
    const statusShellCount = statusRequest ? activeShellTaskCount(statusRequest.requestDebug) : 0;
    const killRequestHasPending =
        killRequest?.requestDebug.includes("pending-tool-result") &&
        killRequest.requestDebug.includes("sleep 60");
    const statusRequestHasPending =
        statusRequest?.requestDebug.includes("pending-tool-result") &&
        statusRequest.requestDebug.includes("sleep 60");
    const unexpectedDefault = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes(shellKillDuplicateFallback)
    );
    const agentListUserEvent = events.find(
        (event) => event.kind === 1 && event.content === shellKillAgentListRequest
    );

    return [
        {
            name: "Probe established the prior agent-list turn",
            ok: Boolean(agentListUserEvent) && Boolean(agentListResponse),
            detail: "Expected the initial project-agent question and PM response before shell turns.",
        },
        {
            name: "Initial sleep request emitted a foreground shell tool event",
            ok: Boolean(runShell),
            detail: `Expected shell tool replying to '${shellKillRunRequest}'; saw ${shellEvents.length} sleep shell event(s).`,
        },
        {
            name: "Kill request prompt saw active shell task reminder",
            ok: Boolean(killRequest) && activeShellTaskCount(killRequest!.requestDebug) >= 1,
            detail: "Expected the kill turn model request to include an active-shell-tasks reminder.",
        },
        {
            name: "Kill request prompt saw structured pending tool result",
            ok: Boolean(killRequestHasPending),
            detail: "Expected the kill turn prompt to include a pending-tool-result paired with the sleep tool call.",
        },
        {
            name: "Kill request did not launch a duplicate sleep shell",
            ok: !killShell && shellEvents.length === 1 && Boolean(killAcknowledgement),
            detail: `Expected only the original sleep shell event and a pending-call acknowledgement; saw ${shellEvents.length} sleep shell event(s).`,
        },
        {
            name: "Follow-up status prompt saw the active shell and pending tool state",
            ok: statusShellCount >= 1 && Boolean(statusRequestHasPending),
            detail: `Expected one active shell task plus pending-tool-result in the status prompt; saw ${statusShellCount} active shell id(s).`,
        },
        {
            name: "No mock fallback responses were used",
            ok: !unexpectedDefault,
            detail: "A fallback response means a model turn missed the expected shell-kill state.",
        },
    ];
}

function shellCommand(event: Event): string | undefined {
    if (!hasTag(event, "tool", "shell")) {
        return undefined;
    }
    try {
        const args = JSON.parse(tagValue(event, "tool-args") ?? "{}") as { command?: unknown };
        return typeof args.command === "string" ? args.command : undefined;
    } catch {
        return undefined;
    }
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
