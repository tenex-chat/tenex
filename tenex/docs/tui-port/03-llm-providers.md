# 03 — LLM Provider Configuration Submenu (Port Spec)

This document specifies pixel-exact behavior for the **LLM Provider configuration submenu** of the TENEX CLI/TUI: choosing/adding/removing built-in LLM providers (OpenRouter, Anthropic, OpenAI, Ollama, Codex, Claude Code), the suggestion/auto-detection logic, persistence to `providers.json`, and color usage.

Out of scope:
- API-key entry/rotation UI (covered by agent 04).
- Model selection per provider (agent 05).
- LLM connectivity testing (agent 06).
- LLM **configuration** (`llms.json`) menu — covered only insofar as removing a provider cascades to it.

All citations are absolute paths with line numbers.

---

## 1. Entry Points and Command Structure

The provider submenu is reached two ways:

1. **`tenex config providers`** — direct subcommand. (`src/commands/config/providers.ts:7`)
2. **`tenex config`** main menu → `AI` section → `Providers` row, label `"Providers"`, description `"API keys and connections"`. (`src/commands/config/index.ts:37`)

Both paths run the same `providersCommand`. Its action:

```ts
// src/commands/config/providers.ts:9
.action(async () => {
    try {
        const globalPath = config.getGlobalPath();                 // line 11
        await fileSystem.ensureDirectory(globalPath);              // line 12

        const existingProviders = await config.loadTenexProviders(globalPath);  // line 14
        const updatedProviders = await runProviderSetup(existingProviders);     // line 15

        await config.saveGlobalProviders(updatedProviders);        // line 17
        console.log(chalk.green("✓") + chalk.bold(` Provider credentials saved to ${globalPath}/providers.json`));
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage?.includes("SIGINT") || errorMessage?.includes("force closed")) {
            return;
        }
        console.log(chalk.red(`❌ Failed to configure providers: ${error}`));
        process.exitCode = 1;
    }
});
```

After the prompt returns, success banner verbatim:
- `✓` is `chalk.green("✓")`, no leading space.
- The remainder is `chalk.bold(...)`: literal text `" Provider credentials saved to <globalPath>/providers.json"` with one leading space inside the bolded string. (`src/commands/config/providers.ts:18`)

Error banner verbatim: `❌ Failed to configure providers: <error>` in `chalk.red`. (`src/commands/config/providers.ts:24`)

SIGINT/`force closed` errors swallow silently (no banner). (`src/commands/config/providers.ts:21–23`)

`globalPath` is `~/.tenex` unless `TENEX_BASE_DIR` is set. (`src/constants.ts:11`, `src/constants.ts:22–24`, `src/services/ConfigService.ts:101–103`)

---

## 2. The Two-Level Prompt — `runProviderSetup`

`runProviderSetup` is the engine for this submenu. It loops between a **provider list (browse mode)** and an **API-key list (keys mode)**, with key entry happening through a separate `password`/`input` prompt that exits and re-enters the list. (`src/llm/utils/provider-setup.ts:25–75`)

```ts
// src/llm/utils/provider-setup.ts:29
const providerIds = [...AI_SDK_PROVIDERS];
```

`AI_SDK_PROVIDERS` is the canonical, ordered, immutable list of all built-in providers shown in the menu:

```ts
// src/llm/types.ts:28-35
export const AI_SDK_PROVIDERS = [
    PROVIDER_IDS.OPENROUTER,
    PROVIDER_IDS.ANTHROPIC,
    PROVIDER_IDS.OPENAI,
    PROVIDER_IDS.OLLAMA,
    PROVIDER_IDS.CODEX,
    PROVIDER_IDS.CLAUDE_CODE,
] as const;
```

The submenu does **not** offer a "custom provider" option. There is no UI for adding non-built-in providers; only these six IDs are selectable. Mock (`PROVIDER_IDS.MOCK`) is excluded from `AI_SDK_PROVIDERS`. (`src/llm/providers/provider-ids.ts:8–17`)

Provider IDs (values stored in `providers.json` keys):

| Constant | Value |
|----------|-------|
| `CLAUDE_CODE` | `"claude-code"` |
| `CODEX` | `"codex"` |
| `OPENROUTER` | `"openrouter"` |
| `ANTHROPIC` | `"anthropic"` |
| `OPENAI` | `"openai"` |
| `OLLAMA` | `"ollama"` |
| `MOCK` | `"mock"` (not selectable) |

Source: `src/llm/providers/provider-ids.ts:9–15`.

---

## 3. Built-in Provider Catalog

Every selectable provider's display string, default model, and capabilities. The display name shown in the list combines `getProviderDisplayName(id)` with `[ ]`/`[✓]` checkmark and an optional gray hint.

### 3.1 Display names

```ts
// src/llm/utils/ProviderConfigUI.ts:14-24
export function getProviderDisplayName(provider: string): string {
    const names: Record<string, string> = {
        [PROVIDER_IDS.OPENROUTER]: "OpenRouter (300+ models)",
        [PROVIDER_IDS.ANTHROPIC]:  "Anthropic (Claude)",
        [PROVIDER_IDS.OPENAI]:     "OpenAI (GPT)",
        [PROVIDER_IDS.OLLAMA]:     "Ollama (Local models)",
        [PROVIDER_IDS.CODEX]:      "Codex",
        [PROVIDER_IDS.CLAUDE_CODE]: "Claude Code (Agents)",
    };
    return names[provider] || provider;
}
```

### 3.2 Capabilities & defaults table

