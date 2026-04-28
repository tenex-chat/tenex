# 12 — Visual Styling: Colors, Theming, Banners, Formatting

Shared reference for the Rust TUI port. **Goal: pixel-exact reproduction of the TS CLI.**

---

## 0. THE ORANGE — Critical Caveat

The codebase uses **two distinct oranges** that look similar but are not the same color. **Both must be reproduced exactly. Do not unify them.**

| Name | Definition | Truecolor RGB | Used in | Source |
|---|---|---|---|---|
| `#FFC107` ("amber") | `chalk.hex("#FFC107")` | `255, 193, 7` | Inquirer prompts: cursors (`›`, `❯`), prefix (`?`), highlight, answer | `src/utils/cli-theme.ts:3-4` |
| `xterm-256 #214` | `chalk.ansi256(214)` | `#ffaf00` = `255, 175, 0` | Section headers, hint arrows, banner accent letter, summary banner, "Done" label, OpenClaw agent names | `src/commands/config/display.ts:4` |

The comment `// amber #FFC107` next to the `chalk.ansi256(214)` line at `src/commands/config/display.ts:4` is **labeling intent, not actual hex**. The file header (`src/commands/config/display.ts:3`) states *"Match Rust TUI's xterm-256 color scheme exactly"* — the Rust TUI is the canonical source for `display.ts`, and it uses xterm-256 indices.

So in TENEX:
- **Inquirer-prompt orange** is true `#FFC107` (yellow-leaning amber).
- **Section / banner / display-helper orange** is xterm-256 #214 (`#ffaf00`, more saturated orange).

When emitting to a 256-color terminal, the Rust port should emit the literal SGR sequences `\x1b[38;5;214m` / `\x1b[38;5;117m` / etc. for the `display.ts` family, and 24-bit `\x1b[38;2;255;193;7m` for the inquirer-prompt family. Mixing them is a regression.

---

## 1. Brand Palette (every distinct color)

### 1a. Truecolor hex (used inside inquirer prompts)

| Hex | Symbol | Bold variant | Classification | Where | Source |
|---|---|---|---|---|---|
| `#FFC107` | `amber` | `amberBold` | Brand primary (truecolor) | Inquirer cursor `❯`, prefix `?`, highlight, answer; navigation cursor `›` in custom prompts; placeholder text wrapping | `src/utils/cli-theme.ts:3-13`, `src/commands/onboard.ts:319,330`, `src/commands/config/roles.ts:174,185`, `src/llm/utils/provider-select-prompt.ts:76`, `src/llm/utils/variant-list-prompt.ts:115`, `src/llm/utils/ModelSelector.ts:51,104,165,227` |

### 1b. xterm-256 indexed (used by `display.ts` and onboard rendering)

| ansi256 | RGB | Name in code | Classification | Where | Source |
|---|---|---|---|---|---|
| 214 | `#ffaf00` | `ACCENT` | Brand accent (orange) | Section headers, hint `→`, banner letter `T E N E X`, summary banner `▲`, OpenClaw agent name | `src/commands/config/display.ts:4`, `src/commands/onboard.ts:902` |
| 117 | `#87d7ff` | `INFO` | Info/sky blue | Summary line label; team-agent bullet `●` | `src/commands/config/display.ts:5`, `src/commands/onboard.ts:1080` |
| 114 | `#87d787` | `SELECTED` | Bright green (selection) | Provider check `[✓]` | `src/commands/config/display.ts:6,108` |
| 130 | `#af5f00` | `DARK` | Logo gradient — darkest | Banner row 5 (bottom) | `src/commands/config/display.ts:9,69` |
| 172 | `#d78700` | `MID` | Logo gradient — mid | Banner row 4 | `src/commands/config/display.ts:10,68` |
| 220 | `#ffd700` | `BRIGHT` | Logo gradient — bright | Banner row 2 | `src/commands/config/display.ts:11,66` |
| 222 | `#ffd787` | `GLOW` | Logo gradient — apex glow | Banner row 1 (top) | `src/commands/config/display.ts:12,65` |
| 240 | `#585858` | (inline) | Muted (very dark gray) | Inactive role recommendation hint | `src/commands/config/roles.ts:186`, `src/commands/onboard.ts:331` |

