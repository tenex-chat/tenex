# 02 — `tenex config` Top-Level Menu and Navigation

Scope: the **top-level** menu rendered by `tenex config` (no subcommand). Submenus
(LLM editor, providers, relays, MCP, whitelist/identity, etc.) are documented by other
agents — this spec covers entry, the menu hierarchy, navigation, state lifetime, and
the persistence model that frames every submenu.

All references are line-precise to the TypeScript source. Porter must not need to read
`.ts`; every observable behavior is reproduced here verbatim.

---

## 1. Entry Points and Wiring

### 1.1 CLI registration

The `config` command is registered on the root `Command` instance built in
`src/index.ts`.

- Imported dynamically after telemetry init: `src/index.ts:40`
  (`{ configCommand }` from `@/commands/config/index`).
- Attached to the root program: `src/index.ts:67`
  (`program.addCommand(configCommand);`).
- Root program uses `exitOverride()` so commander throws instead of `process.exit`:
  `src/index.ts:73`.
- `program.parseAsync(process.argv)` drives dispatch: `src/index.ts:78`.

### 1.2 The `config` command object

Defined at `src/commands/config/index.ts:127–154`.

- Name: `"config"` — `src/commands/config/index.ts:127`.
- Description: `"Configure TENEX backend settings"` — `src/commands/config/index.ts:128`.
- `.action(async () => { … })` — runs the interactive menu when no subcommand is
  given: `src/commands/config/index.ts:129–138`.
- Each menu entry is **also** registered as a top-level subcommand of `config` via
  chained `.addCommand(...)` calls (see §2.4): `src/commands/config/index.ts:139–154`.

### 1.3 Two ways to enter

1. **Interactive top-level menu** — invoked by running `tenex config` with no
   arguments. Hits the `.action` at `src/commands/config/index.ts:129`, which calls
   `runConfigMenu()` (`src/commands/config/index.ts:131`).
2. **Direct subcommand** — `tenex config <name>` (e.g. `tenex config providers`,
   `tenex config llm`). These bypass the menu and go straight into the submenu's own
   `Command` action. The full subcommand list is at
   `src/commands/config/index.ts:139–154`.

The Rust port must preserve **both** paths: a `config` command that opens a menu when
called bare, and N flat subcommands of `config` that map 1:1 to the menu entries.

---

## 2. Menu Hierarchy

### 2.1 Source: the `MENU_SECTIONS` table

The complete top-level menu is a static array `MENU_SECTIONS: MenuSection[]` declared
at `src/commands/config/index.ts:33–75`. Section/entry shape:
`src/commands/config/index.ts:22–31`:

```
MenuEntry  = { label: string; description: string; command: Command }
MenuSection = { header: string; entries: MenuEntry[] }
```

### 2.2 Verbatim hierarchy

Sections are rendered in this order. Within each section, entries are rendered in this
order. Strings shown are the **exact** `label` and `description` as they appear in
`MENU_SECTIONS`.

```
config (top-level menu — message "Settings")
│
├── ── AI ──                                          (separator, header = "AI")
│   ├─ Providers      — API keys and connections     → providersCommand        [other agent: providers]
│   ├─ LLMs           — Model configurations         → llmCommand              [other agent: LLM]
│   ├─ Roles          — Which model handles what task→ rolesCommand            [other agent: LLM/roles]
│   └─ Embeddings     — Text embedding model         → embedCommand            [other agent: LLM/embed]
│
├── ── Agents ──                                      (separator, header = "Agents")
│   ├─ Escalation     — Route ask() through an agent first  → escalationCommand
│   ├─ Intervention   — Auto-review when you're idle        → interventionCommand
│   └─ Telegram       — Agent bot transport and global DM access → telegramCommand
│
├── ── Network ──                                     (separator, header = "Network")
│   └─ Relays         — Nostr relay connections      → relaysCommand           [other agent: relays]
│
├── ── Conversations ──                               (separator, header = "Conversations")
│   ├─ Summarization  — Auto-summary timing          → summarizationCommand
│   └─ Context        — Context management settings  → contextManagementCommand
│
├── ── Advanced ──                                    (separator, header = "Advanced")
│   ├─ Identity       — Authorized pubkeys           → identityCommand         [other agent: whitelist/identity]
│   ├─ System Prompt  — Global prompt for all projects → systemPromptCommand
│   ├─ Paths          — File paths and storage       → pathsCommand
│   ├─ NIP-46         — Remote signing               → nip46Command
│   ├─ Logging        — Log level and file path      → loggingCommand
│   └─ Telemetry      — OpenTelemetry tracing        → telemetryCommand
│
├── (blank Separator)
└── Back                                              (sentinel value -1)
```

