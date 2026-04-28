# 07 — Whitelist and Identity Management

Port spec for the whitelisted-pubkey, telegram-identity, backend-identity,
backend-name, and NIP-46 surfaces of the TENEX TypeScript CLI/TUI to Rust.

This spec is exhaustive. Every claim cites `src/<path>:LINE`. The porter does
not read TypeScript source.

---

## 0. On-disk state

| Field | Type | Purpose | Default |
|-------|------|---------|---------|
| `whitelistedPubkeys` | `string[]` (optional) | Hex pubkeys authorised to drive the daemon | absent → `undefined` |
| `whitelistedIdentities` | `string[]` (optional) | Non-Nostr principal IDs (e.g. `telegram:user:NNN`) | absent → `undefined` |
| `tenexPrivateKey` | `string` (optional, hex) | Backend private key (kind:0 publishing, NIP-42 auth, NIP-46 local signer) | absent → auto-generated and persisted |
| `backendName` | `string` (optional) | Display name for the backend kind:0 profile | `"tenex backend"` |
| `nip46.enabled` | `boolean` | Master switch for NIP-46 remote signing | `false` (treated as enabled for `isEnabled` if explicitly missing — see §6) |
| `nip46.signingTimeoutMs` | `number` | Per-request signing timeout in ms | `30000` |
| `nip46.maxRetries` | `number` | Per-request retries | `2` |
| `nip46.owners` | `Record<hexPubkey,{bunkerUri?:string}>` | Per-owner bunker URIs | `{}` |

Schema source: `src/services/config/types.ts:14-131` (interface), `src/services/config/types.ts:133-255` (zod schema). NIP-46 sub-schema at
`src/services/config/types.ts:117-125` (interface) and
`src/services/config/types.ts:237-251` (zod).

**File location:** `<TENEX_BASE_DIR>/config.json`.

- `TENEX_BASE_DIR` env var, or fallback `$HOME/.tenex`. Constant
  `TENEX_DIR = ".tenex"` and `getTenexBasePath()`:
  `src/constants.ts:11`, `src/constants.ts:22-23`.
- File name `config.json`: `src/constants.ts:29`.
- `getGlobalPath()` returns `<TENEX_BASE_DIR>`:
  `src/services/ConfigService.ts:101-103`.

**File permissions:** No explicit chmod is applied. Files are written via
`writeJsonFile` → `fsPromises.writeFile(path, JSON.stringify(data, null, 2))`
(`src/lib/fs/filesystem.ts:107-116`). The parent directory is created with
`fsPromises.mkdir(dirPath, { recursive: true })` (`src/lib/fs/filesystem.ts:50`),
also without explicit mode. Permissions therefore inherit the process umask.
`tenexPrivateKey` is stored in plaintext alongside the rest of the config.

**JSON formatting:** 2-space indent (`src/lib/fs/filesystem.ts:114`).

---

## 1. Whitelist Pubkeys submenu (`tenex config identity`)

Source of truth: `src/commands/config/identity.ts:7-70`.
Reachable from the Settings menu under the **Advanced** section as
`Identity        — Authorized pubkeys` (`src/commands/config/index.ts:67`).
Command description string: `"Configure authorized pubkeys"`
(`src/commands/config/identity.ts:8`).

### 1.1 Top of submenu — current list rendering

Loads `whitelistedPubkeys` array (or `[]` if absent):
`src/commands/config/identity.ts:11-13`.

| State | Output (verbatim) |
|-------|--------|
| Empty | `  No authorized pubkeys.\n` printed in `chalk.dim` (dim grey), single trailing newline included in the literal. (`src/commands/config/identity.ts:16`) |
| Non-empty | First line `  Authorized pubkeys:` (no color). Then per pubkey, `    <pubkey>` (4-space indent, no color). Then a blank line via `console.log()`. (`src/commands/config/identity.ts:18-22`) |

### 1.2 Action prompt

Inquirer `select` with message `"What do you want to do?"`. Theme: `inquirerTheme` (amber accent — see §8). (`src/commands/config/identity.ts:25-35`)

