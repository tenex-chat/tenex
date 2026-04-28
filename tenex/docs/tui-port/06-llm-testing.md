# 06 — LLM Testing TUI (Port Spec)

Pixel-exact reproduction spec for the **interactive LLM connectivity test** that runs from inside the LLM configuration editor. This document covers ONLY the test flow — provider/model setup is in 03/05 and is assumed already complete.

The test is invoked from the **Configurations** menu inside `tenex config llm` by pressing the `t` key while a configuration row is highlighted. There is no standalone "test" subcommand.

---

## 1. Entry — How a User Reaches the Test

### 1.1 Command surface

The TS daemon exposes the test under the `tenex config llm` Commander subcommand:

- File: `src/commands/config/llm.ts:9-43`
- Command: `new Command("llm").description("Manage LLM configurations (global only)")` — `src/commands/config/llm.ts:9-10`
- Flags: `--advanced` only — `src/commands/config/llm.ts:11`
- Scope: **global only**. Always operates on `config.getGlobalPath()`. Project-local `.tenex/llms.json` is never consulted from this command — `src/commands/config/llm.ts:17-18`.

Pre-flight gate (executed before the menu opens):

1. Background-preload the `models.dev` cache so model lists are warm — `src/commands/config/llm.ts:14-15` (`ensureCacheLoaded().catch(() => {})`)
2. `await fileSystem.ensureDirectory(globalConfigDir)` — `src/commands/config/llm.ts:21`
3. Load providers. If `Object.keys(providersConfig.providers).length === 0`, abort with:
   - `console.log(chalk.red("❌ No providers configured."))` — `src/commands/config/llm.ts:25`
   - `console.log(amber("→") + chalk.bold(" Run tenex config providers first"))` — `src/commands/config/llm.ts:26`
   - `process.exitCode = 1; return;` — `src/commands/config/llm.ts:27-28`
   The test surface is **never** reachable without at least one provider in `providers.json`.
4. Otherwise: `new LLMConfigEditor({ advanced: opts.advanced }).showMainMenu()` — `src/commands/config/llm.ts:31-32`

### 1.2 Menu path to the test

Inside `LLMConfigEditor.showMainMenu()` (`src/llm/LLMConfigEditor.ts:182-235`):

1. Print one blank line — `display.blank()` — `src/llm/LLMConfigEditor.ts:185`
2. Print step header `"  0/0  LLM Configuration"` followed by a 45-char dim amber rule — `display.step(0, 0, "LLM Configuration")` — `src/llm/LLMConfigEditor.ts:186`, expansion in `src/commands/config/display.ts:20-26`.
3. Print "Configured Providers" context block + one `✓ <ProviderDisplayName>` per provider with an API key, then a blank line — `displayProviders(llmsConfig)` — `src/llm/LLMConfigEditor.ts:187`, expansion at `src/llm/utils/ProviderConfigUI.ts:26-42`.
4. Build `items: ListItem[]` from `Object.keys(llmsConfig.configurations)` — `src/llm/LLMConfigEditor.ts:189-207`. Each row is rendered as `<name> <chalk.dim(detail)>` where `detail` is either:
   - For meta-models: `"multi-modal, <N> variants"` — `src/llm/LLMConfigEditor.ts:193-194`
   - Otherwise: the model id (`cfg.model`) — `src/llm/LLMConfigEditor.ts:195-200` (throws if `model` missing — `src/llm/LLMConfigEditor.ts:197`).
5. Open the inquirer prompt `selectWithFooter` with:
   - `message: "Configurations"` — `src/llm/LLMConfigEditor.ts:215`
   - actions: `Add new configuration (a)` and `Add multi-modal configuration (m)` — `src/llm/LLMConfigEditor.ts:209-212`
   - `onTest: (configName) => runConfigurationTest(llmsConfig, configName)` — `src/llm/LLMConfigEditor.ts:218`

The test is triggered by the `t` keypress while the cursor is on a configuration row (i.e. `active > doneIndex`) — `src/llm/LLMConfigEditor.ts:96-106`. There is **no menu entry** named "Test"; the binding is announced only in the footer help line.

