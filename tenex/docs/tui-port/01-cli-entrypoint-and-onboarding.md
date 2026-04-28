# CLI Entrypoint and `tenex onboard`

Exhaustive port spec — every prompt, branch, validation, side effect, color.
All citations are `src/<path>:<line>` from the TypeScript source.

---

## 1. CLI Structure

### 1.1 Shebang and entry

- File: `src/index.ts`
- Shebang: `#!/usr/bin/env bun` (`src/index.ts:1`)
- Comment: "TENEX CLI Entry Point — This is a CLI application - NOT a library. Zero exports." (`src/index.ts:3-4`)

### 1.2 Telemetry initialization (must happen before any other dynamic imports)

- Synchronous imports only at top of file: `node:fs` `readFileSync`, `node:url` `fileURLToPath`, and `@/telemetry/cli-bootstrap` (`src/index.ts:8-10`).
- `initializeCliTelemetry("tenex-daemon")` called immediately at module top-level (`src/index.ts:31`).
- `initializeCliTelemetry` reads `~/.tenex/config.json` (or `$TENEX_BASE_DIR/config.json`) synchronously (`src/telemetry/cli-bootstrap.ts:12-14, 17`).
  - Default config when file missing: `{ enabled: true, serviceName: "tenex-daemon", endpoint: "http://localhost:4318/v1/traces" }` (`src/telemetry/cli-bootstrap.ts:18-22`).
  - Reads `telemetry.enabled` (false to disable; any other value or missing → enabled), `telemetry.serviceName`, `telemetry.endpoint` (`src/telemetry/cli-bootstrap.ts:30-33`).
  - On JSON parse error prints `[TENEX] Warning: Failed to parse config at <path>: <message>` to stderr via `console.warn` and uses defaults (`src/telemetry/cli-bootstrap.ts:35-38`).
- After telemetry init, `main()` is invoked and ALL further imports are dynamic via `Promise.all` (`src/index.ts:35-53`).

### 1.3 Version resolution

Function `getCliVersion()` in `src/index.ts:12-28`:

| Step | Source | Behavior |
|------|--------|----------|
| 1 | `process.env.npm_package_version` | If set, return it (`src/index.ts:13-15`) |
| 2 | `package.json` at `../package.json` relative to `import.meta.url` | Read with `readFileSync(..., "utf8")`; parse JSON; if `version` is a non-empty string, return (`src/index.ts:17-22`) |
| 3 | Fallback | Return `"0.0.0"` (`src/index.ts:27`) |

Read errors are silently swallowed (`src/index.ts:23-25`).

### 1.4 Program metadata

- Name: `"tenex"` (`src/index.ts:62`)
- Description: `"TENEX Command Line Interface"` (`src/index.ts:63`)
- Version: from `getCliVersion()` (`src/index.ts:64`)

### 1.5 Registered subcommands

Order of registration (`src/index.ts:66-70`):

| Order | Name | Source | Description |
|-------|------|--------|-------------|
| 1 | `config` | `@/commands/config/index` | "Configure TENEX backend settings" (`src/commands/config/index.ts:128`) |
| 2 | `onboard` | `@/commands/onboard` | "Initial setup wizard for TENEX" (`src/commands/onboard.ts:1535`) |
| 3 | `doctor` | `@/commands/doctor` | "Diagnose and repair TENEX state" (`src/commands/doctor.ts:75`) |
| 4 | `agent` | `@/commands/agent` | "Manage TENEX agents" (`src/commands/agent/index.ts:109`) |

Before subcommand registration `initializeDefaultHeuristics()` is called (`src/index.ts:55`).

### 1.6 Top-level error handling and exit codes

- `program.exitOverride()` is set so commander throws `CommanderError` instead of calling `process.exit` (`src/index.ts:73`).
- Parse uses `parseAsync(process.argv)` (`src/index.ts:78`).
- Outer try/catch (`src/index.ts:75-94`):
  - If thrown error has `code === "commander.helpDisplayed"` or `"commander.version"` → call `shutdownTelemetrySafely()` and `process.exit(0)` (`src/index.ts:82-89`).
  - Otherwise call `handleCliError(error, "Fatal error in TENEX CLI")` which formats via `formatAnyError`, logs through `logger.error`, prints stack only when `process.env.DEBUG` is truthy, and `process.exit(1)` (`src/utils/cli-error.ts:10-28`).
- `finally` always calls `await shutdownTelemetrySafely()` (`src/index.ts:92-93`).
- After the try/finally block, `process.exit(0)` is called unconditionally (`src/index.ts:96`).
- The top-level promise from `main().catch(...)` prints `Fatal error during TENEX CLI initialization:` followed by the error and `process.exit(1)` — used only for failures during dynamic imports (`src/index.ts:100-104`).
- `shutdownTelemetrySafely` races `shutdownTelemetry()` against a 1000 ms timer (`src/telemetry/cli-bootstrap.ts:50-57`).

| Exit Code | Trigger |
|-----------|---------|
| 0 | Help shown, version shown, normal completion (`src/index.ts:88, 96`) |
| 0 | Onboard SIGINT / "force closed" (`src/commands/onboard.ts:1544-1546`) |
| 0 | Daemon exit code propagated (when `startDaemonFromSetup` succeeds with code 0) (`src/commands/onboard.ts:1189`) |
| 1 | `handleCliError` (`src/utils/cli-error.ts:10`) |
| 1 | Onboard catch-all `console.error(chalk.red("Setup failed: " + error)); process.exit(1)` (`src/commands/onboard.ts:1547-1548`) |
| 1 | Init-time dynamic-import failure (`src/index.ts:103`) |
| 1 | Failed to generate daemon key (`src/commands/onboard.ts:1326-1330`) |

---

## 2. `tenex onboard` Command Definition

- File: `src/commands/onboard.ts`
- Name: `"onboard"` (`src/commands/onboard.ts:1534`)
- Description: `"Initial setup wizard for TENEX"` (`src/commands/onboard.ts:1535`)

### 2.1 CLI options

| Flag | Type | Description | Source |
|------|------|-------------|--------|
| `--pubkey <pubkeys...>` | variadic string | "Pubkeys to whitelist (npub, nprofile, or hex)" | `src/commands/onboard.ts:1536` |
| `--local-relay-url <url>` | string | "URL of a running local relay to offer as an option" | `src/commands/onboard.ts:1537` |
| `--json` | boolean | "Output configuration as JSON" | `src/commands/onboard.ts:1538` |

### 2.2 Action wrapper

(`src/commands/onboard.ts:1539-1550`)

- Invokes `runOnboarding(options)` inside a try/catch.
- On caught error:
  - If `errorMessage` includes `"SIGINT"` or `"force closed"` → `process.exit(0)` (`src/commands/onboard.ts:1544-1546`).
  - Else: `console.error(chalk.red("Setup failed: " + error))` and `process.exit(1)` (`src/commands/onboard.ts:1547-1548`).

---

## 3. Onboarding state machine — `runOnboarding`

Defined `src/commands/onboard.ts:1195-1514`. `totalSteps = 7` (`src/commands/onboard.ts:1204`).

The numeric "step header" only ever shows `N/7` (Steps 1–7). However, internally there are additional non-numbered phases (welcome banner, daemon-key auto-gen, profile publish, etc.).

`jsonMode = (options.json === true)` controls whether all banners and prompts that have CLI alternatives are suppressed (`src/commands/onboard.ts:1196`).

### Pre-flight

Before showing Step 1 (`src/commands/onboard.ts:1197-1204`):

1. `globalPath = config.getGlobalPath()` — equals `~/.tenex` (or `$TENEX_BASE_DIR`) (see `src/services/ConfigService.ts`; same default as telemetry).
2. `await ensureDirectory(globalPath)` — creates the dir if missing.
3. `existingConfig = await config.loadTenexConfig(globalPath)` — used to read `tenexPrivateKey` and `projectsBase` carryovers.
4. `earlyOpenClawDir = await detectOpenClawStateDir()` — checks env var `OPENCLAW_STATE_DIR`, then `~/.openclaw`, `~/.clawdbot`, `~/.moldbot`, `~/.moltbot` for a config file named `openclaw.json`, `clawdbot.json`, `moldbot.json`, or `moltbot.json` (`src/commands/agent/import/openclaw-reader.ts:27, 41-66`).

---

## Screen 0: Welcome banner (jsonMode skips)

(`src/commands/onboard.ts:1207-1212`, banner code `src/commands/config/display.ts:63-85`)

When `!jsonMode`:
1. `display.welcome()` — prints a stippled Sierpinski triangle in 5 lines of `•` characters with these xterm-256 colors and bullet patterns:

```
       •
      • •
    •     •
   • • • • •
  • • • • • •
```

| Row | Pattern (literal, leading `  ` indent) | Color |
|-----|----------------------------------------|-------|
| 0 | `       •       ` | xterm-256 222 (GLOW, named "GLOW") (`src/commands/config/display.ts:12, 65`) |
| 1 | `      • •      ` | xterm-256 220 (BRIGHT) (`src/commands/config/display.ts:11, 66`) |
| 2 | `    •     •    ` + `  T E N E X` | dots: xterm-256 214 (ACCENT/amber); right text: ACCENT bold (`src/commands/config/display.ts:9, 67, 79`) |
| 3 | `   • • • • •   ` + `  Your AI agent team, powered by Nostr.` | dots: xterm-256 172 (MID); right text: `chalk.bold` (default fg) (`src/commands/config/display.ts:10, 68, 80`) |
| 4 | `  • • • • • •  ` + `  Let's get everything set up.` | dots: xterm-256 130 (DARK); right text: `chalk.dim` (`src/commands/config/display.ts:9, 69, 81`) |