| Choice label | Value |
|--------------|-------|
| `Add a pubkey` | `add` |
| `Remove a pubkey` | `remove` |
| `Back` | `back` |

The `Back` label is **not** dimmed in this menu (compare with NIP-46 menu
where it is — see §6).

### 1.3 Add flow

Inquirer `input` prompt (`src/commands/config/identity.ts:38-44`):

- Message: `Pubkey (hex or npub):`
- Theme: amber.
- Validate function: returns `true` if `input.trim().length > 0`, else returns
  the verbatim string `"Pubkey cannot be empty"`.

**No conversion.** The value is stored verbatim after `.trim()` —
**npub is accepted by the prompt but not decoded**. The submenu writes
`[...pubkeys, pubkey.trim()]` directly into `whitelistedPubkeys`
(`src/commands/config/identity.ts:45`). Downstream checks compare against
hex pubkeys, so storing an npub here will silently fail to match anything.
This is the existing behaviour and must be preserved.

After save: prints a green check + bold:
`  ${chalk.green("✓")}${chalk.bold(" Pubkey added.")}` (note: leading
2-space indent comes from how line is composed; the literal is
`chalk.green("✓") + chalk.bold(" Pubkey added.")`)
(`src/commands/config/identity.ts:47`).

### 1.4 Remove flow

`src/commands/config/identity.ts:48-63`.

1. If `pubkeys.length === 0`: prints `  Nothing to remove.` in `chalk.dim`
   and returns to top (no menu shown). (line 50)
2. Otherwise an inquirer `select` is shown:
   - Message: `Remove which pubkey?`
   - Choices: each pubkey is its own choice with `name === value === pubkey`.
   - Theme: amber.
3. Filter out the chosen pubkey, save:
   `existingConfig.whitelistedPubkeys = pubkeys.filter((pk) => pk !== pubkey)`.
4. Print `chalk.green("✓") + chalk.bold(" Pubkey removed.")` (line 61).

### 1.5 Persistence

After every add/remove, `configService.saveGlobalConfig(existingConfig)` is
called — overwrites `config.json` atomically via `writeJsonFile`
(`src/services/ConfigService.ts:722-726`).

### 1.6 Error handling

`src/commands/config/identity.ts:64-69`. Wraps the action in try/catch:

- If error message contains `"SIGINT"` or `"force closed"`: silently
  returns (Ctrl-C cancellation). No exit code.
- Otherwise prints (red): `❌ Failed to configure identity: ${error}`
  and sets `process.exitCode = 1`.

### 1.7 Validation summary table

| Path | Input | Validation | Error message (verbatim) |
|------|-------|------------|--------------------------|
| `tenex config identity` → Add | text | `input.trim().length > 0` | `Pubkey cannot be empty` |
| `tenex config identity` → Add | text | none beyond non-empty (npub/hex not enforced) | — |
| `tenex onboard` → import nsec | text | non-empty AND `nip19.decode(...).type === "nsec"` | `nsec is required` / `Invalid nsec` / `Invalid nsec format` |
| `tenex onboard` → create username | text | non-empty AND length ≥ 2 | `Username is required` / `Username must be at least 2 characters` |
| `tenex setup` (`runInteractiveSetup`) → pubkey loop | text | non-empty AND regex `/^[a-f0-9]{64}$/i` | `Pubkey cannot be empty` / `Invalid pubkey format. Must be 64 hex characters` |
| `tenex onboard --pubkey <…>` (CLI) | text | passed through `decodeToPubkey` (see §2) | `Unsupported identifier type: ${type}` (thrown) |
| `tenex config nip46 owners → add` | hex | `/^[0-9a-f]{64}$/i` | `Please enter a valid 64-character hex pubkey` |
| `tenex config nip46 owners → add` | bunker URI | `startsWith("bunker://")` | `Bunker URI must start with bunker://` |
| `tenex config nip46 → configure` | timeout ms | parseable int > 0 | `Please enter a positive number` |
| `tenex config nip46 → configure` | max retries | parseable int ≥ 0 | `Please enter a non-negative number` |
| `tenex config telegram → DM allowlist add` | text | `input.trim().startsWith("telegram:")` | `Principal IDs must start with telegram:` |