Defaults derive from each provider's `METADATA` declaration. `requiresApiKey` controls whether the row needs API-key entry vs. an Ollama URL or "none" sentinel.

| ID (`providers.json` key) | List label | Category | Default model | requiresApiKey | Default base URL | Auth style |
|---|---|---|---|---|---|---|
| `openrouter` | `OpenRouter (300+ models)` | standard | `openai/gpt-4` | true | (SDK default `https://openrouter.ai/api/v1`) | API key (`Bearer <key>`); SDK adds `X-Title: TENEX` and `HTTP-Referer: https://tenex.chat/` headers |
| `anthropic` | `Anthropic (Claude)` | standard | `claude-sonnet-4-20250514` | true | (SDK default) | API key (`x-api-key: <key>`) **or** OAuth setup-token: keys starting `sk-ant-oat` switch to `authToken` mode with `anthropic-beta: claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14`, `anthropic-dangerous-direct-browser-access: true`, `x-app: cli` |
| `openai` | `OpenAI (GPT)` | standard | `gpt-4` | true | (SDK default `https://api.openai.com/v1`) | API key |
| `ollama` | `Ollama (Local models)` | standard | `llama3.1:8b` | false | `http://127.0.0.1:11434/api` (library default when `apiKey === "local"` or empty); otherwise the user-entered URL is used as base, with `/api` appended if missing | None — the `apiKey` field stores the **base URL**, not a key |
| `codex` | `Codex` | agent | `gpt-5.1-codex-max` | false | n/a (uses local `codex` CLI app-server) | None — `apiKey` is the literal string `"none"` |
| `claude-code` | `Claude Code (Agents)` | agent | `claude-sonnet-4-20250514` | false | n/a (subprocess to `claude` CLI) | None — `apiKey` is the literal string `"none"` |

Sources:
- OpenRouter metadata: `src/llm/providers/standard/OpenRouterProvider.ts:34–46`. Headers in `createProviderInstance`: `src/llm/providers/standard/OpenRouterProvider.ts:57–63`.
- Anthropic metadata: `src/llm/providers/standard/AnthropicProvider.ts:76–88`. OAuth detection (`sk-ant-oat` prefix) and beta headers: `src/llm/providers/standard/AnthropicProvider.ts:22–26`, `:33`, `:68–70`, `:99–113`.
- OpenAI metadata: `src/llm/providers/standard/OpenAIProvider.ts:17–29`.
- Ollama metadata: `src/llm/providers/standard/OllamaProvider.ts:17–29`. Base-URL handling: `src/llm/providers/standard/OllamaProvider.ts:35–51`.
- Codex metadata: `src/llm/providers/agent/CodexProvider.ts:320–334`.
- Claude Code metadata: `src/llm/providers/agent/ClaudeCodeProvider.ts:123–137`.
- Default capability fill-ins (when partial): `src/llm/providers/base/BaseProvider.ts:96–112`.

### 3.3 Documentation URLs (used only by other UIs, kept here for completeness)

| Provider | `documentationUrl` |
|---|---|
| OpenRouter | `https://openrouter.ai/docs` |
| Anthropic | `https://docs.anthropic.com/` |
| OpenAI | `https://platform.openai.com/docs/` |
| Ollama | `https://ollama.ai/` |
| Codex | `https://openai.com/codex` |
| Claude Code | `https://docs.anthropic.com/en/docs/claude-code` |

Sources: same metadata declarations (last positional arg of `createMetadata`).

### 3.4 Environment variables consumed during auto-detection

| Provider | Env var | Behavior when set and provider not yet present |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `providers.anthropic = { apiKey: <value> }`, source label `"Anthropic (from ANTHROPIC_API_KEY)"` |
| `openai` | `OPENAI_API_KEY` | label `"OpenAI (from OPENAI_API_KEY)"` |
| `openrouter` | `OPENROUTER_API_KEY` | label `"OpenRouter (from OPENROUTER_API_KEY)"` |
| `anthropic` | `ANTHROPIC_AUTH_TOKEN` (only if value `startsWith("sk-ant-oat")`) | label `"Anthropic (from ANTHROPIC_AUTH_TOKEN)"` |

Source: `src/commands/onboard.ts:619–638`. Note: these env vars are **only** consulted by the onboarding wizard's `autoDetectProviders`, not by `runProviderSetup` itself when invoked via `tenex config providers`. (`src/commands/onboard.ts:596`, `:1424–1425`)

---

## 4. Browse Mode — Screen 1

Implemented in `src/llm/utils/provider-select-prompt.ts`. The view is a single fenced `createPrompt` that toggles between `mode === "browse"` and `mode === "keys"`.

### 4.1 Prompt header

`runProviderSetup` passes `message: "Configure providers:"`. (`src/llm/utils/provider-setup.ts:36`)

The first rendered line is built by inquirer:

```
<prefix> <styled message>
```

Where:
- `<prefix>` is `usePrefix({ status: "idle", theme })` — for the supplied `inquirerTheme`, the `idle` prefix is `amber("?")` (hex `#FFC107`). When status flips to `done`, it becomes `chalk.green("✓")`. (`src/llm/utils/provider-select-prompt.ts:84`, `src/utils/cli-theme.ts:6–13`)
- `<styled message>` is `theme.style.message("Configure providers:", "idle")` — inquirer's default message style is bold (the `inquirerTheme` does not override `style.message`).

### 4.2 Item ordering (top to bottom)

For each id in `AI_SDK_PROVIDERS` (order preserved):

