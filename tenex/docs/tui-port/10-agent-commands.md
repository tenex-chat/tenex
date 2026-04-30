# `tenex agent` — Command Tree Port Spec

Source root: `src/commands/agent/index.ts`
Registration into root program: `src/index.ts:43,70` (passes `agentCommand` from `@/commands/agent` and calls `program.addCommand(agentCommand)`).

The top-level command is built by `commander` at `src/commands/agent/index.ts:108–116`:

```
agent
  ├── import
  │     └── openclaw
  ├── add        [--event-id <id>] [--slug <slug>]   (also accepts piped JSON via stdin)
  ├── delete <pubkey>
  └── manage
```

`agentCommand`’s default action (when no subcommand is passed) calls `manageAgents()` — i.e., `tenex agent` on its own opens the interactive manager (`src/commands/agent/index.ts:110–112`).

All subcommands except `import` first run `initNDKWithBackendAuth()` (`src/commands/agent/index.ts:17–23`), which calls `initNDK()` and, if no signer is attached, sets `ndk.signer = await config.getBackendSigner()`. This is required for NIP-42 AUTH to succeed before any subscription / fetch fires.

Color & theme primitives used throughout (Rust port should mirror these exactly):

- `inquirerTheme` — `src/utils/cli-theme.ts:6–13`
  - `prefix.idle = amber("?")`, `prefix.done = chalk.green("✓")`
  - `icon.cursor = amber("❯")`
  - `style.highlight = amber(text)`, `style.answer = amber(text)`
  - `amber = chalk.hex("#FFC107")` (`src/utils/cli-theme.ts:3`)
- `display.*` — `src/commands/config/display.ts`
  - `step(n,total,title)` — amber bold step header + 45-char dim amber rule
  - `context(text)` — dim, 2-space indent
  - `success(text)` — `  ✓` (green bold) + text
  - `hint(text)` — `  →` amber + amber text
  - `blank()` — `console.log()`
  - `doneLabel()` — `"  Done"` in amber bold
  - Constants: `ACCENT = ansi256(214)`, `INFO = ansi256(117)`, `SELECTED = ansi256(114)`

---

## 1. Subcommand inventory

| Subcommand | Synopsis | Description | Source |
|---|---|---|---|
| (default) | `tenex agent` | Opens the interactive Agent Manager | `src/commands/agent/index.ts:108–112` |
| `add` | `tenex agent add [-e <event-id>] [--slug <slug>]` | Install an agent from a kind:4199 definition event | `src/commands/agent/index.ts:87–93` |
| `delete` | `tenex agent delete <pubkey>` | Permanently delete a stored agent | `src/commands/agent/index.ts:101–106` |
| `manage` | `tenex agent manage` | Open the interactive agent manager | `src/commands/agent/index.ts:95–99` |
| `import openclaw` | `tenex agent import openclaw [--dry-run] [--json] [--no-sync] [--slugs <a,b>]` | Import agents from a local OpenClaw installation | `src/commands/agent/import/openclaw.ts:149–245` |

There is also a parent `import` command (`src/commands/agent/import/index.ts:4–7`) — `description: "Import agents from external sources"`. Currently `openclaw` is its only subcommand.

---

## 2. `tenex agent add`

Source: `src/commands/agent/index.ts:39–67, 87–93`.

### Synopsis
```
tenex agent add [-e, --event-id <event-id>] [--slug <slug>]
```

### Options
- `-e, --event-id <event-id>` — Nostr event ID of the agent definition (kind:4199). Optional **only if** event JSON is piped via stdin (`src/commands/agent/index.ts:89,57–60`).
- `--slug <slug>` — Override the installed agent slug on first install (`src/commands/agent/index.ts:90`).

### Flow
1. `initNDKWithBackendAuth()` — `src/commands/agent/index.ts:43`.
2. Branch on `process.stdin.isTTY` (`:45`):
   - **stdin (non-TTY)**: read all stdin bytes (utf-8, trimmed) (`:27–37, :46–47`), `JSON.parse` into a raw event object, wrap with `new NDKEvent(undefined, rawEvent)` (`:48`), then call `installAgentFromDefinitionEvent(event, { slugOverride: options.slug })` (`src/services/agents/AgentProvisioningService.ts:65–93`).
   - **TTY mode**:
     - If no `--event-id`, print `chalk.red("Error: provide --event-id or pipe event JSON via stdin")` and `process.exit(1)` (`:57–60`).
     - Otherwise call `installAgentFromDefinitionEventId(options.eventId, { slugOverride: options.slug })` (`src/services/agents/AgentProvisioningService.ts:37–63`).
3. Print result (both branches):
   - `chalk.green('✓ Installed agent "<name>" (<slug>)')` (`:52, :65`).
   - `chalk.gray('  pubkey: <pubkey>')` (`:53, :66`).

Note: messaging is always "Installed agent…" — the alternative `Updated…` wording only appears in the interactive `installFromEvent` path (`AgentManager.ts:368–372`).

### `installAgentFromDefinitionEventId` semantics (`src/services/agents/AgentProvisioningService.ts:37–63`)
1. `agentStorage.initialize()` (creates `~/.tenex/agents/` and loads `index.json`).
2. Looks up by `eventId` to detect re-install: `agentStorage.getAgentByEventId(definitionEventId)`.
3. Calls `installAgentFromNostr(definitionEventId, slugOverride, ndk)` — `src/agents/agent-installer.ts:283–299`:
   - Strips `nostr:` prefix from event id (`:289`).
   - Calls `ndk.fetchEvent(cleanEventId, { groupable: false })`.
   - Throws `AgentNotFoundError(cleanEventId)` if not found (`:294–295`).
   - Delegates to `installAgentFromNostrEvent(...)` — see "Agent definition format" below.
4. Unless `publishInventory: false`, calls `publishInstalledAgentsInventory()` — see §8.
5. Returns `{ storedAgent, pubkey: NDKPrivateKeySigner(nsec).pubkey, created: !existingAgent }`.

