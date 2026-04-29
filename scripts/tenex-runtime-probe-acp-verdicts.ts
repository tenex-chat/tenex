import type { Event } from "nostr-tools";

type Verdict = { name: string; ok: boolean; detail: string };

type AcpEvaluateContext = {
    workerPubkey: string;
};

export function evaluateAcpWorker(events: Event[], context: AcpEvaluateContext): Verdict[] {
    const completion = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.workerPubkey &&
            event.content.toLowerCase().includes("haiku acp worker completed") &&
            hasTag(event, "status", "completed")
    );
    const streamDelta = events.find(
        (event) =>
            event.kind === 24135 &&
            event.pubkey === context.workerPubkey &&
            event.content.toLowerCase().includes("haiku acp worker completed") &&
            hasTag(event, "stream-seq", "1") &&
            !hasTag(event, "p") &&
            !hasTag(event, "status")
    );
    const toolEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.workerPubkey &&
            event.tags.some((tag) => tag[0] === "tool")
    );

    return [
        {
            name: "ACP worker emitted completed Nostr response",
            ok: Boolean(completion),
            detail: "Expected worker completion from tenex-agent-acp containing the ACP backend response.",
        },
        {
            name: "ACP worker streamed visible response delta",
            ok: Boolean(streamDelta),
            detail: "Expected ACP agent_message_chunk updates to publish as non-p-tag kind:24135 stream deltas.",
        },
        {
            name: "ACP worker did not receive TENEX tool surface",
            ok: !toolEvent,
            detail: `Expected no TENEX tool-use events from ACP worker; saw ${toolEvent ? JSON.stringify(toolEvent.tags) : "<none>"}.`,
        },
    ];
}

function hasTag(event: Event, name: string, value?: string): boolean {
    return event.tags.some((tag) => tag[0] === name && (value === undefined || tag[1] === value));
}