- Each row is preceded by `console.log()` (blank) before, and another `console.log()` after the banner (`src/commands/config/display.ts:72, 84`).
- Each character that's not a space is colored bold via `color.bold(ch)` (`src/commands/config/display.ts:78`).
- Trailing comment in source: "Match Rust TUI's xterm-256 color scheme exactly" (`src/commands/config/display.ts:3`).

2. `display.step(1, 7, "Identity")` (see "Step header rendering" below).
3. `display.context("Your identity is how your agents know you, and how others can reach you.")`.
4. `display.blank()`.

### Step header rendering

`display.step(number, total, title)` (`src/commands/config/display.ts:20-26`):

```
<blank line>
  <ACCENT bold>"<n>/<total>"</>  <ACCENT bold>"<title>"</>
  <ACCENT dim>"─" * 45</>
<blank line>
```

- Indentation: 2 spaces.
- `ACCENT` = `chalk.ansi256(214)` (xterm-256 214; the comment says "amber #FFC107" but the literal palette index is 214) (`src/commands/config/display.ts:4`).
- Rule character: U+2500 `─` repeated 45 times.

### `display.context(text)` (`src/commands/config/display.ts:31-35`)

- Splits on `"\n"`; each line printed as `  ` + `chalk.dim(line)`.

### `display.success(text)` (`src/commands/config/display.ts:40-42`)

- Prints `  ` + `chalk.green.bold("✓")` + ` ` + text.

### `display.hint(text)` (`src/commands/config/display.ts:47-49`)

- Prints `  ` + `ACCENT("→")` + ` ` + `ACCENT(text)`.

### `display.blank()` — `console.log()` (`src/commands/config/display.ts:54-56`).

### `display.summaryLine(label, value)` (`src/commands/config/display.ts:99-102`)

- `paddedLabel = (label + ":").padEnd(16)`.
- Output: `    ` + `INFO(paddedLabel)` + value.
- `INFO = chalk.ansi256(117)` (sky blue) (`src/commands/config/display.ts:5`).

### `display.providerCheck(text)` and `display.providerUncheck(text)` (`src/commands/config/display.ts:107-115`)

- Check: `SELECTED.bold("[✓]")` + " " + text. `SELECTED = chalk.ansi256(114)` (bright green).
- Uncheck: `chalk.dim("[ ]")` + " " + text.

### `display.doneLabel()` (`src/commands/config/display.ts:121-123`)

- Returns `ACCENT.bold("  Done")` (note: 2 leading spaces inside the styled span).

### `display.setupComplete()` (`src/commands/config/display.ts:90-94`)

```
<blank>
  <ACCENT bold>▲</> <ACCENT bold>Setup complete!</>
<blank>
```

---

## Screen 1: Identity (Step 1/7)

Path: when `options.pubkey` is provided, **all interactive identity prompts are skipped** and `whitelistedPubkeys = options.pubkey.map(decodeToPubkey(pk.trim()))`. No identity is generated (`src/commands/onboard.ts:1220-1222`).

### `decodeToPubkey(identifier)` (`src/commands/onboard.ts:120-133`)

| Input form | Behavior |
|------------|----------|
| 64 hex chars `[a-f0-9]` (case-insensitive) | Returned as-is (`src/commands/onboard.ts:121-123`) |
| `npub1...` | `nip19.decode → data` (hex pubkey) |
| `nprofile1...` | `nip19.decode → data.pubkey` |
| Other types | Throw: `Unsupported identifier type: <type>` (`src/commands/onboard.ts:131`) |
| Invalid bech32 | `nip19.decode` throws; not caught — propagates to onboard catch ⇒ "Setup failed: …" |

### Screen 1.A: Identity choice (interactive only)

Prompt (`src/commands/onboard.ts:1223-1234`):

| Field | Value |
|-------|-------|
| Type | `inquirer.prompt` `select` |
| Name | `identityChoice` |
| Message | `"How do you want to set up your identity?"` |
| Choices | `[{ name: "Create a new identity", value: "create" }, { name: "I have an existing one (import nsec)", value: "import" }]` |
| Default | none (first item highlighted) |
| Theme | `inquirerTheme` |

Branches: `create` → Screen 1.B; `import` → Screen 1.D.

### Screen 1.B: Create new identity — username

Random username generation (`src/commands/onboard.ts:1237, 1516-1532`). Format: `<adjective>-<noun>`.

ADJECTIVES (30): `swift, bright, calm, bold, keen, warm, wild, cool, fair, glad, brave, clever, deft, eager, fierce, gentle, happy, jolly, kind, lively, mighty, noble, plucky, quick, sharp, steady, true, vivid, witty, zesty` (`src/commands/onboard.ts:1516-1520`).

NOUNS (30): `fox, owl, bear, wolf, hawk, deer, lynx, crow, hare, wren, otter, raven, crane, finch, panda, tiger, eagle, cobra, bison, whale, badger, falcon, heron, robin, viper, squid, gecko, moose, stork, manta` (`src/commands/onboard.ts:1522-1526`).

Picked uniformly via `Math.floor(Math.random() * arr.length)` (`src/commands/onboard.ts:1529-1530`).

Prompt (`src/commands/onboard.ts:1238-1251`):

| Field | Value |
|-------|-------|
| Type | `input` |
| Name | `username` |
| Message | `"Choose a username (this is how agents and other nostr users will see you)"` |
| Default | `randomName` (e.g. `clever-otter`) |
| Validation | `input.trim() === ""` → return `"Username is required"`. `input.trim().length < 2` → return `"Username must be at least 2 characters"`. Otherwise `true`. (`src/commands/onboard.ts:1244-1248`) |
| Theme | `inquirerTheme` |

### Screen 1.C: Identity created (display only, `!jsonMode`)

After username is provided (`src/commands/onboard.ts:1253-1276`):

1. Generate signer via `NDKPrivateKeySigner.generate()`. If `signer.privateKey` is falsy throw `"Failed to generate private key"` (`src/commands/onboard.ts:1253-1254`).
2. Compute `pubkey`, `npub = nip19.npubEncode(pubkey)`, `nsec = nip19.nsecEncode(Buffer.from(privkey, "hex"))`.
3. `whitelistedPubkeys = [pubkey]`, `generatedNsec = nsec`, `userPrivateKeyHex = privkey`, `newIdentityUsername = username.trim()`.
4. If `!jsonMode`:
   ```
   <blank>
     ✓ Identity created
   <blank>
     username:        <username>
     npub:            <npub>
     nsec:            <nsec>
   <blank>
     → Save your nsec somewhere safe. You won't be able to recover it.
   <blank>
   ```
   (`src/commands/onboard.ts:1267-1276`)

### Screen 1.D: Import nsec (interactive only)

Prompt (`src/commands/onboard.ts:1278-1296`):

| Field | Value |
|-------|-------|
| Type | `password` |
| Name | `nsecInput` |
| Message | `"Paste your nsec (hidden)"` |
| Mask | `*` |
| Validation | `input.trim() === ""` → `"nsec is required"`. Try `nip19.decode(input.trim())`; if `decoded.type !== "nsec"` → `"Invalid nsec"`. If decode throws → `"Invalid nsec format"`. Otherwise `true`. (`src/commands/onboard.ts:1284-1293`) |
| Theme | `inquirerTheme` |

After accepted (`src/commands/onboard.ts:1298-1314`):

1. `decoded = nip19.decode(nsecInput.trim())`. `privkeyBytes = decoded.data as Uint8Array`. `privkeyHex = Buffer.from(privkeyBytes).toString("hex")`.
2. Build `signer = new NDKPrivateKeySigner(privkeyHex)`, fetch `pubkey`, encode `npub`.
3. `whitelistedPubkeys = [pubkey]`, `userPrivateKeyHex = privkeyHex`. `generatedNsec` is **not** set.
4. If `!jsonMode`:
   ```
   <blank>
     ✓ Identity imported
     npub:            <npub>
   <blank>
   ```
   (`src/commands/onboard.ts:1310-1314`)

### Screen 1.E: Daemon private key (no UI)

(`src/commands/onboard.ts:1319-1331`)

- `tenexPrivateKey = existingConfig.tenexPrivateKey`.
- If missing: `signer = NDKPrivateKeySigner.generate()` and `tenexPrivateKey = signer.privateKey`. If still missing:
  - `jsonMode` → `console.log(JSON.stringify({ error: "Failed to generate daemon key" }))`.
  - else → `console.error(chalk.red("Failed to generate daemon key"))`.
  - Then `process.exit(1)`.
- No screen output on success.

### Screen 1.F: Projects directory default (no UI)

`projectsBase = existingConfig.projectsBase || path.join(os.homedir(), "tenex")` (`src/commands/onboard.ts:1334`). The user is **not** prompted; this default is used silently. The directory is created later at `src/commands/onboard.ts:1421`.

---

## Screen 2: Communication (Step 2/7)

Banner (only when `!jsonMode`, `src/commands/onboard.ts:1337-1341`):

```
<step header 2/7 "Communication">
  Choose a relay for your agents to communicate through.
<blank>
```

### 2.A: Relay item list

Built in `relayItems: RelayItem[]` (`src/commands/onboard.ts:1343-1358`):

1. **If** `options.localRelayUrl` truthy: prepend `{ type: "choice", name: "Local relay", value: options.localRelayUrl, description: options.localRelayUrl }` (so it is the default-active item — index 0).
2. Always append `{ type: "choice", name: "TENEX Community Relay", value: "wss://tenex.chat", description: "wss://tenex.chat" }`.
3. Always append `{ type: "input" }` — the typing row.

### 2.B: Custom `relayPrompt` (built with `@inquirer/core`)

Defined `src/commands/onboard.ts:37-118`.

Prompt configuration (`src/commands/onboard.ts:1360-1377`):

| Field | Value |
|-------|-------|
| Message | `"Relay"` |
| `inputPrefix` (default) | `"wss://"` |
| `inputPlaceholder` (default) | `"Type a relay URL"` |
| Validate | `validate(url)` (described below) |

