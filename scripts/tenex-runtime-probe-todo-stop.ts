import type { Event } from "nostr-tools";
import type { MockRequestRecord, ScenarioContext } from "./tenex-runtime-probe-scenarios";

export const todoStopUserRequest = "setup a todo list with 3 items and stop";
export const todoStopFinalText = "Todo list set up; stopping now.";

const todoItems = [
    { title: "First probe item", status: "pending" },
    { title: "Second probe item", status: "pending" },
    { title: "Third probe item", status: "pending" },
];

type Verdict = { name: string; ok: boolean; detail: string };

type EvaluateContext = {
    pmPubkey: string;
};

type TodoWriteArgs = {
    todos?: Array<{ title?: unknown; status?: unknown }>;
    force?: unknown;
};

export const todoStopPmInstructions =
    "This scenario verifies explicit todo setup without execution. When asked to set up a todo list and stop, call todo_write exactly once with three pending items. After the tool result, reply exactly: Todo list set up; stopping now. Do not mark items in_progress or done.";

export function todoStopMockScenario(): unknown {
    return {
        responses: [
            {
                agent: "pm",
                turn: 1,
                contains: todoStopUserRequest,
                toolCalls: [
                    {
                        name: "todo_write",
                        args: { todos: todoItems },
                    },
                ],
            },
            {
                agent: "pm",
                turn: 2,
                containsAll: ["Todo list updated", "First probe item", "Third probe item"],
                content: todoStopFinalText,
            },
        ],
        defaultContent: "Todo-stop probe should not re-engage after setting up todos.",
    };
}

export async function runTodoStopProbe(context: ScenarioContext): Promise<void> {
    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: todoStopUserRequest,
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );

    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 8_000);
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "todo_write"),
        timeoutMs,
        "todo_write tool event"
    );
    await context.waitForObservedEvent(
        context.events,
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes(todoStopFinalText) &&
            hasTag(event, "status", "completed"),
        timeoutMs,
        "todo-stop final completion"
    );
}

export function evaluateTodoStop(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const todoEvents = events.filter(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            hasTag(event, "tool", "todo_write")
    );
    const firstTodoArgs = parseTodoArgs(todoEvents[0]);
    const finalEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes(todoStopFinalText) &&
            hasTag(event, "status", "completed")
    );
    const finalIndex = finalEvent ? events.indexOf(finalEvent) : -1;
    const firstTodoIndex = todoEvents[0] ? events.indexOf(todoEvents[0]) : -1;
    const todoAfterFinal =
        finalIndex >= 0 &&
        todoEvents.some((event) => events.indexOf(event) > finalIndex);
    const unexpectedReengagement = requestRecords.some(
        (record) => record.agent === "pm" && record.turn > 2
    );
    const unexpectedFallback = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes("Todo-stop probe should not re-engage")
    );

    return [
        {
            name: "Agent created exactly one todo list",
            ok: todoEvents.length === 1,
            detail: `Expected exactly one todo_write event, saw ${todoEvents.length}.`,
        },
        {
            name: "Todo list contains three pending items",
            ok:
                firstTodoArgs?.todos?.length === 3 &&
                firstTodoArgs.todos.every((todo) => todo.status === "pending") &&
                firstTodoArgs.force !== true,
            detail: firstTodoArgs
                ? `Saw todo payload: ${JSON.stringify(firstTodoArgs)}.`
                : "No parseable todo_write payload found.",
        },
        {
            name: "Final completion published after todo setup",
            ok: Boolean(finalEvent) && firstTodoIndex >= 0 && finalIndex > firstTodoIndex,
            detail: "Expected final status=completed event after the todo_write event.",
        },
        {
            name: "Supervisor did not re-engage on pending setup-only todos",
            ok: !unexpectedReengagement && !unexpectedFallback && !todoAfterFinal,
            detail:
                "Expected no model turn after the scripted final response and no todo updates after completion.",
        },
    ];
}

function parseTodoArgs(event: Event | undefined): TodoWriteArgs | undefined {
    if (!event) {
        return undefined;
    }
    try {
        return JSON.parse(tagValue(event, "tool-args") ?? "{}") as TodoWriteArgs;
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