---

## 2. Conversion: npub vs hex64

Two distinct behaviours by entry point — Rust must reproduce both literally.

### 2.1 `tenex config identity → Add`

**No conversion.** The user-provided string is `.trim()`'d and stored as-is
(`src/commands/config/identity.ts:45`). The prompt's wording is misleading
(`Pubkey (hex or npub):`) but only hex pubkeys actually function for trust
lookups downstream (`src/services/trust-pubkeys/TrustPubkeyService.ts:280-294`).

### 2.2 `tenex onboard --pubkey <pubkeys...>` CLI flag

`src/commands/onboard.ts:1220-1221` calls `decodeToPubkey(pk.trim())` for each
value supplied.

`decodeToPubkey` (`src/commands/onboard.ts:120-133`) accepts:

| Input | Behaviour |
|-------|-----------|
| 64-char hex (regex `/^[a-f0-9]{64}$/i`) | returned verbatim |
| `npub1…` | `nip19.decode` → returns `decoded.data` |
| `nprofile1…` | `nip19.decode` → returns `decoded.data.pubkey` |
| Any other NIP-19 type (`nsec`, `note`, `naddr`, …) | throws `Error("Unsupported identifier type: ${decoded.type}")` |
| Garbage | `nip19.decode` throws (propagates) |

**Library:** `nostr-tools` `nip19` namespace. Imported at
`src/commands/onboard.ts:30` (`import { nip19 } from "nostr-tools";`).

The Rust port must use a NIP-19 decoder with the same alphabet/checksum
behaviour and produce a 32-byte hex string.

### 2.3 `tenex setup` (legacy `runInteractiveSetup`)

`src/commands/config/interactive.ts:65-112`. Strict — accepts only hex64,
lowercases via `.toLowerCase()` before storing
(`src/commands/config/interactive.ts:93`). Loop with `Add another pubkey?`
confirm (default `false`). Final `display.success` line:
`Added ${pubkeys.length} whitelisted pubkey(s)` (line 110).

### 2.4 `runOnboarding` create-identity branch

When no `--pubkey` is supplied and the user picks `"Create a new identity"`,
a fresh keypair is generated by `NDKPrivateKeySigner.generate()`. The new
pubkey is the only entry placed into `whitelistedPubkeys`
(`src/commands/onboard.ts:1253-1265`). The npub form is shown to the user
via `display.summaryLine("npub", npub)` (line 1271) using
`nip19.npubEncode(pubkey)`.

### 2.5 Import-nsec branch

`src/commands/onboard.ts:1278-1314`. Inquirer `password` prompt with `mask: "*"`,
message `"Paste your nsec (hidden)"`. Validate:

- empty → `nsec is required`
- `nip19.decode` throws → `Invalid nsec format`
- `decoded.type !== "nsec"` → `Invalid nsec`
- otherwise OK.

After validation, `decoded.data` is reinterpreted as `Uint8Array` and hex-encoded
via `Buffer.from(privkeyBytes).toString("hex")`. The user's pubkey (derived from
the signer) becomes the sole whitelisted pubkey.

---

## 3. Telegram identities (`whitelistedIdentities`)

Source: `src/commands/config/telegram.ts:316-391` (and child of the Telegram
menu at `src/commands/config/telegram.ts:393-421`).

### 3.1 Format

Telegram principal IDs **must** begin with the literal prefix `telegram:`.
Validated only by prefix; full canonical form for a DM user is
`telegram:user:<USERID>`. Examples shown to the operator in the prompt:
`telegram:user:12345` (`src/commands/config/telegram.ts:358`).

The `whitelistedIdentities` array stores raw principal-ID strings of any
transport. Filtering for the Telegram subset: keep only entries that
`.startsWith("telegram:")` (`src/commands/config/telegram.ts:322`).