#### Rendering (`src/commands/onboard.ts:92-117`)

- `prefix` from `usePrefix({ status, theme })` — uses theme.prefix.idle or done. With `inquirerTheme`: idle = amber `?`, done = green `✓` (`src/utils/cli-theme.ts:7`).
- Active row indicator: `theme.icon.cursor = amber("❯")` (`src/utils/cli-theme.ts:8`).
- Inactive row prefix: `" "` (one space).
- For `type: "choice"` rows:
  - `label = cursor + " " + item.name`
  - If `item.description`: append `chalk.gray(description)` separated by 2 spaces.
  - Active row: label wrapped in `theme.style.highlight` (amber) (`src/utils/cli-theme.ts:11`).
- For `type: "input"` row:
  - When inactive: `  ` + placeholder text.
  - When active: amber-highlighted placeholder + 2 spaces + `chalk.gray(inputPrefix + inputValue)`.
- Trailing error line (when set): `\n` + `chalk.red(error)`.
- Trailing answer line (when status="done"): `${prefix} ${message} ${theme.style.answer(answer)}` where answer is amber.

#### Keyboard handling (`src/commands/onboard.ts:52-90`)

- Up/Down: clamps `active` to `[0, items.length-1]`. Clears any error.
- Enter:
  - On `choice`: calls `done(item.value)` and sets status `done`.
  - On `input`: builds `fullUrl = inputPrefix + inputValue`, runs validate; if not `true`, sets error and stays. Otherwise `done(fullUrl)`.
- When the active row is `input` and key is printable (`charCode >= 32`, length 1, no ctrl): appends to `inputValue`.
- Backspace on input row: removes last char.

#### Validation (`src/commands/onboard.ts:1363-1376`)

Performed via `new URL(url)`:

| Condition | Error message |
|-----------|---------------|
| `URL` constructor throws | `"Invalid URL format"` |
| `parsed.protocol !== "ws:" && parsed.protocol !== "wss:"` | `"URL must use ws:// or wss:// protocol"` |
| `!parsed.hostname \|\| !parsed.hostname.includes(".")` | `"Enter a relay hostname"` |
| Otherwise | `true` |

### 2.C: Side effects after relay chosen

(`src/commands/onboard.ts:1379-1421`)

- `relays = [relay]` — single-element list.
- Start NDK agent discovery in background:
  - `agentDiscovery = startAgentDiscovery(relays, signerOrUndefined)` (`src/commands/onboard.ts:1384-1387`).
  - `signer = userPrivateKeyHex ? new NDKPrivateKeySigner(userPrivateKeyHex) : undefined`.
  - `startAgentDiscovery` (`src/commands/onboard.ts:704-752`):
    - Creates `new NDK({ explicitRelayUrls: relays, enableOutboxModel: false })`.
    - If signer: sets `ndk.signer = signer` and `ndk.relayAuthDefaultPolicy = NDKRelayAuthPolicies.signIn({ ndk, signer })`.
    - Subscribes to `{ kinds: [...NDKAgentDefinition.kinds, 34199] }` with `closeOnEose: false`.
    - On each event: stored by id; on team event (kind 34199) fetches referenced "e" tag agent ids it hasn't already requested.
    - Resolves `initialSync` on first `onEose` or `onClose`.
  - `connectAgentDiscovery(agentDiscovery)` calls `ndk.connect()` fire-and-forget; swallows errors (`src/commands/onboard.ts:754-759`).
- Profile publish (kind 0) — only when both `newIdentityUsername` and `userPrivateKeyHex` set (`src/commands/onboard.ts:1391-1409`):
  - Avatar style is chosen deterministically: `Number.parseInt(pubkey.substring(0,8), 16) % 6` indexed into `["lorelei","miniavs","dylan","pixel-art","rings","avataaars"]` (`src/commands/onboard.ts:1394-1396`).
  - URL: `https://api.dicebear.com/7.x/<style>/png?seed=<pubkey>` (`src/commands/onboard.ts:1397`).
  - Event: `kind: 0`, content `JSON.stringify({ name: newIdentityUsername, picture: avatarUrl })` (`src/commands/onboard.ts:1399-1404`).
  - `profileEvent.sign(userSigner).then(() => profileEvent.publish().catch(() => {})).catch(() => {})` — entirely silent on failure.
- Save global config (`src/commands/onboard.ts:1412-1420`):
  - `newConfig = { ...existingConfig, whitelistedPubkeys, tenexPrivateKey, projectsBase: path.resolve(projectsBase), relays }`.
  - `await config.saveGlobalConfig(newConfig)`.
  - `await ensureDirectory(path.resolve(projectsBase))`.

---

## Screen 3: AI Providers (Step 3/7)

### 3.A: Auto-detection summary

`existingProviders = await config.loadTenexProviders(globalPath)` (`src/commands/onboard.ts:1424`).

`detection = await autoDetectProviders(existingProviders, earlyOpenClawDir)` (`src/commands/onboard.ts:1425`). Defined `src/commands/onboard.ts:596-655`. Order:

1. **Local CLIs**: `Promise.all([commandExists("claude"), commandExists("codex")])` — runs `/bin/sh -c command -v <cmd>` (`src/commands/onboard.ts:564-570, 601-604`).
   - If `codex` present and not already configured: `providers.providers.codex = { apiKey: "none" }`. Source label: `"Codex CLI (codex)"` (`src/commands/onboard.ts:606-609`).
   - `claude` presence is recorded as `claudeCliDetected` only — not auto-added (`src/commands/onboard.ts:654`).
2. **Ollama**: if not configured, `fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) })` and check `response.ok` (`src/commands/onboard.ts:575-582, 612-617`). On success: `providers.providers.ollama = { apiKey: "http://localhost:11434" }`. Source: `"Ollama (localhost:11434)"`.
3. **Env vars** (each: only set if currently absent) (`src/commands/onboard.ts:620-631`):
   | Env var | Provider id | Source label |
   |---------|-------------|---------------|
   | `ANTHROPIC_API_KEY` | `anthropic` | `"Anthropic (from ANTHROPIC_API_KEY)"` |
   | `OPENAI_API_KEY` | `openai` | `"OpenAI (from OPENAI_API_KEY)"` |
   | `OPENROUTER_API_KEY` | `openrouter` | `"OpenRouter (from OPENROUTER_API_KEY)"` |
4. **Anthropic OAuth setup-token**: if `process.env.ANTHROPIC_AUTH_TOKEN` starts with `"sk-ant-oat"` and Anthropic not already configured, set `providers.providers.anthropic = { apiKey: authToken }`. Source: `"Anthropic (from ANTHROPIC_AUTH_TOKEN)"` (`src/commands/onboard.ts:634-638`).
5. **OpenClaw credentials**: read from `<stateDir>/agents/main/agent/auth-profiles.json`. Profiles sorted so any key containing `:default` comes first; deduplicated by provider name. Profile types accepted: `token` (uses `profile.token`), `api_key` (uses `profile.key`), `oauth` (uses `profile.access`) (`src/commands/agent/import/openclaw-reader.ts:143-185`). Source label: `"<provider> (from OpenClaw)"` (`src/commands/onboard.ts:641-651`).

After detection (`src/commands/onboard.ts:1427-1432`): for each source in `detection.detectedSources`, print `display.success("Detected: " + source)`. Then `display.blank()` if any.

### 3.B: Step header + intro

(`src/commands/onboard.ts:1435-1437`)

```
<step header 3/7 "AI Providers">
  Connect the AI services your agents will use. You need at least one.
<blank>
```

### 3.C: Provider hints

`buildProviderHints(detection)` (`src/commands/onboard.ts:657-663`):

- If `detection.claudeCliDetected` and Anthropic not configured ⇒ `hints.anthropic = "via claude setup-token"`.
- Otherwise empty.

### 3.D: Provider select prompt — `runProviderSetup`

Defined `src/llm/utils/provider-setup.ts:25-75`.

Provider list (`AI_SDK_PROVIDERS`, `src/llm/types.ts:28-35`), in order:

| Index | provider id | Display name |
|-------|-------------|--------------|
| 0 | `openrouter` | `OpenRouter (300+ models)` |
| 1 | `anthropic` | `Anthropic (Claude)` |
| 2 | `openai` | `OpenAI (GPT)` |
| 3 | `ollama` | `Ollama (Local models)` |
| 4 | `codex` | `Codex` |
| 5 | `claude-code` | `Claude Code (Agents)` |

(`src/llm/utils/ProviderConfigUI.ts:14-23`).

#### Browse view rendering (`src/llm/utils/provider-select-prompt.ts:228-253`)

Header: `${prefix} Configure providers:` (`src/llm/utils/provider-setup.ts:36`, `src/llm/utils/provider-select-prompt.ts:218`).

Each provider row:
- Active row prefix: amber `›` (= `chalk.hex("#FFC107")("›")`) + space (`src/llm/utils/provider-select-prompt.ts:76, 231`). Inactive: 2 spaces.
- If enabled: `display.providerCheck(name)` (`SELECTED.bold("[✓]") + " " + name`) + key count info.
  - Key count: `chalk.gray(" [<n> key" + (n!==1?"s":"") + "]")` (`src/llm/utils/provider-select-prompt.ts:64-68`). Always rendered, even for `apiKey: "none"` providers — except `"none"` is filtered out by `getApiKeyEntries`, yielding count 0 and empty string.
- If disabled: `display.providerUncheck(name)` (`chalk.dim("[ ]") + " " + name`) optionally followed by `chalk.dim(" — " + hint)` (`src/llm/utils/provider-select-prompt.ts:239-240`).

After provider list:
- Done row: `${donePfx}  Done` where the label is `ACCENT.bold("  Done")` (i.e. amber bold with leading 2 spaces inside the styled string) (`src/llm/utils/provider-select-prompt.ts:244-245`, `src/commands/config/display.ts:121-123`).