### `installAgentFromDefinitionEvent` semantics (`AgentProvisioningService.ts:65–93`)
Same as above but takes an already-formed `NDKEvent`; existence check uses `event.id` if present.

---

## 3. `tenex agent delete <pubkey>`

Source: `src/commands/agent/index.ts:75–83, 101–106`.

### Synopsis
```
tenex agent delete <pubkey>
```

`<pubkey>` is required (positional), declared as `argument("<pubkey>", "Agent public key")` (`:103`).

### Flow
1. `initNDKWithBackendAuth()` (`:76`).
2. `deleteStoredAgent(pubkey)` (`:77`) — defined in `src/services/agents/AgentProvisioningService.ts:129–152`:
   - `agentStorage.initialize()`.
   - `agentStorage.loadAgent(pubkey)`; if `null`, returns `false`.
   - `agentStorage.deleteAgent(pubkey, { quiet: undefined })` — destructive: removes `<pubkey>.json`, removes from `bySlug`, `byEventId`, scrubs from every `byProject[*]` (`src/agents/AgentStorage.ts:660–709`). Logs a warning unless `quiet`.
   - Calls `publishInstalledAgentsInventory()` unless `publishInventory: false`.
   - Returns `true`.
3. If `false` (agent not found): print `chalk.red("Error: agent <pubkey> not found")` and `process.exit(1)` (`:78–81`).
4. Otherwise: `chalk.green("✓ Deleted agent <pubkey>")` (`:82`).

No interactive confirmation is shown for the CLI `delete` subcommand — confirmation lives only in the interactive manager (§5).

---

## 4. `tenex agent manage` (and default action)

Source: `src/commands/agent/AgentManager.ts` — the entire interactive manager.

Entry: `src/commands/agent/index.ts:69–73, 95–99` invokes `new AgentManager().showMainMenu()`. `tenex agent` with no subcommand calls the same path (`:108–112`).

### 4.1. Pre-flight

`showMainMenu` (`AgentManager.ts:249–311`):

1. `await config.loadConfig()` (`:250`).
2. `agents = await this.loadAgents()` — see §4.3.
3. `agents = await this.offerAutoMergeForDuplicateSlugs(agents)` — see §4.4.
4. Print header:
   - `display.blank()`
   - `display.step(0, 0, "Agent Manager")` — i.e., the "0/0" badge with title "Agent Manager".
   - `display.context("Install agents from kind:4199 events, inspect current memberships, or permanently delete stored agents.")` (`:256`).

### 4.2. Custom `agentSelectPrompt` (`AgentManager.ts:86–176`)

A fully custom inquirer prompt built via `@inquirer/core::createPrompt`. It renders three regions: action shortcuts, a `Done` label, and a checkbox list of agents.

**State**:
- `active: number = 0` — index across `actions[] + [doneIndex] + items[]` (`:90`).
- `selectedPubkeys: string[]` — pubkeys with `[x]` (`:92`).
- `doneIndex = actions.length` (`:91`).
- `totalNavigable = actions.length + 1 + items.length` (`:91`).

**Layout** (`:127–175`), in order of lines:
1. `${prefix} ${theme.style.message(message, "idle")}` — top header (e.g., `? Agents (5)` with `(5)` dimmed).
2. For each `action` in `actions`: `"  "` or `${cursor} ` if active, then `chalk.cyan(action.name)`. Action `name` is built as `` `Install from 4199 event ${chalk.dim("(a)")}` `` etc. (`:265–268`), so the trailing letter hint is dim.
3. The `Done` row: prefix or cursor, then `display.doneLabel()` (= amber-bold `"  Done"`).
4. Separator: `"  " + "─".repeat(52)` (`:141`).
5. Items (only in visible window — see below). For each item:
   - prefix or cursor,
   - `[x]` (green) or `[ ]` (dim) (`:159`),
   - item label (active: amber via `theme.style.highlight`, else plain).
6. Top/bottom overflow markers when scrolling: `chalk.dim("  ↑ ${start} more")`, `chalk.dim("  ↓ ${total-end} more")` (`:150, :164`).
7. Empty state, when `items.length === 0`: `chalk.dim("  No installed agents")` (`:144`).
8. Help line at bottom (dim): `"↑↓ navigate • space select • ⏎ select"` with bold key letters and dim spacing dots (`:168–173`).

End of render appends `cursorHide` from `@inquirer/ansi` (`:175`).

**Visible window** (`getVisibleWindow`, `:57–75`):
- `maxVisibleItems = getAgentListHeight()` — `Math.max(MIN_VISIBLE_ITEMS=8, Math.floor(stdout.rows * 0.6))`, falling back to `FALLBACK_VISIBLE_ITEMS=24` when rows are unavailable (`:47–48, :77–84`).
- Centers `activeItemIndex` in the window: `start = max(0, active - half)`, `end = min(total, start + maxVisibleItems)`, then snap if window underfills.

**Keys** (`useKeypress`, `:95–125`):
- `Enter` (`isEnterKey`): if `active < doneIndex` ⇒ done with `actions[active].value`; if `active === doneIndex` ⇒ done with `"done"`; else (in items list) ⇒ done with `items[active - doneIndex - 1].value` (`:96–103`).
- `Up`/`Down` (`isUpKey`/`isDownKey`): `setActive((active + ±1 + total) % total)` and `rl.clearLine(0)` (`:104–107`).
- `Space` (`isSpaceKey`): only when `active > doneIndex` (i.e., on an item). Toggle membership of `item.pubkey` in `selectedPubkeys`. No-op when item has no pubkey (`:108–118`).
- Any other key matched against `actions[].key` triggers `done({ action: match.value, selectedPubkeys })` — i.e., shortcut letters fire immediately without Enter (`:119–124`).

### 4.3. `loadAgents()` (`AgentManager.ts:313–344`)