Other Telegram channel forms (used elsewhere, not by this menu) include
`telegram:chat:<chatId>` and `telegram:group:<chatId>:topic:<topicId>`
(`src/utils/telegram-identifiers.ts:18-20`); the DM allowlist menu accepts
any string starting with `telegram:` so those are technically allowed but
the prompt example only mentions `telegram:user:`.

### 3.2 Telegram top-level menu

`src/commands/config/telegram.ts:393-421`. Inquirer `select`,
`loop: false`, message `Telegram settings`:

| Label | Value |
|-------|-------|
| `Configure an agent Telegram bot` | `agent` |
| `Configure global Telegram DM allowlist` | `global` |
| `Back` | `back` |

`Back` is **not** dimmed.

### 3.3 Global DM allowlist subscreen

`src/commands/config/telegram.ts:316-391`. Looped while user does not
select `back`. On every iteration:

1. Print blank line.
2. Print `  Global Telegram DM allowlist:` (no color).
3. List rendering:
   - Empty → single line `    none` in `chalk.dim`. (line 329)
   - Non-empty → one line per id `    ${identityId}` (no color). (line 332)
4. Inquirer `select` with message `Global Telegram DM access`:

| Label | Value |
|-------|-------|
| `Add an identity` | `add` |
| `Remove an identity` | `remove` |
| `Clear all Telegram identities` | `clear` |
| `Back` | `back` |

`loop: false`. (lines 336-348)

### 3.4 Add flow

Inquirer `input` (`src/commands/config/telegram.ts:354-362`):

- Message: `Telegram principal ID (for example telegram:user:12345):`
- Validate: `input.trim().startsWith("telegram:")`. Error message:
  `Principal IDs must start with telegram:`.
- Trimmed value pushed; deduplicated via `uniq`.

### 3.5 Remove flow

If list empty, the iteration silently `continue`s without prompting.
Otherwise an inquirer `select` (`Remove which identity?`, `loop: false`)
shows each id as both label and value. Filtered out on selection.

### 3.6 Clear flow

Sets the local list to `[]`.

### 3.7 Persistence per iteration

Every action (add/remove/clear) writes config immediately
(`src/commands/config/telegram.ts:384-389`):

1. `mergeTelegramIdentityList(existing, telegramIdentities)`
   (`src/commands/config/telegram.ts:308-314`): take everything from
   `whitelistedIdentities` that does **not** start with `telegram:`,
   then append the deduped Telegram list. Non-Telegram principal IDs
   (e.g. future Slack/email transports) are preserved.
2. `configService.saveGlobalConfig(existingConfig)`.
3. Print `chalk.green("✓") + chalk.bold(" Global Telegram DM allowlist saved.")`.

### 3.8 Error handling at command root

`src/commands/config/telegram.ts:425-433`. SIGINT/`force closed` swallowed.
Otherwise red `❌ Failed to configure Telegram: ${error}` and
`process.exitCode = 1`.

### 3.9 Resolution at runtime

`ConfigService.getWhitelistedIdentities()`
(`src/services/ConfigService.ts:695-716`) merges:

- `nostr:<pubkey>` for every whitelisted Nostr pubkey.
- Every entry in `whitelistedIdentities`, trimmed, ignoring empties.

Returned as a deduped string array.

---

## 4. Backend keypair (`tenexPrivateKey`)

### 4.1 Generation

There is **no UI** for the backend keypair. It is auto-generated lazily.

- During `tenex onboard` (`src/commands/onboard.ts:1318-1331`):
  1. Read existing `tenexPrivateKey` from `config.json`.
  2. If absent: `NDKPrivateKeySigner.generate()` → store
     `signer.privateKey` (32-byte hex string).
  3. If generation fails (returns falsy): `process.exit(1)` after
     printing `chalk.red("Failed to generate daemon key")` (or the
     same message inside `JSON.stringify({ error: ... })` in
     `--json` mode).
- On any later config load that needs it: `ensureBackendPrivateKey()`
  (`src/services/ConfigService.ts:632-651`) re-runs the same logic and
  also logs `Generated new TENEX backend private key` at info level.