Help line (always last): `chalk.dim("  ↑↓ navigate • space toggle • ⏎ manage keys / done")` with `↑↓`, `space`, `⏎` portions in `chalk.bold` (`src/llm/utils/provider-select-prompt.ts:247-252`). Separator `chalk.dim(" • ")`.

`cursorHide` ANSI is appended (`src/llm/utils/provider-select-prompt.ts:226`).

#### Browse keyboard

(`src/llm/utils/provider-select-prompt.ts:114-137`)

- Up/Down: clamp `active` in `[0, doneIndex]` where `doneIndex = providerIds.length`.
- Space: toggle active provider. Only acts when `activeProviderId` is set.
- Enter:
  - On Done row: returns `{ action: "done", providers }` — exits prompt.
  - On a provider that is enabled AND `needsApiKey(pid)` (i.e. `pid` is not `codex` or `claude-code`): switches to keys view for that provider (`src/llm/utils/provider-select-prompt.ts:56-58, 133-135`).

#### Toggling logic (`src/llm/utils/provider-select-prompt.ts:139-161`)

| Current | Action on space |
|---------|------------------|
| Enabled | Move credentials to `stash[pid]`; remove from `providers` |
| Disabled, no API key needed (`codex` / `claude-code`) | `providers[pid] = { apiKey: "none" }` |
| Disabled, has stashed creds | Restore from stash |
| Disabled, no stash | Trigger `add-key` (returnTo: `"browse"`) — exits prompt to ask password (see Screen 3.E) |

#### Keys view (`src/llm/utils/provider-select-prompt.ts:255-286`)

Triggered by Enter on an enabled provider that needs an API key.

Layout:
```
  <bold name> <dim — API Keys>
  <dim ─×30>
  <pfx><masked-key><dim "  <label>"><if active: dim "  d delete">>
  ... (per registered key)
  <pfx><dim "+ Add another key">
  <pfx><dim "← Back">
  <dim "  ↑↓ navigate • d delete key • ⏎ select • esc back">
```

- Mask: when not Ollama, `"*" * (len - 4) + key.slice(-4)`; if length ≤ 4, all asterisks. Ollama keys (URLs) are not masked (`src/llm/utils/provider-select-prompt.ts:70-74`).
- Add row label: `chalk.dim("+ Add another key")` (`src/llm/utils/provider-select-prompt.ts:274`).
- Back row label: `chalk.dim("← Back")` (`src/llm/utils/provider-select-prompt.ts:277`).
- Up/Down clamp `[0, backIndex]`.
- `d` (when on a key row): deletes that key. If list becomes empty, removes provider entirely and exits keys view (`src/llm/utils/provider-select-prompt.ts:199-213`).
- Enter on Add row: triggers `add-key` (returnTo `"keys"`).
- Enter on Back, or `esc`: exits to browse mode.

### 3.E: Add-key flow (`askForKey`, `src/llm/utils/provider-setup.ts:77-110`)

When the prompt returns `{ action: "add-key", providerId, returnTo }`:

1. Look up display name via `getProviderDisplayName(providerId)`.
2. **Ollama branch** (`isOllama(pid) === true`):
   - `@inquirer/input` prompt:
     - Message: `"<displayName> URL:"` (e.g. `"Ollama (Local models) URL:"`).
     - Default: `"http://localhost:11434"`.
     - Theme: `inquirerTheme`.
   - `value = url.trim() || undefined`.
3. **Non-Ollama branch**:
   - If a hint exists for this provider (e.g. claude-code): print
     `chalk.dim("  Run " + chalk.bold("claude setup-token") + " in another terminal, then paste the key (sk-ant-...) here.")` BEFORE the prompt (`src/llm/utils/provider-setup.ts:88-90`).
   - `@inquirer/password`:
     - Message: `"<displayName> API key:"` (e.g. `"Anthropic (Claude) API key:"`).
     - Mask: `*`.
     - Theme: `inquirerTheme`.
   - `value = key.trim() || undefined`.
4. If `value` falsy: returns `undefined` (provider state untouched).
5. Otherwise, ask for label (`@inquirer/input`):
   - Message: `"<displayName> label " + chalk.dim("(optional)") + ":"`.
   - No default.
   - Theme: `inquirerTheme`.
6. Returns `serializeApiKeyEntry(value, label)`. Format: `"<key>"` if no label, else `"<key> <label>"` with single space (`src/llm/providers/key-manager.ts:316-323`).

The returned key string is appended to the provider's `apiKey` (becoming an array if multiple keys exist) and the prompt resumes in the mode it came from (browse or keys) (`src/llm/utils/provider-setup.ts:55-73`).

The loop continues until `action === "done"`, returning `{ providers: result.providers }`.

### 3.F: Save providers and confirmation

(`src/commands/onboard.ts:1440-1442`)

- `await config.saveGlobalProviders(updatedProviders)`.
- `display.success("Provider credentials saved")`.

---

## Screen 4: Models (Step 4/7) — only when ≥1 provider configured

Guard: `Object.keys(updatedProviders.providers).length > 0` (`src/commands/onboard.ts:1445`).

If no providers (`src/commands/onboard.ts:1476-1482`):
- Stop the agent discovery subscription.
- `display.blank()`.
- `display.hint("Skipping model configuration (no providers configured)")`.
- `display.context("Run tenex config providers and tenex config llm later to configure models.")`.
- `display.blank()`.
- Skip Steps 4–7.

### 4.A: Seed default LLM configurations — `seedDefaultLLMConfigs`

Defined `src/commands/onboard.ts:503-557`.

Loaded `llmsConfig = await config.loadTenexLLMs(globalPath)`. Skip entire function if any configurations already exist (`src/commands/onboard.ts:507`).

| Provider connected | Seeded entries |
|--------------------|----------------|
| `anthropic` (`hasAnthropic`) | `Sonnet → { provider: "anthropic", model: "claude-sonnet-4-6" }`<br>`Opus → { provider: "anthropic", model: "claude-opus-4-6" }`<br>`Auto → { provider: "meta", variants: { fast: { model: "Sonnet", keywords: ["quick","fast"], description: "Fast, lightweight tasks" }, powerful: { model: "Opus", keywords: ["think","ultrathink","ponder"], description: "Most capable, complex reasoning" } }, default: "fast" }`<br>`llmsConfig.default = "Auto"` |
| `openai` | `GPT-4o → { provider: "openai", model: "gpt-4o" }`<br>If `llmsConfig.default` not yet set: `default = "GPT-4o"` |

After seeding, if any configurations were added: save and for each entry print
`display.success("Seeded: " + name + " (" + detail + ")")`
where detail is `"meta-model"` for the `Auto` entry, or `"<provider>/<model>"` (`src/commands/onboard.ts:550-556`).

### 4.B: Step header

```
<step header 4/7 "Models">
  Configure which models your agents will use.
<blank>
```
(`src/commands/onboard.ts:1448-1450`)

### 4.C: LLMConfigEditor.showMainMenu()

Invoked at `src/commands/onboard.ts:1452-1453`. Implementation in `src/llm/LLMConfigEditor.ts:182-235`.

Structure (per loop until user picks Done):
1. `display.blank()`.
2. `display.step(0, 0, "LLM Configuration")` — note this prints the header `0/0  LLM Configuration` followed by amber dim rule (`src/commands/config/display.ts:20-26`).
3. `displayProviders(llmsConfig)` (`src/llm/utils/ProviderConfigUI.ts:26-42`) — prints `display.context("Configured Providers")` and either `chalk.gray("  None configured")` or one `display.success(displayName)` per provider whose `apiKey` is configured or equals `"none"`.
4. `selectWithFooter` prompt with:
   - Message: `"Configurations"`.
   - Items: each existing config name shown as `<name> <dim detail>` where detail is `"<model>"` for ordinary configs or `"multi-modal, <n> variants"` for meta configs (`src/llm/LLMConfigEditor.ts:189-207`).
   - Actions:
     - `Add new configuration (a)` — key `a` (`src/llm/LLMConfigEditor.ts:210`)
     - `Add multi-modal configuration (m)` — key `m` (`src/llm/LLMConfigEditor.ts:211`)
   - On test (presumably keypress `t`): `runConfigurationTest(llmsConfig, configName)`.
5. Branches:
   - `delete:<name>` → delete config and recurse.
   - `add` → `addConfiguration(llmsConfig, this.advanced)` then save and recurse.
   - `addMultiModal` → `addMultiModalConfiguration(llmsConfig)` then save and recurse.
   - `done` → return.

(Out of scope here — covered by other porter docs. Onboarding only reaches this menu and waits for "done".)

### 4.D: Step 5/7 — Model Roles

Step header (`src/commands/onboard.ts:1456`):
```
<step header 5/7 "Model Roles">
```

Then `runRoleAssignment()` (`src/commands/onboard.ts:228-381`).

#### 4.D.1: Pre-flight branches

- Load `llmsConfig`. `configNames = Object.keys(configurations)`.
- **Zero configs** (`src/commands/onboard.ts:233-237`):
  ```
    → No model configurations found. Skipping role assignment.
    Run tenex config llm to configure models first.
  ```
  (hint then context)  Returns.
- **One config** (`src/commands/onboard.ts:239-244`):
  - `llmsConfig.default = configNames[0]`.
  - Save.
  - `display.success("All roles assigned to \"<name>\"")`.
  - Returns.

#### 4.D.2: Auto-selection (multiple configs)

