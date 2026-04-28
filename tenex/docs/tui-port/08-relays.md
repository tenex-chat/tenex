# 08 — Relay Management (Port Spec)

Pixel-exact port spec for TENEX TypeScript CLI relay management → Rust.
Scope: list/add/remove relays, identity relays, defaults, ws/wss validation,
`RELAYS` env-var override, persistence, color usage.

All citations refer to paths relative to repo root. Format: `path:LINE`.

---

## 1. Constants & Defaults

### 1.1 Network relay defaults
- `DEFAULT_RELAY_URLS = ["wss://relay.tenex.chat"]`
  - Defined: `src/nostr/relays.ts:6`.
  - Single-element array. The Rust port MUST use this exact list (one URL,
    no trailing slash, lowercase) when no env var and no config-file relays
    exist.

### 1.2 Identity relay defaults
- `DEFAULT_IDENTITY_RELAY_URLS = ["wss://purplepag.es"]`
  - Defined: `src/nostr/relays.ts:11`.
  - Used by `getIdentityRelayUrls()` when config has no `identityRelays`.
- The relay-management CLI screen has its own copy of the constant for
  display purposes:
  - `DEFAULT_IDENTITY_RELAY = "wss://purplepag.es"` at
    `src/commands/config/relays.ts:7`.
  - This is shown as a fallback hint in the listing UI (see §2) and in the
    "nothing to remove" message (see §4).
  - Both copies MUST stay in sync; the Rust port should keep one constant
    and reuse it in both the runtime relay loader and the listing UI.

### 1.3 Onboarding-only relay options
The first-run onboarding flow exposes a different curated set than the
runtime defaults — it does NOT reuse `DEFAULT_RELAY_URLS`:
- `src/commands/onboard.ts:1346-1353` — when `options.localRelayUrl` is
  set on the CLI, a "Local relay" choice is prepended (shown first, hence
  selected by default).
- `src/commands/onboard.ts:1355-1358` — the static curated choice is
  `{ name: "TENEX Community Relay", value: "wss://tenex.chat",
     description: "wss://tenex.chat" }`, followed by an `{ type: "input" }`
  free-text entry row.
- Note: onboarding offers `wss://tenex.chat` (no `relay.` subdomain),
  while the runtime default is `wss://relay.tenex.chat`. The Rust port
  MUST preserve both spellings as-is.

### 1.4 Identity relays — purpose
- Identity relays carry kind:0 profile events and are *added on top of*
  the regular relay set (deduped via `Set`):
  - `src/nostr/AgentProfilePublisher.ts:381-384`,
    `src/nostr/AgentProfilePublisher.ts:462`,
    `src/nostr/AgentProfilePublisher.ts:555` —
    `[...new Set([...getRelayUrls(), ...getIdentityRelayUrls()])]`.