Source spans:

| Section header | Entries (line span in `index.ts`) |
| --- | --- |
| `"AI"` | `34`–`42` (4 entries, `36–41`) |
| `"Agents"` | `43`–`50` (3 entries, `45–49`) |
| `"Network"` | `51`–`56` (1 entry, `53–55`) |
| `"Conversations"` | `57`–`63` (2 entries, `59–62`) |
| `"Advanced"` | `64`–`74` (6 entries, `66–73`) |

Total = **16 selectable entries + Back**.

### 2.3 Submenu coverage map (other agents own these)

| Top-level entry | Owner of detailed spec |
| --- | --- |
| Providers | other agent — providers / API key submenu |
| LLMs | other agent — LLM editor (`LLMConfigEditor.showMainMenu`) |
| Roles | other agent — LLM roles |
| Embeddings | other agent — embed submenu |
| Relays | other agent — relays submenu |
| Identity | other agent — whitelist / identity submenu |
| MCP servers | other agent — MCP submenu (note: **not** in the top-level menu; reached via project-level commands, not from `tenex config`) |
| Escalation, Intervention, Telegram, Summarization, Context, System Prompt, Paths, NIP-46, Logging, Telemetry | other agents — each owns its own submenu spec |

This document is exhaustive only for the **top-level** menu shell.

Note: `MCP_CONFIG_FILE = "mcp.json"` is loaded/saved by `ConfigService`
(`src/services/ConfigService.ts:247–261`, `291–297`) but no `mcp` entry exists in
`MENU_SECTIONS`. The top-level config menu does **not** expose MCP editing.

### 2.4 Subcommands also registered at the `config` level

The same 16 commands are attached as flat subcommands of `tenex config` so they can be
invoked non-interactively. Order at `src/commands/config/index.ts:139–154`:

```
providers, llm, roles, embed,
escalation, intervention,
relays,
summarization, context-management, telegram,
identity, system-prompt, paths, nip46, logging, telemetry
```

The Rust port must mirror these 16 subcommand names. (Each command's exact name string
is set in its own `new Command("<name>")` call — examples:
`providersCommand` = `"providers"` at `src/commands/config/providers.ts:7`,
`llmCommand` = `"llm"` at `src/commands/config/llm.ts:9`,
`relaysCommand` = `"relays"` at `src/commands/config/relays.ts:9`,
`identityCommand` = `"identity"` at `src/commands/config/identity.ts:7`,
`pathsCommand` = `"paths"` at `src/commands/config/paths.ts:8`.)

---

## 3. Top-Level Menu Rendering

### 3.1 Loop shape

The menu is a `while (true)` loop in `runConfigMenu()`
(`src/commands/config/index.ts:77–125`). Each iteration:

1. Prints a leading blank line — `console.log()` at line `79`.
2. Builds a fresh `choices[]` array and a parallel `commandMap[]` array — lines
   `81–97`.