### 1c. Named chalk colors (16-color basic, used everywhere else)

| chalk fn | Classification | Used for | Examples |
|---|---|---|---|
| `chalk.red` | Error | Error prefix `❌`, `✗` icon, fatal log line | `logger.ts:27`, `src/llm/LLMConfigEditor.ts:154`, `src/commands/config/relays.ts:119`, `src/commands/agent/index.ts:58,79` |
| `chalk.green` | Success | `✓` icon, success log line, `[FREE]` tag, `[x]` selected checkbox | `logger.ts:30`, `src/utils/cli-theme.ts:7`, `src/commands/config/relays.ts:67`, `src/llm/utils/ModelSelector.ts:74`, `src/commands/agent/AgentManager.ts:159`, `src/llm/LLMConfigEditor.ts:154` |
| `chalk.yellow` | Warning | `⚠`, warn log line, tool-call line `🔧`, spinner frame, agent-router waiting | `logger.ts:28`, `src/agents/execution/ToolEventHandlers.ts:166`, `src/llm/LLMConfigEditor.ts:150`, `src/services/dispatch/AgentRouter.ts:30,53,133,144`, `src/daemon/ProjectRuntime.ts:100,408` |
| `chalk.blue` | Info | Info log line, doctor progress | `logger.ts:29`, `src/commands/doctor.ts:35,98,146,178,256` |
| `chalk.cyan` | Action / accent | Action item names, "Add variant", relay bullet `●`, "Type model ID manually" | `src/commands/agent/AgentManager.ts:136`, `src/llm/LLMConfigEditor.ts:130`, `src/llm/utils/variant-list-prompt.ts:137`, `src/commands/config/relays.ts:23,32`, `src/llm/utils/ModelSelector.ts:83,204`, `src/daemon/ProjectRuntime.ts:603` |
| `chalk.gray` | Muted | Debug log line, secondary metadata, hints, key counts, model size, MCP path, etc. | `logger.ts:31`, `src/llm/utils/ModelSelector.ts:31,77,140,198`, `src/llm/utils/provider-select-prompt.ts:67`, `src/commands/agent/import/openclaw.ts:137-140` |
| `chalk.white` | Stream content | LLM content delta written to stdout | `src/agents/execution/StreamExecutionHandler.ts:339` |
| `chalk.dim` | Muted-by-modifier (no color, just dimmed) | Background instructions, "Back" labels, separators (`──`, `─`), `[ ]`, `[inactive]`, `(default)`, key hints | very widespread — see §6 |
| `chalk.bold` | Emphasis | Section labels, key chord text, name padding | many call sites; e.g. `src/commands/config/relays.ts:67`, `src/commands/onboard.ts:332,1080` |

`chalk.italic`, `chalk.underline`, `chalk.strikethrough`, and any `chalk.bg*` are **not used anywhere** in the codebase (verified `grep -rn "chalk\.bg\|underline\|strikethrough\|italic" src/`).

---

## 2. Inquirer Theming

`src/utils/cli-theme.ts:6-13` defines the single shared theme passed as `theme: inquirerTheme` to virtually every `inquirer.prompt(...)` call:

```ts
export const inquirerTheme = {
    prefix: { idle: amber("?"), done: chalk.green("✓") },
    icon:   { cursor: amber("❯") },
    style:  {
        highlight: (text: string) => amber(text),
        answer:    (text: string) => amber(text),
    },
};
```

Where `amber = chalk.hex("#FFC107")`.

**Effects:**
- Prompt prefix: `?` in `#FFC107` while idle, `✓` in green when answered.
- List/select cursor glyph: `❯` in `#FFC107`.
- Highlighted (currently active) choice: text in `#FFC107`.
- Echoed answer line: text in `#FFC107`.

**Applied to every prompt across:** `src/commands/config/{relays,logging,nip46,intervention,roles,interactive,index,telemetry,telegram,context-management,paths,system-prompt,llm,embed}.ts`, `src/commands/onboard.ts`, `src/llm/LLMConfigEditor.ts`, `src/llm/utils/{provider-select-prompt,variant-list-prompt,provider-setup,ProviderConfigUI,ConfigurationManager,ModelSelector}.ts`, `src/commands/agent/AgentManager.ts`. (See file list under "All chalk usages" section.)

