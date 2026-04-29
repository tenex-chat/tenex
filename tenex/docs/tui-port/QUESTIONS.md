# TUI port — open questions / spec-vs-source divergences

Pin notable divergences between `tenex/docs/tui-port/{01..12}-*.md` (snapshot
spec) and the live TS source. The port follows TS source — these notes flag
where the spec has fallen behind so future iterations don't re-port removed
surfaces.

## Confirmed stale spec sections

### Spec 10 §2 — `tenex agent add` is gone

Removed in commit `2855d63d` ("remove Nostr-event-based agent installation
(kinds 4199/14199/24012)"). The TS source at
`src/commands/agent/index.ts:38-58` no longer registers an `add` subcommand.
Agent creation happens through the interactive manager or
`agent import openclaw`.

The Rust port matches: `agent_cmd::AgentCommand` has only `Delete`,
`Manage`, `Import`.

### Spec 10 §6 / §8 — kind:4199 references

The "Agent definition format" and "Network publishing" sections that
reference kind:4199 fetches and the `installAgentFromNostr*` family no
longer apply. `installAgentFromDefinitionEvent` /
`installAgentFromDefinitionEventId` have been deleted. AgentStorage's
on-disk schema (§6.1) is still authoritative for persisted agents — those
fields persist for agents that were already installed before the cutover
and for agents created locally.

### Spec 11 §1 — `tenex doctor agents refetch` is gone

Same fallout as the kind:4199 cutover (commit `2855d63d`). With no
Nostr-event-driven agent definitions, there's nothing to refetch. The
live TS source at `src/commands/doctor.ts:43-46` registers only `orphans`
and `categorize` under `tenex doctor agents`. The Rust port now matches.

### Spec 02 / spec docs broadly — NIP-46 is gone

Removed in TS commits `28791660` (nostr_publish_as_user tool),
`af37bf33` (modify_project tool), and `a42db124` (NIP-46 service +
`tenex config nip46` submenu + Daemon init/shutdown). kind:31933
project mutations are now signed directly with the project owner's
nsec via `src/commands/agent/ownerSigner.ts` (env `TENEX_NSEC` →
config `ownerNsec` → password prompt). Spec 02 §3.3 listed a "NIP-46 —
Remote signing" entry in the **Advanced** section; that entry is gone
and the menu is now 15 items, not 16.

The Rust port matches: `tenex/src/config_cmd/nip46.rs` deleted, dispatch
+ menu entry stripped from `config_cmd/mod.rs`, all `nip46_*` accessors
removed from `store/tenex_config.rs`, shared validators relocated to
`tui/prompts/validators.rs`.

### Spec 11 — kind:24030 (TenexAgentDelete) is gone

Removed per user directive in commit `0f8a7668`. The `event-handler`
dispatcher and the daemon ops subscription filter no longer reference
this kind. Spec 11 doesn't list it directly but
`agentDeletion.ts` was implicitly assumed available — it isn't.

## Open: still-stale-or-not?

(none currently)

## Cross-port divergences (acknowledged, not yet aligned)

### `tenex config embed` runs the onboard flow, not the config flow

TS has TWO embedding flows:

- `src/commands/onboard.ts:387-475` `runEmbeddingSetup` — invoked
  during `tenex onboard`. 2 OpenAI models, 2 OpenRouter models, 3 local
  Xenova models. No Ollama option. Always global scope.
- `src/commands/config/embed.ts:55-269` `embedCommand` — invoked by
  `tenex config embed`. 3 OpenAI models (incl. `ada-002` legacy), 3
  OpenRouter models (incl. `ada-002`), 4 Ollama models (`nomic-embed-text`,
  `mxbai-embed-large`, `all-minilm`, `snowflake-arctic-embed`). Has the
  `--project` flag for project-scope persistence in `<project>/.tenex/`.

The Rust port currently routes BOTH `tenex onboard` Step 6 AND
`tenex config embed` through `crate::onboard::embeddings::run` (the
runEmbeddingSetup port). This means the standalone config submenu is
missing: the `--project` flag, the Ollama provider option, the
`text-embedding-ada-002` legacy entries, and the 4 Ollama model rows.

When the project-scope persistence + Ollama embedding adapter land,
add a separate `config_cmd/embed.rs` that ports `embed.ts` and switch
the `tenex config embed` dispatch to it; keep
`onboard::embeddings::run` for the Step 6 path.

### `inquire` wraps help_message in `[...]` brackets

TS @inquirer/select / @inquirer/checkbox emit the auto-helpLine as
plain text starting at column 0:
- select:   `↑↓ navigate • ⏎ select`
- checkbox: `↑↓ navigate • space select • ⏎ submit`

Inquire 0.7's `render_help_message` (`ui/backend.rs:302-310`)
hard-codes `[` + content + `]` brackets around the help string, all
styled with `render_config.help_message`. There's no
`with_help_brackets(false)` toggle and no `Token::Bracket` to suppress
in the test backend either. Output:
- TS:     `↑↓ navigate • ⏎ select`
- Rust:   `[↑↓ navigate • ⏎ select]`

We override the help text content to match TS exactly via
`with_help_message("↑↓ navigate • ⏎ select")` (and the checkbox
equivalent), so the WORDS match — but the bracket wrapping persists.
Affects every stock select / multi_select call site. Suppressing
brackets requires patching the inquire crate; visual divergence is
one bracket-pair per prompt, not a correctness bug.

### `inquire` multi-select inserts an extra space between cursor and checkbox

TS `@inquirer/checkbox/dist/index.js:178` renders each row as
`${cursor}${checkbox} ${name}` — NO space between cursor and checkbox.
For active rows that's `❯◉ name` / `❯◯ name`; for inactive
` ◉ name` / ` ◯ name`.

Rust `inquire` 0.7's MultiSelect backend
(`ui/backend.rs:413-440`) hard-codes
`<prefix> <space> <checkbox> <space> <name>` — one extra space
between the cursor/prefix and the checkbox column. There's no
`RenderConfig` knob to suppress that interstitial space; fixing this
would require either patching the inquire crate or replacing
multi_select with a hand-rolled bespoke prompt (matching what we
already do for variant_list / role_menu / etc.).

Affects: the OpenClaw import checkbox at `onboard.ts:723` and the
agent project-membership editor at `AgentManager.ts:418`. Visual
divergence is one column of horizontal padding per row — not a
correctness bug.

### `crossterm::ResetColor` emits SGR 0 where chalk emits SGR 39

TS `chalk.hex(...)(text)` and `chalk.<color>(text)` close their spans
with `\x1b[39m` (foreground-default). `crossterm::style::ResetColor`
emits `\x1b[0m` (full SGR reset — clears foreground, background, AND
every attribute span open at the same time).

Where `display.rs` and the helpers in `theme.rs` exist, every site
that needs byte-perfect chalk wrapping is already routed through
the raw-string `chalk_*(text)` helpers (which emit
`<open>...\x1b[39m`). The bespoke crossterm prompts in
`tui/custom_prompts/` (`role_menu_prompt`, `provider_select_prompt`,
`section_menu_prompt`, `variant_list_prompt`, `relay_prompt`,
`agent_select_prompt`) historically used `queue!(stdout, ResetColor)`
for every foreground-only close — emitting `\x1b[0m` where TS chalk
emits `\x1b[39m`.

Migrated so far (each site is byte-perfect chalk now):
- The `?` prefix (`inquirerTheme.prefix.idle`) in all six bespoke
  prompts → `Print(theme::FG_RESET)`. Pinned by
  `role_menu_prompt::tests::render_frame_question_prefix_uses_sgr39_close_not_sgr0`.
- Every `chalk.{red,green,yellow,cyan,gray}` wrap that was previously
  routed through crossterm's `Color::Dark*` (256-colour) → raw
  `theme::CHALK_*_OPEN` + `theme::FG_RESET`.
- Every active-row cursor `${cursor} ` close in the five
  separated-cursor bespoke prompts (`role_menu_prompt`,
  `variant_list_prompt`, `agent_select_prompt`, `llm_menu_prompt`,
  `provider_select_prompt`) → `Print(theme::FG_RESET)`. Pinned by
  `role_menu_prompt::tests::render_frame_active_role_cursor_has_space_outside_amber_wrap`
  (asserts the SGR-39 close exactly, forbids SGR-0).

- The outer amber wrap of `section_menu_prompt`'s active Entry and
  active Back rows → `Print(theme::FG_RESET)`. Pinned by
  `section_menu_prompt::tests::render_frame_active_back_preserves_dim_styling`.

Still using `ResetColor` and therefore emitting `\x1b[0m`:
- A handful of mixed-attribute closes (e.g. amber + bold "  Done"
  ending with `NormalIntensity, ResetColor`). These have a real
  intensity-close before the foreground close, so SGR-0 here
  redundantly closes nothing extra — visually identical to chalk.
  Migration would be cosmetic.

Visually identical for spans that only changed foreground (no bold,
dim, italic, or background open at the same time — which is the case
for every `${cursor} ` prefix and every dim-/bold-only label). When a
foreground-and-attribute span is open, the SGR 0 closer also
implicitly closes the attribute, so the matching `NormalIntensity` /
attribute-close that follows is a no-op rather than a real close —
still visually identical because there's nothing left to reset.

Cleanly fixing this would require either:
- replacing every `ResetColor` in `tui/custom_prompts/` with
  `Print(theme::FG_RESET)` (where `FG_RESET = "\x1b[39m"`), AND
- fixing the attribute-close ordering so the `NormalIntensity`
  /`Reset(Italic)` happens *before* the foreground close (to match
  chalk's nested-style closer order).

That's a bespoke-prompt-wide sweep with high diff churn for zero
visual change. Tracked here so the byte-fidelity tests in each
custom prompt assert space-position and order-of-attributes
correctly without conflating the two issues; see e.g.
`role_menu_prompt::tests::render_frame_active_role_cursor_has_space_outside_amber_wrap`.

## Substrate-blocked surfaces (acknowledged, not stubs)

### `tenex doctor migrate` — only reports, doesn't migrate

TS has three migrations registered (`src/services/migrations/migrations/`):

- `unknown→1`: relocate legacy schedules into per-project schedules.json
- `1→2`: reindex PrefixKVStore from 18-char to 10-char prefixes
- `2→3`: bundle built-in skills to `TENEX_BASE_DIR/skills/`

Each migration touches a substrate the Rust port doesn't yet implement
(per-project schedule files, the PrefixKVStore RAG index, the built-in
skills bundle). Implementing them in Rust without those substrates would
either be a stub (forbidden) or a partial port that skips data.

The Rust port's `doctor migrate` reads `config.version`, prints the TS
"Current migration version: X (latest: 3)" line verbatim, and:
- emits "No pending migrations." + "Final migration version: 3" if at v3,
- otherwise surfaces an honest hint and exits 1, telling the user to run
  the TS binary's `tenex doctor migrate` to advance the on-disk state.

This is intentional under CLAUDE.md "no half-finished implementations" —
when the schedules / PrefixKVStore / skills-bundle ports land, this
becomes a real migrate driver.

## Cleared notes

### Root `Cargo.toml` workspace block (resolved)

Earlier fires hit a transient state where root `Cargo.toml` listed
`crates/tenex-context` / `crates/tenex-system-prompt` without the
directories existing yet. The user's parallel work has since landed
both crate scaffolds; `cargo build` / `cargo test` succeed cleanly.