### 1.3 Footer help line (always visible at bottom of menu)

`src/llm/LLMConfigEditor.ts:164-170`:

```
  ↑↓ navigate • ⏎ select • t test • d delete
```

- Each binding is `chalk.bold("<key>")` followed by ` ` and `chalk.dim("<verb>")`.
- Separator: `chalk.dim(" • ")` between parts.
- Whole line is `chalk.dim("  …")` (leading two-space indent).

---

## 2. Test Prompt UX

The test prompt is **not user-editable**. It is hard-coded:

- File: `src/llm/utils/ConfigurationTester.ts:65-68`
- Verbatim message:

```json
[{ "role": "user", "content": "Say 'Hello, TENEX!' in exactly those words." }]
```

There is no override flag, no inquirer text input, no validation. The only "input" the user supplies is the configuration row to test (selected with `↑↓`) and the `t` keypress.

The Rust port MUST send exactly this user-message content as the sole message in the request, with no system prompt, no tools, and no provider options (`tools` is `{}` and `options` is `{}` at `src/llm/utils/ConfigurationTester.ts:68`).

---

## 3. Live Request Flow

### 3.1 What is rendered while the test runs

The test runs **silently** with respect to stdout. Before the request begins, `silenceConsole()` replaces `console.log/warn/error/info` with `noop` — `src/llm/utils/ConfigurationTester.ts:12-28`. This means:

- No streamed tokens are printed to the terminal.
- No log lines from the LLM service are printed.
- The only on-screen feedback is the **inquirer prompt re-render** that swaps the row's leading glyph for a spinner.

Spinner rendering (in `selectWithFooter`):

- Frames: `["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]` (Braille dots, 10 frames) — `src/llm/LLMConfigEditor.ts:39`
- Tick interval: `setInterval(…, 80)` ms — `src/llm/LLMConfigEditor.ts:65-67`
- Color: `chalk.yellow(frame)` — `src/llm/LLMConfigEditor.ts:149-150`
- Row format while testing: `"<pfx><yellow frame> <highlight name>"` — `src/llm/LLMConfigEditor.ts:150`. `pfx` is either `"❯ "` (active) or `"  "` (inactive); `name` is the highlighted-or-plain configuration label.
- Only the row whose `configName === testing` shows a spinner — `src/llm/LLMConfigEditor.ts:148`. Other rows render normally.
- Keypresses are ignored while `testing` is non-null: `if (testing) return;` — `src/llm/LLMConfigEditor.ts:82`. The user cannot navigate, retest, delete, or accept Done during a test.

There is **no time-to-first-token reporting**, no "thinking" indicator, no token counter, no elapsed-time display.

### 3.2 Streaming vs. full

The request is issued via `service.stream(messages, {})` — `src/llm/utils/ConfigurationTester.ts:65-68`. This is a real streaming call, but the `content` listener is a no-op:

```ts
service.on("content", (_event: ContentEvent) => {});
```

— `src/llm/utils/ConfigurationTester.ts:50`.

The tester only awaits the **completion event** (or error/timeout), it does not consume the stream visually. The Rust port should:

1. Issue a streaming request (matching whatever streaming surface the Rust LLM service exposes).
2. Drain content deltas to a no-op sink.
3. Wait for terminal events.

### 3.3 Termination conditions (exact `Promise.race` semantics)

`src/llm/utils/ConfigurationTester.ts:52-70`:

```text
Promise.all([
  service.stream(messages, {}),     // resolves when stream finishes (success or graceful failure path)
  Promise.race([
    completePromise,                 // service.once("complete", resolve)
    errorPromise,                    // service.once("stream-error", e => reject(e.error))
    timeoutPromise,                  // 30 seconds
  ]),
])
```

- Hard timeout: **30000 ms** — `src/llm/utils/ConfigurationTester.ts:60-62`. Rejected error is `new Error("timed out after 30s")`.
- Success requires the `complete` event to fire — `src/llm/utils/ConfigurationTester.ts:52-54`. Stream-error events come from `LLMService.emit("stream-error", { error })` (`src/llm/service.ts:429`, `:437`, `:765`) and reject with the underlying `event.error` — `src/llm/utils/ConfigurationTester.ts:55-59`.
- Note: `service.stream(...)` is awaited concurrently inside `Promise.all`. If it throws (no retry possible — `src/llm/service.ts:431`), the rejection bubbles out of `Promise.all` regardless of the race outcome.

