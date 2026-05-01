// Lock-handoff harness runtime.
//
// Models the proposed design: per-(agent, conversation) lock with three logical
// states (IDLE / STREAMING / TOOL_PENDING). When a tool starts executing, the
// driver is released; a new user message arriving during that window can spawn
// a second concurrent RAL. When the original tool eventually returns, if the
// lock is now held by someone else the original RAL silently exits and writes
// the real result as a "late tool result" system entry.
//
// Source of truth is the ConversationStore. Messages handed to streamText are
// rebuilt from the store on every prepareStep, with synthetic tool-results
// injected for any pending tool-call that doesn't yet have a real result.

import { streamText, tool, stepCountIs } from "ai";
import type { ModelMessage, Tool, ToolSet } from "ai";
import { log, MODEL, nextRalId } from "./_shared";

// ---------- ConversationStore ----------

export interface ToolCallRecord {
    toolCallId: string;
    toolName: string;
    input: unknown;
}

export type StoredEntry =
    | { kind: "user"; content: string; t: number }
    | { kind: "assistant"; text: string; toolCalls: ToolCallRecord[]; t: number }
    | { kind: "tool-result"; toolCallId: string; toolName: string; output: unknown; t: number }
    | {
          kind: "late-tool-result";
          toolCallId: string;
          toolName: string;
          output: unknown;
          failed: boolean;
          t: number;
      }
    | { kind: "system"; content: string; t: number };

export class ConversationStore {
    private entries: StoredEntry[] = [];
    private listeners: ((e: StoredEntry) => void)[] = [];

    append(entry: StoredEntry): void {
        this.entries.push(entry);
        for (const l of this.listeners) l(entry);
    }

    /** Mutate the latest assistant entry (used to add additional parallel tool-calls). */
    mutateLastAssistant(fn: (e: Extract<StoredEntry, { kind: "assistant" }>) => void): void {
        for (let i = this.entries.length - 1; i >= 0; i--) {
            const e = this.entries[i];
            if (e.kind === "assistant") {
                fn(e);
                return;
            }
        }
    }

    all(): readonly StoredEntry[] {
        return this.entries;
    }

    onAppend(fn: (e: StoredEntry) => void): () => void {
        this.listeners.push(fn);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== fn);
        };
    }

    debugDump(): string {
        return this.entries
            .map((e, i) => {
                switch (e.kind) {
                    case "user":
                        return `${i}. user: ${e.content.slice(0, 80)}`;
                    case "assistant":
                        return `${i}. assistant: text="${e.text.slice(0, 60)}" toolCalls=[${e.toolCalls
                            .map((tc) => `${tc.toolName}(${tc.toolCallId.slice(-6)})`)
                            .join(",")}]`;
                    case "tool-result":
                        return `${i}. tool-result(${e.toolCallId.slice(-6)}): ${JSON.stringify(
                            e.output,
                        ).slice(0, 80)}`;
                    case "late-tool-result":
                        return `${i}. late-tool-result(${e.toolCallId.slice(-6)} ${
                            e.failed ? "FAIL" : "ok"
                        }): ${JSON.stringify(e.output).slice(0, 80)}`;
                    case "system":
                        return `${i}. system: ${e.content.slice(0, 80)}`;
                }
            })
            .join("\n");
    }
}

// ---------- Lock ----------

/**
 * Lock for a single (agent, conversation) pair.
 *
 * - `currentDriver` is the RAL id currently driving the LLM (STREAMING).
 *   When `null`, no RAL is making LLM calls right now.
 * - `pendingTools` is a map of toolCallId -> ralId for tools currently
 *   in flight. When a RAL has any pending tool, its `currentDriver` slot
 *   is released so a different RAL can pick up the conversation.
 *
 * State transitions:
 *   IDLE: currentDriver=null, pendingTools={}
 *   STREAMING: currentDriver=R, pendingTools may include R's running tools
 *              (from a previous step that completed without preemption — in
 *              which case the lock was re-acquired)
 *   TOOL_PENDING: currentDriver=null, pendingTools non-empty
 *
 * Multiple RALs can have pending tools simultaneously (e.g., RAL#1's shell
 * and RAL#2's web_fetch both running). The currentDriver slot is the gate
 * for "who is allowed to run streamText right now".
 */