1. `agentStorage.initialize()`.
2. `agentStorage.getAllStoredAgents()` (raw scan; includes inactive + duplicates) — `AgentStorage.ts:1141–1157`.
3. For each `storedAgent`:
   - `pubkey = deriveAgentPubkeyFromNsec(storedAgent.nsec)` — `AgentStorage.ts:157–159`.
   - `projects = agentStorage.getAgentProjects(pubkey)`.
   - For each `projectId` in projects, ask `projectMembershipPublishService.getProjectVisibility(projectId)` (cached in a `Map<string,bool>` so it’s fetched once per project per call — `:317, :324–333`). A project counts as visible if `visibility !== "deleted"`. Visibility is determined by fetching the latest kind:31933 (`Project`) event for the dTag and checking `isDeletedProjectEvent` (`src/services/agents/ProjectMembershipPublishService.ts:74–84`).
   - Push `{ storedAgent, pubkey, projects: visibleProjects }`.
4. Sort with `compareAgents` (`:178–186`):
   - **Inactive last** — `status === "inactive"` sorts after active.
   - Otherwise alphabetically by `slug.localeCompare`.

### 4.4. Auto-merge prompt for duplicate slugs (`offerAutoMergeForDuplicateSlugs`, `:526–560`)

Triggered only if `this.duplicateMergePromptDismissed === false` (`:527`).

`findDuplicateSlugGroups` (`:230–244`) groups `ManagedAgent[]` by `storedAgent.slug` and returns groups of size ≥ 2.

If duplicates exist:
- Builds `summary = group.map(g => "${slug} (${count})").join(", ")` (`:536–538`).
- `inquirer.confirm`, message: `` `Detected duplicate slugs: ${summary}. Auto-merge them now?` ``, `default: true`, `theme: inquirerTheme` (`:540–546`).
- If user declines: `this.duplicateMergePromptDismissed = true` (so it won’t re-ask within this run) and return `agents` unchanged (`:548–551`).
- If accepts: for each group call `mergeAgents(group, false)` (no per-group confirm). After all merges, print `display.success("Auto-merged N duplicate slug group(s)")` and re-load `agents` (`:553–559`).

### 4.5. List rendering (manager main view)

The data → list mapping lives in `:258–262, :270–274`:

- `items: ListItem[] = agents.map(entry => { name: formatManagedAgentListLine(entry), value: "agent:" + entry.pubkey, pubkey: entry.pubkey })`.
- The prompt `message` is `` `Agents ${chalk.dim(`(${agents.length})`)}` ``.

`formatManagedAgentListLine` (`AgentManager.ts:203–207`):
```
[inactive] <slug> · projects: <projectsCsv|"none">
```
- `[inactive] ` prefix (with trailing space, dim) iff `status === "inactive"`.
- Then `slug` (un-styled at line level; the prompt’s `theme.style.highlight` colors the active row amber).
- Then ` · ` (dim middle dot).
- Then `projects: <csv>` (whole "projects: …" segment dim).
- `csv` from `formatProjects(projects)` (`:188–190`): `projects.join(", ")` or the literal `"none"` when empty.

Note: `formatManagedAgentLabel` (`:192–201`) is a multi-line variant (slug + role line + projects line) that is currently unused by the main view — it exists for tests. The shipped main view uses `formatManagedAgentListLine`.

The action row source (`:264–268`):

| name (label as printed) | value | shortcut key |
|---|---|---|
| `Install from 4199 event (a)` (parens dim) | `install` | `a` |
| `Delete selected (x)` | `delete-selected` | `x` |
| `Merge selected (m)` | `merge-selected` | `m` |

Action labels are rendered in `chalk.cyan` (`:136`).

After the prompt resolves, `action` switch (`:277–310`):
- `done` ⇒ return.
- `install` ⇒ `installFromEvent()` then recursively `showMainMenu()`.
- `delete-selected` ⇒ `bulkDeleteAgents(agents, selectedPubkeys)` then recurse.
- `merge-selected` ⇒ `bulkMergeAgents(agents, selectedPubkeys)` then recurse.
- `delete:<pubkey>` ⇒ `confirmAndDelete(pubkey)` then recurse. (Not currently emitted by the main prompt — present for completeness.)
- `agent:<pubkey>` ⇒ `showAgentDetail(pubkey)` then recurse — entered when user presses Enter while focused on an item row.

### 4.6. `installFromEvent` (`AgentManager.ts:346–373`)

Two sequential `inquirer.input` prompts, each with `theme: inquirerTheme`:
1. `eventId`:
   - message: `"4199 event id:"`
   - `validate(input)` → `input.trim().length > 0 || "Event id is required"` (`:351`).
2. `slugOverride`:
   - message: `"Override slug (optional):"`
   - no validation (empty string allowed) (`:355–360`).

Then `await initNDK()` (note: not `initNDKWithBackendAuth` — the signer was already attached at the top-level `manageAgents` (`index.ts:70`)) and call `installAgentFromDefinitionEventId(eventId.trim(), { slugOverride: slugOverride.trim() || undefined })` (`:362–365`).

Output:
- `display.blank()`
- If `result.created` ⇒ `display.success('Installed "<name>" (<slug>)')` else `display.success('Updated "<name>" (<slug>)')` (`:368–372`).

### 4.7. `showAgentDetail(pubkey)` (`AgentManager.ts:375–417`)

Outer `while(true)` loop. Each iteration:

1. `entry = getManagedAgent(pubkey)` (`:376, :633–645`). If `null`:
   - `display.blank()`, `display.hint("Agent no longer exists.")`, return (`:378–382`).
2. Else:
   - `display.blank()`
   - `display.step(0, 0, entry.storedAgent.slug)` — slug is the step title.
   - `display.context("Name: <name>")`
   - `display.context("Role: <role>")`
   - `display.context("Status: <status ?? 'active'>")`
   - `display.context("Projects: <formatProjects(projects)>")` (`:384–389`).
