---
name: report
description: Publish NIP-23 Long-form Articles (kind 30023) to Nostr, signed by this agent
tools:
  - report_publish
---

# Report Publishing

Publish markdown files as Nostr long-form articles (NIP-23, kind 30023), signed with this agent's keys.

## Tool: `report_publish`

Invoke the `report_publish` tool directly — no shell command needed.

**Parameters:**
- `path` (required) — absolute or project-relative path to a single markdown file or directory. If a directory, all files inside are published recursively.
- `project` (optional) — project association a-tag (e.g. `31933:abc123def456:my-project`)

**Article identifiers:**
- Single file: d-tag = filename (e.g. `report.md`)
- Directory: d-tag = `dirname/relative-path` for each file

**Relay resolution** (in priority order):
1. `RELAYS` environment variable (comma-separated WebSocket URLs)
2. `$TENEX_BASE_DIR/config.json` → `relays` array
3. Default: `wss://relay.tenex.chat`

## Examples

Publish a single file:
```
report_publish(path="/path/to/report.md")
```

Publish a directory with project association:
```
report_publish(path="/path/to/reports/", project="31933:abc123:my-project")
```

## Legacy Script (Backward Compatibility)

The original shell script remains available for direct invocation:

```
node $TENEX_SRC/src/skills/built-in/report/scripts/publish.js <path> [--project 31933:pubkey:dtag]
```

**Environment (auto-set by shell):**
- `NSEC` — agent private key (from agent `.env`)
- `RELAYS` — comma-separated relay URLs (from agent `.env`); falls back to `$TENEX_BASE_DIR/config.json`, then `wss://relay.tenex.chat`

Prefer the `report_publish` tool over the shell script.
