# 04 — LLM API Key Management — Port Spec

Pixel-exact reproduction spec for the TENEX TypeScript CLI's LLM API key
management. Scope: multiple keys per provider, env-var auto-detection, key
rotation/health, masking, validation, persistence, and security UX.

Out of scope (covered by other agents): provider availability/selection (03),
model selection (05), live request testing (06).

All references are absolute paths into the source tree.

---

## 1. Multiple-keys model

### 1.1 Storage shape

A provider's credentials are stored as a `ProviderCredentials` record. The
`apiKey` field is **either a single string or an array of strings** — both
are persisted on disk in that form (no normalization on save).
`src/services/config/types.ts:414-419`:

```ts
export interface ProviderCredentials {
    apiKey: string | string[];
    baseUrl?: string;
    timeout?: number;
    options?: Record<string, unknown>;
}
```

Zod schema accepts the union and a free-form `options` map
(`src/services/config/types.ts:428-433`):

```ts
export const ProviderCredentialsSchema = z.object({
    apiKey: z.union([z.string(), z.array(z.string())]),
    baseUrl: z.string().optional(),
    timeout: z.number().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
});
```

The full file is wrapped in
(`src/services/config/types.ts:424-437`):

```ts
export interface TenexProviders {
    providers: Record<string, ProviderCredentials>;
}
export const TenexProvidersSchema = z.object({
    providers: z.record(z.string(), ProviderCredentialsSchema).default({}),
});
```

### 1.2 Single-string vs. array semantics

After parsing, `getApiKeyEntries` treats both shapes uniformly
(`src/llm/providers/key-manager.ts:305-314`):

```ts
export function getApiKeyEntries(apiKey: string | string[] | undefined): ParsedApiKeyEntry[] {
    if (!apiKey) return [];
    const values = Array.isArray(apiKey) ? apiKey : [apiKey];
    return values
        .map(parseApiKeyEntry)
        .filter(entry => entry.key.length > 0 && entry.key !== "none");
}
```

Special sentinel: the literal string `"none"` is **not** a real key; it marks
"provider enabled, no key required" and is filtered out of the
`getApiKeyEntries` view. Used for `codex` and `claude-code`
(`src/llm/utils/provider-select-prompt.ts:56-58`,
`src/llm/utils/provider-select-prompt.ts:149-150`).

### 1.3 In-memory normalization

When the prompt deletes one key from a multi-key array, the remaining
collection is collapsed back to a string when only one entry survives —
again on save the persisted form may be either string or string[]
(`src/llm/utils/provider-select-prompt.ts:199-213`):