3. `inquirer.prompt({ type: "select", name: "action", message: "Agent", theme: inquirerTheme, choices })` (`:391–401`):
   - `Assign to projects` ⇒ `assign-projects`
   - `Delete permanently` ⇒ `delete`
   - `Back` ⇒ `back`
4. Branch (`:403–415`):
   - `back` ⇒ return (caller re-enters main menu).
   - `assign-projects` ⇒ `assignAgentToProjects(pubkey)` then `continue` (re-enter the loop, refreshing the entry).
   - `delete` ⇒ `confirmAndDelete(pubkey)` then return.

### 4.8. `assignAgentToProjects(pubkey)` (`AgentManager.ts:419–479`)

1. Re-load `entry`; if null: `display.blank()`, `display.hint("Agent no longer exists.")`, return (`:420–425`).
2. `availableProjects = projectMembershipPublishService.listAssignableProjectDTags()` — fetches the latest non-deleted Project events plus all locally-known project dTags whose latest event isn’t marked deleted, sorted alphabetically (`src/services/agents/ProjectMembershipPublishService.ts:43–72`).
3. `currentProjects = new Set(entry.projects)`.
4. `choices` = union of `availableProjects ∪ entry.projects`, dedup, sorted by `localeCompare`, mapped to `{ name: projectId, value: projectId, checked: currentProjects.has(projectId) }` (`:429–435`).
5. If `choices.length === 0`: `display.blank()`, `display.hint("No projects available to assign.")`, return (`:437–441`).
6. `inquirer.checkbox` (`:443–450`):
   - `name: "selectedProjects"`, `message: "Assigned to projects"`.
   - `pageSize: getAgentListHeight()` (same dynamic sizing as the main list).
   - `theme: inquirerTheme`.
7. Compute deltas:
   - `projectIdsToAdd = selectedProjectIds.filter(p => !currentProjects.has(p))`.
   - `projectIdsToRemove = entry.projects.filter(p => !selectedProjectSet.has(p))` (`:454–455`).
8. If both deltas are empty: `display.blank()`, `display.hint("No project changes.")`, return (`:457–461`).
9. For each `add`: `agentStorage.addAgentToProject(pubkey, projectId)` (`:463–465`). For each `remove`: `agentStorage.removeAgentFromProject(pubkey, projectId)` (`:467–469`).
10. `projectMembershipPublishService.syncManyProjectMemberships([...add, ...remove])` (`:471–474`) — for each affected dTag, fetches the latest project event then calls `projectEventPublishService.publishMutation({ ownerPubkey, projectDTag, trigger: "agent_manager_31933", retainAgentPubkeys: assignedPubkeys })` (`ProjectMembershipPublishService.ts:86–113`).
11. Output:
    - `display.blank()`
    - `display.success("Updated projects for <slug>")`
    - `display.context("Projects: <formatProjects(selectedProjectIds)>")` (`:476–478`).

### 4.9. `bulkDeleteAgents(agents, selectedPubkeys)` (`AgentManager.ts:481–514`)

1. Guard: if `agents.length === 0 || selectedPubkeys.length === 0` ⇒ `display.blank()`, `display.hint("Select one or more agents first.")`, return (`:482–486`).
2. `selectedAgents = agents.filter(e => selectedPubkeys.includes(e.pubkey))`.
3. `inquirer.confirm` — message: `` `Permanently delete ${n} agent${n===1?"":"s"}?` ``, `default: false`, `theme: inquirerTheme` (`:488–494`). If declined, return.
4. Compute `affectedProjectIds = unique(selectedAgents.flatMap(e => e.projects))` (`:500`).
5. Loop: `deleteStoredAgent(agent.pubkey, { quiet: true })` (default `publishInventory: true` per `AgentProvisioningService.ts:147–149`), increment `deletedCount` if returned `true` (`:502–508`). Note: `quiet: true` suppresses the per-deletion warning log — but each delete still publishes the inventory event.
6. After loop: `projectMembershipPublishService.syncManyProjectMemberships(affectedProjectIds)` (`:510`).
7. `display.blank()`, `display.success("Deleted N agent(s)")` (`:512–513`).

### 4.10. `bulkMergeAgents(agents, selectedPubkeys)` (`AgentManager.ts:516–524`)

1. Guard: `agents.length < 2 || selectedPubkeys.length < 2` ⇒ `display.blank()`, `display.hint("Select at least 2 agents first.")`, return (`:517–521`).
2. Otherwise call `mergeAgents(selectedAgents, true)` (with confirm).

### 4.11. `mergeAgents(agents, confirm=true)` (`AgentManager.ts:562–604`)

1. Need ≥ 2 agents (`:563`).
2. Pick `survivor = pickMergeSurvivor(agents)` (`:567, :209–228`):
   - sort key: more projects first; among equal, active before inactive; tiebreak slug ascending.
3. `mergedProjectIds = unique(agents.flatMap(e => e.projects))`.
4. `agentsToDelete = agents.filter(e => e.pubkey !== survivor.pubkey)` (`:569`).
5. If `confirm`:
   - `inquirer.confirm`, message: `` `Keep ${survivor.slug} and merge ${mergedProjectIds.length} project(s) from ${agentsToDelete.length} other agent(s)?` ``, `default: false`, `theme: inquirerTheme` (`:572–578`). If declined, return.
6. For each `projectId` in `mergedProjectIds`: `agentStorage.addAgentToProject(survivor.pubkey, projectId)` (`:585–587`).
7. For each `agent` in `agentsToDelete` (with `index`): `deleteStoredAgent(agent.pubkey, { publishInventory: index === lastIndex, quiet: true })` (`:589–595`) — i.e., suppress inventory publish until the **last** deletion.
8. `projectMembershipPublishService.syncManyProjectMemberships(mergedProjectIds)` (`:597`).
9. If `confirm`: `display.blank()`, `display.success("Merged N agents into <survivor-slug>")`, `display.context("Projects: <csv>")` (`:599–603`).

### 4.12. `confirmAndDelete(pubkey)` (`AgentManager.ts:606–631`)