export class Lock {
    private currentDriver: string | null = null;
    private readonly pendingTools = new Map<string, string>();
    private onReleaseListeners: Array<() => void> = [];

    getDriver(): string | null {
        return this.currentDriver;
    }

    /**
     * Subscribe to be notified ONCE when the driver slot transitions from
     * non-null to null via `releaseDriver`. The listener is dropped after
     * firing. Used by deferred wakeups: a late-tool-result that couldn't
     * spawn a wakeup RAL because the driver was held subscribes here so
     * it can retry when the current driver finishes.
     *
     * Note: only `releaseDriver` fires this. `finishTool` paths that lead
     * to "preempted" don't fire a release because the driver was already
     * non-null and stays so.
     */
    onceDriverReleased(fn: () => void): void {
        this.onReleaseListeners.push(fn);
    }

    pendingToolCount(): number {
        return this.pendingTools.size;
    }

    pendingToolsForRal(ralId: string): number {
        let n = 0;
        for (const owner of this.pendingTools.values()) if (owner === ralId) n++;
        return n;
    }

    /** True iff the RAL has any tool currently in flight. */
    hasPendingTools(ralId: string): boolean {
        return this.pendingToolsForRal(ralId) > 0;
    }

    /**
     * Atomically acquire the driver slot. Returns true if acquired.
     * Idempotent if already held by the same ralId.
     */
    tryAcquire(ralId: string): boolean {
        if (this.currentDriver === null) {
            this.currentDriver = ralId;
            return true;
        }
        return this.currentDriver === ralId;
    }

    /**
     * A tool of `ralId` is about to start executing. The driver slot is
     * released (so another RAL can pick up the conversation) but `ralId`'s
     * pending-tool tracking persists.
     *
     * Idempotent across parallel tool-call starts in the same step.
     */
    startTool(ralId: string, toolCallId: string): void {
        this.pendingTools.set(toolCallId, ralId);
        if (this.currentDriver === ralId) {
            this.currentDriver = null;
        }
    }

    /**
     * A tool of `ralId` has just finished. Drops the pending-tool entry and
     * decides what comes next:
     *
     * - "still-pending": ralId has more tools in flight (parallel-tool case).
     *   The caller continues to wait for siblings to finish.
     * - "reacquired": all of ralId's pending tools have finished AND the
     *   driver slot is free; ralId is now the driver again.
     * - "preempted": ralId's tools all finished but someone else holds the
     *   driver slot. Caller should silently exit and write a late-tool-result.
     */
    finishTool(
        ralId: string,
        toolCallId: string,
    ): "still-pending" | "reacquired" | "preempted" {
        this.pendingTools.delete(toolCallId);
        if (this.pendingToolsForRal(ralId) > 0) return "still-pending";
        if (this.currentDriver === null) {
            this.currentDriver = ralId;
            return "reacquired";
        }
        return "preempted";
    }

    /** Release the driver slot if held by `ralId`. Used at end-of-RAL. */
    releaseDriver(ralId: string): void {
        if (this.currentDriver !== ralId) return;
        this.currentDriver = null;
        const listeners = this.onReleaseListeners;
        this.onReleaseListeners = [];
        for (const l of listeners) {
            try {
                l();
            } catch (e) {
                log("[lock] release listener threw:", e);
            }
        }
    }

    snapshot(): { driver: string | null; pendingTools: Array<[string, string]> } {
        return {
            driver: this.currentDriver,
            pendingTools: [...this.pendingTools.entries()],
        };
    }
}

// ---------- Message rebuilding ----------

const SYNTHETIC_PLACEHOLDER =
    "Tool execution started in a previous turn and is still in progress. The real result will arrive later as a system message; act on the conversation as it currently stands.";

/**
 * Rebuild the AI SDK message array from the conversation store.
 *
 * Rules:
 * - Each `user` entry → `user` message.
 * - Each `assistant` entry → `assistant` message with text + tool-call blocks.
 *   Followed by ONE `tool` message containing tool-result parts for EVERY
 *   tool-call in that assistant entry. For each tool-call, look up a real
 *   `tool-result` entry by toolCallId; if missing, emit a synthetic placeholder.
 * - `tool-result` entries are consumed inline by the assistant rebuild — skip
 *   them when iterating.
 * - `late-tool-result` entries → `system` message with structured prefix,
 *   appearing in chronological order.
 *
 * Note on tool-message grouping: Anthropic requires that all `tool_use` blocks
 * in a single assistant turn be answered atomically by a single `tool_result`
 * batch. AI SDK forwards this constraint; emit one `tool` message per assistant
 * entry, not one per tool-call.
 */