The backend signer itself is exposed via `getBackendSigner()`
(`src/services/ConfigService.ts:653-659`) which wraps the hex private key
in `new NDKPrivateKeySigner(privateKey)`.

### 4.2 No regenerate flow

There is **no menu, command, or confirmation prompt for regenerating the
backend key.** A grep across `src/` for "regenerate" + "backend"
returns zero hits. To rotate the key the operator must edit `config.json`
manually (delete the `tenexPrivateKey` field — the next daemon start will
regenerate it). The Rust port should preserve this — do **not** invent a
regeneration UI. If a "right fix" justifies one in the future, that is
out of scope for the pixel-exact port.

### 4.3 Storage

Plaintext hex inside `<TENEX_BASE_DIR>/config.json` under key
`tenexPrivateKey` (no `nsec1…` encoding at rest). Permissions per §0:
default umask, no chmod, JSON 2-space indent.

### 4.4 Use sites

| Use site | Source |
|----------|--------|
| Publish backend kind:0 profile on daemon boot | `src/daemon/Daemon.ts:340-344` |
| Sign all TENEX system events (status announcements, etc.) | `getBackendSigner()` callers throughout `src/nostr/` |
| Local signer for NIP-46 client connections | `src/services/nip46/Nip46SigningService.ts:156-157` |
| Set on NDK as the default signer for NIP-42 relay AUTH | `src/daemon/Daemon.ts:341` |

---

## 5. Backend name (`backendName`)

### 5.1 Default value

`"tenex backend"` (lower-case, with single space). Source of truth two places
that must agree:

- Daemon resolves the value with `loadedConfig.backendName || "tenex backend"`
  at `src/daemon/Daemon.ts:343`.
- `publishBackendProfile` parameter default
  (`src/nostr/AgentProfilePublisher.ts:415-420`).
- Config UI default `defaultBackendName = "tenex backend"`
  (`src/commands/config/paths.ts:16`).

### 5.2 Edit UI — `tenex config paths`

There is **no dedicated backend-name menu**. The field is edited inside
the `Paths` submenu, alongside `projectsBase` and `blossomServerUrl`.

`src/commands/config/paths.ts:18-43`. Three sequential inquirer prompts (no
`Back` option — the form runs to completion):

| Field | Prompt | Default | Validation |
|-------|--------|---------|------------|
| `backendName` | `TENEX backend profile name:` | `tenexConfig.backendName ?? "tenex backend"` | none |
| `projectsBase` | `Projects base directory:` | `tenexConfig.projectsBase ?? path.join(homedir(),"tenex")` | none |
| `blossomServerUrl` | `Blossom server URL for blob uploads:` | `tenexConfig.blossomServerUrl ?? "https://blossom.primal.net"` | must start with `http://` or `https://`; error `Please enter a valid HTTP(S) URL` |

After submit (`src/commands/config/paths.ts:45-50`):

```
tenexConfig.backendName = answers.backendName || undefined;
```

Empty string → stored as `undefined` (i.e. removed from JSON, falls back
to the default at runtime).

Save → `config.saveTenexConfig(globalPath, tenexConfig)` →
`✓ Path settings updated` printed in green with a leading newline
(`src/commands/config/paths.ts:50`: `console.log(chalk.green("\n✓ Path settings updated"));`).

### 5.3 No backend-name validation

The field accepts any string (or empty). The Rust port should match this:
the value is forwarded into a kind:0 `name` field
(`src/nostr/AgentProfilePublisher.ts:427`, `:474`). No length cap, no
charset restriction.

---

## 6. NIP-46 remote signing (`tenex config nip46`)

Source of truth: `src/commands/config/nip46.ts:1-159`. Reachable from
Settings → Advanced → `NIP-46 — Remote signing`
(`src/commands/config/index.ts:70`).

### 6.1 Top menu

Inquirer `select`, message `NIP-46 Remote Signing Settings`:

| Label | Value |
|-------|-------|
| `Enable/Disable NIP-46` | `toggle` |
| `Configure timeout and retries` | `configure` |
| `Manage owner bunker URIs` | `owners` |
| `Back` (`chalk.dim`) | `back` |