1. `entry = getManagedAgent(pubkey)`; if null: `display.blank()`, `display.hint("Agent no longer exists.")`, return.
2. `inquirer.confirm` — message: `` `Permanently delete ${slug} from storage?` ``, `default: false`, `theme: inquirerTheme` (`:614–620`). If declined, return.
3. `affectedProjectIds = [...entry.projects]`.
4. `deleteStoredAgent(pubkey, { quiet: true })` (default `publishInventory: true`).
5. `projectMembershipPublishService.syncManyProjectMemberships(affectedProjectIds)`.
6. `display.blank()`, `display.success('Deleted "<name>" (<slug>)')` (`:629–630`).

---

## 5. `tenex agent import openclaw`

Source: `src/commands/agent/import/openclaw.ts`.

### Synopsis
```
tenex agent import openclaw [--dry-run] [--json] [--no-sync] [--slugs <a,b,...>]
```

Options (`openclaw.ts:151–154`):
- `--dry-run` — preview without making changes.
- `--json` — output as JSON; **implies** `--dry-run` (handled by the `if (options.dryRun || options.json)` branch at `:188`).
- `--no-sync` — copy workspace files into the agent home directory instead of symlinking (`commander` automatically maps `--no-sync` to `options.noSync = false` semantics; the implementation reads `options.noSync` truthy ⇒ "copy mode" — see `openclaw.ts:34, :140`). Default is symlink.
- `--slugs <slugs>` — comma-separated allowlist filtered by OpenClaw `agent.id` (`:143–147`).

### High-level flow (`openclaw.ts:155–245`)

1. **Detect state directory** (`detectOpenClawStateDir`, `openclaw-reader.ts:58–66`):
   - First env: `OPENCLAW_STATE_DIR` (must contain a recognized config json).
   - Then ordered fallback: `~/.openclaw`, `~/.clawdbot`, `~/.moldbot`, `~/.moltbot`.
   - "Recognized" = directory contains one of `openclaw.json`, `clawdbot.json`, `moldbot.json`, `moltbot.json` (`openclaw-reader.ts:27, :29–39`).
   - On miss:
     - `--json`: emit `[]` and return (`:159–162`).
     - else: `chalk.red("No OpenClaw installation detected.")` + `chalk.gray("Checked: $OPENCLAW_STATE_DIR, ~/.openclaw, ~/.clawdbot, ~/.moldbot, ~/.moltbot")`, `process.exitCode = 1`, return (`:163–170`).
