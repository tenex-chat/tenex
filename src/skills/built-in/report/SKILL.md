---
name: report
description: Publish NIP-23 Long-form Articles (kind 30023) to Nostr, signed by this agent
---

# Report Publishing

Publish markdown files as Nostr long-form articles (NIP-23, kind 30023), signed with this agent's keys.

## Script

```
node $TENEX_SRC/src/skills/built-in/report/scripts/publish.js <path> [--project 31933:pubkey:dtag]
```

**Arguments:**
- `<path>` — path to a single markdown file or a directory. If a directory, all files inside are published recursively.
- `--project <atag>` — optional project association tag (e.g. `31933:abc123def456:my-project`)

**Environment (auto-set by shell):**
- `NSEC` — agent private key (from agent `.env`)
- `RELAYS` — comma-separated relay URLs (from agent `.env`); falls back to `$TENEX_BASE_DIR/config.json`, then `wss://tenex.chat`

**Article identifiers:**
- Single file: d-tag = filename (e.g. `report.md`)
- Directory: d-tag = `dirname/relative-path` for each file

## Examples

Publish a single file:
```
node $TENEX_SRC/src/skills/built-in/report/scripts/publish.js /path/to/report.md
```

Publish a directory with project association:
```
node $TENEX_SRC/src/skills/built-in/report/scripts/publish.js /path/to/reports/ --project 31933:abc123:my-project
```