`Back` **is dimmed** here (compare with §1, §3 where it is not). Theme
amber.

### 6.2 Toggle flow

Inquirer `confirm` (`src/commands/config/nip46.ts:30-35`):

- Message: `Enable NIP-46 remote signing?`
- Default: `nip46.enabled ?? false`.
- No theme override (uses inquirer default — Y/N).

After confirmation:

```
tenexConfig.nip46 = { ...nip46, enabled };
```

Print: `\n✓ NIP-46 ${enabled ? "enabled" : "disabled"}` in green.
(`src/commands/config/nip46.ts:39`)

**Master-switch semantics at runtime:** `Nip46SigningService.isEnabled()`
returns `cfg.nip46?.enabled !== false` (`src/services/nip46/Nip46SigningService.ts:90-97`).
That means `undefined` (field missing) is treated as **enabled**, only
explicit `false` disables. The Daemon, however, only logs `NIP-46 remote signing enabled`
when `loadedConfig.nip46?.enabled` is truthy
(`src/daemon/Daemon.ts:347-349`). The Rust port must reproduce both
behaviours: the service-level `!== false` check, and the
truthy-only daemon log.

### 6.3 Configure flow

Two sequential `input` prompts (`src/commands/config/nip46.ts:43-71`):

| Field | Prompt | Default | Validation | Error |
|-------|--------|---------|------------|-------|
| `signingTimeoutMs` | `Signing timeout (ms):` | `nip46.signingTimeoutMs ?? 30000` | `parseInt(value,10)` not NaN AND `> 0` | `Please enter a positive number` |
| `maxRetries` | `Max retries:` | `nip46.maxRetries ?? 2` | `parseInt(value,10)` not NaN AND `>= 0` | `Please enter a non-negative number` |

After submit:

```
tenexConfig.nip46 = {
  ...nip46,
  signingTimeoutMs: parseInt(answers.signingTimeoutMs,10),
  maxRetries: parseInt(answers.maxRetries,10),
};
```

Print: `\n✓ NIP-46 settings updated` in green
(`src/commands/config/nip46.ts:80`).

### 6.4 Owners flow

Sub-menu (`src/commands/config/nip46.ts:84-98`):

| Label | Value | Conditional |
|-------|-------|-------------|
| `Add owner bunker URI` | `add` | always |
| `Remove owner bunker URI` | `remove` | only if `ownerPubkeys.length > 0` |
| `Back` (`chalk.dim`) | `back` | always |

#### 6.4.1 Add owner

Two `input` prompts (`src/commands/config/nip46.ts:103-126`):

| Field | Prompt | Validation | Error (verbatim) |
|-------|--------|------------|------------------|
| pubkey | `Owner hex pubkey:` | `/^[0-9a-f]{64}$/i` | `Please enter a valid 64-character hex pubkey` |
| bunkerUri | `Bunker URI (bunker://pubkey?relay=wss://...):` | `value.startsWith("bunker://")` | `Bunker URI must start with bunker://` |

Stored:

```
tenexConfig.nip46.owners = {
  ...owners,
  [pubkey]: { bunkerUri }
};
```

Confirmation: `\n✓ Owner bunker URI added` in green.

#### 6.4.2 Remove owner

Inquirer `select` (`src/commands/config/nip46.ts:142-151`):

- Message: `Select owner to remove:`
- Choice label format: `${pk.substring(0,16)}... (${owners[pk].bunkerUri})`.
- Choice value: full hex pubkey.

Action: `delete owners[pubkeyToRemove]`. Persist. Confirmation:
`\n✓ Owner bunker URI removed` in green.

### 6.5 Default bunker URI when none configured

`Nip46SigningService.getBunkerUri(ownerPubkey)`
(`src/services/nip46/Nip46SigningService.ts:113-125`) auto-constructs:

```
bunker://<ownerPubkey>?relay=<encodeURIComponent(firstRelay)>
```

