# OpenClaw Agent Import Design

## Command

```
tenex agent import openclaw
```

Detects a local OpenClaw installation and imports its agents into TENEX.

---

## Detection

Check in order:

1. `OPENCLAW_STATE_DIR` env var
2. `~/.openclaw/`
3. Legacy paths: `~/.clawdbot/`, `~/.moldbot/`, `~/.moltbot/`

If none found → abort: `"No OpenClaw installation detected."`

---

## Input Parsing

From `openclaw.json`:

- `agents.list[]` — all configured agents. If absent, treat the single default "main" agent as the list.
- Per agent: resolve workspace dir from `agents.defaults.workspace` or per-agent override.
- Per agent: extract configured model from `agents.defaults.model.primary` or per-agent override. Convert `provider/model` → `provider:model` (slash to colon).

---

## Idempotency

Before processing each agent, derive a candidate slug from the agent name (kebab-case of the name found in IDENTITY.md, defaulting to the OpenClaw agent id if IDENTITY.md is absent).

If a StoredAgent with that slug already exists in `~/.tenex/agents/` → abort:

```
Agent 'odyssey' already imported. Delete it first if you want to re-import.
```

---

## LLM Distillation

For each agent, read from its workspace:

- `SOUL.md` — personality & behavior
- `IDENTITY.md` — name, emoji, vibe
- `AGENTS.md` — behavioral guidelines

Send all three to the agent's own configured model with a single extraction prompt:

```
You are extracting a portable agent identity from an OpenClaw installation.
Given these workspace files, return a JSON object with these fields:

- name: the agent's display name
- description: one-sentence description of who this agent is
- role: short phrase describing expertise/personality (e.g. "personal AI assistant")
- useCriteria: when this agent should be selected over others
- instructions: a clean, platform-agnostic system prompt capturing the agent's
  personality, behavioral guidelines, and identity. Discard anything specific
  to OpenClaw: heartbeat polling, HEARTBEAT_OK responses, workspace file reading
  rituals, emoji reaction guidance, silence tokens, tool-specific commands,
  and memory file management instructions.

<SOUL.md content>
<IDENTITY.md content>
<AGENTS.md content>
```

Slug is derived client-side: `name` → kebab-case. No LLM needed for slug.

---

## Agent Creation

For each agent:

**Generate keypair:**
```ts
const signer = NDKPrivateKeySigner.generate();
```

**Save StoredAgent** to `~/.tenex/agents/<pubkey>.json`:
```json
{
  "nsec": "...",
  "slug": "odyssey",
  "name": "Odyssey",
  "role": "personal AI assistant",
  "description": "...",
  "instructions": "...",
  "useCriteria": "...",
  "status": "active",
  "default": {
    "model": "anthropic:claude-sonnet-4-6"
  }
}
```

---

## Agent Home Directory

Create `~/.tenex/agents/<pubkey>/`:

```
~/.tenex/agents/<pubkey>/
├── MEMORY.md  → <openclaw_workspace>/MEMORY.md   (symlink, dangling ok)
├── memory/    → <openclaw_workspace>/memory/      (symlink dir, dangling ok)
└── +INDEX.md                                      (written file)
```

Dangling symlinks are acceptable — OpenClaw will create the files eventually and they'll appear automatically.

`+INDEX.md` content:

```markdown
# Memory Files

This agent's memory is synced live from an OpenClaw installation.

- `MEMORY.md` — long-term curated memory (updated by OpenClaw)
- `memory/YYYY-MM-DD.md` — daily session logs (updated by OpenClaw)

Source: <openclaw_workspace_path>
```

---

## Global System Prompt (USER.md)

Read `<openclaw_workspace>/USER.md`. Append to TENEX `globalSystemPrompt.content`:

```markdown

## About the User (imported from OpenClaw)

<USER.md content>
```

If `globalSystemPrompt` is empty, set it directly. Always set `enabled: true`.

---

## Command Structure

New command hierarchy:

```
tenex agent                        ← new top-level command (src/commands/agent/index.ts)
└── import                         ← subcommand (src/commands/agent/import/index.ts)
    └── openclaw                   ← leaf command (src/commands/agent/import/openclaw.ts)
```

Registered in `src/index.ts` alongside existing `daemon`, `setup`, `doctor` commands.

---

## Output

On success, print a summary per agent:

```
Imported agent: Odyssey (odyssey)
  Keypair:    <pubkey>
  Model:      anthropic:claude-sonnet-4-6
  Home dir:   ~/.tenex/agents/<pubkey>/
  Symlinks:   MEMORY.md, memory/
  Instructions distilled from: SOUL.md, IDENTITY.md, AGENTS.md

Global system prompt updated with USER.md content.
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/commands/agent/index.ts` | `tenex agent` parent command |
| `src/commands/agent/import/index.ts` | `tenex agent import` parent command |
| `src/commands/agent/import/openclaw.ts` | Leaf command + orchestration |
| `src/commands/agent/import/openclaw-reader.ts` | Reads & parses OpenClaw state dir |
| `src/commands/agent/import/openclaw-distiller.ts` | LLM distillation logic |

No new services — command-layer only. Uses existing `agentStorage`, `ConfigService`, and NDK directly for LLM calls.