```ts
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

### 1.4 Key rotation strategy

Selection is **random across healthy keys** (not round-robin)
(`src/llm/providers/key-manager.ts:129-144`):

```ts
selectKey(providerId: string): KeyEntry | undefined {
    const entries = this.keys.get(providerId);
    if (!entries || entries.length === 0) return undefined;
    const healthy = entries.filter(entry => this.isKeyHealthy(providerId, entry.key));
    if (healthy.length === 0) {
        logger.warn(`[KeyManager] No healthy keys available for provider "${providerId}", trying all keys`);
        return this.pickRandom(entries);
    }
    return this.pickRandom(healthy);
}
```

```ts
private pickRandom(entries: KeyEntry[]): KeyEntry {
    return entries[Math.floor(Math.random() * entries.length)];
}
```
(`src/llm/providers/key-manager.ts:278-280`)

### 1.5 Key health tracking

Per-provider, per-key state. Defaults
(`src/llm/providers/key-manager.ts:54-58`):

| Field | Default | Meaning |
|---|---|---|
| `failureWindowMs` | `60_000` (60 s) | Window for counting failures |
| `failureThreshold` | `3` | Failures within window → disable |
| `disableDurationMs` | `300_000` (5 min) | How long disabled |

Failure reporting + auto-disable
(`src/llm/providers/key-manager.ts:178-200`):

```ts
reportFailure(providerId: string, apiKey: string): void {
    const hKey = this.healthKey(providerId, apiKey);
    const health = this.health.get(hKey);
    if (!health) return;
    const now = this.clock.now();
    health.failures.push(now);
    this.pruneFailures(health, now);
    if (health.failures.length >= this.config.failureThreshold) {
        health.disabledUntil = now + this.config.disableDurationMs;
        const keyPreview = `${apiKey.slice(0, 8)}...`;
        logger.warn(
            `[KeyManager] Key ${keyPreview} for "${providerId}" temporarily disabled ` +
            `(${health.failures.length} failures in ${this.config.failureWindowMs}ms window). ` +
            `Re-enables in ${this.config.disableDurationMs / 1000}s`
        );
    }
}
```

Auto re-enable when window passes
(`src/llm/providers/key-manager.ts:246-261`).

### 1.6 Failover at request time

`reinitializeProvider()` is called from the LLM request layer when a key fails
mid-call. It (a) reports the failure, (b) selects an *alternative* key
(explicitly excluding the failed key) via `selectAlternativeKey`, (c)
re-creates the underlying SDK provider with the new key **before** tearing
down the old one (no downtime), and (d) rebuilds the AI SDK registry
(`src/llm/providers/registry/ProviderRegistry.ts:188-244`).

`selectAlternativeKey` falls back to disabled alternatives if no healthy
alternatives exist (`src/llm/providers/key-manager.ts:151-172`).

Active key is tracked per provider for failure attribution
(`src/llm/providers/registry/ProviderRegistry.ts:49`,
`src/llm/providers/registry/ProviderRegistry.ts:250-252`).

### 1.7 Identity labels

Each registered key has an "identity" derived once at registration. If the
user provided a label, it is the label; otherwise it's a synthetic
`{providerId}-key-{n}-****{last4}` tag for analytics (never the raw key)
(`src/llm/providers/key-manager.ts:106-110`):

```ts
const entries: KeyEntry[] = parsedEntries.map((entry, index) => ({
    key: entry.key,
    identity: entry.label || `${providerId}-key-${index + 1}-****${entry.key.slice(-4)}`,
}));
```

### 1.8 Single-key resolver (helpers)

Embeddings/image-gen consumers that only need *one* key call
`resolveApiKey()`, which returns the first parsed key
(`src/llm/providers/key-manager.ts:330-332`):

```ts
export function resolveApiKey(apiKey: string | string[] | undefined): string | undefined {
    return getApiKeyEntries(apiKey)[0]?.key;
}
```

`hasApiKey()` returns whether at least one usable key exists
(`src/llm/providers/key-manager.ts:338-340`).

### 1.9 Active-key selection at startup

On `ProviderRegistry.initialize()` each provider is registered with
`KeyManager`, then **one key is picked at random** from the pool to seed the
SDK provider (`src/llm/providers/registry/ProviderRegistry.ts:117-156`).
Empty arrays / arrays of empty strings are normalized to "no key"
(`src/llm/providers/registry/ProviderRegistry.ts:121-124`).

---

## 2. Key entry flow

The key-entry experience is a **two-prompt loop**, not a single inquirer
session. The outer prompt (`provider-select-prompt`) lets the user toggle
providers and view the per-provider key list; when an "add key" intent fires
the prompt resolves with `{action: "add-key", ...}`, the wrapper opens a
separate password prompt, then the wrapper re-enters the outer prompt with a
preserved `resumeState` (`src/llm/utils/provider-setup.ts:32-74`).

### 2.1 Asking for a key — `askForKey`

`src/llm/utils/provider-setup.ts:77-110`:

```ts
async function askForKey(providerId: string, displayName: string, hint?: string): Promise<string | undefined> {
    let value: string | undefined;
    if (isOllama(providerId)) {
        const url = await input({
            message: `${displayName} URL:`,
            default: "http://localhost:11434",
            theme: inquirerTheme,
        });
        value = url.trim() || undefined;
    } else {
        if (hint) {
            console.log(chalk.dim(`  Run ${chalk.bold("claude setup-token")} in another terminal, then paste the key (sk-ant-...) here.`));
        }
        const key = await password({
            message: `${displayName} API key:`,
            mask: "*",
            theme: inquirerTheme,
        });
        value = key.trim() || undefined;
    }

    if (!value) return undefined;

    const label = await input({
        message: `${displayName} label ${chalk.dim("(optional)")}:`,
        theme: inquirerTheme,
    });

    return serializeApiKeyEntry(value, label);
}
```

Behavior summary:

| Step | Provider type | Prompt kind | Mask | Default |
|---|---|---|---|---|
| 1 | Ollama | `@inquirer/input` | none (URL is plaintext) | `http://localhost:11434` |
| 1 | Anthropic / OpenAI / OpenRouter | `@inquirer/password` | `*` for every char | none |
| 2 | All (after non-empty value) | `@inquirer/input` | none | empty (label is optional) |

Notes:
- The password prompt uses inquirer's mask: every typed character renders as
  `*` (no hold-shift-to-reveal, no confirm-twice).
- Pasting works through inquirer's stdin passthrough — multi-character paste
  events appear as one masked sequence; no special paste handler.
- Trimming: keys are `.trim()`-ed; leading/trailing whitespace is silently
  removed.
- The user is **never asked to re-enter the key** for confirmation.
- Empty string ⇒ entry is dropped (`return undefined`).

### 2.2 Hint line for Anthropic+claude CLI

When the `claude` CLI is detected on PATH but no Anthropic key is configured,
a hint is shown above the password prompt (italic dim grey, single line)
(`src/commands/onboard.ts:657-663`):