1. `OpenRouter (300+ models)`
2. `Anthropic (Claude)`
3. `OpenAI (GPT)`
4. `Ollama (Local models)`
5. `Codex`
6. `Claude Code (Agents)`

After the six providers: a `Done` row.

Indices:
- `doneIndex = providerIds.length` (i.e. `6`). (`src/llm/utils/provider-select-prompt.ts:85`)

### 4.3 Per-row format

```
<pfx><label><suffix>
```

- `pfx`: `"  "` for non-active; `"<CURSOR> "` (`›` in `chalk.hex("#FFC107")`, then a space) when active. (`src/llm/utils/provider-select-prompt.ts:76`, `:231`)
- `label`:
  - If enabled (provider key exists in `providers` map): `display.providerCheck(name)` → `${chalk.ansi256(114).bold("[✓]")} ${name}`. (`src/commands/config/display.ts:107–109`)
  - If disabled: `display.providerUncheck(name)` → `${chalk.dim("[ ]")} ${name}`. (`src/commands/config/display.ts:114–116`)
  - `name` is `getProviderDisplayName(id)` (verbatim from §3.1).
- `suffix`:
  - If enabled and there are keys: `formatKeyInfo(apiKey)` → `chalk.gray(" [N key]")` (`N=1`) or `" [N keys]"` (`N≠1`). Empty when `N=0`. (`src/llm/utils/provider-select-prompt.ts:64–68`, `:236–237`)
  - If disabled and a hint is provided: `chalk.dim(" — <hint>")`. The dash character is `—` (em-dash). (`src/llm/utils/provider-select-prompt.ts:233`, `:239–240`)

The active-row cursor `›` (U+203A) uses the **literal hex** `#FFC107`, not the 256-color amber 214 used elsewhere in `display.ts`. They render as nearly the same color in 256-color terminals but are not the same chalk call. (`src/llm/utils/provider-select-prompt.ts:76`)

### 4.4 Done row

```
<pfx><display.doneLabel()>
```

`doneLabel()` → `chalk.ansi256(214).bold("  Done")` — note the **two leading spaces inside** the bolded string. (`src/commands/config/display.ts:121–123`)

Active-row prefix is the same `›` cursor; non-active is `"  "`. (`src/llm/utils/provider-select-prompt.ts:244–245`)

### 4.5 Help line

```
  ↑↓ navigate • space toggle • ⏎ manage keys / done
```

Concretely composed from:

```ts
// src/llm/utils/provider-select-prompt.ts:247-252
const help = [
    `${chalk.bold("↑↓")} ${chalk.dim("navigate")}`,
    `${chalk.bold("space")} ${chalk.dim("toggle")}`,
    `${chalk.bold("⏎")} ${chalk.dim("manage keys / done")}`,
];
out.push(chalk.dim(`  ${help.join(chalk.dim(" • "))}`));
```

The whole line is wrapped in `chalk.dim`. The bold parts (`↑↓`, `space`, `⏎`) are bold-and-dimmed; some terminals may show this as a slightly brighter dim. The bullet separator is `" • "` (space, U+2022, space).

### 4.6 Keypress handling — browse mode

```ts
// src/llm/utils/provider-select-prompt.ts:123-137
function handleBrowse(key: KeypressEvent): void {
    if (isUpKey(key)) {
        setActive(Math.max(0, active - 1));
    } else if (isDownKey(key)) {
        setActive(Math.min(doneIndex, active + 1));
    } else if (isSpaceKey(key) && activeProviderId) {
        toggleProvider(activeProviderId);
    } else if (isEnterKey(key)) {
        if (active === doneIndex) {
            done({ action: "done", providers });
        } else if (activeProviderId && activeProviderId in providers && needsApiKey(activeProviderId)) {
            enterKeysMode(activeProviderId);
        }
    }
}
```

- **Up/Down**: clamp to `[0, doneIndex]` (no wrap). Cursor moves between rows, including `Done`.
- **Space** on a provider row: `toggleProvider(id)` (see §4.7).
- **Enter** on `Done` row: returns `{ action: "done", providers }` to `runProviderSetup`, which returns from the loop. (`src/llm/utils/provider-setup.ts:46–48`)
- **Enter** on an enabled provider that requires an API key (everything except Codex and Claude Code): switches to keys mode. (`src/llm/utils/provider-select-prompt.ts:56–58`)
- **Enter** on a provider that does not require keys (Codex, Claude Code) with already-enabled state, or on a disabled provider: no-op (the only action is space-toggle).
- The `useKeypress` callback always calls `rl.clearLine(0)` on every keypress. (`src/llm/utils/provider-select-prompt.ts:115`)

### 4.7 Toggle behavior

```ts
// src/llm/utils/provider-select-prompt.ts:139-161
function toggleProvider(pid: string): void {
    const enabled = pid in providers;
    if (enabled) {
        // Disable: move credentials to stash
        const updated = { ...providers };
        const newStash = { ...stash };
        const providerEntry = updated[pid];
        if (providerEntry) newStash[pid] = providerEntry;
        delete updated[pid];
        setProviders(updated);
        setStash(newStash);
    } else if (!needsApiKey(pid)) {
        // Codex / Claude Code: enable with sentinel "none"
        setProviders({ ...providers, [pid]: { apiKey: "none" } });
    } else if (stash[pid]) {
        // Re-enable from stash
        const newStash = { ...stash };
        const restored = newStash[pid];
        if (!restored) return;
        delete newStash[pid];
        setProviders({ ...providers, [pid]: restored });
        setStash(newStash);
    } else {
        // Disabled, needs key, no stash: ask for first key
        requestAddKey(pid, "browse");
    }
}
```