2. **Read agents** via `readOpenClawAgents(stateDir)` (`openclaw-reader.ts:90–131`):
   - Reads first matching config json.
   - `agents.list[]` if present — otherwise produces a single synthetic `{ id: "main", modelPrimary: defaultModel ?? "anthropic/claude-sonnet-4-6", workspacePath: defaults.workspace ?? <stateDir>/workspace }`.
   - Per-entry `workspacePath` defaults to `defaults.workspace ?? <stateDir>/workspace`.
   - `workspaceFiles` = parallel `readFileOrNull` of `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `USER.md` from the workspace.
3. **Filter**: `filterAgents(allAgents, options.slugs)` (`:143–147, :174`). When no agents pass:
   - `--json`: `[]`.
   - else: `chalk.yellow("No matching OpenClaw agents found.")`. Return (`:176–183`).
4. **Load LLM configs**: `await configService.loadConfig()` then `llmConfigs = configService.getAllLLMConfigs()` (`:185–186`).
5. **Dry-run / JSON branch** (`:188–214`):
   - For each agent: `identity = await distillAgentIdentity(agent.workspaceFiles, llmConfigs)` (`openclaw-distiller.ts:73–84`). Slug derivation: `slug = toSlug(identity.name) || agent.id` where `toSlug` lowercases, replaces `[^a-z0-9]+` with `-`, trims leading/trailing dashes (`openclaw.ts:14–20`).
   - Build preview: `{ id, slug, model: convertModelFormat(modelPrimary), ...identity }`.
   - If `--json`: `console.log(JSON.stringify(previews, null, 2))`.
   - Else: `chalk.blue("Would import N agent(s):\n")` then per agent (all gray except slug):
     - `chalk.green("  <slug>") + chalk.gray(" (<name>)")`
     - `chalk.gray("    Role:         <role>")`
     - `chalk.gray("    Model:        <model>")`
     - `chalk.gray("    Description:  <description>")`
     - `chalk.gray("    Instructions: <first 120 chars>...")`
   - Return.
6. **Real import**:
   - `chalk.blue("Found OpenClaw installation at: <stateDir>")`, `chalk.blue("Found N agent(s) to import.")` (`:216–219`).
   - `agentStorage.initialize()` (`:221`).
   - For each agent (in order), call `importOneAgent(agent, llmConfigs, { noSync: options.noSync })` (§5.1).
   - First agent whose `workspaceFiles.user` is non-null triggers `appendUserMdToGlobalPrompt(rawUserMd, llmConfigs)` once (§5.2). Wrapped in `chalk.blue("\nDistilling user context from USER.md...")` then `chalk.green("  ✓ USER.md distilled and appended to global system prompt")` (`:225–233`).
   - At end: `chalk.green("\nImport complete.")` (`:236`).
7. **Errors**:
   - SIGINT/`force closed` errors are silently swallowed (`:239–241`).
   - Any other error: `chalk.red("Import failed: <message>")`, `process.exitCode = 1` (`:242–243`).

### 5.1. `importOneAgent` (`openclaw.ts:100–141`)

1. `tenexModel = convertModelFormat(agent.modelPrimary)` — replaces first `/` with `:` (`openclaw-reader.ts:191–195`).
2. `chalk.blue("\nDistilling identity for agent '<id>'...")` (`:107`).
3. `identity = await distillAgentIdentity(workspaceFiles, llmConfigs)` — calls LLM with the prompt at `openclaw-distiller.ts:16–43` and a Zod schema:
   ```ts
   { name, description, role, useCriteria, instructions } // all strings
   ```
   (`openclaw-distiller.ts:7–14`). On per-config failure, falls through to the next LLM in `llmConfigs` (`openclaw-distiller.ts:45–71`). Throws if `llmConfigs.length === 0`.
4. `slug = toSlug(identity.name) || agent.id` (`:110`).
5. **Conflict handling**: if `agentStorage.slugExists(slug)` ⇒ throw `Agent '<slug>' already imported. Delete it first if you want to re-import.` (`:112–116`). The error bubbles to step 7 above and aborts the whole run with `chalk.red("Import failed: …")`.
6. `signer = NDKPrivateKeySigner.generate()`; `pubkey = signer.pubkey` (`:119–120`).
7. `storedAgent = createStoredAgent({ nsec: signer.privateKey, slug, name, role, description, instructions, useCriteria, defaultConfig: { model: tenexModel } })` (`:122–131`). Note this passes `signer.privateKey` (the hex private key) into the `nsec` field; downstream `deriveAgentPubkeyFromNsec` accepts both hex and bech32 since `NDKPrivateKeySigner` parses both.
8. `agentStorage.saveAgent(storedAgent)` (writes `~/.tenex/agents/<pubkey>.json` and updates `index.json`) (`:133`).
9. `homeDir = createHomeDir(pubkey, agent.workspacePath, { noSync })` — see §5.3 (`:134`).
10. Print (`:136–140`):
    - `chalk.green("  ✓ Imported: <name> (<slug>)")`
    - `chalk.gray("    Keypair:   <pubkey>")`
    - `chalk.gray("    Model:     <tenexModel>")`
    - `chalk.gray("    Home dir:  <homeDir>")`
    - `chalk.gray("    Files:     copied|symlinked from <workspacePath>")`

### 5.2. `appendUserMdToGlobalPrompt` (`openclaw.ts:76–98`)

1. `distilled = await distillUserContext(rawUserMd, llmConfigs)` — uses prompt at `openclaw-distiller.ts:86–100`. Empty results return early (`:81`).
2. Loads global tenex config: `existingConfig = configService.loadTenexConfig(configService.getGlobalPath())`.
3. `userSection = "\n## About the User (imported from OpenClaw)\n\n<distilled>"` (`:86`).
4. `newContent = existingContent ? existingContent + userSection : userSection.trim()` (`:88`).
5. `configService.saveGlobalConfig({ ...existingConfig, globalSystemPrompt: { enabled: true, content: newContent } })` (`:90–97`).

### 5.3. `createHomeDir(pubkey, workspacePath, { noSync })` (`openclaw.ts:26–74`)

`homeDir = getAgentHomeDirectory(pubkey)` — `<TENEX_BASE>/home/<first-8-of-pubkey>` (`src/lib/agent-home.ts:46–49`, `src/constants.ts:22–24`).

`mkdir -p` it.

If `noSync === true` (i.e., user passed `--no-sync` so the resolved option is true ⇒ "copy" branch — note Commander negates `--no-`, so this branch is selected when the user **passes** `--no-sync`):
- `fs.cp(workspacePath, homeDir, { recursive: true })`.
- Write `<homeDir>/+INDEX.md` with copied-text:
  ```
  # Memory Files
  
  This agent's memory was copied from an OpenClaw installation.
  
  - `MEMORY.md` — long-term curated memory (copied from OpenClaw)
  - `memory/YYYY-MM-DD.md` — daily session logs (copied from OpenClaw)
  
  Source: <workspacePath>
  ```

Else (default — symlink mode):
- Remove pre-existing `<homeDir>/MEMORY.md`, then `fs.symlink(<workspacePath>/MEMORY.md, <homeDir>/MEMORY.md)` (dangling allowed) (`:50–53`).
- Remove pre-existing `<homeDir>/memory`, then `fs.symlink(<workspacePath>/memory, <homeDir>/memory)` (`:55–59`).
- Write `<homeDir>/+INDEX.md` with the live-synced text:
  ```
  # Memory Files
  
  This agent's memory is synced live from an OpenClaw installation.
  
  - `MEMORY.md` — long-term curated memory (updated by OpenClaw)
  - `memory/YYYY-MM-DD.md` — daily session logs (updated by OpenClaw)
  
  Source: <workspacePath>
  ```

Returns `homeDir`.

---

## 6. Agent definition format & validation

### 6.1. On-disk schema — `~/.tenex/agents/<pubkey>.json`

Type: `StoredAgent extends StoredAgentData` (`src/agents/AgentStorage.ts:74–88` + `src/agents/types/storage.ts:34–87`).

Fields (full list, and how they’re populated):

| Field | Type | Origin |
|---|---|---|
| `nsec` | `string` | Generated via `NDKPrivateKeySigner.generate()` on install (`agent-installer.ts:182`). The persisted value is whatever the caller passes; `installAgentFromNostrEvent` uses `signer.nsec` (bech32), `openclaw.ts` uses `signer.privateKey` (hex). |
| `slug` | `string` | `customSlug ?? agentDef.slug ?? toKebabCase(title)` (`agent-installer.ts:176`). For OpenClaw: `toSlug(identity.name) || agent.id` (`openclaw.ts:110`). |
| `eventId` | `string?` | The kind:4199 event id (when sourced from Nostr). |
| `status` | `"active" \| "inactive" \| undefined` | Defaults to `"active"` via `createStoredAgent` (`AgentStorage.ts:147`); flipped by `removeAgentFromProject` / `addAgentToProject`. Missing field is treated as active (`isAgentActive`, `:170–175`). |
| `name` | `string` | event `title` tag, falls back to `"Unnamed Agent"` (`agent-installer.ts:101`). |
| `role` | `string` | event `role` tag, falls back to `"assistant"` (`agent-installer.ts:103`). |
| `category` | `AgentCategory?` | event `category` tag when supplied, otherwise LLM-generated by categorization when missing. |
| `description` | `string?` | event `description` tag (`agent-installer.ts:102`). |
| `instructions` | `string?` | event `instructions` tag (`agent-installer.ts:106`). |
| `useCriteria` | `string?` | event `use-criteria` tag (`NDKAgentDefinition.useCriteria`). |
| `mcpServers` | `Record<string, MCPServerConfig>?` | not set during install; reserved for runtime updates. |
| `default` | `{ model?, skills?, mcp? }?` | Initialized with `{ model: DEFAULT_AGENT_LLM_CONFIG, tools, skills }` (`agent-installer.ts:231–234`); also tools-tag captured into `default.tools` (`:115–118, :132–135`). |
| `telegram` | `{ botToken, allowDMs?, apiBaseUrl?, publishReasoningToTelegram?, publishConversationToTelegram? }?` | Updated only via `updateAgentTelegramConfig`. Sanitized (`AgentStorage.ts:22–34`) — drops legacy `chatBindings` field. |
| `definitionDTag` | `string?` | event `d` tag (`agent-installer.ts:111`). |
| `definitionAuthor` | `string?` | event `pubkey` (`agent-installer.ts:112`). |
| `definitionCreatedAt` | `number?` | event `created_at` (`agent-installer.ts:139`). |

Persistence cleanup on every `saveAgent`:
- `sanitizeStoredAgentForPersistence` (`AgentStorage.ts:63–69`) drops undefined keys from `telegram` and `default`, and removes `default.telegram` (legacy).
- `migrateAgentData` (`:246–257`) strips legacy `projectOverrides`, `pmOverrides` on load and writes back.
- legacy `inferredCategory` is removed; if `category` is missing, its value is promoted to `category` during load.

### 6.2. Validation rules (`agent-installer.ts:58–73`)

`validateAgentEvent(agentDef)`:
- `agentDef.id` must be present — else `AgentValidationError("Agent event missing ID")`.
- `agentDef.title` must be a non-whitespace string — else `AgentValidationError("Agent event missing title tag")`.
- `agentDef.instructions` empty/missing only logs a warning (`logger.warn(...)`), does not throw.

OpenClaw distiller validation (`openclaw-distiller.ts:7–14`): output must satisfy zod schema with strings `name`, `description`, `role`, `useCriteria`, `instructions`. The LLM service is rotated through `llmConfigs` until one returns a passing object (`:54–70`).

### 6.3. Slug uniqueness

Global, enforced via `index.json::bySlug` (`AgentStorage.ts:179–192`). `slugExists` returns `true` if any agent — active or inactive — owns the slug (`:715–718`). The OpenClaw importer hard-rejects on conflict (`openclaw.ts:112–116`); `installAgentFromNostrEvent` does not pre-check slug uniqueness but `cleanupDuplicateSlugs` (`AgentStorage.ts:496–554`) evicts the previous owner from any overlapping projects on `saveAgent`.

---

## 7. Persistence layout

Root: `~/.tenex/` (or `$TENEX_BASE_DIR` if set — `src/constants.ts:22–24`).

```
~/.tenex/
├── agents/
│   ├── index.json              ← lookup index (see below)
│   ├── <pubkey-hex>.json       ← one StoredAgent per file
│   └── …
└── home/
    └── <first-8-chars-of-pubkey>/   ← per-agent home dir; +INDEX.md, MEMORY.md, etc.