3. Appends a blank `Separator` and the `Back` entry — lines `99–100`.
4. Awaits an `inquirer` `select` prompt — lines `102–110`.
5. If the user picks `Back` (`-1`), returns from the function — line `112`.
6. Otherwise, looks up the command in `commandMap`, prints a blank line, and runs
   `cmd.parseAsync([], { from: "user" })` — lines `114–118`. After the submenu
   resolves, the `while` loops back and the menu is re-rendered from scratch.

### 3.2 Choice array construction (exact)

For each section in `MENU_SECTIONS` (line `85`):

- A `new inquirer.Separator(chalk.dim("── " + section.header + " ──"))` is pushed.
  Source: `src/commands/config/index.ts:86`. The header text is wrapped in `chalk.dim`
  (ANSI dim attribute, no color change).
- For every entry in the section (lines `88–96`):
  - `label = entry.label.padEnd(16)` — pads the label to 16 visible characters with
    trailing spaces (line `89`).
  - The choice's display `name` is the literal string
    `"  " + label + "— " + entry.description` (line `91`). Note the leading
    **two spaces** of indent and the em-dash-style separator `"— "` (`U+2014` followed
    by one space).
  - `value = idx` (a 0-based index into `commandMap`); `idx++` after each entry
    (lines `92, 95`).
  - The `entry.command` is pushed onto `commandMap` at the same index (line `94`).

After all sections (line `99–100`):

- A bare `new inquirer.Separator()` (default visual: a thin rule) is pushed.
- Final selectable choice: `{ name: chalk.dim("  Back"), value: -1 }`.

### 3.3 Visible labels (after `padEnd(16)`)

Exact rendered choice strings, including the leading two spaces and trailing spaces
inside the 16-char label slot:

```
  Providers       — API keys and connections
  LLMs            — Model configurations
  Roles           — Which model handles what task
  Embeddings      — Text embedding model
  Escalation      — Route ask() through an agent first
  Intervention    — Auto-review when you're idle
  Telegram        — Agent bot transport and global DM access
  Relays          — Nostr relay connections
  Summarization   — Auto-summary timing
  Context         — Context management settings
  Identity        — Authorized pubkeys
  System Prompt   — Global prompt for all projects
  Paths           — File paths and storage
  NIP-46          — Remote signing
  Logging         — Log level and file path
  Telemetry       — OpenTelemetry tracing
  Back
```

(The labels `"Providers"` (9), `"LLMs"` (4), `"Roles"` (5), `"Embeddings"` (10),
`"Escalation"` (10), `"Intervention"` (12), `"Telegram"` (8), `"Relays"` (6),
`"Summarization"` (13), `"Context"` (7), `"Identity"` (8), `"System Prompt"` (13),
`"Paths"` (5), `"NIP-46"` (6), `"Logging"` (7), `"Telemetry"` (9) are each padded
right with spaces to 16 chars before the `— `.)

### 3.4 Section headers (separator strings)

```
── AI ──
── Agents ──
── Network ──
── Conversations ──
── Advanced ──
```

Each is wrapped in `chalk.dim(...)` only — no color tint.

### 3.5 Default highlighted item

`inquirer`'s `select` prompt with `loop: false` is used
(`src/commands/config/index.ts:103–110`). Because the first choice is a
`Separator` (non-selectable), `inquirer` advances the cursor to the **first
selectable** entry, which is `Providers`. Re-entering the loop after a submenu starts
again at the first selectable entry (no `default:` is passed).

Confirm:
- Prompt type: `"select"` — line `104`.
- Prompt name: `"selection"` — line `105`.
- Prompt message: `"Settings"` — line `106`.
- `loop: false` — line `109` (so up-arrow at top stays at top instead of wrapping).
- `theme: inquirerTheme` — line `108`.

### 3.6 Theme (colors and glyphs from `inquirer.prompt`)

`inquirerTheme` is defined at `src/utils/cli-theme.ts:6–13`:

- `prefix.idle` = `chalk.hex("#FFC107")("?")` — amber `?` shown to the left of the
  message while waiting (`src/utils/cli-theme.ts:7`).