```ts
function buildProviderHints(detection: DetectionResult): Record<string, string> {
    const hints: Record<string, string> = {};
    if (detection.claudeCliDetected && !detection.providers.providers[PROVIDER_IDS.ANTHROPIC]) {
        hints[PROVIDER_IDS.ANTHROPIC] = "via claude setup-token";
    }
    return hints;
}
```

The hint is rendered in two places:
- As the **inline browse-row suffix** `— via claude setup-token`
  (`src/llm/utils/provider-select-prompt.ts:239`).
- As the **above-prompt hint line** when the user starts entering a key
  (`src/llm/utils/provider-setup.ts:88-90`):
  `Run claude setup-token in another terminal, then paste the key (sk-ant-...) here.`

### 2.3 Label serialization

The label is appended to the key with a single space and persisted as one
string (`src/llm/providers/key-manager.ts:316-323`):

```ts
export function serializeApiKeyEntry(key: string, label?: string): string {
    const trimmedKey = key.trim();
    const trimmedLabel = label?.trim();
    if (!trimmedLabel) return trimmedKey;
    return `${trimmedKey} ${trimmedLabel}`;
}
```

Round-trip parser (`src/llm/providers/key-manager.ts:288-303`):

```ts
export function parseApiKeyEntry(value: string): ParsedApiKeyEntry {
    const serialized = value.trim();
    if (serialized.length === 0) return { key: "", serialized };
    const [keyPart, ...labelParts] = serialized.split(/\s+/);
    const key = keyPart?.trim() ?? "";
    const label = labelParts.join(" ").trim() || undefined;
    return { key, label, serialized };
}
```

This means an on-disk array entry like `"sk-...abcd primary-prod"` is parsed
into `{ key: "sk-...abcd", label: "primary-prod", serialized: "sk-...abcd primary-prod" }`.

---

## 3. Environment-variable detection

Env-var detection runs **only during `tenex onboard`** — the regular
`tenex config providers` flow does **not** import any env vars. There is no
runtime fallback; if `providers.json` lacks a key the provider is simply
skipped at registry init (`src/llm/providers/registry/ProviderRegistry.ts:127-134`).

### 3.1 Env-var → provider table

`src/commands/onboard.ts:619-638`:

| Env Var | Provider ID | Detected Source label | Behavior |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `anthropic` | `Anthropic (from ANTHROPIC_API_KEY)` | Stored as single string |
| `OPENAI_API_KEY` | `openai` | `OpenAI (from OPENAI_API_KEY)` | Stored as single string |
| `OPENROUTER_API_KEY` | `openrouter` | `OpenRouter (from OPENROUTER_API_KEY)` | Stored as single string |
| `ANTHROPIC_AUTH_TOKEN` | `anthropic` | `Anthropic (from ANTHROPIC_AUTH_TOKEN)` | Only if value starts with `sk-ant-oat`, only if Anthropic not yet set by `ANTHROPIC_API_KEY` |

```ts
const envMap: Array<{ envVar: string; providerId: string; label: string }> = [
    { envVar: "ANTHROPIC_API_KEY", providerId: PROVIDER_IDS.ANTHROPIC, label: "Anthropic (from ANTHROPIC_API_KEY)" },
    { envVar: "OPENAI_API_KEY", providerId: PROVIDER_IDS.OPENAI, label: "OpenAI (from OPENAI_API_KEY)" },
    { envVar: "OPENROUTER_API_KEY", providerId: PROVIDER_IDS.OPENROUTER, label: "OpenRouter (from OPENROUTER_API_KEY)" },
];
for (const { envVar, providerId, label } of envMap) {
    const value = process.env[envVar];
    if (value && !providers.providers[providerId]) {
        providers.providers[providerId] = { apiKey: value };
        detectedSources.push(label);
    }
}

const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (authToken?.startsWith("sk-ant-oat") && !providers.providers[PROVIDER_IDS.ANTHROPIC]) {
    providers.providers[PROVIDER_IDS.ANTHROPIC] = { apiKey: authToken };
    detectedSources.push("Anthropic (from ANTHROPIC_AUTH_TOKEN)");
}
```

### 3.2 Other auto-detected sources (non-env-var)

Same `autoDetectProviders` function also seeds (`src/commands/onboard.ts:600-652`):

| Source | Provider | Stored value | Label |
|---|---|---|---|
| `codex` on PATH | `codex` | `apiKey: "none"` | `Codex CLI (codex)` |
| Reachable Ollama at `localhost:11434` | `ollama` | `apiKey: "http://localhost:11434"` | `Ollama (localhost:11434)` |
| OpenClaw credentials file | per-provider | `apiKey: <opened key>` | `<provider> (from OpenClaw)` |

`claude-code` provider is **not** auto-enabled here; it must be toggled on
manually (it gets `apiKey: "none"` via the toggle flow).