```

### `index.json` schema (`AgentStorage.ts:179–192`)

```ts
interface AgentIndex {
  bySlug: Record<string, { pubkey: string; projectIds: string[] }>;
  byEventId: Record<string, string>;     // eventId -> pubkey
  byProject: Record<string, string[]>;   // projectDTag -> pubkey[]
}
```

Old format (`bySlug: Record<string,string>`) is migrated on load (`:280–319, :336–368`); on bad migration, `rebuildIndex` rescans all `*.json` (`:382–430`).

### Agent file: pretty-printed JSON

Written by `fs.writeFile(filePath, JSON.stringify(sanitizedAgent, null, 2))` (`:576`).

### Slug ownership invariants

- Active agent always wins ownership over an inactive one (`:605–636`).
- When the canonical owner becomes inactive, `findAlternativeSlugOwner` scans for an active twin and reassigns `bySlug[slug]` (`:619–626`).

---

## 8. Network publishing on install / delete / membership

### 8.1. `InstalledAgentListService.publishImmediately()` (`src/services/status/InstalledAgentListService.ts:32–65`)

Triggered at the end of every install/delete in `AgentProvisioningService` (unless `publishInventory: false`).

- `await agentStorage.initialize()`.
- Build event:
  - `kind = NDKKind.TenexInstalledAgentList = 24011` (`src/nostr/kinds.ts:30`).
  - `content = ""`.
  - One `["p", <pubkey>]` per `config.getWhitelistedPubkeys()`.
  - One `["agent", <pubkey>, <slug>]` per stored agent, sorted by `slug` then `pubkey` (`:50–62`).
- Sign with backend signer (`config.getBackendSigner()`), `event.sign(signer, { pTags: false })`.
- `event.publish()`.

### 8.2. Membership publish (kind:31933 mutations)

Whenever the manager mutates project assignments (assign, bulk delete, merge, single delete from detail view), it calls `projectMembershipPublishService.syncManyProjectMemberships(projectDTags)`. Per-project that fetches the latest project event, then `projectEventPublishService.publishMutation({ ownerPubkey, projectDTag, trigger: "agent_manager_31933", retainAgentPubkeys: agentStorage.getProjectAgentPubkeys(projectDTag) })` (`ProjectMembershipPublishService.ts:86–113`). The `Project` kind is `NDKProject.kind` (`src/nostr/kinds.ts:25` — value 31933 per the `trigger` label).

### 8.3. Agent definition events on install

`installAgentFromNostr*` does **not** publish anything itself — it only fetches kind:4199 events (`agent-installer.ts:283–299`) and downstream kind:1063 file events via `installAgentScripts`. Profile (kind:0) publishing is **not** done by `agent add`. Scripts/files referenced by the kind:4199 event are downloaded and written into the agent home directory by `installAgentScripts(eTags, signer.pubkey, ndk)` (`agent-installer.ts:184–196`); failures are logged but non-fatal.

---

## 9. Color usage cheat-sheet (Rust port targets)

| Where | Color / style | Source |
|---|---|---|
| Step header (e.g., `0/0  Agent Manager`) | `chalk.ansi256(214).bold` | `display.ts:21–25` |
| Step header rule (45 × `─`) | `chalk.ansi256(214)(chalk.dim(...))` | `display.ts:23–24` |
| `display.context` lines | `chalk.dim` | `display.ts:31–35` |
| `display.success` `✓` mark | `chalk.green.bold` | `display.ts:40–42` |
| `display.hint` `→` and text | `chalk.ansi256(214)` | `display.ts:47–49` |
| `display.doneLabel` (`"  Done"`) | `chalk.ansi256(214).bold` | `display.ts:121–123` |
| Inquirer prompt prefix `?` | amber (`#FFC107`) | `cli-theme.ts:7` |
| Inquirer prompt prefix done `✓` | `chalk.green` | `cli-theme.ts:7` |
| Active row cursor `❯` | amber | `cli-theme.ts:8` |
| Active row text highlight | amber | `cli-theme.ts:10` |
| Action labels (Install / Delete / Merge) | `chalk.cyan` | `AgentManager.ts:136` |
| Action key hint `(a)`/`(x)`/`(m)` | `chalk.dim` | `AgentManager.ts:265–267` |
| Selected `[x]` | `chalk.green` | `AgentManager.ts:159` |
| Unselected `[ ]` | `chalk.dim` | `AgentManager.ts:159` |
| Empty list "No installed agents" | `chalk.dim` | `AgentManager.ts:144` |
| Overflow markers `↑ N more` / `↓ N more` | `chalk.dim` | `AgentManager.ts:150,164` |
| Help footer (`↑↓ navigate • space select • ⏎ select`) | bold keys + `chalk.dim` separators | `AgentManager.ts:168–173` |
| `[inactive]` tag in list line | `chalk.dim` | `AgentManager.ts:205` |
| List middle dot `·` and `projects:` chunk | `chalk.dim` | `AgentManager.ts:206` |
| `tenex agent add` success line | `chalk.green` | `index.ts:52, 65` |
| `tenex agent add` pubkey line | `chalk.gray` | `index.ts:53, 66` |
| `tenex agent add` / `delete` errors | `chalk.red` | `index.ts:58, 79` |
| `tenex agent delete` success line | `chalk.green` | `index.ts:82` |
| OpenClaw "Distilling…" lines | `chalk.blue` | `openclaw.ts:107, 217–218, 229` |
| OpenClaw `✓ Imported / ✓ USER.md…` | `chalk.green` | `openclaw.ts:136, 231` |
| OpenClaw per-agent metadata (`Keypair / Model / Home dir / Files`) | `chalk.gray` | `openclaw.ts:137–140` |
| OpenClaw dry-run slug | `chalk.green` | `openclaw.ts:206` |
| OpenClaw dry-run `(name)` and detail lines | `chalk.gray` | `openclaw.ts:206–211` |
| OpenClaw "No matching agents" | `chalk.yellow` | `openclaw.ts:181` |
| OpenClaw "No installation detected" | `chalk.red` + `chalk.gray` "Checked: …" | `openclaw.ts:163–168` |
| OpenClaw final "Import complete." | `chalk.green` | `openclaw.ts:236` |
| OpenClaw "Import failed: …" | `chalk.red` | `openclaw.ts:242` |