export function buildMessages(store: ConversationStore): ModelMessage[] {
    const out: ModelMessage[] = [];
    const entries = store.all();

    const realResultByToolCallId = new Map<
        string,
        Extract<StoredEntry, { kind: "tool-result" }>
    >();
    for (const e of entries) {
        if (e.kind === "tool-result" && !realResultByToolCallId.has(e.toolCallId)) {
            realResultByToolCallId.set(e.toolCallId, e);
        }
    }

    for (const e of entries) {
        switch (e.kind) {
            case "user":
                out.push({ role: "user", content: e.content });
                break;
            case "assistant": {
                const assistantContent: Array<
                    | { type: "text"; text: string }
                    | {
                          type: "tool-call";
                          toolCallId: string;
                          toolName: string;
                          input: unknown;
                      }
                > = [];
                if (e.text) assistantContent.push({ type: "text", text: e.text });
                for (const tc of e.toolCalls) {
                    assistantContent.push({
                        type: "tool-call",
                        toolCallId: tc.toolCallId,
                        toolName: tc.toolName,
                        input: tc.input,
                    });
                }
                out.push({ role: "assistant", content: assistantContent });

                if (e.toolCalls.length > 0) {
                    out.push({
                        role: "tool",
                        content: e.toolCalls.map((tc) => {
                            const real = realResultByToolCallId.get(tc.toolCallId);
                            if (real) {
                                return {
                                    type: "tool-result" as const,
                                    toolCallId: tc.toolCallId,
                                    toolName: tc.toolName,
                                    output: {
                                        type: "json" as const,
                                        value: real.output as never,
                                    },
                                };
                            }
                            return {
                                type: "tool-result" as const,
                                toolCallId: tc.toolCallId,
                                toolName: tc.toolName,
                                output: {
                                    type: "text" as const,
                                    value: SYNTHETIC_PLACEHOLDER,
                                },
                            };
                        }),
                    });
                }
                break;
            }
            case "tool-result":
                // Already grouped under the producing assistant entry.
                break;
            case "late-tool-result": {
                // Render as a USER-role message rather than system.
                //
                // Rationale: Anthropic (and most providers) requires that the
                // last message before an assistant generation be a user turn.
                // Wakeup RALs spawn with a late-tool-result as the chronologically
                // last entry; if rendered as `system`, the trailing message in
                // the rebuilt array is whatever assistant turn preceded it, and
                // the model has no signal to respond. As a user message with a
                // structured `[late-tool-result ...]` prefix, the model treats
                // it as new informational input from the system and produces a
                // status update.
                const status = e.failed ? "failed" : "completed";
                const outputStr =
                    typeof e.output === "string" ? e.output : JSON.stringify(e.output);
                out.push({
                    role: "user",
                    content: `[late-tool-result toolCallId=${e.toolCallId} tool=${e.toolName} status=${status}] ${outputStr}`,
                });
                break;
            }
            case "system":
                out.push({ role: "system", content: e.content });
                break;
        }
    }

    return out;
}

// ---------- RAL runner ----------

export interface RalContext {
    ralId: string;
    store: ConversationStore;
    lock: Lock;
    tools: ToolSet;
    systemPrompt?: string;
    /**
     * Called when this RAL writes a late-tool-result. The dispatcher uses
     * this to spawn a wakeup RAL when the lock is free.
     */
    onLateResult?: (entry: Extract<StoredEntry, { kind: "late-tool-result" }>) => void;
    /**
     * Test-observability hook: fires exactly once when this RAL receives its
     * first stream chunk (text-delta, tool-input-start, etc.). Useful for
     * tests that need to wait until a RAL is actually mid-LLM-call before
     * exercising a race condition.
     */
    onFirstChunk?: () => void;
    maxSteps?: number;
}

export interface RalOutcome {
    ralId: string;
    outcome: "completed" | "preempted" | "stop-cap";
    finalText: string;
    stepsRun: number;
}