- `await ensureCacheLoaded()` — ensures models.dev metadata is available (`src/commands/onboard.ts:248`).
- `defaultConfig = llmsConfig.default || configNames[0]`.
- For each role in `MODEL_ROLES`, ensure `llmsConfig[role.key]` is set (default to `defaultConfig`) (`src/commands/onboard.ts:253-257`).
- `autoSelectRoles(llmsConfig, configNames)` (`src/commands/onboard.ts:161-220`):
  - Build `scored[]` of `{ name, inputCost, contextWindow }`, skipping meta configs and any without `info.cost` and `info.limit.context`.
  - If empty: returns (no auto picks).
  - `summarization` ← cheapest input cost where `contextWindow ≥ 100000`.
  - `supervision` ← most expensive input cost overall.
  - `promptCompilation` ← most expensive where `contextWindow ≥ 100000`.
  - `contextDiscovery` ← cheapest where `contextWindow ≥ 32000`, falling back to `≥ 8000`.
  - The `categorization` role is **not** auto-set despite being in `MODEL_ROLES`.

#### 4.D.3: Roles list

`MODEL_ROLES` (`src/commands/onboard.ts:147-154`):

| key | label | recommendation |
|-----|-------|----------------|
| `default` | `Default` | `The default model all agents get — pick your best all-rounder` |
| `summarization` | `Summarization` | `Used for conversation metadata (summaries, titles) — choose a cheap model with a large context window` |
| `supervision` | `Supervision` | `Evaluates agent work and decides next steps — choose a model with strong reasoning` |
| `promptCompilation` | `Prompt Compilation` | `Distills lessons into system prompts — choose a smart model with a large context window` |
| `categorization` | `Categorization` | `Classifies agent roles — choose a cheap, fast model` |
| `contextDiscovery` | `Context Discovery` | `Plans proactive memory searches — choose a cheap, fast model with reliable JSON output` |

#### 4.D.4: Role menu (custom prompt) — `roleMenuPrompt`

Defined `src/commands/onboard.ts:293-347`. Layout:

```
<blank>
<prefix(idle)> <styled "Model roles">
<blank>
<pfx><bold(label padded)>  <dim assigned-config-name>
  <recommendation hint>
<pfx><bold(label padded)>  <dim assigned-config-name>
  <recommendation hint>
... (one block per role)
  <"─" × 40>
<donePfx><amber bold "  Done">
  <dim "↑↓ navigate" + " • " + "⏎ change">
<cursorHide>
```

- `labelWidth = max(role.label.length)` (so labels are space-padded uniformly) (`src/commands/onboard.ts:265`).
- Cursor: `chalk.hex("#FFC107")("›")` (`src/commands/onboard.ts:319`). Inactive: 2 spaces.
- Active recommendation: `chalk.hex("#FFC107").dim(rec)` (`src/commands/onboard.ts:329-331`).
- Inactive recommendation: `chalk.ansi256(240)(rec)` (`src/commands/onboard.ts:331`).
- Done row indent inside styled span: `"  Done"` via `display.doneLabel()` (`src/commands/onboard.ts:338`).
- Help: `↑↓ navigate • ⏎ change` with bolded keys, dim text, dim separator (`src/commands/onboard.ts:340-344`).

Keyboard:
- Up/Down: clamp `[0, roleCount]` (where `roleCount = 6`, so last index is the Done row).
- Enter: if `active < roleCount` → `{ action: "edit", roleKey: roles[active].key }`. Else → `{ action: "done" }` (`src/commands/onboard.ts:303-317`).

#### 4.D.5: Role config selection

When a role row is chosen (`src/commands/onboard.ts:362-376`):

- `inquirer.prompt` `select`:
  - Message: `"<role.label>:"` e.g. `"Default:"`.
  - Choices: built once from `configNames` (`src/commands/onboard.ts:268-284`):
    - For meta configs: `"<name>  <dim (multi-modal, <n> variants)>"`.
    - For ordinary configs: `"<name>  <dim "<contextK>K ctx · $<inputCost>/M in">"` — parts only included if respective metadata is available; rendered as `"<name>"` alone when neither is available. Uses `getModelInfo(provider, model)` from models.dev cache.
  - Default: `currentValue` (current assignment for that role, falling back to `defaultConfig`).
- `llmsConfig[result.roleKey] = picked`.

Loop returns to the role menu until Done is selected, then:
- `await config.saveGlobalLLMs(llmsConfig)`.
- `display.success("Model roles saved")`.

(`src/commands/onboard.ts:379-380`).

---

## Screen 6: Embeddings (Step 6/7)

Banner (`src/commands/onboard.ts:1460-1462`):
```
<step header 6/7 "Embeddings">
  Choose an embedding model for semantic search and RAG.
<blank>
```

Then `runEmbeddingSetup(updatedProviders)` (`src/commands/onboard.ts:387-492`).

### 6.A: Auto-pick recommendation

`existing = await loadEmbeddingConfiguration({ scope: "global" })` (`src/commands/onboard.ts:389`).

Default selection (`src/commands/onboard.ts:393-403`), priority:

| Condition | defaultProvider | defaultModel |
|-----------|-----------------|--------------|
| `openai` connected | `openai` | `text-embedding-3-small` |
| else `openrouter` connected | `openrouter` | `openai/text-embedding-3-small` |
| else | `local` | `Xenova/all-MiniLM-L6-v2` |

Effective (`src/commands/onboard.ts:406-407`):
- `provider = existing?.provider ?? defaultProvider`.
- `model = existing?.model ?? defaultModel`.

Provider label (`src/commands/onboard.ts:409-412`):
- `local` → `"Local Transformers"`.
- `openai` → `"OpenAI"`.
- `openrouter` → `"OpenRouter"`.
- otherwise the provider id itself.

Display (`src/commands/onboard.ts:414-415`):
```
  <dim "Recommended: <providerLabel> / <model>">
<blank>
```

### 6.B: Accept/Change prompt

(`src/commands/onboard.ts:417-426`)

| Field | Value |
|-------|-------|
| Type | `inquirer` `select` |
| Name | `action` |
| Message | `"Embedding model"` |
| Choices | `[{ name: "Use <providerLabel> / <model>", value: "accept" }, { name: "Choose a different model", value: "change" }]` |
| Theme | `inquirerTheme` |

If `accept`:
- `await saveEmbeddingConfiguration({ provider, model }, "global")`.
- `display.success("Embeddings: <providerLabel> / <model>")`.
- Return.

### 6.C: Manual provider selection (when `change`)

(`src/commands/onboard.ts:435-452`)

Build choices: always include `{ name: "Local Transformers (runs on your machine)", value: "local" }`. Then append `OpenAI` / `OpenRouter` if the corresponding provider id exists in `configuredProviders`.

Prompt:
| Field | Value |
|-------|-------|
| Type | `select` |
| Message | `"Embedding provider"` |
| Choices | (above) |
| Default | `provider` |

### 6.D: Manual model selection — Local (when `chosenProvider === "local"`)

(`src/commands/onboard.ts:455-468`)

Prompt:
- Message: `"Local embedding model"`.
- Choices:
  - `{ name: "all-MiniLM-L6-v2 (fast, good for general use)", value: "Xenova/all-MiniLM-L6-v2" }`
  - `{ name: "all-mpnet-base-v2 (larger, better quality)", value: "Xenova/all-mpnet-base-v2" }`
  - `{ name: "paraphrase-multilingual-MiniLM-L12-v2 (multilingual)", value: "Xenova/paraphrase-multilingual-MiniLM-L12-v2" }`
- Default: `"Xenova/all-MiniLM-L6-v2"`.

### 6.E: Manual model selection — API providers

(`src/commands/onboard.ts:469-487`)

For OpenAI:
- `{ name: "text-embedding-3-small (fast, good quality)", value: "text-embedding-3-small" }`
- `{ name: "text-embedding-3-large (slower, best quality)", value: "text-embedding-3-large" }`

For OpenRouter:
- `{ name: "openai/text-embedding-3-small", value: "openai/text-embedding-3-small" }`
- `{ name: "openai/text-embedding-3-large", value: "openai/text-embedding-3-large" }`

Prompt: select `"Embedding model"` with the above choices, no default.

### 6.F: Save

(`src/commands/onboard.ts:489-491`)
- `embeddingConfig = { provider: chosenProvider, model: chosenModel }`.
- `await saveEmbeddingConfiguration(embeddingConfig, "global")`.
- `display.success("Embeddings: <chosenProvider> / <chosenModel>")` — note: when manual path is taken, the raw provider id (`openrouter`) is used in the success line, not the friendly label.

---

## Screen 7: Project & Agents (Step 7/7) — only when `userPrivateKeyHex` is set

Guard: `if (userPrivateKeyHex)` else `agentDiscovery.subscription.stop()` (`src/commands/onboard.ts:1466-1475`). Step is **skipped entirely** if the user supplied `--pubkey` (because `userPrivateKeyHex` is undefined in that branch).

### 7.A: Step header

(`src/commands/onboard.ts:1467`)
```
<step header 7/7 "Project & Agents">
```

`runProjectAndAgentsStep` is invoked with `(agentDiscovery, userPrivateKeyHex, detection.openClawStateDir)`. Defined `src/commands/onboard.ts:843-1158`.

### 7.B: Pre-flight

- `discoveryReady = waitForAgentDiscovery(discovery)` (lazily awaited; default 3 s timeout from `connectAgentDiscovery` start) (`src/commands/onboard.ts:849, 761-771`).
- `await agentStorage.initialize()` (`src/commands/onboard.ts:851`).

### 7.C: OpenClaw agent import (when `openClawStateDir` is set)

(`src/commands/onboard.ts:890-929`)

`openClawAgents = await readOpenClawAgents(openClawStateDir)` — see `src/commands/agent/import/openclaw-reader.ts:90-131`.

If `openClawAgents.length > 0`:

1. `display.hint("Found your OpenClaw agents:")`.
2. `display.blank()`.
3. `inquirer.prompt` `checkbox`:
   - Name: `selected`.
   - Message: `"Import your OpenClaw agents? (space to toggle, enter to confirm)"`.
   - Choices: each agent rendered as `chalk.ansi256(214)(a.id)` (xterm-256 214 = amber), `value: a.id`, `checked: true` (i.e. all selected by default).
   - Theme: `inquirerTheme`.