### 3.3 Precedence rules

Detection only writes to a provider slot when it is **empty**
(`src/commands/onboard.ts:606`, `:612`, `:627`, `:635`, `:647`).
The order of operations within the onboard flow:

1. Existing `providers.json` values (loaded first into `existingProviders`).
2. Local CLI commands (`codex` → `apiKey:"none"`).
3. Reachable Ollama → `apiKey:"http://localhost:11434"`.
4. Env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`).
5. `ANTHROPIC_AUTH_TOKEN` (only if Anthropic still unset and OAuth-prefixed).
6. OpenClaw credentials.
7. Interactive `runProviderSetup` (user can override anything by
   add/delete in the prompt before saving — but env detection has
   already mutated the in-memory record passed to it).

So **on-disk config wins over env vars**; env vars only fill gaps. There is
no "live env-var override at runtime."

### 3.4 UI rendering of auto-detection

For each `detectedSources` entry, onboard prints a green-check success line
*before* the provider prompt opens (`src/commands/onboard.ts:1427-1432`):

```
  ✓ Anthropic (from ANTHROPIC_API_KEY)
  ✓ Ollama (localhost:11434)
```

via `display.success(label)` — `  ✓ {text}` with green-bold ✓
(`src/commands/config/display.ts:40-42`).

---

## 4. Key listing UI

### 4.1 Browse view (provider list)

`src/llm/utils/provider-select-prompt.ts:228-253`. For each provider:

- **Configured providers** render as `[✓] {DisplayName} [N keys]` — green
  bracketed checkmark plus dim grey count suffix.
- **Unconfigured providers** render as `[ ] {DisplayName} — {hint}` — dim
  brackets, then optional dim italic-style hint after an em-dash.

Cursor is `›` in amber (#FFC107) (`src/llm/utils/provider-select-prompt.ts:76`):

```ts
const CURSOR = chalk.hex("#FFC107")("›");
```

Active row: `› ` prefix; inactive: two-space pad.

Key-count badge format (`src/llm/utils/provider-select-prompt.ts:64-68`):

```ts
function formatKeyInfo(apiKey: string | string[] | undefined): string {
    const count = getKeys(apiKey).length;
    if (count === 0) return "";
    return chalk.gray(` [${count} key${count !== 1 ? "s" : ""}]`);
}
```

So examples:
- `[✓] Anthropic (Claude) [2 keys]`
- `[✓] OpenAI (GPT) [1 key]`
- `[✓] Codex` (no badge — `"none"` filtered out by `getKeys`)
- `[ ] OpenRouter (300+ models) — via claude setup-token` (with hint)

`Done` line: `  Done` in amber bold (`src/commands/config/display.ts:121-123`,
`src/llm/utils/provider-select-prompt.ts:244-245`).

Help footer (dim grey):
`↑↓ navigate • space toggle • ⏎ manage keys / done`
(`src/llm/utils/provider-select-prompt.ts:247-252`).

Provider display names (`src/llm/utils/ProviderConfigUI.ts:14-24`):

| Provider ID | Display Name |
|---|---|
| `openrouter` | `OpenRouter (300+ models)` |
| `anthropic` | `Anthropic (Claude)` |
| `openai` | `OpenAI (GPT)` |
| `ollama` | `Ollama (Local models)` |
| `codex` | `Codex` |
| `claude-code` | `Claude Code (Agents)` |

Provider order in the list is the static `AI_SDK_PROVIDERS` tuple
(`src/llm/types.ts:28-35`):

```
openrouter, anthropic, openai, ollama, codex, claude-code
```

### 4.2 Keys view (per-provider)

Entered by pressing `Enter` while focused on a configured provider that
"needs an API key" (`src/llm/utils/provider-select-prompt.ts:130-136`).
Providers `codex` and `claude-code` skip this view — the toggle suffices
(`src/llm/utils/provider-select-prompt.ts:56-58`).

Layout (`src/llm/utils/provider-select-prompt.ts:255-286`):

```
  {DisplayName} — API Keys
  ──────────────────────────────  (dim, 30 dashes)
  ************abcd  primary-prod   d delete
  ************wxyz  fallback
  + Add another key
  ← Back
  ↑↓ navigate • d delete key • ⏎ select • esc back