- `prefix.done` = `chalk.green("✓")` — green check after submission
  (`src/utils/cli-theme.ts:7`).
- `icon.cursor` = `chalk.hex("#FFC107")("❯")` — amber `❯` on the highlighted row
  (`src/utils/cli-theme.ts:8`).
- `style.highlight(text)` = `chalk.hex("#FFC107")(text)` — highlighted choice text in
  amber `#FFC107` (`src/utils/cli-theme.ts:10`).
- `style.answer(text)` = `chalk.hex("#FFC107")(text)` — chosen answer redisplayed in
  amber `#FFC107` (`src/utils/cli-theme.ts:11`).

The amber color `#FFC107` is the canonical TENEX accent. Ansi-256 fallback `214`
appears in `display.ts` (`src/commands/config/display.ts:4`) — both must render as
amber.

### 3.7 Layout per render

Per iteration of the menu loop, the visible block is:

```
<blank line>                       ← console.log() at index.ts:79
? Settings (Use arrow keys)
❯   Providers       — API keys and connections        ← amber cursor + amber highlight
    LLMs            — Model configurations
    Roles           — Which model handles what task
    Embeddings      — Text embedding model
── Agents ──                                          (dim)
    Escalation      — Route ask() through an agent first
    …
── Network ──                                          (dim)
    …
── Conversations ──                                    (dim)
    …
── Advanced ──                                         (dim)
    …
<inquirer thin separator>
    Back                                              (dim)
```

The leading `── AI ──` separator is the **first** visible row beneath the prompt
message (it is pushed before the first entry — line `86` in the loop iteration where
section header is `"AI"`).

---

## 4. Navigation Behavior

### 4.1 Within the top-level menu

| Input | Effect | Source |
| --- | --- | --- |
| `↑` / `↓` | Move highlight, skipping `Separator` rows. Does not wrap because `loop: false`. | `src/commands/config/index.ts:109` |
| `Enter` on an entry | Resolves the prompt with that `value`. The matching `Command` is awaited via `cmd.parseAsync([], { from: "user" })`. After it returns, the loop redraws the menu. | `src/commands/config/index.ts:103–118` |
| `Enter` on `Back` (value `-1`) | `runConfigMenu` returns. Control unwinds through the `.action` (`src/commands/config/index.ts:129`) and the CLI exits cleanly. | `src/commands/config/index.ts:112` |
| `Ctrl-C` (SIGINT) | Inquirer rejects the prompt with an Error whose message contains `"SIGINT"` or `"force closed"`. Caught at `src/commands/config/index.ts:119–123`: `runConfigMenu` returns silently. The outer `.action` catch (`133–134`) re-checks the same substrings and also returns silently. **No error is printed.** Process exits 0. | `src/commands/config/index.ts:119–123, 133–137` |
| `Esc` | Not handled specially. Inquirer's default for `select` is to ignore it (no resolve, no reject). The cursor stays where it is. To leave, the user must use `Back` or `Ctrl-C`. | n/a — no `keypress`/`escape` handler in `runConfigMenu` |

There is **no** "Quit" string anywhere in the top-level menu — the only documented
exit affordances are `Back` and `Ctrl-C`. (The literal token `"Quit"` does not appear
in `src/commands/config/index.ts`.)

### 4.2 Inside a submenu

`cmd.parseAsync([], { from: "user" })` is awaited at
`src/commands/config/index.ts:117`. Each submenu manages its own loop and its own
`Back` / Ctrl-C behavior. When that promise resolves (cleanly or via the submenu's
own SIGINT swallow), the `while` loop in `runConfigMenu` immediately re-renders the
top-level menu (line `78`). State is reloaded by re-running submenu logic on next
entry — see §5.

If a submenu **throws** an error, it propagates out of `cmd.parseAsync` into the
top-level `try/catch` (`src/commands/config/index.ts:102–123`):

