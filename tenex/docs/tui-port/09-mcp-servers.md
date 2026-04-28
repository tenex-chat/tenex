# 09 — MCP (Model Context Protocol) Server Configuration

## TL;DR for the porter

**There is no interactive MCP screen in the TENEX TypeScript CLI/TUI.**

The brief asks for an "MCP menu hierarchy", "Add server flow", "Edit/remove flows", "Env vars input UX", "stdio vs. http transports" and an "Enable/disable toggle". After exhaustive search of `src/commands/config/`, none of these UI surfaces exist. **The porter MUST NOT invent them.** Pixel-exact reproduction of the TS surface means: *no MCP screen at all*.

What does exist:
1. A persisted JSON file (`mcp.json`) with a strict Zod schema — **stdio transport only**.
2. An auto-installer that consumes Nostr `kind:4200` (`NDKMCPTool`) events and writes entries into a project's `mcp.json`.
3. A runtime merge of global + project `mcp.json` performed by `MCPManager` and `ConfigService.loadConfig`.
4. Three coloured `chalk` lines on stdout when servers start up.

That is the entire user-visible surface for MCP configuration in TENEX TS.

**Out of scope (do not build):**
- HTTP / SSE / streamable-HTTP MCP transport. The schema does not accept it; `MCPManager` only constructs `StdioClientTransport` (`src/services/mcp/MCPManager.ts:269`).
- Per-server enable/disable. The `enabled` flag is per-file (whole MCP system on/off), not per-server (`src/services/config/types.ts:454`).
- An "Add Server" wizard, an "Edit Server" wizard, a "Remove Server" confirm prompt, an "Env Vars input" UX. None of these flows exist in the TS code; reproducing them in Rust is out of scope.

---

## 1. MCP menu hierarchy

**There is no MCP entry in the config menu.**

The full top-level config menu is built from `MENU_SECTIONS` (`src/commands/config/index.ts:33-75`). The five sections and their entries (in order) are:

| Section | Entries (in order) |
|---|---|
| AI | Providers, LLMs, Roles, Embeddings (`src/commands/config/index.ts:36-41`) |
| Agents | Escalation, Intervention, Telegram (`src/commands/config/index.ts:44-50`) |
| Network | Relays (`src/commands/config/index.ts:52-56`) |
| Conversations | Summarization, Context (`src/commands/config/index.ts:58-63`) |
| Advanced | Identity, System Prompt, Paths, NIP-46, Logging, Telemetry (`src/commands/config/index.ts:65-74`) |

The `configCommand` `.addCommand(...)` chain at `src/commands/config/index.ts:139-154` registers exactly these subcommands. **No `mcpCommand` is imported, registered, or referenced.** A `grep -rn "mcp\|MCP" src/commands/config/` returns zero matches.

**Porter action:** do not add an MCP entry to the equivalent Rust menu. If a user wants to manage MCP servers, they edit `mcp.json` by hand or rely on Nostr-event auto-install (see §2).

---

## 2. "Add server" flow — non-interactive only

The only way servers are added in the TS code is `installMCPServerFromEvent` (`src/services/mcp/mcpInstaller.ts:10-67`), driven by Nostr `kind:4200` events handled in `src/event-handler/project.ts:88`.

Schema of the Nostr event (`src/events/NDKMCPTool.ts`):
- Tag `name` (`src/events/NDKMCPTool.ts:17-24`)
- Tag `description` (`src/events/NDKMCPTool.ts:26-33`)
- Tag `command` — full shell-like string, space-split into `[cmd, ...args]` (`src/events/NDKMCPTool.ts:35-42`, used at `src/services/mcp/mcpInstaller.ts:22`)
- Tag `image` (`src/events/NDKMCPTool.ts:44-51`) — read but not written into `mcp.json`
- Server slug derived from `name` lowercase, non-alphanumeric→`-`, trimmed (`src/events/NDKMCPTool.ts:53-59`)