```

`RULE_WIDTH` = 30 (`src/llm/utils/provider-select-prompt.ts:77`).

Masking (`src/llm/utils/provider-select-prompt.ts:70-74`):

```ts
function maskKey(providerId: string, key: string): string {
    if (isOllama(providerId)) return key;          // Ollama URL shown plaintext
    if (key.length <= 4) return "*".repeat(key.length);
    return "*".repeat(key.length - 4) + key.slice(-4);
}
```

So:
- Ollama: full URL shown.
- All other providers: every char except last 4 is `*`. The number of
  asterisks reflects actual key length (no fixed-width truncation).
- Keys ≤ 4 chars: fully masked.

Label rendering (`src/llm/utils/provider-select-prompt.ts:264-271`):

```ts
const parsed = parseApiKeyEntry(key);
const masked = maskKey(pid, parsed.key);
const label = parsed.label ? chalk.dim(`  ${parsed.label}`) : "";
const deleteHint = keysActive === i ? chalk.dim("  d delete") : "";
out.push(`${pfx}${masked}${label}${deleteHint}`);
```

The `d delete` hint appears only for the focused row.

Ordering: keys render in **storage order** (insertion order of the array; no
sort, no "active-first" promotion). `getKeys()` preserves array order
(`src/llm/utils/provider-select-prompt.ts:52-54`).

The `+ Add another key` and `← Back` rows are dim grey
(`src/llm/utils/provider-select-prompt.ts:274,277`).

---

## 5. Add / remove / rotate flows

### 5.1 Toggle a provider on (browse mode, `space` key)

`src/llm/utils/provider-select-prompt.ts:139-161`. Cases when the user
presses `space` over a provider row:

| Current state | Action |
|---|---|
| Enabled (key present) | Move credentials to `stash`, remove from `providers` (uncheck) |
| Disabled, provider does not need API key (`codex`, `claude-code`) | Set `apiKey: "none"`, mark enabled |
| Disabled, has stashed credentials from this session | Restore from stash |
| Disabled, no stash | Resolve prompt with `{action: "add-key", returnTo: "browse"}` → wrapper opens password prompt |

Stash is **session-scoped only** — it lives in component state, not on disk.
Toggling a provider off and on within one session round-trips its keys
without a re-prompt; closing and re-opening the editor means a re-prompt.

### 5.2 Adding another key (keys mode)

In keys mode, `Enter` on `+ Add another key` resolves with
`{action: "add-key", providerId, returnTo: "keys", state}`
(`src/llm/utils/provider-select-prompt.ts:189-191`).
The wrapper appends the new key to the existing array
(`src/llm/utils/provider-setup.ts:55-65`):

```ts
if (apiKey) {
    const existing = getKeys(state.providers[providerId]?.apiKey);
    if (existing.length > 0) {
        state.providers[providerId] = {
            ...state.providers[providerId],
            apiKey: [...existing, apiKey],
        } as ProviderCredentials;
    } else {
        state.providers[providerId] = { apiKey };
    }
}
```

If the user submits an empty value at the password prompt, the existing key
list is unchanged (`provider-setup.ts:55` `if (apiKey)` skip).

### 5.3 Deleting a key (`d` key in keys mode)

`src/llm/utils/provider-select-prompt.ts:186-188`,
`src/llm/utils/provider-select-prompt.ts:199-213`. No confirmation
prompt — pressing `d` deletes immediately. Behavior:

| Remaining keys after delete | Result |
|---|---|
| 0 | Provider removed from `providers` map; exit keys mode back to browse |
| 1 | `apiKey` collapsed to a string |
| 2+ | `apiKey` stays an array |

The cursor's `keysActive` is clamped to the new last index.

### 5.4 Exiting keys mode

- `Enter` on `← Back` row.
- `Escape` key.
- Both go through `exitKeysMode()` which resets `mode/keysTarget/keysActive`
  (`src/llm/utils/provider-select-prompt.ts:169-173,194-196`).

### 5.5 Finishing the editor

In browse mode, focus the synthesized `Done` row (index =
`providerIds.length`) and press `Enter`. This resolves the prompt with
`{action: "done", providers}` (`src/llm/utils/provider-select-prompt.ts:130-132`).

The wrapper then:

```ts
if (result.action === "done") {
    return { providers: result.providers };
}
```
(`src/llm/utils/provider-setup.ts:46-48`).

The `providersCommand` saves the result and prints a confirmation
(`src/commands/config/providers.ts:7-27`):

```
✓ Provider credentials saved to {globalPath}/providers.json
```

(green ✓ bold + bold suffix).

Also, when the LLM editor saves, `llmServiceFactory.initializeProviders()` is
re-run so newly-added or removed keys take effect immediately
(`src/llm/LLMConfigEditor.ts:264-270`).

### 5.6 Errors

The `providers` command swallows SIGINT/`force closed` as a clean exit, and
prints any other error in red with `❌` prefix
(`src/commands/config/providers.ts:19-25`):

```
❌ Failed to configure providers: {error}
```

---

## 6. Validation

### 6.1 No format validation at entry time

`askForKey` does **not** validate prefix, length, or charset. It only
trims whitespace and checks non-empty (`src/llm/utils/provider-setup.ts:91-100`).
Empty strings are silently discarded.

The label prompt has no validator — any text is allowed (including spaces,
since the label re-joins on whitespace when serialized).

### 6.2 Sentinel detection (`"none"` and OAuth tokens)

- Literal `"none"` is filtered from "real keys" by
  `getApiKeyEntries` (`src/llm/providers/key-manager.ts:312-313`) and treated
  as "no key required" by the toggle flow
  (`src/llm/utils/provider-select-prompt.ts:149-150`).
- Anthropic detects OAuth tokens by prefix `sk-ant-oat`
  (`src/llm/providers/standard/AnthropicProvider.ts:68-70`,
  `:99-109`). OAuth keys go through a different `createAnthropic` config
  path with `authToken` + a fixed beta-header set (not `apiKey`).
- OpenRouter, OpenAI, Anthropic (non-OAuth) all just throw
  `"<Provider> requires an API key"` if `config.apiKey` is falsy at provider
  init time (`src/llm/providers/standard/OpenAIProvider.ts:36-38`,
  `OpenRouterProvider.ts:53-55`,
  `AnthropicProvider.ts:95-97`).

### 6.3 Schema validation on save

`saveTenexProviders` runs `TenexProvidersSchema.parse(data)` before writing
(`src/services/ConfigService.ts:299-304`,
`src/services/ConfigService.ts:957-961`). The Zod schema rejects:

- `apiKey` not string and not `string[]`
- `baseUrl` not a string when present
- `timeout` not a number when present

It does **not** reject empty strings or empty arrays. Filtering of empty
strings happens at *load* time inside `KeyManager.registerKeys`
(`src/llm/providers/key-manager.ts:98-104`) and via the
empty-array normalization in `ProviderRegistry.initialize`
(`src/llm/providers/registry/ProviderRegistry.ts:121-124`).

### 6.4 Failure messaging

There is no inline "wrong key" feedback during entry. Failure surfaces in
two places later:

- **At provider init** (e.g., the SDK's `createAnthropic` rejects the call):
  the registry logs an error and excludes that provider from `getAvailableProviders()`
  (`src/llm/providers/registry/ProviderRegistry.ts:160-167`).
- **At runtime** (the SDK returns 401/etc.): the request layer calls
  `reinitializeProvider`; KeyManager logs a warn with the masked preview
  (`src/llm/providers/key-manager.ts:193-198`).

The "test" function in `LLMConfigEditor` (`t` keystroke) is a separate
integration path and is covered by spec 06.

---

## 7. Persistence

### 7.1 File location

`{GLOBAL_PATH}/providers.json` where `GLOBAL_PATH = process.env.TENEX_BASE_DIR ?? ~/.tenex`
(`src/constants.ts:11-23`, `:32`).

The same schema is applied to project-level paths if used, but `providers`
config is conventionally global only — the `tenex config providers` command
always targets the global path
(`src/commands/config/providers.ts:11-17`), as do `LLMConfigEditor`
(`src/llm/LLMConfigEditor.ts:252-262`) and onboard
(`src/commands/onboard.ts:1424,1441`).

### 7.2 Exact JSON shape

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-api03-...abcd primary-prod"
    },
    "openai": {
      "apiKey": [
        "sk-proj-...wxyz",
        "sk-proj-...mnop fallback"
      ]
    },
    "openrouter": {
      "apiKey": "sk-or-...1234",
      "baseUrl": "https://openrouter.ai/api/v1",
      "timeout": 60000,
      "options": { "anyVendorSpecific": "value" }
    },
    "ollama": {
      "apiKey": "http://localhost:11434"
    },
    "codex": {
      "apiKey": "none"
    },
    "claude-code": {
      "apiKey": "none"
    }
  }
}
```

