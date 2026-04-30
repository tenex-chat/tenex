import { existsSync, readFileSync } from "node:fs";
import type { Event } from "nostr-tools";
import type { MockRequestRecord, ScenarioContext } from "./tenex-runtime-probe-scenarios";

export const learnUserRequest = "Record a lesson: when running fs_read, always check the working directory first. Category: debugging.";
export const learnTitle = "Check working directory before fs_read";
export const learnCategory = "debugging";
export const learnCompletionText = "Lesson recorded and index updated.";

type Verdict = { name: string; ok: boolean; detail: string };

type EvaluateContext = {
    pmPubkey: string;
    agentHomeDir?: string;
};

export const learnPmInstructions =
    "When asked to record a lesson, call the learn tool exactly once with the requested title, lesson content, and category. After the tool result, reply exactly: Lesson recorded and index updated. Do not call any other tools.";

export function learnMockScenario(): unknown {
    return {
        responses: [
            {
                agent: "pm",
                turn: 1,
                contains: learnUserRequest,
                toolCalls: [
                    {
                        name: "learn",
                        args: {
                            title: learnTitle,
                            lesson: "When running fs_read, always check the working directory first.",
                            category: learnCategory,
                        },
                    },
                ],
            },
            {
                agent: "pm",
                turn: 2,
                containsAll: ["Lesson", "published", "+INDEX.md"],
                content: learnCompletionText,
            },
        ],
        defaultContent: "Learn probe should not re-engage after recording the lesson.",
    };
}

export async function runLearnProbe(context: ScenarioContext): Promise<void> {
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 15_000);

    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: learnUserRequest,
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
            hasTag(event, "tool", "learn"),
        timeoutMs,
        "learn tool event"
    );
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes(learnCompletionText) &&
            hasTag(event, "status", "completed"),
        timeoutMs,
        "learn final completion"
    );
}

export function evaluateLearn(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const learnEvents = events.filter(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "learn")
    );
    const firstLearnArgs = parseLearnArgs(learnEvents[0]);
    const finalEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes(learnCompletionText) &&
            hasTag(event, "status", "completed")
    );
    const lessonNostrEvent = events.find(
        (event) => event.kind === 4129
    );
    const titleTag = lessonNostrEvent?.tags.find((tag) => tag[0] === "title");
    const categoryTag = lessonNostrEvent?.tags.find((tag) => tag[0] === "category");
    const learnRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.toolCalls?.includes("learn")
    );

    let indexMdExists = false;
    let indexMdContainsLesson = false;
    if (context.agentHomeDir) {
        const indexPath = context.agentHomeDir + "/+INDEX.md";
        if (existsSync(indexPath)) {
            indexMdExists = true;
            const indexContent = readFileSync(indexPath, "utf8");
            indexMdContainsLesson =
                indexContent.toLowerCase().includes("debugging") ||
                indexContent.toLowerCase().includes("working directory") ||
                indexContent.toLowerCase().includes("fs_read");
        }
    }

    return [
        {
            name: "Agent called learn tool exactly once",
            ok: learnEvents.length === 1,
            detail: `Expected exactly one learn tool event, saw ${learnEvents.length}.`,
        },
        {
            name: "Learn tool received correct title and category",
            ok: firstLearnArgs?.title === learnTitle && firstLearnArgs?.category === learnCategory,
            detail: firstLearnArgs
                ? `Saw title='${firstLearnArgs.title}' category='${firstLearnArgs.category}'.`
                : "No parseable learn tool payload found.",
        },
        {
            name: "Lesson Nostr event published (kind 4129)",
            ok: Boolean(lessonNostrEvent),
            detail: "Expected a kind:4129 lesson event on the relay.",
        },
        {
            name: "Lesson event has title and category tags",
            ok: Boolean(titleTag) && Boolean(categoryTag),
            detail: `Title: ${titleTag?.[1] ?? "<missing>"}, category: ${categoryTag?.[1] ?? "<missing>"}.`,
        },
        {
            name: "Final completion published after learn",
            ok: Boolean(finalEvent),
            detail: "Expected final status=completed event after the learn tool call.",
        },
        {
            name: "+INDEX.md file exists in agent home",
            ok: indexMdExists,
            detail: context.agentHomeDir
                ? `Expected +INDEX.md at ${context.agentHomeDir}/+INDEX.md.`
                : "Agent home directory not provided to verdict context.",
        },
        {
            name: "+INDEX.md contains the learned lesson",
            ok: indexMdContainsLesson,
            detail: "Expected +INDEX.md to mention the debugging lesson content.",
        },
    ];
}

function parseLearnArgs(event: Event | undefined): { title?: string; category?: string; lesson?: string } | undefined {
    if (!event) return undefined;
    try {
        return JSON.parse(tagValue(event, "tool-args") ?? "{}") as { title?: string; category?: string; lesson?: string };
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
