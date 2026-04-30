import type { Event } from "nostr-tools";
import type { MockRequestRecord, ScenarioContext } from "./tenex-runtime-probe-scenarios";

export const askUserRequest = "Ask the project owner: Which branch should I target for the release? Options: main, staging, release-v2.";
export const askTitle = "Release branch selection";
export const askCompletionText = "Question sent to project owner.";

type Verdict = { name: string; ok: boolean; detail: string };

type EvaluateContext = {
    pmPubkey: string;
    ownerPubkey: string;
};

export const askPmInstructions =
    "When asked to ask the owner a question, call the ask tool exactly once with a structured question. After the tool result, stop and wait for the owner's reply. Do not call any other tools.";

export function askMockScenario(): unknown {
    return {
        responses: [
            {
                agent: "pm",
                turn: 1,
                contains: askUserRequest,
                toolCalls: [
                    {
                        name: "ask",
                        args: {
                            title: askTitle,
                            context: "Need to determine the target branch for the release.",
                            questions: [
                                {
                                    type: "single_select",
                                    title: "Target branch",
                                    prompt: "Which branch should I target for the release?",
                                    options: ["main", "staging", "release-v2"],
                                },
                            ],
                        },
                    },
                ],
            },
            {
                agent: "pm",
                turn: 2,
                containsAll: ["Question", "sent", "owner"],
                content: askCompletionText,
            },
        ],
        defaultContent: "Ask probe should not re-engage after sending the question.",
    };
}

export async function runAskProbe(context: ScenarioContext): Promise<void> {
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 15_000);

    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: askUserRequest,
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
            hasTag(event, "tool", "ask"),
        timeoutMs,
        "ask tool event"
    );
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "status", "completed"),
        timeoutMs,
        "ask completion"
    );
}

export function evaluateAsk(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const askEvents = events.filter(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "ask")
    );
    const firstAskArgs = parseAskArgs(askEvents[0]);
    const completedEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "status", "completed")
    );

    // Look for the Nostr ask event directed to the owner
    const askNostrEvent = events.find(
        (event) =>
            event.kind === 1 &&
            hasTag(event, "p", context.ownerPubkey) &&
            !hasTag(event, "tool") &&
            event.pubkey === context.pmPubkey &&
            (event.content.includes(askTitle) ||
                event.content.toLowerCase().includes("branch") ||
                event.content.toLowerCase().includes("release"))
    );

    const hasTitle = typeof firstAskArgs?.title === "string" && firstAskArgs.title.length > 0;
    const hasQuestions = Array.isArray(firstAskArgs?.questions) && firstAskArgs.questions.length > 0;
    const hasContext = typeof firstAskArgs?.context === "string" && firstAskArgs.context.length > 0;

    return [
        {
            name: "Agent called ask tool exactly once",
            ok: askEvents.length === 1,
            detail: `Expected exactly one ask event, saw ${askEvents.length}.`,
        },
        {
            name: "Ask has title",
            ok: hasTitle,
            detail: firstAskArgs
                ? `Title: '${firstAskArgs.title ?? "<missing>"}'.`
                : "No parseable ask payload found.",
        },
        {
            name: "Ask has structured questions",
            ok: hasQuestions,
            detail: firstAskArgs
                ? `Questions count: ${firstAskArgs.questions?.length ?? 0}.`
                : "No questions in ask payload.",
        },
        {
            name: "Ask has context field",
            ok: hasContext,
            detail: firstAskArgs
                ? `Context: '${firstAskArgs.context ?? "<missing>"}'.`
                : "No context in ask payload.",
        },
        {
            name: "Ask event published to owner on relay",
            ok: Boolean(askNostrEvent),
            detail: "Expected a kind:1 event from PM to owner with the question content.",
        },
        {
            name: "Agent stopped after ask (status=completed)",
            ok: Boolean(completedEvent),
            detail: "Expected the agent to emit status=completed after calling ask, indicating it stopped to wait for a reply.",
        },
    ];
}

function parseAskArgs(event: Event | undefined): { title?: string; context?: string; questions?: unknown[] } | undefined {
    if (!event) return undefined;
    try {
        return JSON.parse(tagValue(event, "tool-args") ?? "{}") as { title?: string; context?: string; questions?: unknown[] };
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