Rules:

- Top-level only key: `"providers"`. Map of provider-id → credentials.
- `apiKey` is required, can be a `string` or `string[]`. The TUI emits a
  bare string when one key is present and an array when 2+ are present
  (collapsing on delete to reach 1). Either form is loaded identically.
- `baseUrl`, `timeout`, `options` are optional and untouched by the TUI flow
  (no UI to set them — they survive round-trips because the prompt
  spreads `...state.providers[providerId]` when adding keys
  (`src/llm/utils/provider-setup.ts:58-61`)).
- For Ollama, `apiKey` actually carries the base URL string
  (`src/llm/providers/standard/OllamaProvider.ts:36-48`).
- For `codex`/`claude-code`, the value is the literal string `"none"`,
  serving as a "provider enabled, no credential" marker.
- Keys may have an inline label appended after a single space (see §2.3).

### 7.3 File mode / permissions

`writeJsonFile` uses default `fs.writeFile` semantics — **no chmod, no
explicit 0600**. The file inherits the process umask (typically `0644` on
Linux) (`src/lib/fs/filesystem.ts:107-116`):

```ts
export async function writeJsonFile<T>(
    filePath: string,
    data: T,
    options?: { spaces?: number }
): Promise<void> {
    const resolvedPath = resolvePath(filePath);
    await ensureDirectory(path.dirname(resolvedPath));
    const spaces = options?.spaces ?? 2;
    await fsPromises.writeFile(resolvedPath, JSON.stringify(data, null, spaces));
}
```