Disable always preserves credentials in `stash` so that toggling off then on does not lose keys until the user explicitly chooses `Done`. The stash exists only inside the prompt; it is **not persisted** to `providers.json`. (See §7.)

When a disabled provider that requires a key is space-toggled and has no stashed credentials, the prompt exits via `done({ action: "add-key", providerId, returnTo: "browse", state })` and `runProviderSetup` raises a separate `password`/`input` prompt for the key. After capture, the prompt is re-launched with `resumeState = { ...state, mode: "browse", keysTarget: null, keysActive: 0 }`, restoring the cursor position and accumulated state. (`src/llm/utils/provider-select-prompt.ts:108–110`, `src/llm/utils/provider-setup.ts:46–73`)

### 4.8 `needsApiKey`

```ts
// src/llm/utils/provider-select-prompt.ts:56-58
function needsApiKey(providerId: string): boolean {
    return providerId !== PROVIDER_IDS.CODEX && providerId !== PROVIDER_IDS.CLAUDE_CODE;
}
```

Codex and Claude Code are flagged as "no key needed" — toggling them on stores `{ apiKey: "none" }` directly without any prompt. (`src/llm/utils/provider-select-prompt.ts:149–150`)

### 4.9 Defaults / initial state

When the user enters the prompt for the first time (no `resumeState`):

- `active = 0` (cursor on first provider, OpenRouter).
- `providers = { ...config.initialProviders }` — i.e. whatever was loaded from `providers.json`. (`src/llm/utils/provider-select-prompt.ts:88–91`)
- `stash = {}`.
- `mode = "browse"`, `keysTarget = null`, `keysActive = 0`.

When resuming from a key-add round-trip, all fields are taken from `resumeState`. (`src/llm/utils/provider-select-prompt.ts:88–97`)

---

## 5. Suggestion / Auto-Detection Logic

There is **no in-menu "Suggest provider" UI** in the providers submenu itself. Auto-detection happens only:

1. Inside the **onboarding wizard** (`tenex` first-run / `tenex onboard`), before invoking the same `runProviderSetup` prompt with pre-populated providers and a single hint string for Anthropic. (`src/commands/onboard.ts:1423–1442`)
2. Anywhere a hint is passed into `runProviderSetup({ providerHints })`. The `tenex config providers` command does **not** pass hints. (`src/commands/config/providers.ts:15`, `src/llm/utils/provider-setup.ts:25–30`)

### 5.1 Auto-detection algorithm — `autoDetectProviders`

Executed once during onboarding, in this strict order, mutating a shallow-clone of the existing `providers`:

```ts
// src/commands/onboard.ts:596-654
async function autoDetectProviders(existing: TenexProviders, preDetectedOpenClawDir?: string | null): Promise<DetectionResult> {
    const providers = { ...existing, providers: { ...existing.providers } };
    const detectedSources: string[] = [];

    // 1. Detect local CLI commands
    const [hasClaude, hasCodex] = await Promise.all([
        commandExists("claude"),
        commandExists("codex"),
    ]);

    if (hasCodex && !providers.providers[PROVIDER_IDS.CODEX]) {
        providers.providers[PROVIDER_IDS.CODEX] = { apiKey: "none" };
        detectedSources.push("Codex CLI (codex)");
    }

    // 2. Detect Ollama
    if (!providers.providers[PROVIDER_IDS.OLLAMA]) {
        if (await ollamaReachable()) {
            providers.providers[PROVIDER_IDS.OLLAMA] = { apiKey: "http://localhost:11434" };
            detectedSources.push("Ollama (localhost:11434)");
        }
    }

    // 3. Environment variable API keys
    const envMap = [
        { envVar: "ANTHROPIC_API_KEY",  providerId: PROVIDER_IDS.ANTHROPIC,  label: "Anthropic (from ANTHROPIC_API_KEY)" },
        { envVar: "OPENAI_API_KEY",     providerId: PROVIDER_IDS.OPENAI,     label: "OpenAI (from OPENAI_API_KEY)" },
        { envVar: "OPENROUTER_API_KEY", providerId: PROVIDER_IDS.OPENROUTER, label: "OpenRouter (from OPENROUTER_API_KEY)" },
    ];
    for (const { envVar, providerId, label } of envMap) {
        const value = process.env[envVar];
        if (value && !providers.providers[providerId]) {
            providers.providers[providerId] = { apiKey: value };
            detectedSources.push(label);
        }
    }

    // 4. Anthropic OAuth setup-token
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    if (authToken?.startsWith("sk-ant-oat") && !providers.providers[PROVIDER_IDS.ANTHROPIC]) {
        providers.providers[PROVIDER_IDS.ANTHROPIC] = { apiKey: authToken };
        detectedSources.push("Anthropic (from ANTHROPIC_AUTH_TOKEN)");
    }

    // 5. OpenClaw credentials
    const openClawStateDir = preDetectedOpenClawDir !== undefined
        ? preDetectedOpenClawDir
        : await detectOpenClawStateDir();
    if (openClawStateDir) {
        const credentials = await readOpenClawCredentials(openClawStateDir);
        for (const cred of credentials) {
            if (!providers.providers[cred.provider]) {
                providers.providers[cred.provider] = { apiKey: cred.apiKey };
                detectedSources.push(`${cred.provider} (from OpenClaw)`);
            }
        }
    }

    return { providers, openClawStateDir, detectedSources, claudeCliDetected: hasClaude };
}
```