4. If any selected:
   - `display.context("Importing OpenClaw agents in background while setup continues...")`.
   - `display.blank()`.
   - Spawn child process: `execFile(process.argv[0], [process.argv[1], "agent", "import", "openclaw", "--slugs", "<csv>"], cb)`. Promise resolves to `{ importedCount, stdout, stderr, failed }` (`src/commands/onboard.ts:914-926`). Counts: `importedCount = err ? 0 : selected.length`.
   - Promise stored; awaited later via `waitForOpenClawImportIfNeeded`.

### 7.D: Meta project confirm

Always shown, even when no OpenClaw agents (`src/commands/onboard.ts:931-944`):

```
  Projects organize what your agents work on. We suggest starting with a
  "Meta" project — a command center where agents track everything else.
<blank>
```

Note: the context string is two lines joined by `\n` so it prints as two indented dim lines.

Prompt:
| Field | Value |
|-------|-------|
| Type | `confirm` |
| Name | `createMeta` |
| Message | `"Create a Meta project?"` |
| Default | `true` |
| Theme | `inquirerTheme` |

#### Branch: `createMeta === false`

(`src/commands/onboard.ts:946-957`)

- Stop `discovery.subscription`.
- Await pending OpenClaw import (see 7.G).
- If `installedCount > 0`: `display.blank(); display.success("<n> agent(s) ready.");`.
- `display.blank()`.
- `display.context("Sure thing. You can create projects anytime from the dashboard.")`.
- `return false`.

### 7.E: Wait for discovery + resolve events

(`src/commands/onboard.ts:959-960`)

- `await discoveryReady` (Promise.race of `initialSync` vs the remaining time of a 3 s timer).
- `fetchResults = resolveAgentDiscovery(discovery)`.

`resolveAgentDiscovery` (`src/commands/onboard.ts:779-831`):
- Stops the subscription.
- Filters events into:
  - **Teams (kind 34199)**: requires non-empty `title` tag. `description = event.content || tag("description")`. `agentEventIds = event.tags.filter(t[0]==="e" && t[1])`.
  - **Agents** (`NDKAgentDefinition.kinds`): `name = tag("title") || "Unnamed Agent"`, `role = tag("role") || ""`, `description = tag("description") || event.content || ""`.
- Dedup teams by title (first kept).
- Dedup agents: bucket by `${pubkey}:${dTag}` keeping highest `created_at`; events lacking a `d` tag are kept as-is.

### 7.F: Team / agent selection menu

(`src/commands/onboard.ts:963-1108`)

- `display.blank()`, `display.context("Pick a pre-built agent team or choose individual agents.")`, `display.blank()`.
- `hasNostrAgents = fetchResults.agents.length > 0`.

If `hasNostrAgents === false`:
- `display.context("No Nostr agents available right now.")`.
- `display.hint("You can browse and hire agents later from the dashboard.")`.

Otherwise loop until Done or nothing left to offer:

#### Each iteration (`src/commands/onboard.ts:974-1107`):

1. Compute available teams: only those where some referenced agent is not yet selected (`src/commands/onboard.ts:976-978`).
2. Compute `hasRemainingAgents`: any agent in results not yet selected.
3. If both empty: `break`.
4. Build menu choices:
   - One entry per available team. Label format:
     - With description: `"<title> — <description> (<n> agents)"` where n is unselected count.
     - Without description: `"<title> (<n> agents)"`.
     - Value: `"team:<eventId>"`.
   - If `hasRemainingAgents`: `{ name: "Add individual agents", value: "__individual__" }`.
   - Always: `{ name: "Done", value: "__done__" }`.
5. `inquirer.prompt` `select` with message `"Add agents"`, theme `inquirerTheme`.

Branches:

##### `__done__`
Break the loop.

##### `__individual__` (`src/commands/onboard.ts:1018-1064`)

`inquirer.prompt` `checkbox`:
- Message: `"Select agents (space to toggle, enter to confirm)"`.
- Choices: for each remaining agent:
  - With role: `"<name padded to 20> <role> — <description>"`.
  - Without role: `"<name padded to 20> <description>"`.
  - Value: `agent.id`.
- Theme: `inquirerTheme`.

For each selected:
- Add to `selectedNostrAgentEventIds`.
- For each, attempt `installAgentFromDefinitionEvent(agent.event, { ndk })`. Track `installedNow` count, `selectedAgentPubkeys.add(result.pubkey)`, `installedCount++`. On error: `display.context("Failed to install \"<name>\": " + msg)` (`src/commands/onboard.ts:1043-1055`).

Then:
- `display.blank()`.
- `display.success("Added <n> agent tag(s): <comma-joined names>")`.
- If `installedNow !== selectedAgents.length`: `display.hint("Installed <m>/<n> locally. Remaining agents will load from project tags.")`.

`continue` to top of loop.

##### Team selection (value starts with `team:`) (`src/commands/onboard.ts:1067-1106`)

- Strip `team:` prefix.
- Find team in results; if not found, `continue`.
- `teamAgents = agentsForTeam(...).filter(unselected)`. If empty, `continue`.
- `display.blank()`.
- `display.hint("Agents in <team.title>:")`.
- For each agent in teamAgents, print `console.log("    " + chalk.ansi256(117)("●") + " " + chalk.bold(name padded 20) + " " + chalk.dim(role))` (4-space indent, sky-blue dot, bold name, dim role).
- Add all to `selectedNostrAgentEventIds`.
- Install each (same as individual flow).
- `display.blank()`.
- `display.success("Team \"<title>\" added (<n> agent tag(s)): <comma-joined names>")`.
- If partial install: `display.hint("Installed <m>/<n> locally. Remaining agents will load from project tags.")`.

### 7.G: `waitForOpenClawImportIfNeeded`

(`src/commands/onboard.ts:865-888`)

After the menu loop:
- If a child-process import promise is pending and still in flight: print `display.context("Waiting for OpenClaw import to finish..."); display.blank();`.
- Await the promise.
- Pipe the child's `stdout` and `stderr` straight to ours (raw — bypasses display helpers).
- If `failed`: `display.context("OpenClaw import encountered an issue — check daemon logs.")`.
- Else if `importedCount > 0`: `installedCount += importedCount` and `display.success("Imported <n> OpenClaw agent(s).")`.
- `display.blank()`.

### 7.H: Add locally-stored agents to project p-tags

(`src/commands/onboard.ts:1112-1119`)

- `allStoredAgents = await agentStorage.getAllStoredAgents()`.
- For each agent without an `eventId`: `selectedAgentPubkeys.add(new NDKPrivateKeySigner(agent.nsec).pubkey)`.

### 7.I: Publish kind 31933 project event

(`src/commands/onboard.ts:1124-1148`)

Try block:
1. `signer = new NDKPrivateKeySigner(userPrivateKeyHex)`. Set `ndk.signer = signer` and `relayAuthDefaultPolicy = signIn({ndk, signer})`.
2. `project = new NDKProject(ndk)`.
   - `project.dTag = "meta"`.
   - `project.title = "Meta"`.
   - `project.tags.push(["client", "tenex-setup"])`.
   - For each `pubkey` in `selectedAgentPubkeys`: `project.tags.push(["p", pubkey])`.
3. `await project.sign()`.
4. `await project.publish()`.
5. `display.success("Published \"Meta\" project to relays.")`.
6. `await new Promise(r => setTimeout(r, 2000))` — propagation grace period.

Catch: `display.context("Could not publish project event (<error.message>) — the daemon will pick it up later.")`.

### 7.J: Final success messaging

(`src/commands/onboard.ts:1150-1157`)

- If `installedCount > 0`: `display.blank(); display.success("<n> agent(s) ready.");`.
- `display.blank()`.
- `display.success("Created \"Meta\" project.")`.
- `return true` (used to set `metaProjectCreated`).

---

## 4. Final summary & daemon launch

(`src/commands/onboard.ts:1485-1513`)

### 4.A: jsonMode output

```json
{
  "npub": "<npub>",
  "pubkey": "<hex pubkey>",
  "projectsBase": "<absolute projects path>",
  "relays": ["<relay url>"],
  "nsec": "<nsec>"            // only when generatedNsec set (Create-new path)
}
```

Printed via `console.log(JSON.stringify(output, null, 2))`. Then `process.exit(0)` (`src/commands/onboard.ts:1513`).

### 4.B: Non-jsonMode (`!jsonMode`)

(`src/commands/onboard.ts:1496-1510`)

```
<blank>
  ▲ Setup complete!         (display.setupComplete)
<blank>
    Identity:       <npub>
    nsec:           <nsec>            // only when generatedNsec set
    Projects:       <absolute path>
    Relays:         <comma-joined relay urls>
<blank>
  <dim "<launch-context>">
<blank>
```

`launch-context` text:
- If `metaProjectCreated`: `"Starting daemon with auto-boot for the Meta project..."` (`src/commands/onboard.ts:1505-1507`).
- Else: `"Starting daemon..."`.

### 4.C: `startDaemonFromSetup(metaProjectCreated)` (`src/commands/onboard.ts:1166-1190`)

- `entrypoint = process.argv[1]`. If falsy: throw `"Cannot determine TENEX CLI entrypoint for daemon startup"`.
- `isWrapperEntrypoint = entrypoint.endsWith("wrapper.ts") || entrypoint.endsWith("wrapper.js")`.
- `daemonArgs`:
  - If wrapper entrypoint: `metaProjectCreated ? ["--boot", "meta"] : []`.
  - Otherwise: `["daemon", ...(metaProjectCreated ? ["--boot", "meta"] : [])]`.