### 3.4 Provider initialization side-effect

Before each test, `runConfigurationTest` reloads global config and re-initializes providers:

- `await configService.loadConfig()` — `src/llm/utils/ConfigurationTester.ts:42`
- `const llmConfig = configService.getLLMConfig(configName)` — `src/llm/utils/ConfigurationTester.ts:43`
- `await llmServiceFactory.initializeProviders(llmsConfig.providers)` — `src/llm/utils/ConfigurationTester.ts:45`
- `service = llmServiceFactory.createService(llmConfig, { agentName: "configuration-tester" })` — `src/llm/utils/ConfigurationTester.ts:46-48`

The test always uses the **literal** agent name `"configuration-tester"` (slugified by the factory at `src/llm/LLMServiceFactory.ts:121-124` to `"configuration-tester"`).

### 3.5 Sequence diagram — happy path

```
User                Inquirer prompt        runConfigurationTest         LLMService
 │  press 't' on    │                      │                            │
 │  config row      │                      │                            │
 ├─────────────────▶│ setTesting(name)     │                            │
 │                  │ start spinner timer  │                            │
 │                  │ (80 ms tick)         │                            │
 │                  │                      │                            │
 │                  │ onTest(name) ───────▶│ silenceConsole()           │
 │                  │                      │ loadConfig()               │
 │                  │                      │ initializeProviders()      │
 │                  │                      │ createService(...)         │
 │                  │                      │ on("content", noop)        │
 │                  │                      │ once("complete",resolve)   │
 │                  │                      │ once("stream-error",rej)   │
 │                  │                      │ start 30s timeout          │
 │                  │                      │ stream([{user msg}], {}) ─▶│ HTTP request
 │                  │                      │                            │ stream chunks
 │                  │                      │                            │ emit "content" (ignored)
 │                  │                      │                            │ emit "complete"
 │                  │                      │ ◀──── complete ────────────│
 │                  │                      │ await sleep(200ms)         │
 │                  │                      │ restoreConsole()           │
 │                  │                      │ return {success:true}      │
 │                  │ resultsRef[name] =   │                            │
 │                  │   {success:true}     │                            │
 │                  │ setTesting(null)     │                            │
 │                  │ stop spinner         │                            │
 │                  │ re-render row        │                            │
 │                  │ with green ✓         │                            │
```

`sleep(200ms)` reference: `await new Promise((resolve) => setTimeout(resolve, 200))` — `src/llm/utils/ConfigurationTester.ts:86`. The delay swallows any logger stragglers that fire after the stream completes.

---

## 4. Output Rendering

### 4.1 No response body is ever shown

The model's actual response text is **discarded**. There is no response panel, no transcript window, no copy-to-clipboard. The only visible output is the row glyph + optional dim error string. This is a deliberate consequence of `silenceConsole()` plus the no-op `content` handler.

### 4.2 Row state machine (single row, post-test)

After the test completes, the same row that previously showed a spinner re-renders. Logic at `src/llm/LLMConfigEditor.ts:148-160`:

```text
if (testing === name)        →  "<pfx><yellow ⠋…> <highlightedName>"
elif resultsRef[name] exists →  "<pfx><icon> <highlightedName><errorHint>"
                                  icon       = green ✓ if success else red ✗
                                  errorHint  = "" if success else " <chalk.dim(result.error)>"
else                          →  "<pfx>   <highlightedName>"   (two-space pad before name)
```

- `pfx`: `"❯ "` (amber, when `active`) or `"  "` (when inactive) — `src/llm/LLMConfigEditor.ts:144`. `cursor` source: `inquirerTheme.icon.cursor = amber("❯")` — `src/utils/cli-theme.ts:8`.
- `highlightedName`: when active, wrapped in `theme.style.highlight` (= `amber`); otherwise identity — `src/llm/LLMConfigEditor.ts:145`.
- Note the result branch uses a **single space** between `pfx` and `icon`, while the no-result branch uses `pfx` + two spaces (`"  "`) — i.e. column alignment is preserved by treating the icon glyph as a one-cell substitute for two spaces.
- No newline or "end-of-response" marker is ever emitted; rendering is in-place inquirer redraw.

