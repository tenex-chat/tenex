import type { Event } from "nostr-tools";
import type { MockRequestRecord, ScenarioContext } from "./tenex-runtime-probe-scenarios";

export const ragSelfUserRequest = "Store a note in your personal knowledge: My preferred code style is early returns over nested if-else. Audience: self.";
export const ragProjectUserRequest = "Store this in the project collection: The build command is cargo build --release. Audience: project.";
export const ragSelfCompletionText = "Personal knowledge stored.";
export const ragProjectCompletionText = "Project document stored.";

type Verdict = { name: string; ok: boolean; detail: string };

type EvaluateContext = {
    pmPubkey: string;
};

export const ragPmInstructions =
    "When asked to store a document with audience=self, call rag_add_documents exactly once with the content and audience='self'. When asked to store with audience=project, call rag_add_documents with audience='project'. After each tool result, confirm with the exact completion phrase. Do not call any other tools.";

export function ragMockScenario(): unknown {
    return {
        responses: [
            {
                agent: "pm",
                turn: 1,
                contains: ragSelfUserRequest,
                toolCalls: [
                    {
                        name: "rag_add_documents",
                        args: {
                            content: "My preferred code style is early returns over nested if-else.",
                            audience: "self",
                            title: "Code style preference",
                        },
                    },
                ],
            },
            {
                agent: "pm",
                turn: 2,
                containsAll: ["Stored", "self"],
                content: ragSelfCompletionText,
            },
        ],
        defaultContent: "RAG documents probe should not re-engage after storing.",
    };
}

export async function runRagDocumentsProbe(context: ScenarioContext): Promise<void> {
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 15_000);

    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: ragSelfUserRequest,
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
            hasTag(event, "tool", "rag_add_documents"),
        timeoutMs,
        "rag_add_documents tool event"
    );
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes(ragSelfCompletionText) &&
            hasTag(event, "status", "completed"),
        timeoutMs,
        "rag documents final completion"
    );
}

export function evaluateRagDocuments(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const ragEvents = events.filter(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "rag_add_documents")
    );
    const firstRagArgs = parseRagArgs(ragEvents[0]);
    const finalEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            (event.content.includes(ragSelfCompletionText) || event.content.includes(ragProjectCompletionText)) &&
            hasTag(event, "status", "completed")
    );

    const usedSelfAudience = firstRagArgs?.audience === "self";
    const usedProjectAudience = firstRagArgs?.audience === "project";
    const hasContent = typeof firstRagArgs?.content === "string" && firstRagArgs.content.length > 0;

    return [
        {
            name: "Agent called rag_add_documents exactly once",
            ok: ragEvents.length === 1,
            detail: `Expected exactly one rag_add_documents event, saw ${ragEvents.length}.`,
        },
        {
            name: "Document stored with correct audience scope",
            ok: usedSelfAudience || usedProjectAudience,
            detail: firstRagArgs
                ? `Saw audience='${firstRagArgs.audience}'. Expected 'self' or 'project'.`
                : "No parseable rag_add_documents payload found.",
        },
        {
            name: "Document has non-empty content",
            ok: hasContent,
            detail: firstRagArgs
                ? `Content length: ${firstRagArgs.content?.length ?? 0}.`
                : "No content found in rag_add_documents args.",
        },
        {
            name: "Agent did not attempt to create or delete collections",
            ok: !events.some((event) => hasTag(event, "tool", "rag_collection_list")) &&
                !events.some((event) => hasTag(event, "tool", "rag_collection_delete")),
            detail: "Agents should not have rag_collection_list or rag_collection_delete tools available.",
        },
        {
            name: "Final completion published after rag_add_documents",
            ok: Boolean(finalEvent),
            detail: "Expected final status=completed event after the rag_add_documents call.",
        },
    ];
}

function parseRagArgs(event: Event | undefined): { content?: string; audience?: string; title?: string } | undefined {
    if (!event) return undefined;
    try {
        return JSON.parse(tagValue(event, "tool-args") ?? "{}") as { content?: string; audience?: string; title?: string };
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