### Custom @inquirer/core prompts (not standard list)

These are full custom renders built with `createPrompt(...)` from `@inquirer/core`. They reuse `inquirerTheme` via `makeTheme(inquirerTheme)` and append `cursorHide` from `@inquirer/ansi` to suppress the terminal cursor while keypress-driven:

| File | Cursor glyph | Notes |
|---|---|---|
| `src/llm/utils/provider-select-prompt.ts:76` | `chalk.hex("#FFC107")("›")` | `RULE_WIDTH = 30` for `─` rule |
| `src/llm/utils/variant-list-prompt.ts:115` | `chalk.hex("#FFC107")("›")` | |
| `src/commands/config/roles.ts:174` | `chalk.hex("#FFC107")("›")` | rule width 40 (`src/commands/config/roles.ts:191`) |
| `src/commands/onboard.ts:319` | `chalk.hex("#FFC107")("›")` | rule width 40 (`src/commands/onboard.ts:336`) |
| `src/commands/agent/AgentManager.ts` | `theme.icon.cursor` (i.e. `❯` amber) | rule width 52 (`AgentManager.ts:141`) |
| `src/llm/LLMConfigEditor.ts` | `theme.icon.cursor` (i.e. `❯` amber) | rule width 40 (`LLMConfigEditor.ts:136`) |

Note the **glyph dichotomy**: the standard inquirer cursor is `❯` (heavy right-pointing angle), but custom prompts that render their own list explicitly use `›` (thin single chevron). Both are `#FFC107`. Reproduce both, do not unify.

`cursorHide` is the literal ANSI sequence `\x1b[?25l`. Custom prompt renders end with this string.

---

## 3. Banner / Logo

**Single ASCII banner**, defined in `src/commands/config/display.ts:63-85` (function `welcome()`). Called at most twice per session: at the start of onboarding (`src/commands/onboard.ts:1208`) and at the start of interactive config (`src/commands/config/interactive.ts:10`).

Visual: a 5-row stippled Sierpinski triangle (made of `•` and spaces), each row a different shade of orange (gradient apex→base, lightest to darkest), with `T E N E X` and tagline appearing to the right.

```
                                  (one blank line above)
         •                         <- row 0, color: ansi256(222) GLOW, bold
        • •                        <- row 1, color: ansi256(220) BRIGHT, bold
      •     •    T E N E X         <- row 2, color: ansi256(214) ACCENT, bold; tagline-1: ACCENT bold
     • • • • •    Your AI agent team, powered by Nostr.   <- row 3, color: ansi256(172) MID, bold; tagline-2: chalk.bold (default fg)
    • • • • • •   Let's get everything set up.            <- row 4, color: ansi256(130) DARK, bold; tagline-3: chalk.dim (default fg, dim)
                                  (one blank line below)
```

Exact source-of-truth code (preserve byte-for-byte):

```ts
const art: Array<[string, typeof ACCENT]> = [
    ["       •       ", GLOW],
    ["      • •      ", BRIGHT],
    ["    •     •    ", ACCENT],
    ["   • • • • •   ", MID],
    ["  • • • • • •  ", DARK],
];

console.log();
for (let i = 0; i < art.length; i++) {
    const [line, color] = art[i];
    let row = "  ";                            // 2-space left margin
    for (const ch of line) {
        row += ch === " " ? " " : color.bold(ch);
    }
    if (i === 2) row += `  ${ACCENT.bold("T E N E X")}`;
    if (i === 3) row += `  ${chalk.bold("Your AI agent team, powered by Nostr.")}`;
    if (i === 4) row += `  ${chalk.dim("Let's get everything set up.")}`;
    process.stdout.write(`${row}\n`);
}
console.log();
```

Notes for the Rust port:
- Each row has a **2-space left margin** prepended.
- Within each row, **only non-space characters are colored**; spaces remain plain.
- Each `•` is `color.bold(ch)` — i.e. ansi256 + SGR bold.
- Taglines on rows 2/3/4 are separated from the dot pattern by **two spaces**.
- Tagline 2 (`Your AI agent team, powered by Nostr.`) uses `chalk.bold(...)` — default foreground, bold only. No color.
- Tagline 3 (`Let's get everything set up.`) uses `chalk.dim(...)` — default foreground, dim only.
- A blank line precedes and follows the banner.