- If the error message includes `"SIGINT"` or `"force closed"`, the menu exits
  silently (line `121`).
- Otherwise the error is **rethrown** (line `122`), bubbling to the outer `.action`
  handler (`src/commands/config/index.ts:130–137`) which prints
  `❌ Configuration error: <error>` in red and sets `process.exitCode = 1`
  (lines `135–136`).

### 4.3 Direct subcommand invocation (`tenex config <x>`)

When the user runs `tenex config providers` (or any of the 16 subcommands) directly,
control bypasses `runConfigMenu()` entirely: commander dispatches to the
subcommand's own `.action`, the action runs once, returns, and the CLI exits. There
is no menu loop, no `Back`, and no re-render. SIGINT handling and persistence remain
identical to interactive use because each submenu owns those concerns.

---

## 5. State at Entry and Between Menu Returns

### 5.1 The top-level menu loads nothing

Crucially, `runConfigMenu` itself does **not** call `config.loadConfig()` or any
`loadTenex*` method. The top-level menu only owns the static `MENU_SECTIONS` array
(`src/commands/config/index.ts:33–75`). It maintains **no in-memory configuration
state of its own**.

This means:

- There is no "dirty" buffer at the top level.
- There is no top-level "Save" action. There is nothing to save.
- Returning from a submenu does not require re-reading config at the top level.

### 5.2 Each submenu is responsible for its own load + save

Every submenu's `.action(...)` re-loads from disk on entry. Examples (each under
`src/commands/config/`):

- `providers.ts:14` — `await config.loadTenexProviders(globalPath)`.
- `llm.ts:23` — `await config.loadTenexProviders(globalConfigDir)`.
- `relays.ts:14` — `await configService.loadTenexConfig(globalPath)`.
- `identity.ts:12` — `await configService.loadTenexConfig(globalPath)`.
- `paths.ts:12` — `await config.loadTenexConfig(globalPath)`.

Because `ConfigService`'s in-process cache has a **5-second TTL**
(`src/services/ConfigService.ts:982–983`), repeated re-entry within a few seconds may
return cached data; longer pauses re-read from disk. The submenu therefore always
sees current on-disk state (subject to the 5s cache window).

### 5.3 Shared `ConfigService` singleton

The instance `config` exported at `src/services/ConfigService.ts:1035` is a shared
singleton. Submenu saves go through it (`saveGlobalConfig`, `saveGlobalLLMs`,
`saveGlobalProviders`, `saveGlobalMCP` — `src/services/ConfigService.ts:722–744`),
which:

- ensures `~/.tenex` exists before writing (`ensureDirectory`, lines `724`, `730`,
  `736`, `742`);
- validates against the corresponding Zod schema before writing
  (`src/services/ConfigService.ts:957–958`);
- writes the JSON via `writeJsonFile` (`src/services/ConfigService.ts:961`);
- updates the in-process cache (`src/services/ConfigService.ts:964`).

Saves to `providers.json` additionally:

- replace `loadedConfig.providers` if `basePath === globalPath`
  (`src/services/ConfigService.ts:307–311`);
- run `syncProvidersRuntime(...)` to push the new credentials into
  `llmServiceFactory` (`src/services/ConfigService.ts:870–890`);
- ensure the `providers.json` file-watcher is active
  (`src/services/ConfigService.ts:762–781`).

The top-level menu does **not** trigger any of these — submenus do, on their own
"save" affordances.

### 5.4 No state carried across submenu boundaries

Because the top-level menu re-enters each submenu via `cmd.parseAsync([], { from: "user" })`
(`src/commands/config/index.ts:117`), the submenu starts fresh every time. Any local
state inside a submenu (e.g. an unsaved buffer of new relay URLs) is lost the moment
that submenu's `.action` returns. There is no cross-submenu transactional model.

---

## 6. Persistence Model