`firstRelay` falls back to `wss://tenex.chat` when the relay list is empty.
The Rust port must reproduce the URI-encoded relay query string.

### 6.6 Persistence

Every branch saves with `config.saveTenexConfig(globalPath, tenexConfig)`
(direct, not `saveGlobalConfig`). No difference at runtime — both
ultimately call `saveConfigFile`
(`src/services/ConfigService.ts:275-281`, `:948-973`).

### 6.7 No top-level error handler

Unlike `identity` and `telegram` commands, the `nip46` command has no
try/catch. Errors propagate to commander, which prints a stack and exits
non-zero. The Rust port may keep this asymmetry or unify it; the literal
TS behaviour is "no special handling".

---

## 7. Empty whitelist behaviour

### 7.1 Daemon hard error

`src/daemon/Daemon.ts:301-314`:

```
const whitelistedPubkeys = loadedConfig.whitelistedPubkeys;
if (!whitelistedPubkeys) {
    throw new Error("whitelistedPubkeys not configured");
}
this.whitelistedPubkeys = whitelistedPubkeys;
…
if (this.whitelistedPubkeys.length === 0) {
    throw new Error("No whitelisted pubkeys configured. Run 'tenex onboard' first.");
}
```

Two distinct error messages depending on whether the field is *absent*
(`undefined`) versus *present-but-empty* (`[]`):

| State | Error (verbatim) |
|-------|------------------|
| Field missing | `whitelistedPubkeys not configured` |
| Field is `[]` | `No whitelisted pubkeys configured. Run 'tenex onboard' first.` |

The Rust port **must** preserve both wordings exactly — they are surfaced
to operators in logs, supervisor output, and in the user-facing daemon
crash reports. The second one is also referenced verbatim by the
caller's spec brief.

### 7.2 No warning UI

Outside of the daemon hard-error path:

- The `tenex config identity` menu functions normally with an empty
  whitelist (top of menu prints `  No authorized pubkeys.`, no warning,
  no special call-to-action). `src/commands/config/identity.ts:15-16`.
- `runInteractiveSetup` (`src/commands/config/interactive.ts:15-19`)
  triggers the `promptForPubkeys` loop (§2.3) only when the existing
  whitelist is empty.