/**
 * Run a single RAL. Assumes the lock has already been acquired by `ralId`
 * (the dispatcher does this before calling).
 */
export async function runRAL(ctx: RalContext): Promise<RalOutcome> {
    const { ralId, store, lock, tools, systemPrompt } = ctx;
    if (lock.getDriver() !== ralId) {
        throw new Error(
            `runRAL: lock.driver=${lock.getDriver()} but expected ${ralId} (acquire before calling)`,
        );
    }

    log(`[${ralId}] START driver=${ralId}`);

    let preempted = false;
    let stepsRun = 0;
    let firstChunkPending = true;
    // Side-channel: results captured at onToolCallFinish are committed at onStepFinish.
    type StashedResult = {
        toolCallId: string;
        toolName: string;
        output: unknown;
        failed: boolean;
    };
    let stashedResults: StashedResult[] = [];
    // Tool calls observed at onToolCallStart in the current step.
    let stepToolCalls: ToolCallRecord[] = [];
    // Text streamed so far in the current step. We commit at onToolCallStart so
    // that a concurrently-spawned RAL can see this assistant turn.
    let stepText = "";

    const result = streamText({
        model: MODEL,
        system: systemPrompt,
        messages: buildMessages(store),
        tools,
        stopWhen: [stepCountIs(ctx.maxSteps ?? 8), () => preempted],
        prepareStep: ({ stepNumber, messages }) => {
            const rebuilt = buildMessages(store);
            log(
                `[${ralId}]   prepareStep#${stepNumber} sdk=${messages.length} rebuilt=${rebuilt.length}`,
            );
            return { messages: rebuilt };
        },
        onChunk: ({ chunk }) => {
            if (firstChunkPending) {
                firstChunkPending = false;
                ctx.onFirstChunk?.();
            }
            if (chunk.type === "text-delta") {
                stepText += chunk.text ?? "";
            }
        },
        experimental_onToolCallStart: ({ toolCall }) => {
            const id = toolCall.toolCallId;
            log(
                `[${ralId}]   onToolCallStart id=${id.slice(-6)} name=${toolCall.toolName} input=${JSON.stringify(toolCall.input).slice(0, 80)}`,
            );
            stepToolCalls.push({
                toolCallId: id,
                toolName: toolCall.toolName,
                input: toolCall.input,
            });
            // Commit (or update) the assistant entry now, so a RAL spawned
            // during the tool window can see this tool-call in the store.
            if (stepToolCalls.length === 1) {
                store.append({
                    kind: "assistant",
                    text: stepText,
                    toolCalls: [...stepToolCalls],
                    t: Date.now(),
                });
            } else {
                store.mutateLastAssistant((a) => {
                    a.toolCalls = [...stepToolCalls];
                });
            }
            lock.startTool(ralId, id);
            log(
                `[${ralId}]   lock released (driver=${lock.getDriver()} pending=${lock.pendingToolCount()})`,
            );
        },
        experimental_onToolCallFinish: (event) => {
            const id = event.toolCall.toolCallId;
            const out: unknown = event.success ? event.output : event.error;
            log(
                `[${ralId}]   onToolCallFinish id=${id.slice(-6)} ${event.success ? "OK" : "ERR"} duration=${event.durationMs}ms`,
            );
            stashedResults.push({
                toolCallId: id,
                toolName: event.toolCall.toolName,
                output: out,
                failed: !event.success,
            });
        },
        onStepFinish: (s) => {
            stepsRun++;
            log(
                `[${ralId}]   onStepFinish#${stepsRun - 1} reason=${s.finishReason} toolCalls=${s.toolCalls?.length ?? 0} text="${(s.text ?? "").slice(0, 60)}"`,
            );

            if (stashedResults.length > 0) {
                let finalState: "still-pending" | "reacquired" | "preempted" =
                    "still-pending";
                for (const r of stashedResults) {
                    finalState = lock.finishTool(ralId, r.toolCallId);
                }
                log(
                    `[${ralId}]   step lock outcome=${finalState} driver=${lock.getDriver()}`,
                );
                if (finalState === "reacquired") {
                    for (const r of stashedResults) {
                        store.append({
                            kind: "tool-result",
                            toolCallId: r.toolCallId,
                            toolName: r.toolName,
                            output: r.output,
                            t: Date.now(),
                        });
                    }
                } else if (finalState === "preempted") {
                    for (const r of stashedResults) {
                        const entry: Extract<
                            StoredEntry,
                            { kind: "late-tool-result" }
                        > = {
                            kind: "late-tool-result",
                            toolCallId: r.toolCallId,
                            toolName: r.toolName,
                            output: r.output,
                            failed: r.failed,
                            t: Date.now(),
                        };
                        store.append(entry);
                        log(
                            `[${ralId}]   wrote late-tool-result for ${r.toolCallId.slice(-6)}`,
                        );
                        ctx.onLateResult?.(entry);
                    }
                    preempted = true;
                }
                // "still-pending" only happens between parallel-tool finishes
                // before the last one; AI SDK fires onStepFinish only after all,
                // so this branch is effectively unreachable from here.
            } else if (s.text) {
                // Pure-text final step; commit assistant entry.
                store.append({
                    kind: "assistant",
                    text: s.text,
                    toolCalls: [],
                    t: Date.now(),
                });
            }

            stashedResults = [];
            stepToolCalls = [];
            stepText = "";
        },
        onError: ({ error }) => {
            log(`[${ralId}]   onError:`, error instanceof Error ? error.message : error);
        },
    });

    let finalText = "";
    try {
        for await (const d of result.textStream) finalText += d;
    } catch (e) {
        log(
            `[${ralId}]   textStream threw:`,
            e instanceof Error ? e.message : String(e),
        );
    }

    let outcome: RalOutcome["outcome"] = "completed";
    if (preempted) outcome = "preempted";

    if (!preempted) {
        lock.releaseDriver(ralId);
    }

    log(
        `[${ralId}] END outcome=${outcome} steps=${stepsRun} text="${finalText.slice(0, 80)}"`,
    );
    return { ralId, outcome, finalText, stepsRun };
}