Behavioral notes:
- **Existing entries are never overwritten** — every step guards with `!providers.providers[id]`.
- **Codex CLI present** → injects `{ apiKey: "none" }`. Equivalent to the user toggling Codex on in browse mode.
- **Claude CLI present** does **not** inject Anthropic. It only sets a hint (see §5.2).
- **Ollama probe** is `fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) })`; success requires `response.ok`. Any throw or non-OK response → not reachable. (`src/commands/onboard.ts:575–582`)
- **Detected default base URL** for Ollama: literal `"http://localhost:11434"` (no `/api` suffix). The provider implementation will append `/api` at runtime if missing. (`src/commands/onboard.ts:614`, `src/llm/providers/standard/OllamaProvider.ts:45–47`)
- **`ANTHROPIC_AUTH_TOKEN` only counts** if it `startsWith("sk-ant-oat")`. Other values are ignored.
- **OpenClaw**: a separate scanner reads previously stored OpenClaw credentials and, for each non-conflicting provider, injects them with source label `"<providerId> (from OpenClaw)"`. (Out of scope for porter — list of source labels here is exhaustive.)

After detection, each entry of `detectedSources` is printed as `display.success(\`Detected: ${source}\`)` before the prompt opens, then a blank line. (`src/commands/onboard.ts:1427–1432`)

### 5.2 Provider hint construction — `buildProviderHints`

```ts
// src/commands/onboard.ts:657-663
function buildProviderHints(detection: DetectionResult): Record<string, string> {
    const hints: Record<string, string> = {};
    if (detection.claudeCliDetected && !detection.providers.providers[PROVIDER_IDS.ANTHROPIC]) {
        hints[PROVIDER_IDS.ANTHROPIC] = "via claude setup-token";
    }
    return hints;
}
```

So at most one hint is ever produced: `anthropic → "via claude setup-token"`. It is rendered, dimmed, after the disabled-row label (see §4.3 and the rendering code at `src/llm/utils/provider-select-prompt.ts:239–240`).

When the user selects a hinted provider and the key prompt opens, the hint is also surfaced as a one-line console hint **above** the password input:

```ts
// src/llm/utils/provider-setup.ts:88-90
if (hint) {
    console.log(chalk.dim(`  Run ${chalk.bold("claude setup-token")} in another terminal, then paste the key (sk-ant-...) here.`));
}
```

(That message is only printed when a non-Ollama key is being asked for and a hint exists for that provider.)

---

## 6. Custom Provider Flow

There is none. The submenu has no UI for adding a provider whose ID is not in `AI_SDK_PROVIDERS`. The browse list is statically derived from that constant (`src/llm/utils/provider-setup.ts:29`). The `providers.json` schema does **not** restrict keys to those six (`z.record(z.string(), ProviderCredentialsSchema)`, `src/services/config/types.ts:436`), so a hand-edited file with an additional provider would load and persist, but it cannot be created or edited via the menu, and other parts of the code assume only the six known IDs.

Porter implication: do not add a "Custom provider" menu item. Hand-editing remains supported by the file format, but no UX flow exists.

---

## 7. Provider Removal

### 7.1 How removal happens

The browse list does **not** have a "Remove" action. The only way to remove a provider via the menu is:

1. **Toggle off via space**: the provider's credentials are moved to the in-memory `stash` and removed from `providers`. `Done` then writes the resulting `providers` map (without that key) to disk. (`src/llm/utils/provider-select-prompt.ts:139–148`)
2. **Delete all keys in keys mode**: pressing `d` on each key entry until the last one removes the entire provider entry from `providers` and exits keys mode. (`src/llm/utils/provider-select-prompt.ts:199–213`) — covered in detail by agent 04, summarized here:

   ```ts
   // src/llm/utils/provider-select-prompt.ts:199-213
   function deleteKey(pid: string, index: number, keys: string[]): void {
       const remaining = keys.filter((_, i) => i !== index);
       if (remaining.length === 0) {
           const updated = { ...providers };
           delete updated[pid];
           setProviders(updated);
           exitKeysMode();
       } else {
           setProviders({
               ...providers,
               [pid]: { ...providers[pid], apiKey: remaining.length === 1 ? remaining[0] ?? remaining : remaining },
           });
           setKeysActive(Math.min(keysActive, remaining.length - 1));
       }
   }
   ```

There is **no confirmation prompt**. Toggling/deleting acts immediately on the in-memory state; the change becomes durable only when the user lands on `Done`.

### 7.2 Cascade effects on `llms.json`

Removing a provider does **not** automatically rewrite `llms.json`. There is no cascade. Any `LLMConfiguration` entry whose `provider` field still references the removed provider remains intact, and on the next `loadConfig`, `validateProviderReferences` emits a warning to the logger:

```ts
// src/services/ConfigService.ts:892-908
private validateProviderReferences(llms: TenexLLMs, providers: TenexProviders): void {
    const missingProviders = new Set<string>();

    for (const configValue of Object.values(llms.configurations)) {
        if (configValue.provider === "meta") continue;

        const providerName = configValue.provider;
        if (!providers.providers[providerName]) {
            missingProviders.add(providerName);
        }
    }

    if (missingProviders.size > 0) {
        logger.warn(
            `LLM configurations reference providers not in providers.json: ${Array.from(missingProviders).join(", ")}`
        );
    }
}
```