Indentation: `JSON.stringify(data, null, 2)` — 2-space indent, no trailing
newline. (Rust port should match for diff-friendly storage.)

The parent directory is ensured via `ensureDirectory` before write — also
default permissions.

### 7.4 Hot-reload watcher

ConfigService polls `providers.json` every 250 ms via `fs.stat` and reloads
+ re-syncs runtime providers whenever mtime/size/inode changes
(`src/services/ConfigService.ts:762-895`). Reload is debounced 100 ms
(`:783-794`). On reload, the cache is cleared and `KeyManager` and the AI
SDK provider registry are rebuilt for the new config. **This is independent
of the TUI** — useful only if an external editor changes the file.

The Rust port can decide whether to mirror this behavior; it is not
essential for the TUI itself.

---

## 8. Security UX

### 8.1 What appears in logs

Every log statement that mentions a key value uses one of two redactions:

- `${apiKey.slice(0, 8)}...` — first 8 chars + `...`
  (`src/llm/providers/key-manager.ts:192-193`,
  `src/llm/providers/registry/ProviderRegistry.ts:233`).
- `****${key.slice(-4)}` — last 4 chars (used for KeyManager identity)
  (`src/llm/providers/key-manager.ts:108`).

Raw keys never appear in `logger.*` calls in the LLM module — all log lines
either omit the key entirely or use one of the two truncations.

### 8.2 What appears on screen