- `runOnboarding` always writes a fresh `whitelistedPubkeys` array (the
  newly created or imported identity's pubkey is the sole entry) before
  saving — `src/commands/onboard.ts:1411-1420`.

### 7.3 Other empty-state behaviours

- `ConfigService.getWhitelistedPubkeys()` returns `[]` when the field is
  missing or non-array (`src/services/ConfigService.ts:666-689`). It
  does not throw.
- `ConfigService.getWhitelistedIdentities()` always emits the
  `nostr:<pubkey>` derived entries even if `whitelistedIdentities` is
  empty (`src/services/ConfigService.ts:695-716`).
- Trust-pubkey lookups use a cached empty `Set` and return `false` for
  any pubkey when the whitelist is empty
  (`src/services/trust-pubkeys/TrustPubkeyService.ts:280-294`).

---

## 8. Color usage

All ANSI colors flow through two modules:

### 8.1 Inquirer prompts

`src/utils/cli-theme.ts:1-13`:

```
amber       = chalk.hex("#FFC107")
inquirerTheme = {
  prefix: { idle: amber("?"), done: chalk.green("✓") },
  icon:   { cursor: amber("❯") },
  style:  {
    highlight: amber,
    answer:    amber,
  },
};
```

This theme is passed to **every** identity / telegram / nip46 prompt that
sets `theme: inquirerTheme`. Notably the `nip46.confirm` for enable/disable
omits the theme (uses inquirer's default Y/N rendering).

### 8.2 Onboarding / shared display

`src/commands/config/display.ts:1-124`. Palette (xterm-256):

| Name | Code | Used by |
|------|------|---------|
| `ACCENT` (amber) | `chalk.ansi256(214)` | step headers, hint arrow `→`, "Done" labels, setup-complete `▲` |
| `INFO` (sky blue) | `chalk.ansi256(117)` | summary line labels |
| `SELECTED` (bright green) | `chalk.ansi256(114)` | provider checkboxes `[✓]` |
| logo `DARK` | `chalk.ansi256(130)` | logo bottom row |
| logo `MID` | `chalk.ansi256(172)` | logo row 4 |
| logo `BRIGHT` | `chalk.ansi256(220)` | logo row 2 |
| logo `GLOW` | `chalk.ansi256(222)` | logo top row |

Note: `display.ts` documents the accent as "amber #FFC107" (line 4)
yet uses xterm-256 code 214; the inquirer theme uses true-color
`#FFC107`. The Rust TUI must reproduce both — xterm-256 #214 for the
display module's outputs and 24-bit `#FFC107` for inquirer prompts
(or pick one and accept the slight visual delta).

### 8.3 Local color usage in this scope

| Site | Color | Source |
|------|-------|--------|
| Identity menu — empty list | `chalk.dim` | `src/commands/config/identity.ts:16` |
| Identity menu — confirmation `✓ Pubkey added.` | `chalk.green` for `✓`, `chalk.bold` for text | `src/commands/config/identity.ts:47` |
| Identity menu — error | `chalk.red` | `src/commands/config/identity.ts:67` |
| Telegram DM menu — empty `none` | `chalk.dim` | `src/commands/config/telegram.ts:329` |
| Telegram DM menu — confirmation | `chalk.green` + `chalk.bold` | `src/commands/config/telegram.ts:389` |
| NIP-46 menu — `Back` label | `chalk.dim` | `src/commands/config/nip46.ts:22`, `:95` |
| NIP-46 menu — confirmations | `chalk.green` | `src/commands/config/nip46.ts:39`, `:80`, `:137`, `:156` |
| Paths — confirmation | `chalk.green` | `src/commands/config/paths.ts:50` |
| Onboard — failure messages | `chalk.red` | `src/commands/onboard.ts:1327`, `:1547` |

### 8.4 Inquirer separator colors

The Settings menu uses `chalk.dim` for separators
`── ${section.header} ──` and the trailing `Back` entry
(`src/commands/config/index.ts:86`, `:100`). Not directly inside the
identity scope, but relevant for parity when reaching it.

---

## 9. Cross-references

- Daemon boot sequence consuming this state: `src/daemon/Daemon.ts:280-470`.
- Config layer/file format: `src/services/config/types.ts:133-255`.
- Config IO: `src/services/ConfigService.ts:101-103` (paths), `:275-301` (save), `:632-716` (helpers), `:948-973` (atomic write).
- Backend kind:0 profile publisher: `src/nostr/AgentProfilePublisher.ts:415-475`.
- NIP-46 service: `src/services/nip46/Nip46SigningService.ts:1-498`.
- Trust evaluation: `src/services/trust-pubkeys/TrustPubkeyService.ts:1-388`.

---

## 10. Port checklist

- [ ] `whitelistedPubkeys` add prompt accepts arbitrary text (no decode)
      and stores trimmed verbatim.
- [ ] `--pubkey` CLI flag decodes hex64 / npub / nprofile per §2.2 with
      identical error wording.
- [ ] `whitelistedIdentities` Telegram subset: prefix-match `telegram:`
      only; non-Telegram entries are preserved on save.
- [ ] `tenexPrivateKey` auto-generated lazily, hex-string at rest, no
      regenerate UI.
- [ ] `backendName` editable only inside `Paths` submenu, default
      `"tenex backend"`, empty submission stored as missing.
- [ ] NIP-46 enable check uses `!== false` (undefined ⇒ enabled at the
      service level).
- [ ] Bunker URI auto-construction matches §6.5 byte-for-byte (URI
      encoding of relay).
- [ ] Daemon emits the two distinct error strings for missing-vs-empty
      whitelist (§7.1).
- [ ] All confirmation lines use `chalk.green("✓")` + bold text per the
      audit table in §8.3.
- [ ] No file-permission tightening (default umask) on `config.json`
      writes — match TS behaviour exactly; do not introduce 0600 unless
      the user requests it.