### Setup-complete mini banner

`src/commands/config/display.ts:90-94`:

```ts
console.log();
console.log(`  ${ACCENT.bold("▲")} ${ACCENT.bold("Setup complete!")}`);
console.log();
```

A single line: 2-space indent, `▲` then `Setup complete!`, both ansi256(214) bold, blank line above and below.

---

## 4. Status Glyphs (canonical mapping)

The codebase uses **two parallel glyph conventions** depending on context. The Rust port should reproduce both, not unify.

### 4a. Logger (emoji-prefixed, `src/utils/logger.ts:34-40`)

These are emitted by `logger.{error,warn,info,success,debug}` **only when stdout is a TTY** (i.e. `logFilePath` is null). When the daemon initializes file logging via `initDaemonLogging()` (`src/utils/logger.ts:125-139`), output goes to `daemon.log` as plain `[ts] LEVEL: message` with **no emojis and no colors**.

| Level | Emoji | Color (TTY mode) | File-mode prefix |
|---|---|---|---|
| error | `❌` | `chalk.red` | `ERROR: ` |
| warn | `⚠️` | `chalk.yellow` | `WARN: ` |
| info | `ℹ️` | `chalk.blue` | `INFO: ` |
| success | `✅` | `chalk.green` | `SUCCESS: ` |
| debug | `🔍` | `chalk.gray` | `DEBUG: ` |

### 4b. Inline UI (ASCII glyphs)

These appear inside config commands, doctor reports, custom prompts, etc.

| Glyph | Meaning | Color | Examples |
|---|---|---|---|
| `✓` | Success / saved / installed / item-selected-default | `chalk.green` (or `chalk.green.bold` in `display.success`) | `src/commands/config/relays.ts:67`, `src/commands/agent/index.ts:52,65,82`, `src/utils/cli-theme.ts:7` (done prefix), `src/commands/config/embed.ts:256`, `src/llm/LLMConfigEditor.ts:154`, `src/commands/config/display.ts:41` |
| `✗` | Test failed / re-index failed | `chalk.red` | `src/llm/LLMConfigEditor.ts:154`, `src/commands/doctor.ts:305,348`, `src/services/mcp/MCPManager.ts:301,324` |
| `⚠` | Doctor warning, MCP path skip | `chalk.yellow` | `src/commands/doctor.ts:109,294,299`, `src/services/mcp/MCPManager.ts:246` |
| `→` | Hint arrow, "Type manually" | ansi256(214) for `display.hint`; `chalk.cyan` for ModelSelector | `src/commands/config/display.ts:48`, `src/llm/utils/ModelSelector.ts:83,204`, `src/commands/config/llm.ts:26` |
| `›` | Custom-prompt list cursor | `#FFC107` truecolor | see §2 |
| `❯` | Standard inquirer cursor | `#FFC107` truecolor | `src/utils/cli-theme.ts:8` |
| `●` | Relay bullet (cyan) / team-agent bullet (ansi256 117) | `chalk.cyan` or `INFO` | `src/commands/config/relays.ts:23,32`, `src/commands/onboard.ts:1080` |
| `▲` | Setup-complete marker | ansi256(214) bold | `src/commands/config/display.ts:92` |
| `[✓]` / `[ ]` | Provider checkbox | `SELECTED.bold("[✓]")` (ansi256 114) / `chalk.dim("[ ]")` | `src/commands/config/display.ts:108,115` |
| `[x]` / `[ ]` | Multi-select agent checkbox | `chalk.green("[x]")` / `chalk.dim("[ ]")` | `src/commands/agent/AgentManager.ts:159` |
| `[FREE]` | OpenRouter free tag | `chalk.green` | `src/llm/utils/ModelSelector.ts:74` |
| `[inactive]` | Inactive agent tag | `chalk.dim` | `src/commands/agent/AgentManager.ts:194,205` |
| `↑↓ ⏎ ⌫ ⏎ esc space d t a m x` | Help-row key chords | each in `chalk.bold`, label after in `chalk.dim`, joined by ` • ` (also dim) | §6 |

### 4c. Project lifecycle (mixed emoji)

`src/daemon/ProjectRuntime.ts` mixes emoji and ASCII:

| Line | Glyph | Color |
|---|---|---|
| 100 | `🚀` | `chalk.yellow` (project starting) |
| 308 | `✅` | `chalk.green` (project started) |
| 321 | `❌` | `chalk.red` (project failed to start) |
| 408 | `🛑` | `chalk.yellow` (project stopping) |
| 491 | `✅` | `chalk.green` (project stopped) |
| 710 | `⚠️` | (literal in agent-message content, not a chalk wrap) |

`src/agents/execution/ToolEventHandlers.ts:166` uses `🔧` (wrench, U+1F527) wrapped in `chalk.yellow` for tool-will-execute lines, with leading `\n` and `(args...)` preview.

---

## 5. Formatting Helpers — full signatures

All in `src/commands/config/display.ts`. These are the canonical building blocks for every onboarding/config screen. Reproduce them in Rust as a `display` module.

### 5.1 `step(number: number, total: number, title: string): void`
`src/commands/config/display.ts:20-26`. Prints a step header. Output:
```
                                          (blank)
  N/T  Title                              (ACCENT.bold "N/T", two spaces, ACCENT.bold title)
  ─────────────────────────────────────────────   (2-space indent, ACCENT(chalk.dim(rule)), 45-char rule of "─")
                                          (blank)
```

### 5.2 `context(text: string): void`
`src/commands/config/display.ts:31-35`. For each line in input (split on `\n`): prints `  ${chalk.dim(line)}` (2-space indent, dim text).

### 5.3 `success(text: string): void`
`src/commands/config/display.ts:40-42`. Prints `  ${chalk.green.bold("✓")} ${text}` — 2-space indent, green-bold check, space, text in default color.

### 5.4 `hint(text: string): void`
`src/commands/config/display.ts:47-49`. Prints `  ${ACCENT("→")} ${ACCENT(text)}` — 2-space indent, ansi256(214) `→`, space, ansi256(214) text. Both **non-bold**.

### 5.5 `blank(): void`
`src/commands/config/display.ts:54-56`. Prints a single empty line (`console.log()`).

### 5.6 `welcome(): void`
See §3.

### 5.7 `setupComplete(): void`
See §3.

### 5.8 `summaryLine(label: string, value: string): void`
`src/commands/config/display.ts:99-102`. Prints `    ${INFO(paddedLabel)}${value}` where `paddedLabel = (label + ":").padEnd(16)` — 4-space indent, ansi256(117) label padded to 16 chars (including the trailing colon), then value in default color.

### 5.9 `providerCheck(text: string): string`
`src/commands/config/display.ts:107-109`. **Returns a string** (does not print): `${SELECTED.bold("[✓]")} ${text}` — ansi256(114) bold `[✓]`, space, text.

### 5.10 `providerUncheck(text: string): string`
`src/commands/config/display.ts:114-116`. **Returns a string**: `${chalk.dim("[ ]")} ${text}` — dim `[ ]`, space, text.

### 5.11 `doneLabel(): string`
`src/commands/config/display.ts:121-123`. **Returns a string**: `ACCENT.bold("  Done")` — ansi256(214) bold, with **two leading spaces inside the bolded span**.

### 5.12 Logger (`src/utils/logger.ts:142-210`)

| Function | Signature | TTY behavior | File behavior |
|---|---|---|---|
| `logger.error` | `(message: string, error?: unknown) => void` | `console.error(red("❌ " + message), error \|\| "")` | `[ts] ERROR: <message> [args]\n` to log file |
| `logger.warn` | `(message: string, ...args: unknown[]) => void` | `console.warn(yellow("⚠️ " + message), ...args)` | `[ts] WARN: <message> [args]\n` |
| `logger.warning` | alias of `warn` | — | — |
| `logger.info` | `(message: string, ...args) => void` | `console.log(blue("ℹ️ " + message), ...args)` | `[ts] INFO: ...` |
| `logger.success` | `(message: string, ...args) => void` | `console.log(green("✅ " + message), ...args)` | `[ts] SUCCESS: ...` |
| `logger.debug` | `(message: string, ...args) => void` | `console.log(gray("🔍 " + message), ...args)` (only if `DEBUG=true`) | `[ts] DEBUG: ...` |
| `logger.isLevelEnabled` | `(level) => boolean` | — | — |
| `logger.writeToWarnLog` | `(WarnLogEntry) => void` | structured JSON to `warn.log` | rotation at 100 MB → `warn.log.1` |