### 4.3 Line wrapping & ANSI

There is no explicit wrapping logic. The terminal wraps the inquirer-managed buffer. The colors used:

| Element | Color / source |
|---|---|
| Spinner frame | `chalk.yellow` — `src/llm/LLMConfigEditor.ts:150` |
| Success icon `✓` | `chalk.green` — `src/llm/LLMConfigEditor.ts:154` |
| Failure icon `✗` | `chalk.red` — `src/llm/LLMConfigEditor.ts:154` |
| Error hint text | `chalk.dim` — `src/llm/LLMConfigEditor.ts:155` |
| Active row name | `theme.style.highlight` (amber #FFC107 / xterm-256 214) — `src/utils/cli-theme.ts:3,10` |
| Cursor `❯` | amber #FFC107 — `src/utils/cli-theme.ts:8` |
| Action lines | `chalk.cyan(action.name)` — `src/llm/LLMConfigEditor.ts:130` |
| Done label | `chalk.ansi256(214).bold("  Done")` — `src/commands/config/display.ts:121-123` |
| Empty-list placeholder | `chalk.dim("  No configurations yet")` — `src/llm/LLMConfigEditor.ts:139` |
| Separator rule under actions | `"  " + "─".repeat(40)` (no color) — `src/llm/LLMConfigEditor.ts:136` |

`cursorHide` ANSI escape is appended at the end of every render — `src/llm/LLMConfigEditor.ts:172`.

### 4.4 Glyphs (verbatim Unicode)

| Glyph | Codepoint | Use |
|---|---|---|
| `❯` | U+276F | Cursor — `src/utils/cli-theme.ts:8` |
| `✓` | U+2713 | Success icon — `src/llm/LLMConfigEditor.ts:154`; also `display.success` and `inquirerTheme.prefix.done` |
| `✗` | U+2717 | Failure icon — `src/llm/LLMConfigEditor.ts:154` |
| `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | U+280B etc | Spinner frames — `src/llm/LLMConfigEditor.ts:39` |
| `─` | U+2500 | Separator rules — `src/llm/LLMConfigEditor.ts:136`; `src/commands/config/display.ts:21` |
| `→` | U+2192 | Hint arrow — `src/commands/config/llm.ts:26`; `src/commands/config/display.ts:48` |
| `↑` `↓` `⏎` `•` | U+2191/93/23CE/2022 | Footer help — `src/llm/LLMConfigEditor.ts:165-170` |

---

## 5. Status Indicators (Success vs. Failure)

The result is rendered exclusively through the row glyph + optional dim hint. There is **no** "Test passed" / "Test failed" banner, no toast, no status line.

- Success: `chalk.green("✓") + " " + <name>` — `src/llm/LLMConfigEditor.ts:154,156`
- Failure: `chalk.red("✗") + " " + <name> + " " + chalk.dim(result.error)` — `src/llm/LLMConfigEditor.ts:154-156`

`result.error` is ALWAYS one of the four strings produced by `runConfigurationTest`'s catch block (see §6.2). The hint is displayed inline, on the same line, separated by a single ASCII space. There is no separate explanation pane.

### 5.1 Result persistence within the menu session

Results are kept in `resultsRef.current: Record<string, TestResult>` — `src/llm/LLMConfigEditor.ts:56`. Behavior:

- Once a row has a result, the icon stays visible across subsequent navigations — the row is repainted from `resultsRef` on every render.
- Re-pressing `t` on a row that already has a recorded result is **a no-op**: `if (resultsRef.current[configName]) return;` — `src/llm/LLMConfigEditor.ts:100`. The user cannot re-run a test from the same menu instance unless they leave and re-enter (see §10).
- Results are stored under the **`configName`** key. They are not persisted across menu invocations (the ref is local to the prompt).

---

## 6. Error Rendering

### 6.1 Where errors come from

Three error origins all funnel into the same `catch` block at `src/llm/utils/ConfigurationTester.ts:73-83`:

1. `service.stream(...)` rejection (post-retry path) — `src/llm/service.ts:431`.
2. `stream-error` event — `src/llm/utils/ConfigurationTester.ts:55-58` rejects `errorPromise`.
3. 30-second timeout — `new Error("timed out after 30s")` — `src/llm/utils/ConfigurationTester.ts:60-62`.

### 6.2 Hint mapping (verbatim)

`src/llm/utils/ConfigurationTester.ts:75-83`:

```text
errorMessage = error instanceof Error ? error.message : String(error)
hint = errorMessage           // default

if errorMessage contains "401" OR "Unauthorized":
    hint = "invalid or expired API key"
else if errorMessage contains "404":
    hint = "model not available"
else if errorMessage contains "rate limit":
    hint = "rate limited"
```

These four hint strings are **the only** human-readable failure reasons the user ever sees. The Rust port MUST emit these exact strings (case-sensitive, verbatim) to match the on-screen output.

Notes on matching:

- `.includes()` semantics — substring match, case-sensitive. "rate limit" matches lowercase only; an upstream "Rate Limit" would fall through to the raw error message.
- The mapping is **mutually exclusive** in source order: 401/Unauthorized first, then 404, then "rate limit". An error containing both "401" and "rate limit" would map to `"invalid or expired API key"`.
- Fallback: when none of the patterns match, `hint = errorMessage` — i.e. the raw `Error.message` string. This includes the timeout literal `"timed out after 30s"`.

### 6.3 Configuration-not-found

If `runConfigurationTest` is called with an unknown name:

- Returns `{ success: false, error: "configuration not found" }` immediately — `src/llm/utils/ConfigurationTester.ts:35-37`.
- No console silencing, no provider init. Cannot happen via the UI in practice (rows always reflect the current config map), but the Rust port should preserve the exact string for parity.

### 6.4 Suggested-fix presentation

There is **no** "suggested fix" UI. The hint string IS the fix suggestion. There are no clickable links, no "press X to retry now", no contextual help.

### 6.5 HTTP / network / auth specifics

The TS path delegates HTTP semantics to the AI SDK — TENEX never inspects `error.statusCode` or `error.headers`. It only matches against `error.message` substrings. The Rust port should:

- Preserve raw `error.message` (or equivalent) text from the underlying provider SDK, **including** numeric HTTP status codes embedded in the message (so "401" and "404" continue to match).
- Lowercase the substring `"rate limit"` somewhere in the error text when surfacing rate-limit conditions.

---

## 7. Token / Latency Stats

**None are shown.** The TUI test path:

- Does not display token counts — even though the `complete` event includes `usage: LanguageModelUsageWithCostUsd` (`src/llm/types.ts:193-201`), `runConfigurationTest` ignores it.
- Does not display latency / time-to-first-token / total wall-time.
- Does not display cost / model id.

The Rust port MUST NOT add stats output; doing so would deviate from on-screen parity.

---

## 8. Retry

There is **no in-place "Try again?" prompt**. The user's only way to retry is:

1. Wait for the row to settle (icon visible).
2. Exit the prompt (select Done — see §10).
3. Re-enter `tenex config llm` and press `t` again on the same row.

Within a single prompt session, the de-dup guard at `src/llm/LLMConfigEditor.ts:100` blocks re-pressing `t` on a row with a recorded result.

Internal LLM-service retries (key rotation) **are** supported in the underlying `service.stream()` and happen transparently to the tester — see `src/llm/service.ts:413-440` (`isRetryableKeyError`, `keyRotationHandler`). The tester's `LLMService` instance is constructed without a `keyRotationHandler` (`createService` at `src/llm/LLMServiceFactory.ts:95-115` does not wire one for `agentName: "configuration-tester"`), so the retry path collapses immediately at `src/llm/service.ts:415-431` and emits `stream-error`. The Rust port should reproduce this: **no automatic retry for the configuration tester**.

---

## 9. Cancel Mid-Stream (Ctrl-C)

The tester does NOT pass an `AbortSignal` to `service.stream`:

- Call site: `service.stream([{ role: "user", content: "Say 'Hello, TENEX!' …" }], {})` — `src/llm/utils/ConfigurationTester.ts:65-68`. The `options` argument is `{}` — no `abortSignal`.
- The `stream` signature accepts `options?.abortSignal` (`src/llm/service.ts:374-376`), but it is unused here.

Observed behavior on Ctrl-C **during** a test:

1. Inquirer's keypress loop receives SIGINT and throws (`ExitPromptError` or "force closed").
2. The error bubbles to `tenex config llm`'s top-level `catch` — `src/commands/config/llm.ts:33-38`.
3. The handler matches `errorMessage.includes("SIGINT") || errorMessage.includes("force closed")` and `return`s silently (no exit code, no message) — `src/commands/config/llm.ts:36-37`.
4. The in-flight HTTP request is **not** aborted from the application layer; it continues until the provider SDK detects process teardown (or completes against `/dev/null` because the Node event loop is empty and the process exits). No cleanup of in-flight requests is performed.

On Ctrl-C **outside** a test (cursor on a row, no testing active): same path — exits silently.

The Rust port should:

- Treat Ctrl-C as a clean exit from the menu (no error message, no non-zero status).
- Match TS behavior of NOT plumbing an abort into the LLM call, OR add an abort and let the request cancel cleanly — but ensure no error popup is shown either way (the user expects silent exit).

---

## 10. Cleanup — What Gets Saved

Running a test has **zero persistent side-effects**:

- The tester does not call `saveConfig` / `saveGlobalLLMs` / `saveGlobalProviders`.
- It does not modify `llmsConfig.default`. The selected configuration is **not** promoted to default by being tested.
- It does not write to `resultsRef` outside the React-state lifetime of the prompt; results are discarded when the menu closes.
- Provider initialization (`llmServiceFactory.initializeProviders`) is a process-local singleton mutation — it has no on-disk effect.

Default-handling is handled exclusively by other paths:

- `addConfiguration` / `addMultiModalConfiguration` — `src/llm/LLMConfigEditor.ts:225-229` (out of scope here).
- `deleteConfig` — `src/llm/LLMConfigEditor.ts:237-250` reassigns `default` only when deleting the currently-default configuration.

Exit conditions of the prompt (action returned by `selectWithFooter`):

| Action | Source line | Effect |
|---|---|---|
| `"add"` | `src/llm/LLMConfigEditor.ts:224-226` | Open Add flow; on completion, save config; recurse `showMainMenu` |
| `"addMultiModal"` | `src/llm/LLMConfigEditor.ts:227-229` | Open Multi-Modal flow; save; recurse |
| `"delete:<name>"` | `src/llm/LLMConfigEditor.ts:221-223` | `deleteConfig`; save; recurse |
| `"done"` | `src/llm/LLMConfigEditor.ts:230-231` | Return from `showMainMenu` (exit) |
| any `config:<name>` | not handled — falls through to `showMainMenu()` recurse | A no-op re-render. **Pressing Enter on a configuration row does nothing useful.** |

Consequence for test flow: after a test completes the user has only `Done` (Enter on the Done row) or `↑↓ + a/m/d/t` to act. The result icon survives only until `showMainMenu()` returns and is **lost** on the recursive call — entering Add/Delete causes `showMainMenu` to recurse, building a fresh `selectWithFooter` whose `resultsRef` starts empty.

---

## 11. Full Render Reference (sample frames)

Frame A — fresh menu, two configs, cursor on first action:

```
?  Configurations
❯ Add new configuration (a)
  Add multi-modal configuration (m)
    Done
  ────────────────────────────────────────
    gpt-4o-prod gpt-4o
    sonnet-dev claude-3-5-sonnet-20241022
   ↑↓ navigate • ⏎ select • t test • d delete
```

Frame B — cursor moved to first config, `t` pressed (testing):

```
?  Configurations
  Add new configuration (a)
  Add multi-modal configuration (m)
    Done
  ────────────────────────────────────────
❯ ⠹ gpt-4o-prod gpt-4o
    sonnet-dev claude-3-5-sonnet-20241022
   ↑↓ navigate • ⏎ select • t test • d delete
```

Frame C — test succeeded:

```
?  Configurations
  Add new configuration (a)
  Add multi-modal configuration (m)
    Done
  ────────────────────────────────────────
❯ ✓ gpt-4o-prod gpt-4o
    sonnet-dev claude-3-5-sonnet-20241022
   ↑↓ navigate • ⏎ select • t test • d delete
```

Frame D — test failed (auth):

```
?  Configurations
  Add new configuration (a)
  Add multi-modal configuration (m)
    Done
  ────────────────────────────────────────
❯ ✗ gpt-4o-prod gpt-4o invalid or expired API key
    sonnet-dev claude-3-5-sonnet-20241022
   ↑↓ navigate • ⏎ select • t test • d delete
```

Frame E — failed test, raw fallback (timeout):

```
❯ ✗ gpt-4o-prod gpt-4o timed out after 30s
```

Frame F — failed test, model 404:

```
❯ ✗ gpt-4o-prod gpt-4o model not available
```

Frame G — failed test, rate-limited:

```
❯ ✗ gpt-4o-prod gpt-4o rate limited
```

(Color note: in Frames A–G, `❯` is amber, the active row's name is amber, `⠹`/spinner is yellow, `✓` is green, `✗` is red, the dim hint after `✗` is `chalk.dim` grey, `?` prefix is amber idle / green-on-finish from `inquirerTheme.prefix`, and `(a)` / `(m)` annotations are `chalk.dim`.)

---

## 12. Summary of Required Rust Surfaces

A faithful Rust port must expose:

1. A keypress handler bound to literal lowercase `t` (no modifier) on configuration rows — `src/llm/LLMConfigEditor.ts:96`.
2. A 10-frame Braille spinner ticking every 80 ms in yellow — `src/llm/LLMConfigEditor.ts:39, 65-67`.
3. A silent-stdout context that swallows logger output during the request and waits 200 ms after completion before unsilencing — `src/llm/utils/ConfigurationTester.ts:12-28, 84-87`.
4. A streaming LLM call with the **exact** message `"Say 'Hello, TENEX!' in exactly those words."` (single user message, no tools, no system prompt, no provider options) — `src/llm/utils/ConfigurationTester.ts:65-68`.
5. A 30-second hard timeout producing the literal error `"timed out after 30s"` — `src/llm/utils/ConfigurationTester.ts:60-62`.
6. Error-message substring routing producing exactly `"invalid or expired API key"` / `"model not available"` / `"rate limited"` / `<raw error.message>` — `src/llm/utils/ConfigurationTester.ts:75-83`.
7. Per-row result memoization that prevents re-test within the same prompt session — `src/llm/LLMConfigEditor.ts:100`.
8. Silent Ctrl-C exit from the menu — `src/commands/config/llm.ts:33-38`.
9. **No** persistence: tests must never save anything to `llms.json`, `providers.json`, or change the default configuration.

---

## File Reference Index

- `src/commands/config/llm.ts` — entry command, provider gate, SIGINT handling.
- `src/llm/LLMConfigEditor.ts` — menu rendering, keybindings, spinner, result paint.
- `src/llm/utils/ConfigurationTester.ts` — request lifecycle, prompt text, error mapping, console silencing.
- `src/llm/LLMServiceFactory.ts` — `initializeProviders` / `createService` used by the tester.
- `src/llm/service.ts` — `stream()` method and event emission (`content`, `complete`, `stream-error`).
- `src/llm/types.ts` — event payload shapes (`ContentEvent`, `CompleteEvent`, `StreamErrorEvent`, `OnStreamStartCallback`).
- `src/llm/utils/ProviderConfigUI.ts` — `displayProviders` header rendering.
- `src/commands/config/display.ts` — shared `step` / `success` / `hint` / `blank` / `doneLabel` helpers + xterm-256 palette.
- `src/utils/cli-theme.ts` — `inquirerTheme`, `amber`, cursor / prefix glyphs.