// ---------- Dispatcher ----------

export interface DispatchContext {
    store: ConversationStore;
    lock: Lock;
    /**
     * Called for each spawned RAL to compose the runtime context (tools,
     * system prompt, late-result callback, etc.). The dispatcher provides
     * `ralId` and the spawn happens with the lock already held.
     */
    makeRalContext: (ralId: string) => Omit<RalContext, "ralId">;
}

/**
 * Atomically (synchronously w.r.t. the JS event loop) commit a user message
 * to the store and decide whether to spawn a fresh RAL. Returns the spawn
 * promise (if any) so callers can await the run.
 *
 * - If the lock is free → acquire and spawn.
 * - If the lock is held → just commit; the active RAL's next prepareStep
 *   will pick up the message via the message rebuild.
 */
export function dispatchUserMessage(
    ctx: DispatchContext,
    userMessage: string,
): { spawned: boolean; ralId?: string; promise?: Promise<RalOutcome> } {
    const { store, lock } = ctx;
    store.append({ kind: "user", content: userMessage, t: Date.now() });

    const ralId = nextRalId();
    if (!lock.tryAcquire(ralId)) {
        log(
            `[dispatch] user message queued; lock held by ${lock.getDriver()} (no spawn)`,
        );
        return { spawned: false };
    }
    log(`[dispatch] spawning ${ralId} for new user message`);
    const promise = runRAL({ ...ctx.makeRalContext(ralId), ralId });
    return { spawned: true, ralId, promise };
}

/**
 * Wakeup dispatch — used when a late-tool-result lands. If the lock is free,
 * spawn a fresh RAL whose only job is to surface the late result. If held,
 * the active RAL will see the late-result on its next prepareStep.
 */
export function dispatchWakeup(
    ctx: DispatchContext,
    reason: string,
): { spawned: boolean; ralId?: string; promise?: Promise<RalOutcome> } {
    const { lock } = ctx;
    const ralId = nextRalId();
    if (!lock.tryAcquire(ralId)) {
        log(
            `[wakeup] suppressed: lock held by ${lock.getDriver()} (${reason})`,
        );
        return { spawned: false };
    }
    log(`[wakeup] spawning ${ralId} (${reason})`);
    const promise = runRAL({ ...ctx.makeRalContext(ralId), ralId });
    return { spawned: true, ralId, promise };
}