Levels: `silent=0, error=1, warn=2, info=3, debug=4` (`src/utils/logger.ts:6-12`); env `LOG_LEVEL` and `DEBUG=true` gate output.

### 5.13 `handleCliError` (`src/utils/cli-error.ts:10-28`)

`handleCliError(error: unknown, context?: string, exitCode = 1): never`. Formats via `formatAnyError`, calls `logger.error`, optionally logs stack if `process.env.DEBUG`, exits with `exitCode`. No additional decoration.

### 5.14 Spinner

There is **no `ora` / `cli-spinner` dependency** (verified `grep` and `package.json`). Manual frame animation only.

- `src/llm/LLMConfigEditor.ts:39`: `const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];`
- Frame interval: **80 ms** (`src/llm/LLMConfigEditor.ts:67`).
- Color: `chalk.yellow` (`src/llm/LLMConfigEditor.ts:150`).
- Mounted as a render frame, not a separate stdout stream.

---

## 6. Section / Box Rendering

There are no boxes, table borders, or `boxen`-style frames anywhere. **Sectioning is done by horizontal rules built from repeated `─` (U+2500), and dim-text labels.**

| Rule width | Character | Style | Where |
|---|---|---|---|
| 45 | `─` | `ACCENT(chalk.dim(rule))` (i.e. ansi256(214) dimmed) | `display.step()`, `src/commands/config/display.ts:21,24` |
| 40 | `─` | `chalk.dim` (no color, just dim) — appears via `"  ${"─".repeat(40)}"` so the rule is **default fg, no styling** in some custom prompts | `src/commands/config/roles.ts:191`, `src/commands/onboard.ts:336`, `src/llm/LLMConfigEditor.ts:136` |
| 52 | `─` | default fg (no chalk) | `src/commands/agent/AgentManager.ts:141` |
| 30 | `─` | `chalk.dim` | `src/llm/utils/provider-select-prompt.ts:262` (keys-view header rule) |

**Per-screen rule choice** (preserve in Rust port; do not normalize to a single width):
- Step header: 45 (full color-faded rule)
- Onboard role menu / LLM editor menu: 40 (plain rule)
- Agent manager menu: 52 (plain rule)
- Provider keys sub-view: 30 (dim rule)

### Settings menu separators (`src/commands/config/index.ts:86`)

```ts
new inquirer.Separator(chalk.dim(`── ${section.header} ──`))
```

— two leading dashes, header, two trailing dashes; entire string `chalk.dim`. Used to group settings entries.

### Help row (key chord legend)

Appears at the bottom of every custom prompt. Standard format:

```
  <bold key1> <dim label1>  <dim •>  <bold key2> <dim label2>  ...
```

where the joiner ` • ` (space-bullet-space) is itself wrapped in `chalk.dim`. The whole line is then prefixed `  ` (2-space indent) and **the prefix-plus-line is wrapped in another `chalk.dim` call**, producing a uniformly-dim line where the bold parts remain readable due to `chalk.bold`'s priority.

Example construction (`src/llm/utils/provider-select-prompt.ts:248-252`):

```ts
const help = [
    `${chalk.bold("↑↓")} ${chalk.dim("navigate")}`,
    `${chalk.bold("space")} ${chalk.dim("toggle")}`,
    `${chalk.bold("⏎")} ${chalk.dim("manage keys / done")}`,
];
out.push(chalk.dim(`  ${help.join(chalk.dim(" • "))}`));
```

### Per-context help-row variants (verbatim)

| Screen | Keys shown | Source |
|---|---|---|
| Provider browse | `↑↓ navigate`, `space toggle`, `⏎ manage keys / done` | `src/llm/utils/provider-select-prompt.ts:247-252` |
| Provider keys | `↑↓ navigate`, `d delete key`, `⏎ select`, `esc back` | `src/llm/utils/provider-select-prompt.ts:280-285` |
| Variant list | `↑↓ navigate`, `⏎ edit`, `d set default`, `⌫ remove` | `src/llm/utils/variant-list-prompt.ts:149-154` |
| Roles | `↑↓ navigate`, `⏎ change` | `src/commands/config/roles.ts:196-199` |
| Onboard role pick | `↑↓ navigate`, `⏎ change` | `src/commands/onboard.ts:341-344` |
| LLM config menu | `↑↓ navigate`, `⏎ select`, `t test`, `d delete` | `src/llm/LLMConfigEditor.ts:165-170` |
| Agent manager | `↑↓ navigate`, `space select`, `⏎ select` | `src/commands/agent/AgentManager.ts:169-173` |