| Place | Format |
|---|---|
| Browse list | `[N keys]` count only (`src/llm/utils/provider-select-prompt.ts:64-68`) |
| Keys view | `*` × (len-4) + last-4 chars (`src/llm/utils/provider-select-prompt.ts:70-74`) |
| Password prompt | `*` per character (inquirer default mask) (`src/llm/utils/provider-setup.ts:92-96`) |
| Ollama URL | Plaintext (it's a URL, not a secret) |

### 8.3 Clipboard

There is **no clipboard integration**. No "copy key to clipboard," no
clipboard-read on entry, no anti-paste handling. Pasting works through
stdin via the terminal — masked via inquirer's password mask exactly like
typed input.

### 8.4 Errors that include the failed key

`reinitializeProvider`'s success log uses `${newEntry.key.slice(0, 8)}...`
(`src/llm/providers/registry/ProviderRegistry.ts:233-234`). Failure path
logs only the error message, not the key
(`src/llm/providers/registry/ProviderRegistry.ts:237-243`).

`KeyManager.reportFailure` warn message is the only place a key prefix
appears in normal logs (`src/llm/providers/key-manager.ts:192-198`).

### 8.5 Telemetry / analysis identity

The `LLMAnalysisHooks.openRequest` payload carries `apiKeyIdentity` —
**never the raw key** (`src/llm/types.ts:120-132`,
`src/llm/providers/key-manager.ts:106-110`). That identity is either the
user-supplied label or the synthetic `<provider>-key-N-****<last4>` tag.

---

## 9. Color usage

All colors come from `chalk` and `src/commands/config/display.ts`. Refer to
spec 02 for the canonical theme; the LLM-key UI uses these specific colors:

| Element | Color | Source |
|---|---|---|
| Cursor `›` | Hex `#FFC107` (amber) | `src/llm/utils/provider-select-prompt.ts:76` |
| Browse provider checked `[✓]` | xterm-256 #114 (bright green), bold | `src/commands/config/display.ts:6,108` |
| Browse provider unchecked `[ ]` | dim default (no color) | `src/commands/config/display.ts:115` |
| Provider name (enabled) | default | — |
| Key-count `[N keys]` suffix | gray | `src/llm/utils/provider-select-prompt.ts:67` |
| Hint suffix `— via ...` | dim default | `src/llm/utils/provider-select-prompt.ts:239` |
| `Done` row | xterm-256 #214 (amber #FFC107), bold | `src/commands/config/display.ts:5,121-123` |
| Help footer | dim default | `src/llm/utils/provider-select-prompt.ts:252,285` |
| Keys-view header `{Name}` | bold default; `— API Keys` dim | `src/llm/utils/provider-select-prompt.ts:261` |
| Rule line `─` × 30 | dim default | `src/llm/utils/provider-select-prompt.ts:262` |
| Masked key chars | default | (no color applied) |
| Label suffix in keys view | dim default | `src/llm/utils/provider-select-prompt.ts:268` |
| `d delete` hint on focused row | dim default | `src/llm/utils/provider-select-prompt.ts:269` |
| `+ Add another key`, `← Back` | dim default | `src/llm/utils/provider-select-prompt.ts:274,277` |
| Inquirer password input (typed `*`) | inquirer theme answer (amber `#FFC107`) | `src/utils/cli-theme.ts:6-13` |
| Detected source `✓ {label}` | green-bold `✓` + default text | `src/commands/config/display.ts:40-42` |
| Save success line `✓ Provider credentials saved to ...` | green `✓` + bold suffix | `src/commands/config/providers.ts:18` |
| Setup-token hint above prompt | dim, with `claude setup-token` bold inside | `src/llm/utils/provider-setup.ts:88-90` |
| Error `❌ Failed to ...` | red | `src/commands/config/providers.ts:24` |

xterm-256 base palette (`src/commands/config/display.ts:5-7`):

```ts
const ACCENT = chalk.ansi256(214);   // amber  #FFC107
const INFO   = chalk.ansi256(117);   // sky blue (unused in this view)
const SELECTED = chalk.ansi256(114); // bright green
```

`chalk.dim`, `chalk.gray`, `chalk.bold`, `chalk.hex("#FFC107")` are used
as-is — the Rust port must match these to ANSI 256 / truecolor sequences
ratser than approximating with 16-color fallbacks.

---

## 10. Keymap reference

### 10.1 Browse mode

| Key | Action | Reference |
|---|---|---|
| `↑` | Move cursor up (clamped at 0) | `provider-select-prompt.ts:124` |
| `↓` | Move cursor down (clamped at `Done` index) | `provider-select-prompt.ts:126` |
| `space` | Toggle provider enabled (see §5.1) | `provider-select-prompt.ts:128` |
| `⏎` (on provider row, configured) | Enter keys-view (only if needs API key) | `provider-select-prompt.ts:133-134` |
| `⏎` (on `Done` row) | Resolve, save, exit | `provider-select-prompt.ts:131` |

### 10.2 Keys mode

| Key | Action | Reference |
|---|---|---|
| `↑` | Move cursor up (clamped at 0) | `provider-select-prompt.ts:182` |
| `↓` | Move cursor down (clamped at `← Back`) | `provider-select-prompt.ts:184` |
| `d` (on key row) | Delete that key, no confirm | `provider-select-prompt.ts:186-187` |
| `⏎` on `+ Add another key` | Open password prompt for additional key | `provider-select-prompt.ts:189-190` |
| `⏎` on `← Back` | Return to browse mode | `provider-select-prompt.ts:191-192` |
| `escape` | Return to browse mode | `provider-select-prompt.ts:194-195` |

### 10.3 Password / label sub-prompts (`@inquirer/password`, `@inquirer/input`)

Standard inquirer behavior:
- Each typed char appears as `*` (password) or as itself (input).
- `⏎` submits.
- `Ctrl+C` raises SIGINT (caught upstream as a clean exit).
- No multi-line input; no built-in confirmation step.

---

## 11. Key files and line ranges (porter cheat-sheet)

| Concern | File | Lines |
|---|---|---|
| `ProviderCredentials` schema | `src/services/config/types.ts` | 414-437 |
| `KeyManager` (multi-key, health, rotation) | `src/llm/providers/key-manager.ts` | full file |
| Key parse / serialize / mask helpers | `src/llm/providers/key-manager.ts` | 288-340 |
| Provider list + keys view (TUI) | `src/llm/utils/provider-select-prompt.ts` | full file |
| Two-prompt entry loop + `askForKey` | `src/llm/utils/provider-setup.ts` | full file |
| Provider display names | `src/llm/utils/ProviderConfigUI.ts` | 14-24 |
| Provider order constant | `src/llm/types.ts` | 28-35 |
| Provider IDs | `src/llm/providers/provider-ids.ts` | 8-16 |
| `tenex config providers` entry | `src/commands/config/providers.ts` | full file |
| Onboarding env-var detection | `src/commands/onboard.ts` | 596-655 |
| Onboarding hint builder | `src/commands/onboard.ts` | 657-663 |
| Save providers (global) | `src/services/ConfigService.ts` | 740-744, 299-316 |
| Hot-reload watcher | `src/services/ConfigService.ts` | 762-895 |
| `writeJsonFile` (no chmod, 2-space indent) | `src/lib/fs/filesystem.ts` | 107-116 |
| Provider init / random key seed | `src/llm/providers/registry/ProviderRegistry.ts` | 103-178 |
| Runtime failover / re-init | `src/llm/providers/registry/ProviderRegistry.ts` | 188-244 |
| Anthropic OAuth detection | `src/llm/providers/standard/AnthropicProvider.ts` | 68-114 |
| Theme constants | `src/commands/config/display.ts` | 1-13, 107-123 |
| Inquirer theme | `src/utils/cli-theme.ts` | 1-13 |
| Constants / file path | `src/constants.ts` | 11-32 |