### 6.1 No top-level commit

The top-level menu never writes a file. Changes made inside a submenu are committed
when **that submenu** decides to commit (typically immediately after each user
confirmation, via `saveGlobalConfig` / `saveGlobalLLMs` / `saveGlobalProviders` /
`saveGlobalMCP`).

### 6.2 Where each entry writes

| Top-level entry | Service file written | File on disk (relative to `~/.tenex/`) | Source of save call (one anchor; submenus may save more than once) |
| --- | --- | --- | --- |
| Providers | `saveGlobalProviders` | `providers.json` | `src/commands/config/providers.ts:17` |
| LLMs | `saveGlobalLLMs` (via `LLMConfigEditor`) | `llms.json` | `src/commands/config/llm.ts:32` (delegates to `LLMConfigEditor.showMainMenu`) |
| Roles | `saveGlobalLLMs` | `llms.json` | covered in roles submenu spec |
| Embeddings | `saveGlobalLLMs` (writes `embedding`/role keys) | `llms.json` | covered in embed submenu spec |
| Escalation | `saveGlobalConfig` | `config.json` | covered in escalation submenu spec |
| Intervention | `saveGlobalConfig` | `config.json` | covered in intervention submenu spec |
| Telegram | `saveGlobalConfig` (and provider/LLM as needed) | `config.json` (and `providers.json` if a Telegram bot token is added there) | covered in telegram submenu spec |
| Relays | `saveGlobalConfig` (relays/identityRelays fields) | `config.json` | `src/commands/config/relays.ts:14` (load) + saves inside the action |
| Summarization | `saveGlobalLLMs` (`summarization` key) | `llms.json` | covered in summarization submenu spec |
| Context | `saveGlobalConfig` (`contextManagement`/`contextDiscovery` fields) | `config.json` | covered in context submenu spec |
| Identity | `saveGlobalConfig` (`whitelistedPubkeys`, `whitelistedIdentities`) | `config.json` | covered in identity submenu spec |
| System Prompt | `saveGlobalConfig` | `config.json` | covered in system-prompt submenu spec |
| Paths | `saveGlobalConfig` (`backendName`, `projectsBase`, `blossomServerUrl`) | `config.json` | `src/commands/config/paths.ts:12` (load) + saves inside the action |
| NIP-46 | `saveGlobalConfig` | `config.json` | covered in nip46 submenu spec |
| Logging | `saveGlobalConfig` | `config.json` | covered in logging submenu spec |
| Telemetry | `saveGlobalConfig` (`telemetry.*` fields) | `config.json` | covered in telemetry submenu spec |

`mcp.json` is never written from any top-level config entry — the menu has no MCP
item (§2.3). Constants for these filenames:
`src/constants.ts:29–32` (`CONFIG_FILE = "config.json"`, `MCP_CONFIG_FILE = "mcp.json"`,
`LLMS_FILE = "llms.json"`, `PROVIDERS_FILE = "providers.json"`).

### 6.3 Save timing

Saves are **immediate per submenu interaction** — every submenu calls
`config.saveGlobal*(...)` synchronously when the user confirms a change. There is
**no batching at the top level** and **no "Save and exit" prompt**. The submenu spec
documents the exact save points; from the top-level perspective the rule is:
"a submenu may have written to disk by the time it returns control to the menu."

### 6.4 Partial-state and abort behavior

- **Ctrl-C during a submenu**: the submenu's own SIGINT handler swallows the error
  and returns. Any partial writes that already happened **stay**. Writes that hadn't
  yet been flushed (in-memory buffer state local to the submenu) are discarded.
- **Ctrl-C at the top-level menu**: nothing is in flight at the top level (§5.1), so
  the only effect is silent exit (lines `121`, `133–134` of
  `src/commands/config/index.ts`).