- Spawn: `spawn(process.argv[0], [entrypoint, ...daemonArgs], { stdio: "inherit", env: process.env })`.
- Awaits child close; resolves to `code ?? 1`. On `error` event the spawn promise rejects (will be caught by outer try as a failure with red `"Setup failed: ..."`).
- `process.exit(exitCode)`.

(After this call control never returns; `process.exit(0)` immediately after is unreachable.)

---

## 5. File side effects

| Action | Path | Source |
|--------|------|--------|
| Read telemetry config | `~/.tenex/config.json` (or `$TENEX_BASE_DIR/config.json`) | `src/telemetry/cli-bootstrap.ts:14, 17` |
| Ensure global config dir | `<globalPath>` (= `~/.tenex` by default) | `src/commands/onboard.ts:1198` |
| Read existing TENEX config | `<globalPath>/config.json` (via `config.loadTenexConfig`) | `src/commands/onboard.ts:1199` |
| Save TENEX config | `<globalPath>/config.json` | `src/commands/onboard.ts:1420` |
| Ensure projects dir | `<projectsBase>` (default `~/tenex`, resolved absolute) | `src/commands/onboard.ts:1421` |
| Read providers | `<globalPath>/providers.json` (via `loadTenexProviders`) | `src/commands/onboard.ts:1424` |
| Save providers | `<globalPath>/providers.json` | `src/commands/onboard.ts:1441` |
| Read OpenClaw config | `~/.openclaw/openclaw.json` (or sibling state dir / config name) | `src/commands/agent/import/openclaw-reader.ts:27, 41-66` |
| Read OpenClaw credentials | `<openClawStateDir>/agents/main/agent/auth-profiles.json` | `src/commands/agent/import/openclaw-reader.ts:144` |
| Read OpenClaw workspace | `<workspace>/{SOUL.md, IDENTITY.md, AGENTS.md, USER.md}` | `src/commands/agent/import/openclaw-reader.ts:80-87` |
| Load LLM configs | `<globalPath>/llms.json` (via `config.loadTenexLLMs`) | `src/commands/onboard.ts:230, 505` |
| Save LLM configs | `<globalPath>/llms.json` | `src/commands/onboard.ts:242, 379, 551` |
| Read embedding config | `<globalPath>/embeddings.json` (`loadEmbeddingConfiguration`) | `src/commands/onboard.ts:389` |
| Save embedding config | `<globalPath>/embeddings.json` (`saveEmbeddingConfiguration`) | `src/commands/onboard.ts:429, 490` |
| Agent storage initialize | LMDB-style local store rooted under `<globalPath>` (via `agentStorage.initialize`) | `src/commands/onboard.ts:851` |
| Spawn child for OpenClaw import | `<argv0> <argv1> agent import openclaw --slugs <csv>` | `src/commands/onboard.ts:918` |
| Spawn daemon | `<argv0> <entrypoint> [daemon] [--boot meta]` | `src/commands/onboard.ts:1179` |

---

## 6. Network calls

| Call | Trigger | Source |
|------|---------|--------|
| HTTP GET `http://localhost:11434/api/tags` (timeout 2 s) | Auto-detection of Ollama | `src/commands/onboard.ts:577` |
| Connect to relay (NDK) | After Step 2 relay chosen; subscribes to kinds `[NDKAgentDefinition.kinds, 34199]` with NIP-42 AUTH if signer present | `src/commands/onboard.ts:705-749, 1384-1388` |
| Publish kind 0 profile event | `name`/`picture` after Step 2 (when new identity created) | `src/commands/onboard.ts:1399-1408` |
| Publish kind 31933 NDKProject event | "Meta" project at Step 7 finalize | `src/commands/onboard.ts:1129-1140` |
| Fetch dicebear avatar URL | URL only stored in profile event; not fetched by CLI | `src/commands/onboard.ts:1397` |
| Fetch missing agent definition events | Whenever a kind-34199 team event references unfetched agent ids | `src/commands/onboard.ts:727-736` |

---

## 7. Color usage (every `chalk.*` call in the onboard flow)

Sources span `src/commands/onboard.ts`, `src/utils/cli-theme.ts`, `src/commands/config/display.ts`, and the prompts in `src/llm/utils/`.

### 7.1 Palette

| Name | Code | Where applied |
|------|------|---------------|
| Amber `#FFC107` | `chalk.hex("#FFC107")` | `inquirerTheme.prefix.idle` (`?`), `inquirerTheme.icon.cursor` (`❯`), `theme.style.highlight`, `theme.style.answer`, custom prompt cursors `›`, and amber-dim recommendation hint (`src/utils/cli-theme.ts:3-13`, `src/commands/onboard.ts:319, 330`, `src/llm/utils/provider-select-prompt.ts:76`) |
| Amber xterm-256 (214, "ACCENT") | `chalk.ansi256(214)` | Step number/title, step rule (dim), step hints (`→`), Done label, OpenClaw agent ids, welcome row 2 dots | `src/commands/config/display.ts:4, 22-25, 41, 48, 121-123, 67`, `src/commands/onboard.ts:902` |
| Sky blue xterm-256 (117, "INFO") | `chalk.ansi256(117)` | Summary line label, team agent bullet `●` | `src/commands/config/display.ts:5, 100`, `src/commands/onboard.ts:1080` |
| Bright green xterm-256 (114, "SELECTED") | `chalk.ansi256(114)` | `[✓]` checkbox in provider list | `src/commands/config/display.ts:6, 108` |
| Logo dark xterm-256 (130) | `chalk.ansi256(130)` | Welcome row 4 dots | `src/commands/config/display.ts:9, 69` |
| Logo mid xterm-256 (172) | `chalk.ansi256(172)` | Welcome row 3 dots | `src/commands/config/display.ts:10, 68` |
| Logo bright xterm-256 (220) | `chalk.ansi256(220)` | Welcome row 1 dots | `src/commands/config/display.ts:11, 66` |
| Logo glow xterm-256 (222) | `chalk.ansi256(222)` | Welcome row 0 dot | `src/commands/config/display.ts:12, 65` |
| xterm-256 (240) | `chalk.ansi256(240)` | Inactive role recommendation in role menu | `src/commands/onboard.ts:331` |
| Default green | `chalk.green` / `chalk.green.bold` | `display.success` checkmark `✓`, `inquirerTheme.prefix.done` | `src/commands/config/display.ts:41`, `src/utils/cli-theme.ts:7` |
| Default red | `chalk.red` | Relay validation error display, "Setup failed: …", "Failed to generate daemon key" | `src/commands/onboard.ts:116, 1327, 1547` |
| Gray | `chalk.gray` | Description text in relay choices, typed URL preview, key-count `[N keys]` | `src/commands/onboard.ts:107, 112` (relay), `src/llm/utils/provider-select-prompt.ts:67` |
| Default `chalk.dim` | mostly | Step rule body, context lines, hint suffix, bracket text `[ ]`, Done label override, separators, masked-key labels, prompt help, "(optional)" label | `src/commands/config/display.ts:24, 33, 81, 115`, `src/llm/utils/provider-select-prompt.ts:67, 239, 268-269, 274, 277, 285`, `src/llm/utils/provider-setup.ts:88, 105` |
| Default `chalk.bold` | mostly | Welcome tagline (row 3), provider keys-view title, role label, helper key bindings | `src/commands/config/display.ts:80`, `src/llm/utils/provider-select-prompt.ts:261`, `src/commands/onboard.ts:332, 341, 343` |

### 7.2 Specific uses in onboard.ts

| Line | Call | Purpose |
|------|------|---------|
| `116` | `chalk.red(error)` | Relay prompt validation error |
| `107` | `chalk.gray(typedUrl)` | Active relay-input preview |
| `112` | `chalk.gray(item.description)` | Relay choice description |
| `272` | `chalk.dim("(multi-modal, <n> variants)")` | Role-menu config choice meta |
| `282` | `chalk.dim("<ctx>K · $cost/M in")` | Role-menu config choice meta |
| `319` | `chalk.hex("#FFC107")("›")` | Role-menu cursor |
| `330` | `chalk.hex("#FFC107").dim(rec)` | Active role recommendation |
| `331` | `chalk.ansi256(240)(rec)` | Inactive role recommendation |
| `332` | `chalk.bold(label)` + `chalk.dim(assigned)` | Role row text |
| `336` | `"─".repeat(40)` (no color) | Role menu separator |
| `341-343` | `chalk.bold` keys + `chalk.dim` help | Role menu help line |
| `902` | `chalk.ansi256(214)(a.id)` | OpenClaw agent id in checkbox list |
| `1080` | `chalk.ansi256(117)("●")` + `chalk.bold(name)` + `chalk.dim(role)` | Team-detail listing |
| `1327` | `chalk.red("Failed to generate daemon key")` | Daemon key fatal |
| `1547` | `chalk.red("Setup failed: <error>")` | Onboard catch-all |

---

## 8. Error handling matrix