Installer behaviour (`src/services/mcp/mcpInstaller.ts`):
1. Validates `command` is present, else throws `"MCP tool event ${id} is missing command tag"` (line 17-19).
2. Splits `command` at whitespace into `cmd` and `args[]` (line 22).
3. Builds `MCPServerConfig` with `command`, `args`, `description`, `eventId = mcpTool.id` (lines 25-30). **No `env`, no `allowedPaths` set by this path.**
4. Loads `metadataPath/mcp.json` (line 33).
5. Dedup by event id: if any existing server already has the same `eventId`, logs `"MCP tool with event ID ${id} already installed"` and returns (lines 36-39, 73-85).
6. Dedup by slug: if a server with the same `serverName` exists *and* it has an `eventId`, returns without modifying (lines 42-53). If the existing entry lacks an `eventId`, the new event-installed entry adopts the slot.
7. Writes `serverConfig` into `mcpConfig.servers[serverName]` (line 56) and saves to `metadataPath/mcp.json` (line 59).
8. Logs `"Auto-installed MCP server: ${serverName}"` with `metadataPath, command, args, eventId` (lines 61-66).

**Validation per field — none of the field-by-field prompts in the brief exist.** The only validation is the Zod parse in `loadTenexMCP` (`src/services/ConfigService.ts:247-261`) — a `mcp.json` failing `TenexMCPSchema` causes `loadConfigFile` to propagate the error (`src/services/ConfigService.ts:929-934`).

**Porter action:** reproduce the Nostr-event auto-install path verbatim. Do not implement an interactive add-server prompt.

---

## 3. Server list rendering

There is no list view. The only place server names appear on screen is **MCPManager startup output**, written via `console.log` / `console.error` with `chalk`:

| Event | Output | Source |
|---|---|---|
| Server skipped because `allowedPaths` excludes the working dir | `chalk.yellow("   ⚠ MCP server skipped: " + chalk.bold(name) + " (path restriction)")` | `src/services/mcp/MCPManager.ts:246` |
| Health check failed (couldn't list tools within 5000 ms) | `chalk.red("   ✗ MCP server health check failed: " + chalk.bold(name) + " — " + errMsg)` | `src/services/mcp/MCPManager.ts:301` |
| Started OK | `chalk.green("   ✓ MCP server started: " + chalk.bold(name))` | `src/services/mcp/MCPManager.ts:315` |
| Spawn / connect error | `chalk.red("   ✗ MCP server failed: " + chalk.bold(name) + " — " + errMsg)` | `src/services/mcp/MCPManager.ts:324` |

Note exact prefix: three spaces, then a single Unicode glyph (`⚠`, `✗`, `✓`), then a space, then the literal label. The server name is bold.

There is **no transport indicator** (only stdio exists), **no enabled/disabled badge per server** (no per-server enabled flag exists), and **no scope indicator** in this output.

**Porter action:** match these four chalk lines exactly when the Rust MCP manager spawns its servers. Do not invent a "list servers" command/screen.

---

## 4. Edit / remove flows

No interactive edit flow exists. The only programmatic remove path is `removeMCPServerByEventId` (`src/services/mcp/mcpInstaller.ts:110-130`):

- Triggered from `src/event-handler/project.ts:76` when a previously installed event id is no longer present in the project's referenced MCP tools (computed by diffing `getInstalledMCPEventIds` against the current set at `src/event-handler/project.ts:62`).
- Walks `mcpConfig.servers`, deletes each entry whose `eventId` matches (`mcpInstaller.ts:116-122`), saves only if at least one was removed (lines 124-129).
- Logs `"Removed MCP server '${serverName}' with event ID ${eventId}"` (line 120) on success, or `"No MCP server found with event ID ${eventId}"` (line 128) on no-op.

There is **no confirmation prompt**. There is **no edit flow at all** — neither for command/args, nor env, nor description. To change a server, the operator edits `mcp.json` directly or republishes the `kind:4200` event.

**Porter action:** reproduce only the event-driven remove. Do not add `inquirer.confirm`-style prompts.

---

## 5. Env vars input UX

**Does not exist.** No `inquirer` prompt, no key=value validator, no bulk paste flow exists anywhere in `src/`. Env vars enter `mcp.json` only when the user hand-edits the JSON. The schema accepts `env: Record<string,string>` (`src/services/config/types.ts:460`) — both keys and values are arbitrary strings, no validation beyond Zod `z.string()`.

At server-start time, the env passed to the spawned MCP process is built at `src/services/mcp/MCPManager.ts:251-261`:
1. Copy every defined entry of `process.env` (`MCPManager.ts:252-257`).
2. Override with `config.env` keys (`MCPManager.ts:259-261`).
3. Pass the merged map to `StdioClientTransport`'s `env` (`MCPManager.ts:269-274`), along with `cwd: this.workingDirectory`.

**Porter action:** do not build an env-vars wizard. Reproduce only the merge-and-spawn semantics.

---

## 6. Global vs. project scope (the only real merge logic)

This is the one MCP-config behaviour the porter must reproduce precisely.

### File locations

| Scope | Path | Source |
|---|---|---|
| Global | `${TENEX_BASE_DIR \|\| ~/.tenex}/mcp.json` | `src/constants.ts:11,22-24,30`; `src/services/ConfigService.ts:97-103,128-130` |
| Project | `${TENEX_BASE_DIR \|\| ~/.tenex}/projects/${projectId}/mcp.json` | `src/services/ConfigService.ts:109-111,128-130` (the project metadata path, *not* `<repo>/.tenex/mcp.json`) |

The `getProjectPath(projectPath)` helper that *would* give you `<repo>/.tenex` exists at `src/services/ConfigService.ts:105-107` but is **not** used for MCP. MCP project config is stored under the per-project metadata directory `~/.tenex/projects/{dTag}/mcp.json`. Confirmed by:
- `src/event-handler/project.ts:44`: `const metadataPath = currentContext.agentRegistry.getMetadataPath();`
- `src/event-handler/project.ts:88,99,76,62`: all pass `metadataPath` to MCP installer / loader.
- `src/services/mcp/__tests__/mcpInstaller.test.ts:47-54`: explicitly asserts `mcp.json` is written to `metadataPath`, **not** `projectPath/.tenex`.

### Merge algorithm (run twice — same result both times)

Both `ConfigService.loadConfig` and `MCPManager.initialize` perform the same merge.

```
globalMCP  = loadTenexMCP(globalPath)                        // {servers, enabled}
projectMCP = metadataPath ? loadTenexMCP(metadataPath)
                          : { servers: {}, enabled: true }
merged.servers = { ...globalMCP.servers, ...projectMCP.servers }
merged.enabled = projectMCP.enabled !== undefined
                   ? projectMCP.enabled
                   : globalMCP.enabled
```

Sources:
- `src/services/ConfigService.ts:206-214`
- `src/services/mcp/MCPManager.ts:131-141`

Defaults when a file is missing:
- `loadConfigFile` returns `defaultValue` if the file does not exist (`src/services/ConfigService.ts:923-926`).
- For MCP that default is `{ servers: {}, enabled: true }` (`src/services/ConfigService.ts:251-254`).
- An additional defensive normalisation on read forces `servers ||= {}` and `enabled ??= true` (`src/services/ConfigService.ts:257-260`).

Therefore:
- **Server-name collisions:** project entry wins (object spread order, project last).
- **`enabled` resolution:** project value, even if explicitly `false`, overrides global. Only an *absent* project `enabled` falls back to global.
- **Project servers do not "extend" global** — a project entry with a given slug fully replaces the global entry of the same slug; there is no field-level merge.

**Porter action:** reproduce this merge exactly. The merge runs both at config-load time (so `getMCP()` is correct) *and* at MCP-manager init time. The duplicate is intentional: `MCPManager` may be re-initialised independently when a project is reloaded (`src/services/mcp/MCPManager.ts:122-164`; reload at `src/event-handler/project.ts:105`).

### Why a user would pick global vs project

This decision is implicit, not prompted:
- A user editing `~/.tenex/mcp.json` defines servers visible to **all** projects.
- A user editing `~/.tenex/projects/{dTag}/mcp.json` (or letting the Nostr-event installer write there) defines servers scoped to one project, possibly overriding a global slug.
- The Nostr `kind:4200` auto-install path **always** writes to project metadata (`src/services/mcp/mcpInstaller.ts:59`).
- Programmatic global save is via `ConfigService.saveGlobalMCP` (`src/services/ConfigService.ts:734-738`) — but no caller in `src/` ever invokes it from a UI.

**Porter action:** there is no scope-picker UI to reproduce. Provide the same two file locations with the same merge.

---

## 7. Enable / disable toggle

**Per-file, not per-server.** The flag is `TenexMCP.enabled: boolean` (`src/services/config/types.ts:452-455`, default `true` at `src/services/config/types.ts:468`).

Behaviour: if `merged.enabled === false`, `MCPManager.initialize` short-circuits — it sets `isInitialized = true` and returns *without storing any pending config*, so no servers ever start (`src/services/mcp/MCPManager.ts:143-146`).

Persistence: a user toggles MCP off by setting `"enabled": false` in either:
- `~/.tenex/mcp.json` — disables MCP for projects that don't override.
- `~/.tenex/projects/{dTag}/mcp.json` — disables MCP for that project regardless of global (because project-defined-`enabled` always wins; see §6).

There is **no per-server `enabled` field** in the schema. To "disable a single server" the user must remove the entry from `mcp.json`.

**Porter action:** reproduce the file-level kill-switch, not a per-server toggle. No interactive toggle UI is required.

---

## 8. Persistence — `mcp.json` schema (authoritative)

### Zod schema

`MCPServerConfigSchema` (`src/services/config/types.ts:457-464`):

```typescript
{
  command:      z.string(),                          // required
  args:         z.array(z.string()),                 // required (may be [])
  env:          z.record(z.string(), z.string()).optional(),
  description:  z.string().optional(),
  allowedPaths: z.array(z.string()).optional(),
  eventId:      z.string().optional(),               // Nostr provenance
}
```

`TenexMCPSchema` (`src/services/config/types.ts:466-469`):

```typescript
{
  servers: z.record(z.string(), MCPServerConfigSchema).default({}),
  enabled: z.boolean().default(true),
}
```

### Field semantics

| Field | Required | Used by | Notes |
|---|---|---|---|
| `command` | yes | `StdioClientTransport.command` (`MCPManager.ts:270`) | Executable name or absolute path. |
| `args` | yes | `StdioClientTransport.args` (`MCPManager.ts:271`) | Always an array; empty `[]` is valid. The Nostr installer fills this by space-splitting the `command` tag (`mcpInstaller.ts:22`). |
| `env` | no | Merged over `process.env` (`MCPManager.ts:251-261`) | Both keys and values are plain strings. No further validation. |
| `description` | no | Logged metadata only | Set by the Nostr installer from the `description` tag (`mcpInstaller.ts:28`). |
| `allowedPaths` | no | Path-restriction guard at startup (`MCPManager.ts:228-249`) | If non-empty *and* `workingDirectory` is set, the server starts only when `path.resolve(workingDirectory)` is a prefix of, or prefixed by, one of the resolved `allowedPaths`. Otherwise startup logs the yellow `⚠` line and returns. The Nostr installer never sets this field. |
| `eventId` | no | Nostr provenance for dedup / removal | Set by `installMCPServerFromEvent`; checked by `isMCPToolInstalled` (`mcpInstaller.ts:73-85`) and consumed by `removeMCPServerByEventId` (`mcpInstaller.ts:110-130`) and `getInstalledMCPEventIds` (`mcpInstaller.ts:91-104`). |

### Forbidden / non-existent fields

The schema's Zod `.object` is **not** `.passthrough()` (contrast `StandardLLMConfigurationSchema` at `src/services/config/types.ts:386` which does), so any extra key is **stripped** by `parse`. Specifically the following keys do NOT exist in TENEX TS and must NOT be emitted by the porter:

- `transport` (no transport discriminator — stdio is implicit)
- `type`
- `url`
- `httpUrl`
- `headers`
- `enabled` (per server — only the file-level flag exists)
- `disabled`
- `name` (the server's name is its key in `servers`, not a field)

### Sample `mcp.json` (stdio, the only supported shape)

```json
{
  "enabled": true,
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"],
      "env": {
        "DEBUG": "mcp:*"
      },
      "description": "Local filesystem access scoped to ~/notes"
    },
    "github-from-nostr": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx"
      },
      "description": "GitHub MCP server",
      "eventId": "8e1f3c7a4d2b6e9f1c0a3b5d7e8f1234567890abcdef1234567890abcdef1234"
    },
    "scoped-tool": {
      "command": "/usr/local/bin/my-mcp",
      "args": [],
      "allowedPaths": ["/Users/me/projects/teneX-allowed"]
    }
  }
}
```

### What an HTTP example would look like — DO NOT EMIT

The brief asked for an HTTP transport example. **There is none in the TS surface.** Emitting one would teach the porter to build a feature that does not exist, breaking pixel-exact parity. If the Rust port later adds HTTP, it must be a deliberate scope expansion documented separately, not a back-port from a fictional TS spec. The schema (`MCPServerConfigSchema`, `src/services/config/types.ts:457-464`) has only `command`/`args`/`env`/`description`/`allowedPaths`/`eventId`; `MCPManager.startServer` constructs only `StdioClientTransport` (`src/services/mcp/MCPManager.ts:269-274`); only `StdioClientTransport` is imported (`src/services/mcp/MCPManager.ts:15`).

### File write semantics

`saveTenexMCP` re-validates against `TenexMCPSchema` before writing (`src/services/ConfigService.ts:291-297`) — a config built from in-memory state that fails validation will throw at save time. The save path goes through the generic `saveConfigFile` helper. No comments are preserved (it is JSON), and field order on round-trip is whatever `JSON.stringify` produces.

---

## 9. Color usage

Total chalk usage in MCP code is the four startup lines listed in §3 plus one log call. There is no other coloured output anywhere in the MCP module:

| Color | Where | Glyph |
|---|---|---|
| `chalk.yellow` | path-restriction skip (`MCPManager.ts:246`) | `⚠` |
| `chalk.red` | health-check failure (`MCPManager.ts:301`) | `✗` |
| `chalk.green` | server started (`MCPManager.ts:315`) | `✓` |
| `chalk.red` | spawn/connect failure (`MCPManager.ts:324`) | `✗` |
| `chalk.bold` | server name inside each of the above lines | — |

No banner. No header. No table colours. No "MCP enabled / disabled" status line. No tool-count summary printed to the user (the count is only emitted as OpenTelemetry trace events at `MCPManager.ts:347-363`, never to stdout).

**Porter action:** match these four exact strings byte-for-byte when reproducing startup output. Use the same Unicode glyphs.

---

## Reference index

- Schema definition: `src/services/config/types.ts:443-469`
- Provider-side MCP type (no `transport` field): `src/llm/providers/types.ts:80-92`
- Config load + global/project merge: `src/services/ConfigService.ts:180-261`, `:291-297`, `:734-738`
- Manager init + merge + lazy start + lifecycle: `src/services/mcp/MCPManager.ts:50-200`, `:202-219`, `:221-327`
- Nostr-event installer / dedup / removal: `src/services/mcp/mcpInstaller.ts:1-130`
- Project-event handler driving install/remove/reload: `src/event-handler/project.ts:44`, `:62`, `:76`, `:88`, `:99`, `:105`
- Path constants: `src/constants.ts:11`, `:22-24`, `:30`
- Config menu (no MCP entry): `src/commands/config/index.ts:33-75`, `:139-154`
- AGENTS note acknowledging "Only `mcp.json` is project-level": `src/services/AGENTS.md:43`
- Tests asserting metadata-path write location: `src/services/mcp/__tests__/mcpInstaller.test.ts:47-54`, `:81`