- Per the schema comment at `src/services/config/types.ts:21`:
  "Additional relays for publishing kind:0 identity events
  (default: wss://purplepag.es)".

---

## 2. Relay List UI

Source: `src/commands/config/relays.ts:9-49`.

The screen renders BEFORE the action prompt every iteration of the
command (the action menu does not loop — each invocation prints once,
prompts once, applies once, exits). The Rust port may keep this
single-shot semantics or loop; the TS implementation is single-shot.

### 2.1 Header & ordering
Output sequence (verbatim, in order):

1. Blank line (`console.log()` is implicit in `chalk.dim("\n  Relays:")`
   — note the leading `\n`).
2. `chalk.dim("  Relays:")` — header for network relays.
3. Either:
   - `chalk.dim("    No relays configured.")` if `relays.length === 0`
     (`src/commands/config/relays.ts:19-20`), OR
   - one line per relay (in array order, no sorting), formatted as
     `    ${chalk.cyan("●")} ${relay}` — four leading spaces, cyan
     bullet, single space, raw URL (`src/commands/config/relays.ts:21-25`).
4. `chalk.dim("\n  Identity relays (for kind:0 events):")` — header for
   identity relays, with leading newline.
5. Either:
   - `chalk.dim(\`    \${DEFAULT_IDENTITY_RELAY} (default)\`)` if no
     custom identity relays — i.e. literally
     `    wss://purplepag.es (default)` in dim style
     (`src/commands/config/relays.ts:28-29`), OR
   - one line per relay, same `    ● <url>` format
     (`src/commands/config/relays.ts:30-34`).
6. Blank line `console.log()` (`src/commands/config/relays.ts:35`).

### 2.2 Defaults vs user-set indicator
- The list does NOT mark which relays in the *network* list are
  defaults — it shows ONLY what is in `existingConfig.relays`. If the
  user has never configured anything, `relays.length === 0` and the
  screen displays "No relays configured." (the runtime fallback to
  `DEFAULT_RELAY_URLS` happens elsewhere in `getRelayUrls()`; the
  config UI does not surface it).
- The *identity* list explicitly labels the default with the suffix
  `" (default)"` only when the config array is empty.

### 2.3 Connected/disconnected indicator
- **None.** The TS UI prints a static cyan `●` next to every configured
  relay regardless of connection state. There is no live status, no
  spinner, no probe. The Rust port MUST NOT add a connection indicator
  (do not gold-plate). NDK pool events (`relay:connect`,
  `relay:disconnect`, `relay:ready`, `relay:auth`, `flapping`) are
  logged via `logger` but never surfaced in the config UI
  (`src/nostr/ndkClient.ts:39-93`).

### 2.4 Ordering semantics
- Insertion order. New relays are appended (`[...relays, url.trim()]`,
  `src/commands/config/relays.ts:65`,
  `src/commands/config/relays.ts:97`). No sorting, no de-duplication on
  list/render.

---

## 3. Action Menu

After the list, an inquirer `select` prompt with message
`"What do you want to do?"` (`src/commands/config/relays.ts:40`) and
choices in this order (`src/commands/config/relays.ts:41-47`):

| Label                       | Value             |
|-----------------------------|-------------------|
| `Add a relay`               | `add`             |
| `Remove a relay`            | `remove`          |
| `Add an identity relay`     | `add-identity`    |
| `Remove an identity relay`  | `remove-identity` |
| `Back`                      | `back`            |

The prompt uses `inquirerTheme` — defined at
`src/utils/cli-theme.ts:6-13`:
- prefix idle: amber `?`, done: green `✓`
- cursor: amber `❯`
- highlight/answer: amber `#FFC107` (`src/utils/cli-theme.ts:3`).

`back` is a no-op — control returns to the parent menu.

---

## 4. Add Relay Flow

### 4.1 Network relay (`action === "add"`)
Source: `src/commands/config/relays.ts:51-67`.

- Inquirer `input` prompt.
- Message text (verbatim): `"Relay URL (ws:// or wss://):"`
  (`src/commands/config/relays.ts:55`).
- Validator (`src/commands/config/relays.ts:57-63`):
  - Trim input.
  - If trimmed value does NOT start with `ws://` AND does NOT start with
    `wss://`, return error string:
    `"URL must start with ws:// or wss://"`.
  - Otherwise return `true`.
- On submit:
  - `existingConfig.relays = [...relays, url.trim()]`
    (`src/commands/config/relays.ts:65`). Note: the *trimmed* URL is
    appended, even though validation operated on a separately trimmed
    copy.
  - `await configService.saveGlobalConfig(existingConfig)`
    (`src/commands/config/relays.ts:66`).
  - Print: `chalk.green("✓") + chalk.bold(" Relay added.")`
    (`src/commands/config/relays.ts:67`). Result is e.g. green check +
    bold-default `" Relay added."` (the space before `Relay` is part
    of the bold string).

### 4.2 Identity relay (`action === "add-identity"`)
Source: `src/commands/config/relays.ts:83-99`. Identical to §4.1 except:
- Prompt message: `"Identity relay URL (ws:// or wss://):"`
  (`src/commands/config/relays.ts:87`).
- Stored to `existingConfig.identityRelays`
  (`src/commands/config/relays.ts:97`).
- Success line: `"✓ Identity relay added."`
  (`src/commands/config/relays.ts:99`).

### 4.3 Validation differences (CLI vs runtime)
The CLI validator only checks the `ws://` / `wss://` *prefix*. It is
strictly weaker than `isValidWebSocketUrl` (see §5) — it accepts e.g.
`wss://` (empty host) and `ws://not a url`. The runtime loader silently
filters such entries out. The Rust port should preserve this exact
behavior (CLI prefix-check, runtime full-URL-parse filter) to match
existing config files in the wild.

### 4.4 Dedup
- **None.** The CLI does not check for duplicates — adding the same URL
  twice produces two array entries. The Rust port MUST preserve this
  (no implicit dedup on add).
- Dedup happens only in `AgentProfilePublisher` via `new Set(...)` when
  composing the relay set for kind:0 publishes
  (`src/nostr/AgentProfilePublisher.ts:382`).

### 4.5 URL trimming
- The validator trims for prefix-check
  (`src/commands/config/relays.ts:58`).
- The stored value is also trimmed (`url.trim()`,
  `src/commands/config/relays.ts:65`,
  `src/commands/config/relays.ts:97`).
- No other normalization (no lowercasing, no stripping trailing `/`,
  no IDN handling).

### 4.6 Onboarding prompt validator
The onboarding `relayPrompt` uses a stricter validator
(`src/commands/onboard.ts:1363-1376`) and is the exception:
- `new URL(url)` — invalid URL → `"Invalid URL format"`.
- Protocol must be `ws:` or `wss:` →
  `"URL must use ws:// or wss:// protocol"`.
- Hostname must exist and contain `.` →
  `"Enter a relay hostname"`.
- Otherwise `true`.

Reproduce these messages verbatim for onboarding; do NOT use them in
the config-screen flow.

---

## 5. `isValidWebSocketUrl` — runtime validator

Source: `src/nostr/relays.ts:18-25`.

```
function isValidWebSocketUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "ws:" || parsed.protocol === "wss:";
    } catch {
        return false;
    }
}
```

- Used by `getRelayUrls()` and `getIdentityRelayUrls()` to filter both
  env-var entries and config-file entries.
- Function is module-private (no export). The Rust port should
  re-implement (e.g. via the `url` crate, gating on `scheme() == "ws"`
  or `"wss"`) and keep it private to the relay loader module.

---

## 6. Remove Relay Flow

### 6.1 Network relay (`action === "remove"`)
Source: `src/commands/config/relays.ts:68-82`.

- If `relays.length === 0`:
  - Print: `chalk.dim("  Nothing to remove.")` and finish (no prompt).
- Else:
  - Inquirer `select` prompt with message `"Remove which relay?"`
    (`src/commands/config/relays.ts:75`).
  - Choices: `relays.map((r) => ({ name: r, value: r }))`
    (`src/commands/config/relays.ts:76`) — same array order as listing,
    no extra "cancel" entry.
  - On selection:
    - `existingConfig.relays = relays.filter((r) => r !== relay)`
      (`src/commands/config/relays.ts:79`). Removes ALL entries equal
      to the chosen URL (matters because dedup is not enforced on add).
    - `await configService.saveGlobalConfig(existingConfig)`.
    - Print: `chalk.green("✓") + chalk.bold(" Relay removed.")`.

### 6.2 Identity relay (`action === "remove-identity"`)
Source: `src/commands/config/relays.ts:100-114`. Identical to §6.1
except:
- Empty message: `chalk.dim(\`  No custom identity relays configured
  (using default: \${DEFAULT_IDENTITY_RELAY}).\`)` — i.e.
  `"  No custom identity relays configured (using default:
   wss://purplepag.es)."` (`src/commands/config/relays.ts:102`).
- Prompt message: `"Remove which identity relay?"`
  (`src/commands/config/relays.ts:107`).
- Stored at `existingConfig.identityRelays`.
- Success line: `"✓ Identity relay removed."`.

### 6.3 Confirmation
- **None.** No "Are you sure?" prompt. Selecting from the list applies
  immediately. The Rust port should NOT add confirmation.

### 6.4 Cascading effects
- Saving `relays = []` does NOT crash the daemon — `getRelayUrls()`
  falls through to `DEFAULT_RELAY_URLS` when `tenexConfig.relays` is
  empty/undefined or fully filters out
  (`src/nostr/relays.ts:48-53,59`).
- Saving `identityRelays = []` causes
  `getIdentityRelayUrls()` to fall through to
  `DEFAULT_IDENTITY_RELAY_URLS` (`src/nostr/relays.ts:71-76,81`).
- The currently-running daemon is NOT signaled. NDK keeps its existing
  `explicitRelayUrls` until next restart (`src/nostr/ndkClient.ts:29-33`
  initializes once; `resetNDK()` at `src/nostr/ndkClient.ts:11` is only
  called from outside this flow). Document: "Restart daemon for relay
  changes to take effect." The TS code does NOT print this hint, and
  the Rust port should also not add it (matching behavior).

---

## 7. Env-Var Override (`RELAYS`)

Source: `src/nostr/relays.ts:32-60` (`getRelayUrls`).

### 7.1 Precedence (highest → lowest)
1. `process.env.RELAYS` (if set AND parses to ≥1 valid URL).
2. `tenexConfig.relays` from config file (if present AND ≥1 valid URL
   after filtering).
3. `DEFAULT_RELAY_URLS` (`["wss://relay.tenex.chat"]`).

The Rust port MUST honor exactly this precedence.

### 7.2 Parsing
```
const envRelays = process.env.RELAYS;
if (envRelays) {
    const urls = envRelays
        .split(",")
        .map((url) => url.trim())
        .filter((url) => url && isValidWebSocketUrl(url));
    if (urls.length > 0) {
        return urls;
    }
}
```
- Source: `src/nostr/relays.ts:34-43`.
- Split on literal `,`. No whitespace separator support.
- Trim each segment.
- Drop empty strings AND entries that fail `isValidWebSocketUrl`.
- If the resulting array is empty → fall through (do NOT short-circuit
  to defaults; let config-file path run next).

### 7.3 Identity relay env override
- **None.** `RELAYS` does NOT influence identity relays.
  `getIdentityRelayUrls()` reads only the config file then falls back
  to defaults (`src/nostr/relays.ts:68-82`). No env precedence above
  config. The Rust port MUST NOT introduce one.

### 7.4 Where else `RELAYS` is produced
- `src/lib/agent-home-env.ts:54-56` — when bootstrapping a per-agent
  shell environment file, `RELAYS=<comma-joined>` is appended if
  `relays` is non-empty. This is the producer side of the contract;
  the Rust port should keep this format identical so that the existing
  `.env` files remain compatible.

### 7.5 Config-file load failure
- If `config.getConfig()` throws (config not loaded yet), the catch
  block silently swallows and falls through to defaults
  (`src/nostr/relays.ts:54-56` and `src/nostr/relays.ts:77-79`).

---

## 8. Test Connection / Probe Flow

**There is no test-relay flow.** Searched: `src/nostr/`,
`src/commands/config/relays.ts`, `src/commands/onboard.ts`. No probe,
no ping, no "test this relay" command.

Closest signals:
- `src/nostr/ndkClient.ts:96-111` — `initNDK()` races
  `ndk.connect()` against a 5000 ms timeout. On timeout, it logs a
  warning and continues — the daemon does not abort. There is no
  surface on the config UI; logs go to `logger.warn`.
- `src/nostr/ndkClient.ts:39-93` — pool event listeners log lifecycle
  events (`relay:connecting`, `relay:connect`, `relay:ready`,
  `relay:disconnect`, `notice`, `flapping`, `relay:auth`,
  `relay:authed`) at info/warn/debug. None of these reach the config
  screen.

The Rust port should NOT add a probe button. (Restating: no
gold-plating.)

---

## 9. Persistence

### 9.1 Storage location
- File: `${global config base}/config.json`. Resolved via
  `configService.getGlobalPath()` (`src/services/ConfigService.ts:101-103`),
  which delegates to `getConfigPath()` (no subdir →
  `getTenexBasePath()` from `src/services/ConfigService.ts:96-99`). The
  base resolves to `~/.tenex` per `TENEX_DIR` conventions.
- Read: `configService.loadTenexConfig(globalPath)`
  (`src/commands/config/relays.ts:14`,
  `src/services/ConfigService.ts:232`).
- Write: `configService.saveGlobalConfig(existingConfig)`
  (`src/commands/config/relays.ts:66,80,98,112`,
  `src/services/ConfigService.ts:722-726`).

### 9.2 Schema
- TS interface: `TenexConfig.relays?: string[]` and
  `TenexConfig.identityRelays?: string[]`
  (`src/services/config/types.ts:20-21`).
- Zod schema: `relays: z.array(z.string()).optional()` and
  `identityRelays: z.array(z.string()).optional()`
  (`src/services/config/types.ts:140-141`).
- Both fields are `.optional()` — saving an empty array IS distinct from
  deleting the key, but at runtime both paths fall through to defaults.
  The Rust port may either persist `[]` (matches current TS write
  behavior; the filter `relays.filter(r => r !== chosen)` produces `[]`
  when removing the last entry) or omit the key. The TS code persists
  `[]`; preserve this.

### 9.3 Save side effects
- `saveGlobalConfig` ensures the directory exists then writes
  (`src/services/ConfigService.ts:722-726`).
- No mutation of the in-memory `loadedConfig` cache from the relay
  command. The next `config.getConfig()` after a save in a separate
  process picks up the new value; within the same process the loaded
  config is NOT refreshed by `saveGlobalConfig`. The relay command
  reloads via `loadTenexConfig` on each invocation
  (`src/commands/config/relays.ts:14`), which sidesteps the staleness.

---

## 10. Color & Styling

All styling via `chalk` (`src/commands/config/relays.ts:3`).

| Element                                  | Style                                | Citation |
|------------------------------------------|--------------------------------------|----------|
| Section headers ("Relays:", "Identity relays (for kind:0 events):") | `chalk.dim` | `src/commands/config/relays.ts:18,27` |
| "No relays configured."                  | `chalk.dim`                          | `src/commands/config/relays.ts:20` |
| Default identity hint `wss://purplepag.es (default)` | `chalk.dim`                          | `src/commands/config/relays.ts:29` |
| Bullet `●`                               | `chalk.cyan`                         | `src/commands/config/relays.ts:23,32` |
| URL text (after bullet)                  | default (no chalk wrapper)           | `src/commands/config/relays.ts:23,32` |
| "Nothing to remove."                     | `chalk.dim`                          | `src/commands/config/relays.ts:70` |
| "No custom identity relays configured (using default: …)." | `chalk.dim`                          | `src/commands/config/relays.ts:102` |
| Success check `✓`                        | `chalk.green`                        | `src/commands/config/relays.ts:67,81,99,113` |
| Success message text                     | `chalk.bold` (default fg)            | `src/commands/config/relays.ts:67,81,99,113` |
| Error line `❌ Failed to configure relays: <err>` | `chalk.red`                          | `src/commands/config/relays.ts:119` |
| Inquirer prefix idle                     | amber `?` (`#FFC107`)                | `src/utils/cli-theme.ts:7` |
| Inquirer prefix done                     | green `✓`                            | `src/utils/cli-theme.ts:7` |
| Inquirer cursor                          | amber `❯`                            | `src/utils/cli-theme.ts:8` |
| Inquirer highlight/answer                | amber `#FFC107`                      | `src/utils/cli-theme.ts:9-12` |

The Rust port should map:
- `chalk.dim` → ANSI dim (SGR 2).
- `chalk.cyan` → ANSI 36 (or 256-color cyan; the TS code uses default
  16-color cyan).
- `chalk.green` → ANSI 32.
- `chalk.bold` → ANSI 1.
- `chalk.red` → ANSI 31.
- amber `#FFC107` → 24-bit truecolor `38;2;255;193;7` (matching
  `src/utils/cli-theme.ts:3` `chalk.hex("#FFC107")`).

---

## 11. Error Handling

Source: `src/commands/config/relays.ts:116-121`.

- The whole action handler is wrapped in `try/catch`.
- Errors whose message includes `"SIGINT"` or `"force closed"` (i.e.
  Ctrl-C from inquirer) → silent return (`process.exitCode` unchanged).
- Other errors → print
  `chalk.red(\`❌ Failed to configure relays: \${error}\`)` and set
  `process.exitCode = 1`.

The Rust port MUST:
- Silently swallow Ctrl-C from the prompt without an error banner.
- Render exactly `❌ Failed to configure relays: <error>` (with the
  Unicode `❌`, U+274C) in red for any other failure.
- Exit nonzero on non-Ctrl-C errors.

---

## 12. Onboarding Relay Setup (in scope, related)

Source: `src/commands/onboard.ts:33-118` (custom `relayPrompt`),
`src/commands/onboard.ts:1336-1379` (Step 2 "Communication"),
`src/commands/onboard.ts:1411-1420` (persist).

### 12.1 Step header
- `display.step(2, totalSteps, "Communication")`
  (`src/commands/onboard.ts:1338`).
- `display.context("Choose a relay for your agents to communicate
  through.")` (`src/commands/onboard.ts:1339`).
- `display.blank()` (`src/commands/onboard.ts:1340`).
- Skipped entirely under `jsonMode` (`src/commands/onboard.ts:1337`).

### 12.2 Custom relay prompt widget
The onboarding flow does NOT use inquirer's stock `select`; it uses a
custom prompt built with `@inquirer/core` (`createPrompt`, `useState`,
`useKeypress`, `usePrefix`, `makeTheme`) at
`src/commands/onboard.ts:37-118`. Behavior:

- Renders a list of `RelayItem`s. Each item is either:
  - `{ type: "choice", name, value, description? }` — fixed choice.
  - `{ type: "input" }` — inline free-text entry (the user types after
    the cursor).
- Cursor: `theme.icon.cursor` (`❯` amber) on the active row, single
  space on others (`src/commands/onboard.ts:101-102`).
- Description rendered in `chalk.gray` after the name (active row only
  for input rows; both for choice rows)
  (`src/commands/onboard.ts:107,112`).
- Active row text wrapped in `theme.style.highlight` (amber)
  (`src/commands/onboard.ts:108,113`).
- Input row's typed value displayed as
  `inputPrefix + inputValue`, default `inputPrefix = "wss://"`,
  `inputPlaceholder = "Type a relay URL"`
  (`src/commands/onboard.ts:44`).
- Up/Down arrows clamp at boundaries (`Math.max(0)…items.length-1`),
  no wraparound (`src/commands/onboard.ts:72-78`).
- Enter on input row: builds `inputPrefix + inputValue`, runs
  `validate`, if returns string → display in `chalk.red` below the list
  and stay; if `true` → mark `done` and submit
  (`src/commands/onboard.ts:55-67`,
  `src/commands/onboard.ts:116`).
- Enter on choice row: submits `item.value`
  (`src/commands/onboard.ts:68-71`).
- On any printable key while an input row is active: append the
  character (`ch.charCodeAt(0) >= 32`) to `inputValue`
  (`src/commands/onboard.ts:79-88`).
- Backspace on input row: drop the last char
  (`src/commands/onboard.ts:81-83`).
- After submission, render line:
  `${prefix} ${message} ${theme.style.answer(answer)}`
  (`src/commands/onboard.ts:94-98`). For input rows, `answer` is the
  full `inputPrefix + inputValue`; for choice rows, it is `item.name`
  (NOT `item.value`).

### 12.3 Items shown in onboarding
Order (`src/commands/onboard.ts:1343-1358`):
1. (Optional) `{ name: "Local relay", value: options.localRelayUrl,
   description: options.localRelayUrl }` — only when CLI flag set.
2. `{ name: "TENEX Community Relay", value: "wss://tenex.chat",
   description: "wss://tenex.chat" }`.
3. `{ type: "input" }` — free-text entry with prefix `wss://`.

The first item is the initial active row (default selection).

### 12.4 Persistence after onboarding
- `relays = [relay]` — single-element array of the chosen URL
  (`src/commands/onboard.ts:1379`).
- Persisted as part of the new config blob
  (`src/commands/onboard.ts:1411-1420`):
  ```
  const newConfig = {
      ...existingConfig,
      whitelistedPubkeys,
      tenexPrivateKey,
      projectsBase: path.resolve(projectsBase),
      relays,
  };
  await config.saveGlobalConfig(newConfig);
  ```
- Onboarding does NOT touch `identityRelays`; the runtime continues to
  use `DEFAULT_IDENTITY_RELAY_URLS`. Same for the Rust port.

---

## 13. Consumers (informational, do not re-implement here)

These are read-only in this spec — the Rust port author needs to know
what depends on the relay config so listing/persistence semantics stay
consistent.

- `src/nostr/ndkClient.ts:26` — `initNDK()` reads `getRelayUrls()` once
  at startup; daemon must be restarted for relay changes to take
  effect.
- `src/nostr/AgentProfilePublisher.ts:382,462,555` — kind:0 publishes
  use `[...new Set([...getRelayUrls(), ...getIdentityRelayUrls()])]`.
  Identity relays are *additive*, not a replacement.
- `src/services/nip46/Nip46SigningService.ts:122` — NIP-46 signer reads
  `getRelayUrls()` (no identity-relay merge).
- `src/lib/agent-home-env.ts:55` — agent-home `.env` files written
  with `RELAYS=<comma-joined>`. The producer side of the env-var
  contract.

---

## 14. Summary Checklist for the Rust Porter

- [ ] Hardcode `DEFAULT_RELAY_URLS = ["wss://relay.tenex.chat"]` and
  `DEFAULT_IDENTITY_RELAY_URLS = ["wss://purplepag.es"]`.
- [ ] Implement `is_valid_websocket_url` matching
  `src/nostr/relays.ts:18-25` (parse URL, accept `ws:` or `wss:`, reject
  everything else including parse errors).
- [ ] `get_relay_urls()` precedence: env `RELAYS` (comma-split, trim,
  filter valid, ≥1 → return) → config `relays` (filter valid, ≥1 →
  return) → defaults.
- [ ] `get_identity_relay_urls()`: config `identityRelays` (filter
  valid, ≥1 → return) → defaults. NO env override.
- [ ] List screen prints headers in `dim`, bullets in `cyan ●`, URLs
  default fg, with `(default)` suffix only on the empty-identity-list
  fallback line.
- [ ] No connected/disconnected indicator. No probe.
- [ ] Action menu choices in exact order/labels per §3.
- [ ] Add: prompt `"Relay URL (ws:// or wss://):"` /
  `"Identity relay URL (ws:// or wss://):"`, validator checks
  trimmed-prefix `ws://` or `wss://`, error
  `"URL must start with ws:// or wss://"`, append trimmed URL, no
  dedup.
- [ ] Remove: empty-list message uses `dim` and the exact strings in
  §6.1 / §6.2; selection list uses raw URL as both `name` and `value`;
  filter-out matching entries removes ALL duplicates; no confirmation.
- [ ] Success lines: green `✓` + bold rest, exact strings in §4 / §6.
- [ ] SIGINT swallowed silently; other errors print
  `❌ Failed to configure relays: <err>` in red and set exit code 1.
- [ ] Persist to `~/.tenex/config.json` keys `relays` /
  `identityRelays` (`string[]`).
- [ ] Onboarding "Communication" step (Step 2) reproduces custom
  list-with-inline-input prompt per §12, with the stricter validator
  and three error messages verbatim.
- [ ] Continue producing per-agent `.env` files with
  `RELAYS=<comma-joined>` to match existing agent shell expectations.