| Where | Caught? | Behavior |
|-------|---------|----------|
| Top-level `main()` rejection | `src/index.ts:100-104` | `console.error("Fatal error during TENEX CLI initialization:", error); process.exit(1)` |
| Commander parse → help/version | `src/index.ts:82-89` | Shutdown telemetry; `process.exit(0)` |
| Commander parse → other error | `src/index.ts:90` | `handleCliError(error, "Fatal error in TENEX CLI")` (logs via logger; stack only when `DEBUG`; `process.exit(1)`) |
| Telemetry config JSON parse fail | `src/telemetry/cli-bootstrap.ts:35-38` | `console.warn("[TENEX] Warning: Failed to parse config at <path>: <message>")`; defaults used |
| `getCliVersion` package.json read | `src/index.ts:23-25` | Swallowed; falls through to `"0.0.0"` |
| `decodeToPubkey` invalid input | `src/commands/onboard.ts:131` | Throws `"Unsupported identifier type: <type>"` (or whatever `nip19.decode` throws) |
| `commandExists` failure | `src/commands/onboard.ts:566-568` | Resolves `false` |
| `ollamaReachable` failure | `src/commands/onboard.ts:579-581` | Catch returns `false` |
| OpenClaw config JSON parse | `src/commands/agent/import/openclaw-reader.ts:151-153` | Catch returns `[]` (no creds) |
| Profile event sign/publish | `src/commands/onboard.ts:1406-1408` | Both `.then`/`.catch` callbacks swallow errors silently |
| NDK `connect()` failure | `src/commands/onboard.ts:758` | Swallowed |
| Agent install during selection | `src/commands/onboard.ts:1052-1054, 1095-1097` | Catch prints `display.context("Failed to install \"<name>\": <message>")`; loop continues |
| Project publish | `src/commands/onboard.ts:1145-1148` | Catch prints `display.context("Could not publish project event (<message>) — the daemon will pick it up later.")` |
| OpenClaw import child process | `src/commands/onboard.ts:917-925` | Resolved with `failed: true` on err; later message via `display.context("OpenClaw import encountered an issue — check daemon logs.")` |
| `runOnboarding` outer try | `src/commands/onboard.ts:1542-1549` | `SIGINT`/`force closed` ⇒ `process.exit(0)`; otherwise `console.error(chalk.red("Setup failed: <error>"))` and `process.exit(1)` |
| Daemon spawn `error` event | `src/commands/onboard.ts:1185` | Promise rejects → onboard outer catch ⇒ red "Setup failed" |
| Daemon spawn `close` | `src/commands/onboard.ts:1186-1189` | `process.exit(child code ?? 1)` |

---

## 9. Step ↔ Output Cheat Sheet

| Step header line | Verbatim title | Conditional skip |
|------------------|----------------|-------------------|
| `1/7  Identity` | `Identity` | only when `!jsonMode` (else still runs but no banner) |
| `2/7  Communication` | `Communication` | only when `!jsonMode` |
| `3/7  AI Providers` | `AI Providers` | always shown |
| `4/7  Models` | `Models` | only if ≥1 provider configured |
| `5/7  Model Roles` | `Model Roles` | inside Models guard |
| `6/7  Embeddings` | `Embeddings` | inside Models guard |
| `7/7  Project & Agents` | `Project & Agents` | inside Models guard AND `userPrivateKeyHex` set (i.e. not `--pubkey`) |

(Note: source uses `totalSteps = 7` but seven banners; despite the comment at `src/commands/onboard.ts:1203` mentioning 8 phases, only 7 numeric step headers are printed.)

---

## 10. Inquirer theme reference

`inquirerTheme` (`src/utils/cli-theme.ts:6-13`):

```ts
{
  prefix: { idle: amber("?"), done: chalk.green("✓") },
  icon:   { cursor: amber("❯") },
  style:  {
    highlight: (text) => amber(text),
    answer:    (text) => amber(text),
  },
}
```

`amber = chalk.hex("#FFC107")` (`src/utils/cli-theme.ts:3`).

This theme is passed to every `inquirer.prompt(...)` call in onboard and to the custom `relayPrompt` / `roleMenuPrompt` / `providerSelectPrompt` (`src/commands/onboard.ts:46-48, 297-299, 1232, 1250, 1294, 374, 425, 451, 466, 484, 906, 943, 1013, 1033`).

---

## 11. Misc constants and literal strings (for reproduction)

| Literal | Location |
|---------|----------|
| Step rule width | 45 (`src/commands/config/display.ts:21`) |
| Role menu separator width | 40 (`src/commands/onboard.ts:336`) |
| Provider keys-view rule width | 30 (`src/llm/utils/provider-select-prompt.ts:77`) |
| Amber hex (theme) | `#FFC107` (`src/utils/cli-theme.ts:3`) |
| Avatar host base | `https://api.dicebear.com/7.x/<style>/png?seed=<pubkey>` (`src/commands/onboard.ts:1397`) |
| Avatar style families | `lorelei, miniavs, dylan, pixel-art, rings, avataaars` (`src/commands/onboard.ts:1394`) |
| Welcome lines | 5 lines, 15 chars wide each (`src/commands/config/display.ts:64-70`) |
| `TEAM_KIND` | 34199 (`src/commands/onboard.ts:714, 782`) |
| Kind 0 used for profile | `src/commands/onboard.ts:1400` |
| Kind 31933 used for project | implicit via `NDKProject` (TENEX project event) |
| OpenClaw config filename candidates | `openclaw.json, clawdbot.json, moldbot.json, moltbot.json` (`src/commands/agent/import/openclaw-reader.ts:27`) |
| OpenClaw state dir candidates | `~/.openclaw, ~/.clawdbot, ~/.moldbot, ~/.moltbot` (env override `OPENCLAW_STATE_DIR`) (`src/commands/agent/import/openclaw-reader.ts:43-66`) |
| Daemon spawn boot args | `["--boot", "meta"]` only when `metaProjectCreated` (`src/commands/onboard.ts:1175-1177`) |
| Default projects base | `os.homedir() + "/tenex"` (`src/commands/onboard.ts:1334`) |
| Default global path | `~/.tenex` (or `$TENEX_BASE_DIR`) — same convention as telemetry config (`src/telemetry/cli-bootstrap.ts:13`) |
| OpenClaw default model fallback | `anthropic/claude-sonnet-4-6` (`src/commands/agent/import/openclaw-reader.ts:111, 125`) |
| Models.dev: summarization context threshold | 100000 (`src/commands/onboard.ts:206`) |
| Models.dev: promptCompilation context threshold | 100000 (`src/commands/onboard.ts:214`) |
| Models.dev: contextDiscovery context thresholds | 32000 then 8000 (`src/commands/onboard.ts:217`) |
| Initial-sync wait | 3000 ms (`src/commands/onboard.ts:761-771`) |
| Project publish propagation wait | 2000 ms (`src/commands/onboard.ts:1144`) |
| Telemetry shutdown timeout | 1000 ms (`src/telemetry/cli-bootstrap.ts:50, 54`) |
| Ollama detection timeout | 2000 ms (`src/commands/onboard.ts:577`) |

---

## 12. Step numbering edge cases

- The comment at `src/commands/onboard.ts:1203` lists "Identity, Communication, Providers, Models, Roles, Embeddings, Image Gen, Project & Agents" (8 items) but `totalSteps = 7` (`src/commands/onboard.ts:1204`). There is no Image-Gen step in the implementation. Numbered banners use 1..7 as listed in §9.
- The `LLMConfigEditor.showMainMenu` invokes `display.step(0, 0, "LLM Configuration")` (`src/llm/LLMConfigEditor.ts:186`) — the "0/0" header is shown on every redraw inside that menu. Reproduce verbatim.

---

## 13. Inquirer prompt summary (every prompt asked during onboard)

| # | Screen | Library | Type | Message | Default |
|---|--------|---------|------|---------|---------|
| 1 | 1.A | `inquirer` | `select` | `How do you want to set up your identity?` | first item |
| 2 | 1.B | `inquirer` | `input` | `Choose a username (this is how agents and other nostr users will see you)` | random `<adj>-<noun>` |
| 3 | 1.D | `inquirer` | `password` | `Paste your nsec (hidden)` | — |
| 4 | 2.B | custom (`relayPrompt`) | list+input | `Relay` | first item (Local relay if `--local-relay-url`, else community relay) |
| 5 | 3.D | custom (`providerSelectPrompt`) | list | `Configure providers:` | top of list |
| 6 | 3.E (Ollama) | `@inquirer/input` | input | `<displayName> URL:` | `http://localhost:11434` |
| 7 | 3.E (other) | `@inquirer/password` | password | `<displayName> API key:` | — |
| 8 | 3.E label | `@inquirer/input` | input | `<displayName> label (optional):` | — |
| 9 | 4.C | `selectWithFooter` | list | `Configurations` | first item |
| 10 | 5.D.4 | custom (`roleMenuPrompt`) | list | `Model roles` | first item |
| 11 | 5.D.5 | `inquirer` | `select` | `<role.label>:` | current value |
| 12 | 6.B | `inquirer` | `select` | `Embedding model` | `accept` |
| 13 | 6.C (manual) | `inquirer` | `select` | `Embedding provider` | recommended provider |
| 14 | 6.D | `inquirer` | `select` | `Local embedding model` | `Xenova/all-MiniLM-L6-v2` |
| 15 | 6.E | `inquirer` | `select` | `Embedding model` | — |
| 16 | 7.C | `inquirer` | `checkbox` | `Import your OpenClaw agents? (space to toggle, enter to confirm)` | all checked |
| 17 | 7.D | `inquirer` | `confirm` | `Create a Meta project?` | `true` |
| 18 | 7.F | `inquirer` | `select` | `Add agents` | first team or `__individual__` |
| 19 | 7.F (individual) | `inquirer` | `checkbox` | `Select agents (space to toggle, enter to confirm)` | none checked |

All prompts use `theme: inquirerTheme` (amber accents).

---

## 14. Validation summary

| Field | Validator | Errors |
|-------|-----------|--------|
| Username | `input.trim()` truthy and ≥ 2 chars | `Username is required` / `Username must be at least 2 characters` (`src/commands/onboard.ts:1244-1248`) |
| nsec | non-empty trimmed; `nip19.decode(...).type === "nsec"` | `nsec is required` / `Invalid nsec` / `Invalid nsec format` (`src/commands/onboard.ts:1284-1293`) |
| Relay URL | `new URL(url)`; protocol ws/wss; hostname contains `.` | `Invalid URL format` / `URL must use ws:// or wss:// protocol` / `Enter a relay hostname` (`src/commands/onboard.ts:1363-1376`) |
| Pubkey CLI | hex-64 OR `npub` OR `nprofile` | `Unsupported identifier type: <t>` (`src/commands/onboard.ts:131`) |

No other interactive validators in the onboard flow.
