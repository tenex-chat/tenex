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

function tagValue(event: Event, name: string): string | undefined {
    return event.tags.find((tag) => tag[0] === name)?.[1];
}

type AcpMidTurnContext = {
    workerPubkey: string;
};

export function evaluateAcpMidTurnInjection(
    events: Event[],
    context: AcpMidTurnContext
): Verdict[] {
    const completions = events.filter(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.workerPubkey &&
            hasTag(event, "status", "completed")
    );
    const prompt1 = completions.find((event) => event.content.includes("[prompt #1]"));
    const prompt2 = completions.find((event) => event.content.includes("[prompt #2]"));
    const thread1 = prompt1 ? tagValue(prompt1, "llm-thread-id") : undefined;
    const thread2 = prompt2 ? tagValue(prompt2, "llm-thread-id") : undefined;

    const reply1 = prompt1?.tags.find((tag) => tag[0] === "e" && tag[3] === "reply")?.[1];
    const reply2 = prompt2?.tags.find((tag) => tag[0] === "e" && tag[3] === "reply")?.[1];
    const distinctReplies = Boolean(reply1 && reply2 && reply1 !== reply2);

    return [
        {
            name: "ACP worker emitted completion for first prompt",
            ok: Boolean(prompt1),
            detail: "Expected completion containing [prompt #1] tagged status=completed.",
        },
        {
            name: "ACP worker emitted completion for second prompt",
            ok: Boolean(prompt2),
            detail: "Expected completion containing [prompt #2] tagged status=completed.",
        },
        {
            name: "ACP mid-turn injection: both completions share one persistent session",
            ok: Boolean(thread1 && thread2 && thread1 === thread2),
            detail: `Expected matching llm-thread-id on both completions (single persistent ACP session); saw thread1=${thread1 ?? "<none>"} thread2=${thread2 ?? "<none>"}.`,
        },
        {
            name: "ACP mid-turn injection: completions reply to distinct user events",
            ok: distinctReplies,
            detail: `Expected each completion's e-reply tag to point to a different user event; saw reply1=${reply1 ?? "<none>"} reply2=${reply2 ?? "<none>"}.`,
        },
    ];
}