Verbatim warning format: `LLM configurations reference providers not in providers.json: <comma+space-joined provider IDs>`. This is emitted via `logger.warn` (no console banner in the providers submenu).

### 7.3 Confirmation prompt verbatim

None. The submenu silently mutates state; the only "are you sure" semantics come from "you have to land on `Done` to persist". Therefore the porter must **not** introduce a confirmation dialog; the existing UX assumes the stash + Ctrl-C escape hatch is sufficient.

(For completeness: the `LLMConfigEditor` — separate menu, agent 05's domain — deletes LLM configurations without confirmation either. It calls `display.success(\`Configuration "${configName}" deleted\`)` after the in-memory delete. `src/llm/LLMConfigEditor.ts:248`.)

### 7.4 Aborts

`Ctrl-C` in either the browse list or the key/URL/label prompt raises an inquirer exception whose `.message` includes `"SIGINT"` or `"force closed"`. The catch in `providersCommand` swallows it, returning **without** writing `providers.json`. The pre-existing `providers.json` is untouched. (`src/commands/config/providers.ts:21–23`)

---

## 8. Persistence — `providers.json`

### 8.1 Path

- File name: `providers.json`. (`src/constants.ts:32`)
- Global location: `<getGlobalPath()>/providers.json`, where `getGlobalPath()` returns `process.env.TENEX_BASE_DIR` or `~/.tenex`. (`src/constants.ts:11`, `:22–24`; `src/services/ConfigService.ts:101–103`, `:128–130`)

### 8.2 Schema

```ts
// src/services/config/types.ts:414-437
export interface ProviderCredentials {
    apiKey: string | string[];
    baseUrl?: string;
    timeout?: number;
    options?: Record<string, unknown>;
}

export interface TenexProviders {
    providers: Record<string, ProviderCredentials>;
}

export const ProviderCredentialsSchema = z.object({
    apiKey: z.union([z.string(), z.array(z.string())]),
    baseUrl: z.string().optional(),
    timeout: z.number().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
});

export const TenexProvidersSchema = z.object({
    providers: z.record(z.string(), ProviderCredentialsSchema).default({}),
});
```

Notes:
- `apiKey` is either a single string or an array of strings. Arrays are the multi-key rotation form (covered by agent 04). Inside each string an optional space-separated **label** suffix may appear, e.g. `"sk-... my-personal-key"`. Parsing/serialization: `src/llm/providers/key-manager.ts:288–323`.
- For Ollama, `apiKey` actually stores the **base URL** (`"http://localhost:11434"` or `"local"` sentinel meaning library default). (`src/llm/providers/standard/OllamaProvider.ts:36–48`)
- For Codex and Claude Code, `apiKey` is the literal string `"none"`. The `hasApiKey()` helper treats `"none"` and empty strings as "no key registered" (`src/llm/providers/key-manager.ts:305–313`, `:338–340`), but the surrounding code also recognises `"none"` as the sentinel meaning "this provider does not need a key but is enabled". (`src/llm/utils/ProviderConfigUI.ts:30–32`)
- `baseUrl`, `timeout`, and `options` are **never written** by the providers submenu; they are present in the schema for future / hand-edited use.

### 8.3 Example — verbatim shape after a typical run

After the user enables OpenRouter (one key with label), Anthropic (OAuth setup-token), Ollama (custom URL), and Codex, the file looks like:

```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-v1-abc123 work-account"
    },
    "anthropic": {
      "apiKey": "sk-ant-oat01-..."
    },
    "ollama": {
      "apiKey": "http://localhost:11434"
    },
    "codex": {
      "apiKey": "none"
    }
  }
}
```

Notes on serialization:
- The label form is one string with a single space, not an object. The first whitespace-run separates the key from an optional label; all subsequent whitespace becomes part of the label. (`src/llm/providers/key-manager.ts:288–303`, `:316–323`)
- A multi-key entry is an array of such strings:
  ```json
  "anthropic": { "apiKey": ["sk-ant-... primary", "sk-ant-... fallback"] }
  ```
- Top-level top-level key is always `"providers"` (mandatory). The schema defaults missing `providers` to `{}`. Missing file → load returns `{ providers: {} }`. (`src/services/ConfigService.ts:263–269`)

### 8.4 Load path

```ts
// src/services/ConfigService.ts:263-269
async loadTenexProviders(basePath: string): Promise<TenexProviders> {
    return this.loadConfigFile(
        this.getConfigFilePath(basePath, PROVIDERS_FILE),
        TenexProvidersSchema,
        { providers: {} }
    );
}
```

`loadConfigFile` (lines 911–945): reads cache → if missing-on-disk, returns default `{ providers: {} }` (logger.debug only); if present-but-invalid JSON or Zod parse fails, **propagates** the error after logging (`Config file is corrupt or invalid: <path>`).

### 8.5 Save path

```ts
// src/services/ConfigService.ts:299-316
async saveTenexProviders(basePath: string, providers: TenexProviders): Promise<void> {
    await this.saveConfigFile(
        this.getConfigFilePath(basePath, PROVIDERS_FILE),
        providers,
        TenexProvidersSchema
    );

    if (basePath === this.getGlobalPath()) {
        if (this.loadedConfig) {
            this.loadedConfig = {
                ...this.loadedConfig,
                providers,
            };
        }
        await this.syncProvidersRuntime(providers, "providers save");
        await this.ensureProvidersMonitor(basePath);
    }
}
```

The convenience entry point used by the providers command:

```ts
// src/services/ConfigService.ts:740-744
async saveGlobalProviders(providers: TenexProviders): Promise<void> {
    const globalPath = this.getGlobalPath();
    await this.saveTenexProviders(globalPath, providers);
}
```

After saving:
1. The in-memory `loadedConfig.providers` is replaced.
2. `syncProvidersRuntime` re-initializes the runtime registry (`llmServiceFactory.initializeProviders(providers.providers)`), but only if the providers signature changed. (`src/services/ConfigService.ts:880–890`)
3. `ensureProvidersMonitor` is set up so that subsequent file-system edits to `providers.json` are picked up live (lines 817–833). Reload failures keep the previous runtime config and emit `[ConfigService] Failed to reload providers.json; keeping previous runtime config`. (`src/services/ConfigService.ts:833`)

### 8.6 What write order looks like at exit

1. User picks `Done` → `runProviderSetup` returns `{ providers: <merged map> }`.
2. `providersCommand` calls `config.saveGlobalProviders(...)`.
3. `saveTenexProviders` writes the file, then prints `chalk.green("✓") + chalk.bold(\` Provider credentials saved to ${globalPath}/providers.json\`)`.

The stash never reaches disk: only the keys present in the final `providers` map are written. Toggling a provider off → `Done` → providers.json no longer contains that key.

---

## 9. Color Usage

This section pins down every color used in provider screens. All colors come from these modules:

- `src/commands/config/display.ts` — semantic palette.
- `src/utils/cli-theme.ts` — inquirer prompt theme.
- `src/llm/utils/provider-select-prompt.ts` — prompt-internal constants.

### 9.1 Display palette (xterm-256)

```ts
// src/commands/config/display.ts:4-12
const ACCENT   = chalk.ansi256(214); // amber #FFC107
const INFO     = chalk.ansi256(117); // sky blue
const SELECTED = chalk.ansi256(114); // bright green
const DARK     = chalk.ansi256(130);
const MID      = chalk.ansi256(172);
const BRIGHT   = chalk.ansi256(220);
const GLOW     = chalk.ansi256(222);
```

### 9.2 Where each color appears in this submenu

| Element | Function | Color |
|---|---|---|
| `[✓]` checkmark on enabled provider rows | `display.providerCheck` | `chalk.ansi256(114).bold` (bright green) |
| `[ ]` brackets on disabled provider rows | `display.providerUncheck` | `chalk.dim` |
| Provider display name (right of brackets) | inline in prompt | default terminal foreground (no color) |
| Hint suffix on disabled rows (`" — via claude setup-token"`) | inline | `chalk.dim` |
| `[N keys]` count next to enabled provider | `formatKeyInfo` | `chalk.gray` |
| Active-row cursor `›` | constant `CURSOR` | `chalk.hex("#FFC107")` (literal hex amber) |
| `Done` row label `"  Done"` | `display.doneLabel` | `chalk.ansi256(214).bold` (amber bold) |
| Browse help line | inline | whole line `chalk.dim`; key labels (`↑↓`, `space`, `⏎`) `chalk.bold` (still inside dim wrapper) |
| Idle prompt prefix `?` | `inquirerTheme.prefix.idle` | `chalk.hex("#FFC107")("?")` |
| Done prompt prefix `✓` | `inquirerTheme.prefix.done` | `chalk.green("✓")` |
| Inquirer message text (`"Configure providers:"`) | `theme.style.message(..., "idle")` | inquirer default: bold, no color |
| Step header banner `"3/8  AI Providers"` (only via onboarding) | `display.step` | `chalk.ansi256(214).bold` and rule line `chalk.ansi256(214)(chalk.dim(...))` |
| Context lines (description) | `display.context` | `chalk.dim` |
| Detected source banner `"✓ Detected: ..."` | `display.success` | leading `✓` `chalk.green.bold`; rest default fg |
| Hint pseudo-arrow `→` (used in onboarding skip path) | `display.hint` | `chalk.ansi256(214)` for both arrow and message |
| Save success banner | `chalk.green("✓") + chalk.bold(...)` | as listed |
| Error banner | `chalk.red(...)` | red |

### 9.3 Subtleties

- The cursor `›` (`chalk.hex("#FFC107")`) and the `Done` label / amber accents (`chalk.ansi256(214)`) are different chalk methods that target the same visual color. In a true-color-capable terminal the hex is exact `#FFC107`; in 256-color terminals chalk downgrades to color 214. Match this distinction in the Rust port (xterm-256 fallback is acceptable; the visible color is identical).
- `chalk.dim` and `chalk.bold` inside a wrapping `chalk.dim(...)` produce a string with both SGR codes; in most terminals the result reads as "bold dim" — slightly brighter than dim alone. Do not collapse these.

---

## 10. Validation, Errors, and Edge Cases

### 10.1 URL validation (Ollama)

```ts
// src/llm/utils/provider-setup.ts:80-86
if (isOllama(providerId)) {
    const url = await input({
        message: `${displayName} URL:`,
        default: "http://localhost:11434",
        theme: inquirerTheme,
    });
    value = url.trim() || undefined;
}
```

There is **no URL validation**: any non-empty trimmed string is accepted. An empty trimmed input is treated as "abort key entry" (returns `undefined`, the provider stays toggled off / unchanged). The default suggestion is the literal `"http://localhost:11434"`. The provider implementation will append `/api` to the URL at runtime if missing. (`src/llm/providers/standard/OllamaProvider.ts:43–48`)

### 10.2 Name/ID uniqueness

The list is keyed by hard-coded provider IDs from `AI_SDK_PROVIDERS`. There is no user-entered name and therefore no uniqueness validation. A given provider can be enabled exactly once. (`src/llm/utils/provider-select-prompt.ts:139–161` — toggling re-uses the same key.)

### 10.3 Empty-list handling

The provider list is never empty: `AI_SDK_PROVIDERS` always contains six IDs. (`src/llm/types.ts:28–35`)

If `providers.json` is missing or `providers === {}`, the browse list still renders all six providers as `[ ] <name>` rows; the user must enable at least one to persist anything meaningful. There is no prompt warning for "no providers" inside this submenu. (The onboarding flow has its own copy: `display.hint("Skipping model configuration (no providers configured)")` and `display.context("Run tenex config providers and tenex config llm later to configure models.")` — `src/commands/onboard.ts:1479–1481`.)

### 10.4 Removing an in-use provider

Allowed with no warning. Cascade is described in §7.2. The next config load logs:

```
LLM configurations reference providers not in providers.json: <ids>
```

via `logger.warn` (no terminal banner). (`src/services/ConfigService.ts:905–907`)

### 10.5 Duplicate-name (custom) errors

N/A — no custom flow. The schema would silently overwrite a duplicate top-level key (regular JS object semantics) but the menu cannot create one.

### 10.6 Corrupt / invalid `providers.json`

`loadConfigFile` (lines 911–945 of `ConfigService.ts`) does not silently recover. If the file exists but JSON parsing or Zod parsing fails, the error is logged as `Config file is corrupt or invalid: <path>` and **rethrown**. The caller (`providersCommand` action) then catches it, renders `❌ Failed to configure providers: <error>` and sets `process.exitCode = 1`. (`src/services/ConfigService.ts:935–941`, `src/commands/config/providers.ts:19–25`)

### 10.7 SIGINT / force-closed

Inquirer raises an error containing `"SIGINT"` or `"force closed"` when the user hits `Ctrl-C`. The action handler returns silently. No partial writes occur — `runProviderSetup` either returns the new map or never reaches `saveGlobalProviders`. (`src/commands/config/providers.ts:21–23`)

### 10.8 Default base URL and "key === 'local'"

Ollama treats both an empty `apiKey` and the literal sentinel `"local"` as "use library default base URL", which is `http://127.0.0.1:11434/api`. (`src/llm/providers/standard/OllamaProvider.ts:40–48`) The auto-detection writes `"http://localhost:11434"` (note `localhost` not `127.0.0.1`); the runtime code normalises by appending `/api`.

### 10.9 No "default provider" notion

The submenu does **not** have a "set default provider" action. The concept of "default" applies to LLM **configurations** (`TenexLLMs.default`), not providers, and is managed elsewhere (agent 05). Provider auto-detection / suggestion does not assign a default either — `seedDefaultLLMConfigs` (onboarding) decides the default LLM config based on which providers are present, but that writes `llms.json`, not `providers.json`. (`src/commands/onboard.ts:503–548`, especially `:537` `llmsConfig.default = "Auto"` and `:546` `llmsConfig.default = "GPT-4o"`)

---

## 11. Putting It All Together — Pseudocode of Submenu Flow

```text
on `tenex config providers`:
  ensure_dir(globalPath)                          // ~/.tenex
  loaded = loadTenexProviders(globalPath)          // parse providers.json
  result = runProviderSetup(loaded)                // §2-§4 prompts
  saveGlobalProviders(result)                      // §8 write + sync runtime
  print "✓ Provider credentials saved to <globalPath>/providers.json"

runProviderSetup(loaded, hints?):
  state.providers = clone(loaded.providers)
  state.stash = {}
  loop:
    res = providerSelectPrompt({
      message: "Configure providers:",
      providerIds: [openrouter, anthropic, openai, ollama, codex, claude-code],
      initialProviders: state.providers,
      providerHints: hints,
      resumeState: state, // first iteration: undefined
    })
    if res.action == "done":
      return { providers: res.providers }
    // res.action == "add-key"
    name = displayNameOf(res.providerId)
    apiKey = askForKey(res.providerId, name, hints?[res.providerId])
    if apiKey:
      append apiKey to state.providers[res.providerId].apiKey (string→array)
    state = res.state with { mode: res.returnTo, keysTarget, keysActive: 0 }

providerSelectPrompt:
  state machine:
    BROWSE:
      render header, six provider rows, Done row, help line
      keys: ↑↓ navigate (clamp), space toggle, ⏎ select
        toggle: enabled → stash & remove
                disabled needsKey & has stash → restore
                disabled & !needsKey → enable with apiKey:"none"
                disabled needsKey & no stash → exit with action:"add-key"
        ⏎ on Done → exit with action:"done"
        ⏎ on enabled needsKey → enter KEYS mode
    KEYS:                              // covered by agent 04
      …
```

---

## 12. Cross-References

- API-key entry (the `password`/`input` flow inside `askForKey`, plus the `keys` mode of `providerSelectPrompt`): **agent 04**.
- Per-provider model selection after a config is being added: **agent 05** (`addConfiguration`, `selectOpenRouterModel`, etc., starting at `src/llm/utils/ConfigurationManager.ts:21`).
- Connectivity testing (`runConfigurationTest`, the `t` keybinding in `LLMConfigEditor`): **agent 06**.
- Full TUI theme definitions (palette, prompt theme, banner art): see `src/commands/config/display.ts` and `src/utils/cli-theme.ts`.