/**
 * Same as {@link dispatchWakeup} but if the lock is held, registers a
 * one-shot listener so the wakeup retries automatically when the current
 * driver releases. Used by late-tool-result handlers to ensure that a
 * late result is eventually surfaced even if it lands while a different
 * RAL is mid-stream and that RAL doesn't proactively pick it up.
 *
 * Returns the wakeup promise IF spawned now; otherwise undefined. Promises
 * for deferred wakeups are pushed to `promiseSink` when they eventually fire.
 */
export function dispatchWakeupOrDefer(
    ctx: DispatchContext,
    reason: string,
    promiseSink: Promise<RalOutcome>[],
): { spawned: boolean; ralId?: string } {
    const r = dispatchWakeup(ctx, reason);
    if (r.spawned) {
        if (r.promise) promiseSink.push(r.promise);
        return r;
    }
    log(`[wakeup] deferring (${reason}); will retry on driver release`);
    ctx.lock.onceDriverReleased(() => {
        const retry = dispatchWakeup(ctx, `${reason} [deferred]`);
        if (retry.promise) promiseSink.push(retry.promise);
        if (!retry.spawned) {
            // Still held (someone else acquired in the meantime). Re-defer.
            ctx.lock.onceDriverReleased(() =>
                dispatchWakeupOrDefer(ctx, `${reason} [re-deferred]`, promiseSink),
            );
        }
    });
    return r;
}

// ---------- Tool helpers (reusable across scenarios) ----------

import { z } from "zod";

/**
 * A tool that sleeps for `seconds` seconds and then returns a tagged result.
 * Used to simulate long-running operations.
 */
export function makeSleepTool(label: string): Tool {
    return tool({
        description: `Sleep for N seconds and then return ${label}'s result. Use ONLY when the user explicitly asks to wait.`,
        inputSchema: z.object({
            seconds: z.number().min(0).max(60).describe("seconds to sleep"),
        }),
        execute: async ({ seconds }, opts) => {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, seconds * 1000);
                opts.abortSignal?.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        reject(new Error("aborted"));
                    },
                    { once: true },
                );
            });
            return { ok: true, label, slept: seconds };
        },
    });
}

/** Synchronous "echo"-style tool: returns immediately. */
export function makeEchoTool(): Tool {
    return tool({
        description: "Echoes the input back. Use for quick lookups.",
        inputSchema: z.object({
            value: z.string(),
        }),
        execute: async ({ value }) => ({ echoed: value }),
    });
}

/**
 * A tool whose `execute` waits indefinitely until the test signals it to
 * finish. Lets a scenario deterministically control when RAL#1's tool
 * completes, removing race-prone real-time delays.
 */
export interface ManualToolHandle {
    tool: Tool;
    /** Resolve the in-flight execute call. Idempotent (only first call wins). */
    finish: (output?: unknown) => void;
    /** Reject the in-flight execute call. */
    failWith: (errorMsg: string) => void;
    /** Promise that resolves once execute STARTS (i.e., onToolCallStart fired). */
    started: Promise<void>;
}

export function makeManualTool(
    label: string,
    description = `Manual tool ${label}: takes a 'note' and waits for the test to signal completion.`,
): ManualToolHandle {
    let resolveResult: ((value: unknown) => void) | undefined;
    let rejectResult: ((reason: unknown) => void) | undefined;
    let signaled = false;
    let signalValue: { kind: "ok"; output: unknown } | { kind: "err"; msg: string } | null = null;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((res) => {
        resolveStarted = res;
    });

    const t = tool({
        description,
        inputSchema: z.object({
            note: z.string().optional().describe("Optional note for tracing."),
        }),
        execute: async () => {
            resolveStarted?.();
            // If already signaled before execute started, return immediately.
            if (signaled) {
                if (signalValue?.kind === "ok") return signalValue.output;
                throw new Error(signalValue?.msg ?? "manual tool failed");
            }
            return await new Promise<unknown>((resolve, reject) => {
                resolveResult = resolve;
                rejectResult = reject;
            });
        },
    });

    const finish = (output: unknown = { ok: true, label, mode: "manual" }) => {
        if (signaled) return;
        signaled = true;
        signalValue = { kind: "ok", output };
        resolveResult?.(output);
    };
    const failWith = (msg: string) => {
        if (signaled) return;
        signaled = true;
        signalValue = { kind: "err", msg };
        rejectResult?.(new Error(msg));
    };

    return { tool: t, finish, failWith, started };
}