- **Submenu throws**: the top-level catch rethrows non-SIGINT errors
  (`src/commands/config/index.ts:122`) and the outer `.action` catch prints them in
  red and sets exit code 1 (`src/commands/config/index.ts:135–136`). Files already
  saved by the submenu are kept; in-memory buffer state is lost.

### 6.5 Cross-process sync (providers.json watcher)

When any path inside or outside the CLI rewrites `~/.tenex/providers.json`,
`ConfigService` polls the file (`setInterval(..., 250)` at
`src/services/ConfigService.ts:777`) and reloads if mtime+size changed
(`src/services/ConfigService.ts:796–814`, debounced 100 ms at lines `783–794`). This
keeps the top-level menu's underlying provider data fresh during long-running
sessions, but is not user-visible at the menu level — the menu re-loads anyway on
next submenu entry.

---

## 7. Color Usage in the Top-Level Rendering

Every `chalk` invocation that affects the top-level menu (i.e. lives in
`src/commands/config/index.ts` or in the theme/display modules used by it):

| Element | Function | Chalk call | Source |
| --- | --- | --- | --- |
| Section header `── AI ──` etc. | `inquirer.Separator(chalk.dim("── " + header + " ──"))` | `chalk.dim` (no color, only the ANSI dim attribute) | `src/commands/config/index.ts:86` |
| `Back` row | `{ name: chalk.dim("  Back"), value: -1 }` | `chalk.dim` | `src/commands/config/index.ts:100` |
| Highlight on hover | inquirer applies `style.highlight = chalk.hex("#FFC107")` | amber `#FFC107` | `src/utils/cli-theme.ts:10` |
| Cursor `❯` | `icon.cursor = chalk.hex("#FFC107")("❯")` | amber `#FFC107` | `src/utils/cli-theme.ts:8` |
| Idle prompt prefix `?` | `prefix.idle = chalk.hex("#FFC107")("?")` | amber `#FFC107` | `src/utils/cli-theme.ts:7` |
| Done prompt prefix `✓` | `prefix.done = chalk.green("✓")` | green | `src/utils/cli-theme.ts:7` |
| Selected answer echo (after Enter) | `style.answer = chalk.hex("#FFC107")` | amber `#FFC107` | `src/utils/cli-theme.ts:11` |
| Error fallback `❌ Configuration error: ...` | `chalk.red(...)` | red | `src/commands/config/index.ts:135` |
| Choice body text (label, dash, description) | uncolored | default terminal foreground | `src/commands/config/index.ts:91` |

The choice body (`"  " + label + "— " + entry.description`, line `91`) has **no
chalk wrapper** — only the inquirer `style.highlight` recolors the row when it's the
cursor row.

The Rust port's amber should be the same `#FFC107` (or its xterm-256 nearest, `214`,
which `display.ts` uses for non-prompt text — `src/commands/config/display.ts:4`).

---

## 8. Error UI at the Top Level

### 8.1 Submenu error (non-SIGINT)

Caught at `src/commands/config/index.ts:130–137`:

```
console.log(chalk.red(`❌ Configuration error: ${error}`));
process.exitCode = 1;
```

- Red text, leading `❌` glyph, single line, no stack trace.
- `${error}` is JS string-coerced (so an `Error` becomes `Error: <message>`).
- Exit code is set to 1 but `runConfigMenu` does not loop back — the function has
  already rethrown so the menu exits.

### 8.2 SIGINT / "force closed"

Treated as a clean exit at both the inner and outer catch
(`src/commands/config/index.ts:119–123` and `133–134`). No message printed. Exit
code stays 0.

### 8.3 Config-load errors at submenu entry

The top-level menu does not load config (§5.1), so it never raises a load error at
this layer. However, the **submenu**'s call to `config.loadTenex*` may throw if a
file exists but is corrupt or invalid: `ConfigService.loadConfigFile`
(`src/services/ConfigService.ts:911–946`) wraps any parse/validation failure in:

```
Error: Failed to load config file "<path>": <message>. Fix the file or delete it to use defaults.
```

(Source: `src/services/ConfigService.ts:941–944`.) This propagates out of the
submenu, hits the top-level catch at `src/commands/config/index.ts:119–123`, fails
the SIGINT-substring check, and is rethrown to the outer `.action` catch which
prints the red `❌ Configuration error: …` line (§8.1). The full thrown message is
included.

If a config file simply does **not exist**, `loadConfigFile` silently returns the
default value (`src/services/ConfigService.ts:923–925`) — no error, no UI.

### 8.4 Validation errors inside a submenu

Inquirer-level field validation (e.g. pubkey hex check at
`src/commands/config/interactive.ts:81–88`, relay URL check at
`src/commands/config/relays.ts:57–60`) is rendered by `inquirer` itself in red text
inline with the prompt — those flows are owned by submenu specs, not this one. The
top-level menu sees no validation errors.

### 8.5 Schema validation on save

`saveConfigFile` (`src/services/ConfigService.ts:948–973`) re-validates the shape
before writing. A schema violation throws and bubbles up the same way as a load
error (§8.3). The top-level menu does **not** display these specially; it uses the
generic `❌ Configuration error: …` line.

---

## 9. Lifecycle Summary

```
$ tenex config
        │
        ▼
src/index.ts:78  program.parseAsync(argv)
        │
        ▼
configCommand.action()                                   src/commands/config/index.ts:129
        │
        ▼
runConfigMenu()  ← while(true) loop                     src/commands/config/index.ts:77
        │
        ├── build choices[] from MENU_SECTIONS         (lines 81–100)
        ├── inquirer.prompt({type:"select", ...})      (lines 103–110)
        │
        ├── Back? value === -1            ─► return    (line 112)
        │
        ├── SIGINT/"force closed"?        ─► return    (lines 119–123)
        │
        ├── otherwise, cmd.parseAsync([], {from:"user"}) (lines 114–118)
        │     │
        │     └── submenu owns its own load → edit → save → return
        │
        └── loop back to redraw menu                   (line 78)
```

Final unwind: `runConfigMenu` returns → `.action` returns → `program.parseAsync`
resolves in `src/index.ts:78` → telemetry shutdown (`src/index.ts:93`) →
`process.exit(0)` (`src/index.ts:96`).

---

## 10. Port Checklist (Rust)

The Rust TUI must reproduce, in order:

1. A `config` subcommand on the root CLI.
2. The 16 flat subcommands listed in §2.4 with the exact same names.
3. When `config` is invoked with no subcommand: a TUI menu titled `Settings` with
   the prefix `?` (idle, amber `#FFC107`) → `✓` (green, after submission).
4. Menu items in the order, sectioning, label-padding (16-char `padEnd`), and
   description text given in §2.2 / §3.3.
5. Section headers rendered as `── <Header> ──` in dim style; non-selectable.
6. Trailing entries: blank separator + `Back` (dim) with sentinel value `-1`.
7. Default selection on first render: `Providers` (first selectable after first
   separator).
8. Arrow-key navigation skipping separators; **no wrap** at top/bottom (`loop:false`).
9. `Enter` on `Back` → return cleanly. `Ctrl-C` at any point in the menu loop →
   return cleanly with no message and exit code 0.
10. On entry confirmation: dispatch to the corresponding submenu/`Command`. After
    the submenu returns (success or its own SIGINT swallow), redraw the menu from
    scratch (no cached state).
11. The top-level menu must not load or save any config file directly.
12. On a submenu throwing a non-SIGINT error: print red `❌ Configuration error: <error>`
    on a single line and set exit code 1.
13. Amber accent must equal `#FFC107` (xterm-256 `214` is acceptable fallback).
14. Highlight row, cursor `❯`, idle prefix `?`, and final answer echo all use that
    same amber.
15. The done-prefix is green `✓` (default green channel).