---

## 10. Behavioral notes for the porter

1. **Default action equals `manage`.** `tenex agent` opens the manager (`index.ts:108–112`). The Rust binding must register the bare `agent` invocation with the same handler as `agent manage`.
2. **NDK auth ordering.** `initNDKWithBackendAuth` runs before any subscription/fetch. Without an attached signer, NIP-42 AUTH challenges hang silently to EOSE timeout (comment at `index.ts:14–17`).
3. **Stdin vs TTY for `agent add`.** Single-shot piped JSON should be parsed exactly as `JSON.parse(readUtf8Trim(stdin))` and wrapped into an `NDKEvent` via `new NDKEvent(undefined, raw)`. Don’t apply schema validation up front — let `validateAgentEvent` raise.
4. **OpenClaw `--no-sync` is a real flag, not negation of `--sync`.** Commander wires `--no-sync` to `options.noSync = true` here (because the option is declared as `--no-sync`, Commander stores it as `noSync` boolean which is **true** when present). Confirmed by `openclaw.ts:153, 155` (the destructured `noSync`) and the conditional at `:34, :140`.
5. **Slug normalization differs across paths.** Nostr install uses `toKebabCase` (`src/lib/string.ts`) on the title; OpenClaw uses an in-file `toSlug` (`openclaw.ts:14–20`) that lowercases, replaces non-alnum with `-`, and trims dashes. Reproduce both verbatim.
6. **Inventory publish on every mutation** unless `publishInventory: false`. The bulk merge path explicitly defers the inventory event until the last deletion (`AgentManager.ts:589–595`).
7. **Visible window math** (`getVisibleWindow`) MUST be byte-identical for stable rendering at small terminals: 8-row floor, 60% of `stdout.rows`, 24-row fallback when rows is unavailable.
8. **Action shortcuts fire on key-up without Enter.** `a`, `x`, `m` resolve the prompt directly.
9. **Auto-merge prompt is only shown once per `AgentManager` instance.** The dismissal flag is `duplicateMergePromptDismissed` and is set to `true` only on a *No* answer (`:548–550`); accepting does not set the flag because it always re-loads the agent list afterwards (`:559`).
10. **`SIGINT` / "force closed" suppression** in the OpenClaw command must keep exit code 0 (early return without setting `process.exitCode`) — `openclaw.ts:239–241`.