Action items (e.g. `Add new configuration (a)`, `Delete selected (x)`) put the bracketed letter in `chalk.dim`: `Add new configuration ${chalk.dim("(a)")}` — `src/llm/LLMConfigEditor.ts:210-211`, `src/commands/agent/AgentManager.ts:265-267`.

---

## 7. Per-screen-type Defaults

### Section header (`display.step`)
- Two-line block: `N/T Title` then a 45-char rule.
- Both lines are 2-space indented.
- `N/T` and `Title` are ansi256(214) bold (separated by 2 spaces).
- Rule is ansi256(214) + dim.

### Custom-prompt menu (roles, providers, agents, LLM editor)
- **Title line:** `${prefix} ${theme.style.message(message, "idle")}` — inquirer prefix (`?` amber) + amber-highlighted message.
- **Action items first:** each line `${cursor or "  "}${chalk.cyan(action.name)}`.
- **Done label:** `${cursor or "  "}${ACCENT.bold("  Done")}`.
- **Separator rule** (40/52/30 chars, see §6).
- **List items** below the rule.
- **Help row** at the bottom (see §6).
- All rendered output ends with `cursorHide` ANSI (`\x1b[?25l`).

### Settings entry (config menu)
- Section separator: `chalk.dim(── HEADER ──)`.
- Entry name: `  LABEL_PADDED_TO_16— DESCRIPTION` (2-space indent, label padded right to 16, em-dash separator, description in default color).
- Back row: `chalk.dim("  Back")` with value `-1`.

### Doctor / progress output
- Action line in `chalk.blue`.
- Per-item line: `  ✓` (green), `  ✗` (red), `  ⚠` (yellow), or no marker for ok/skip.
- Tail/details in `chalk.gray`.
- Final summary in `chalk.blue` ("Final migration version: ...") or `chalk.green` ("complete in Ns").

### LLM streaming (Stream output)
- `content` deltas: `chalk.white` written directly to `process.stdout` (no newline) — `src/agents/execution/StreamExecutionHandler.ts:339`.
- `reasoning` deltas: `chalk.gray` written directly to `process.stdout` — `src/agents/execution/StreamExecutionHandler.ts:348`.
- Tool-call header: `\n🔧 toolName(argsPreview...)` in `chalk.yellow` — `src/agents/execution/ToolEventHandlers.ts:166`.

### Project lifecycle (ProjectRuntime)
| Phase | Line format | Color |
|---|---|---|
| starting | `🚀 Starting project: ${bold(title)}` | yellow |
| started | `✅ Project started: ${bold(title)}` then `   Agents: N \| Path: ...` (gray) | green / gray |
| start failed | `❌ Failed to start project: ${bold(title)}` then `   <errMsg>` | red / red |
| stopping | `🛑 Stopping project: ${bold(title)}` | yellow |
| stopped | `✅ Project stopped: ${bold(title)}` then `   Uptime: Xs \| Events processed: N` (gray) | green / gray |
| MCP info | `   MCP: N server(s) configured: ...` | cyan |

### Agent install (CLI command)
- `✓ Installed agent "name" (slug)` — `chalk.green` (`src/commands/agent/index.ts:52,65`)
- `  pubkey: ...` — `chalk.gray`
- `Error: ...` — `chalk.red` (`src/commands/agent/index.ts:58,79`)

### Generic CLI errors
- `❌ Failed to ... : ${error}` — `chalk.red` (config commands).
- `Setup failed: ${error}` (no emoji) — `chalk.red` (`src/commands/onboard.ts:1547`).
- Inline form error inside select prompts: `\n${chalk.red(error)}` (`src/commands/onboard.ts:116`).

