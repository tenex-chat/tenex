import type { Event } from "nostr-tools";
import type { MockRequestRecord, ScenarioContext } from "./tenex-runtime-probe-scenarios";
import { waitForStoredMessage } from "./tenex-runtime-probe-conversations";

export const hooksPreToolUserRequest = "run the shell command 'echo hello'";
export const hooksPreToolBlockReason = "hook-blocked";
export const hooksPreToolFinalText =
    "The shell command was blocked by the project hook; I did not run it.";
export const hooksPreToolFallback =
    "Hooks pre-tool probe did not match expected runtime state.";

/// The `.tenex-hooks.json` written into the workspace before the runtime
/// boots. The hook blocks any `shell` tool call by exiting non-zero with
/// `hook-blocked` on stderr, and allows everything else.
export const hooksPreToolConfig = {
    hooks: [
        {
            name: "block-shell",
            command: [
                "sh",
                "-c",
                "if grep -q '\"tool\":\"shell\"'; then printf hook-blocked >&2; exit 1; fi",
            ],
            events: ["pre-tool"],
        },
    ],
};

type Verdict = { name: string; ok: boolean; detail: string };

type EvaluateContext = {
    pmPubkey: string;
};

const shellToolCall = {
    name: "shell",
    args: {
        command: "echo hello",
        description: "Run the requested shell command",
        timeout: 5,
    },
};

export const hooksPreToolPmInstructions =
    "This scenario verifies project pre-tool hooks. On the first turn, call shell exactly once to run the requested command. The shell call will be blocked by a project hook; after you receive the block reason, do not call tools again and reply exactly: " +
    hooksPreToolFinalText;

export function hooksPreToolMockScenario(): unknown {
    return {
        responses: [
            // Turn 1: the model calls shell. The project pre-tool hook blocks
            // it; the block reason is fed back as the tool result.
            {
                agent: "pm",
                turn: 1,
                contains: hooksPreToolUserRequest,
                toolCalls: [shellToolCall],
            },
            // Turn 2: the model has observed the block reason in its prompt and
            // acknowledges without retrying the tool.
            {
                agent: "pm",
                turn: 2,
                contains: hooksPreToolBlockReason,
                content: hooksPreToolFinalText,
            },
        ],
        defaultContent: hooksPreToolFallback,
    };
}

export async function runHooksPreToolProbe(context: ScenarioContext): Promise<void> {
    const timeoutMs = Number(process.env.TENEX_PROBE_WAIT_MS ?? 12_000);

    const userEvent = context.sign(
        {
            kind: 1,
            created_at: context.now(),
            content: hooksPreToolUserRequest,
            tags: [["a", context.projectRef]],
        },
        context.userSecret
    );
    await Promise.all(context.pool.publish([context.relayUrl], userEvent));

    // A hook-blocked tool is skipped before any tool-use event is published —
    // exactly like a supervisor block — so there is no `tool=shell` nostr event
    // to observe. The block reason is instead fed back as the tool result and
    // appears in the next model request. Waiting on that request proves the
    // gate fired and the reason reached the LLM.
    await context.waitForRequestRecord(
        context.requestRecordPath,
        (records) =>
            records.some(
                (record) =>
                    record.agent === "pm" &&
                    record.turn === 2 &&
                    record.requestDebug.includes(hooksPreToolBlockReason)
            ),
        timeoutMs,
        "second PM request carrying the hook block reason"
    );

    // Use the conversation DB (not the relay subscription) to detect completion —
    // the relay's ACL defers event delivery to external subscribers.
    await waitForStoredMessage(
        context.conversationDbPath,
        userEvent.id,
        (message) =>
            message.authorPubkey === context.pmPubkey &&
            message.content.includes(hooksPreToolFinalText),
        timeoutMs,
        "hooks pre-tool final completion",
        context.delay
    );
}

export function evaluateHooksPreTool(
    events: Event[],
    requestRecords: MockRequestRecord[],
    context: EvaluateContext
): Verdict[] {
    const blockReasonRequest = requestRecords.find(
        (record) =>
            record.agent === "pm" &&
            record.turn === 2 &&
            record.requestDebug.includes(hooksPreToolBlockReason)
    );
    // The hook blocks before execution: the actual command (`echo hello`) must
    // never run, so its output must not appear in any model request.
    const commandRan = requestRecords.some((record) =>
        record.requestDebug.includes("hello\n")
    );
    const finalEvent = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes(hooksPreToolFinalText) &&
            hasTag(event, "status", "completed")
    );
    const unexpectedFallback = events.find(
        (event) =>
            event.kind === 1 &&
            event.pubkey === context.pmPubkey &&
            event.content.includes(hooksPreToolFallback)
    );

    return [
        {
            name: "Pre-tool hook block reason reached the model",
            ok: Boolean(blockReasonRequest),
            detail: `Expected the second PM request to contain the hook block reason '${hooksPreToolBlockReason}' as the shell tool result.`,
        },
        {
            name: "Blocked shell command never executed",
            ok: !commandRan,
            detail: "Expected no model request to contain the shell command's output ('hello'); the hook must gate execution.",
        },
        {
            name: "Agent acknowledged the block and stopped",
            ok: Boolean(finalEvent) && !unexpectedFallback,
            detail: "Expected the PM to publish the scripted acknowledgement after the block, with no fallback response.",
        },
    ];
}

function hasTag(event: Event, name: string, value?: string): boolean {
    return event.tags.some((tag) => tag[0] === name && (value === undefined || tag[1] === value));
}