### MCP server messages (`src/services/mcp/MCPManager.ts`)
- `   ⚠ MCP server skipped: ${bold(name)} (path restriction)` — yellow (`:246`)
- `   ✓ MCP server started: ${bold(name)}` — green (`:315`)
- `   ✗ MCP server health check failed: ${bold(name)} — ${err}` — red (`:301`)
- `   ✗ MCP server failed: ${bold(name)} — ${err}` — red (`:324`)

### AgentRouter messages (`src/services/dispatch/AgentRouter.ts`)
- "Routing to..." in yellow when waiting; gray for routine forwards; green when matched. See lines 30, 53, 68, 80, 112, 133, 144, 149.

### Conversation resolver (`src/conversations/services/ConversationResolver.ts`)
- New conversation: `chalk.green("Created new conversation ...")` (`:145`)
- Fetch warning: `chalk.yellow("Could not fetch target event ...")` (`:195`)
- Fetched OK: `chalk.green("Fetched target event and N replies")` (`:208`)

---

## 8. Dependencies

From `package.json`:

```
"chalk": "^5.6.2"
"inquirer": "^13.4.2"
"@inquirer/core": "^11.1.9"
"@inquirer/ansi": "^2.0.5"
```

**Not present** (do not assume): `ora`, `cli-spinner`, `cli-progress`, `boxen`, `figlet`, `gradient-string`, `chalk-animation`, `cli-table`. The visual styling is entirely chalk + inline ASCII + manual spinner.

---

## 9. ANSI Reproduction Cheat-Sheet for the Rust Port

| TS expression | ANSI sequence to emit | Notes |
|---|---|---|
| `chalk.hex("#FFC107")(s)` | `\x1b[38;2;255;193;7m{s}\x1b[39m` | truecolor — for inquirer prompt accents |
| `chalk.hex("#FFC107").bold(s)` | `\x1b[1m\x1b[38;2;255;193;7m{s}\x1b[39m\x1b[22m` | (chalk wraps bold separately) |
| `chalk.hex("#FFC107").dim(s)` | `\x1b[2m\x1b[38;2;255;193;7m{s}\x1b[39m\x1b[22m` | |
| `chalk.ansi256(N)(s)` | `\x1b[38;5;{N}m{s}\x1b[39m` | for display.ts palette |
| `chalk.bold(s)` | `\x1b[1m{s}\x1b[22m` | |
| `chalk.dim(s)` | `\x1b[2m{s}\x1b[22m` | |
| `chalk.red(s)` | `\x1b[31m{s}\x1b[39m` | basic red, not 256 |
| `chalk.green(s)` | `\x1b[32m{s}\x1b[39m` | |
| `chalk.yellow(s)` | `\x1b[33m{s}\x1b[39m` | |
| `chalk.blue(s)` | `\x1b[34m{s}\x1b[39m` | |
| `chalk.cyan(s)` | `\x1b[36m{s}\x1b[39m` | |
| `chalk.gray(s)` | `\x1b[90m{s}\x1b[39m` | bright black, not 256 |
| `chalk.white(s)` | `\x1b[37m{s}\x1b[39m` | |
| `cursorHide` (from `@inquirer/ansi`) | `\x1b[?25l` | append to custom prompt renders |

For Rust: `crossterm` or `nu-ansi-term` will emit equivalent sequences, but the exact codes above are what chalk produces — match them when in doubt about color-fallback behavior.

---

## 10. Authoritative Source Files (read these to verify any detail)

1. **`src/utils/cli-theme.ts`** — `amber`, `amberBold`, `inquirerTheme`. The truecolor brand center.
2. **`src/commands/config/display.ts`** — `ACCENT`, `INFO`, `SELECTED`, logo gradient (`DARK`/`MID`/`BRIGHT`/`GLOW`), all formatting helpers, banner. The xterm-256 brand center.
3. **`src/utils/logger.ts`** — emoji-glyph + chalk-color logger; TTY vs daemon-file split.
4. **`src/llm/LLMConfigEditor.ts:39`** — spinner frames + 80ms cadence.
5. **`src/llm/utils/provider-select-prompt.ts`** — most complete custom-prompt example (cursor, rule, help row, sub-view).
6. **`src/commands/onboard.ts:1208`** + **`src/commands/config/interactive.ts:10`** — the only two `display.welcome()` call sites.

If any of the above changes after this doc is written, this spec must be updated before the Rust port absorbs the change.
