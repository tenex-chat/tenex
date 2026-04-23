#!/usr/bin/env bash
set -euo pipefail

umask 077

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
work_root="$(cd "$repo_root/.." && pwd)"
tmp_base="${TMPDIR:-/tmp}"
tmp_base="${tmp_base%/}"

relay_url="${TENEX_INTEROP_RELAY_URL:-wss://relay.tenex.chat}"
ollama_base_url="${TENEX_INTEROP_OLLAMA_BASE_URL:-http://localhost:11434}"
source_agents_dir="${TENEX_INTEROP_SOURCE_AGENTS_DIR:-$HOME/.tenex/agents}"
cli_repo="${TENEX_INTEROP_CLI_REPO:-$work_root/TENEX-TUI-Client-awwmtk}"
default_llm_config="qwen3.5"
project_name="${TENEX_INTEROP_PROJECT_NAME:-NAK Interop Test}"
skip_publish="${TENEX_INTEROP_SKIP_PUBLISH:-0}"

timestamp="$(date +%Y%m%d%H%M%S)"
project_d_tag="${TENEX_INTEROP_PROJECT_D_TAG:-nak-interop-test-${timestamp}-${RANDOM}}"
fixture_root="${TENEX_INTEROP_FIXTURE_ROOT:-$tmp_base/tenex-nak-interop-${timestamp}-$$}"
backend_base="$fixture_root/backend"
cli_data_dir="$backend_base/cli"
agents_dir="$backend_base/agents"
projects_base="$fixture_root/projects"

usage() {
  cat <<'USAGE'
Usage: scripts/setup-nak-interop-fixture.sh

Creates an isolated TENEX backend and tenex-cli fixture using nak for key
generation, pubkey derivation, nsec encoding, and Nostr event publishing.

Environment overrides:
  TENEX_INTEROP_RELAY_URL              Relay to publish to (default: wss://relay.tenex.chat)
  TENEX_INTEROP_OLLAMA_BASE_URL        Ollama base URL (default: http://localhost:11434)
  TENEX_INTEROP_SOURCE_AGENTS_DIR      Source agents dir (default: ~/.tenex/agents)
  TENEX_INTEROP_CLI_REPO               tenex-cli repo path
  TENEX_INTEROP_FIXTURE_ROOT           Fixture root to create
  TENEX_INTEROP_PROJECT_D_TAG          Project d-tag to publish
  TENEX_INTEROP_PROJECT_NAME           Project title to publish
  TENEX_INTEROP_SKIP_PUBLISH=1         Create files without publishing events
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

status() {
  echo "==> $*" >&2
}

require_command() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die "required command not found: $name"
}

compact_output() {
  tr -d '[:space:]'
}

generate_private_key_hex() {
  nak key generate | compact_output
}

public_key_from_private_hex() {
  local private_key_hex="$1"
  nak key public "$private_key_hex" | compact_output
}

nsec_from_private_hex() {
  local private_key_hex="$1"
  nak encode nsec "$private_key_hex" | compact_output
}

validate_hex_key() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[[:xdigit:]]{64}$ ]] || die "$label must be a 64-character hex key"
}

find_agent_file_by_slug() {
  local slug="$1"
  local path
  local match=""
  local count=0

  while IFS= read -r -d '' path; do
    if jq -e --arg slug "$slug" '.slug == $slug' "$path" >/dev/null; then
      match="$path"
      count=$((count + 1))
    fi
  done < <(find "$source_agents_dir" -maxdepth 1 -type f -name '*.json' ! -name 'index.json' -print0)

  if [[ "$count" -eq 0 ]]; then
    die "no source agent with slug '$slug' found in $source_agents_dir"
  fi
  if [[ "$count" -gt 1 ]]; then
    die "multiple source agents with slug '$slug' found in $source_agents_dir"
  fi

  printf '%s\n' "$match"
}

write_agent_copy() {
  local source_file="$1"
  local target_file="$2"
  local agent_nsec="$3"

  jq \
    --arg nsec "$agent_nsec" \
    --arg model "$default_llm_config" \
    '
      def clean_tool:
        select(type == "string")
        | select((startswith("-") | not))
        | sub("^\\+"; "");

      def inherited_tools:
        if (.default.tools? | type) == "array" then
          [.default.tools[] | clean_tool]
        elif (.tools? | type) == "array" then
          [.tools[] | clean_tool]
        elif (.projectOverrides? | type) == "object" then
          [.projectOverrides[] | (.tools? // empty) | .[] | clean_tool] | unique
        else
          []
        end;

      (inherited_tools) as $tools
      | del(
          .eventId,
          .definitionAuthor,
          .definitionCreatedAt,
          .definitionDTag,
          .llmConfig,
          .phases,
          .projectOverrides,
          .projects,
          .telegram,
          .tools
        )
      | .nsec = $nsec
      | .status = "active"
      | .default = ((.default // {}) + { model: $model })
      | if ($tools | length) > 0 then .default.tools = $tools else . end
    ' "$source_file" > "$target_file"
}

publish_whitelist_event() {
  nak event \
    --auth \
    --sec "$user_private_key_hex" \
    --kind 14199 \
    --content "" \
    -p "$backend_pubkey" \
    -p "$transparent_pubkey" \
    -p "$agent1_pubkey" \
    -p "$agent2_pubkey" \
    "$relay_url"
}

publish_project_event() {
  nak event \
    --auth \
    --sec "$user_private_key_hex" \
    --kind 31933 \
    --content "Fixture project for TENEX daemon and CLI interoperability debugging." \
    --tag "title=$project_name" \
    --tag "client=tenex-nak-interop-fixture" \
    --tag "d=$project_d_tag" \
    -p "$transparent_pubkey" \
    -p "$agent1_pubkey" \
    -p "$agent2_pubkey" \
    "$relay_url"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_command nak
require_command jq
require_command find

[[ -d "$source_agents_dir" ]] || die "source agents dir does not exist: $source_agents_dir"
[[ -d "$cli_repo" ]] || die "tenex-cli repo does not exist: $cli_repo"
[[ ! -e "$fixture_root" ]] || die "fixture root already exists: $fixture_root"

status "Locating source agents"
transparent_source="$(find_agent_file_by_slug transparent)"
agent1_source="$(find_agent_file_by_slug agent1)"
agent2_source="$(find_agent_file_by_slug agent2)"

status "Creating fixture directories"
mkdir -p "$agents_dir" "$cli_data_dir" "$backend_base/projects" "$projects_base/$project_d_tag"
chmod 700 "$fixture_root" "$backend_base" "$agents_dir" "$cli_data_dir" "$projects_base" "$projects_base/$project_d_tag"

status "Generating keys with nak"
backend_private_key_hex="$(generate_private_key_hex)"
user_private_key_hex="$(generate_private_key_hex)"
transparent_private_key_hex="$(generate_private_key_hex)"
agent1_private_key_hex="$(generate_private_key_hex)"
agent2_private_key_hex="$(generate_private_key_hex)"

validate_hex_key "backend private key" "$backend_private_key_hex"
validate_hex_key "user private key" "$user_private_key_hex"
validate_hex_key "transparent private key" "$transparent_private_key_hex"
validate_hex_key "agent1 private key" "$agent1_private_key_hex"
validate_hex_key "agent2 private key" "$agent2_private_key_hex"

backend_pubkey="$(public_key_from_private_hex "$backend_private_key_hex")"
user_pubkey="$(public_key_from_private_hex "$user_private_key_hex")"
transparent_pubkey="$(public_key_from_private_hex "$transparent_private_key_hex")"
agent1_pubkey="$(public_key_from_private_hex "$agent1_private_key_hex")"
agent2_pubkey="$(public_key_from_private_hex "$agent2_private_key_hex")"

validate_hex_key "backend pubkey" "$backend_pubkey"
validate_hex_key "user pubkey" "$user_pubkey"
validate_hex_key "transparent pubkey" "$transparent_pubkey"
validate_hex_key "agent1 pubkey" "$agent1_pubkey"
validate_hex_key "agent2 pubkey" "$agent2_pubkey"

user_nsec="$(nsec_from_private_hex "$user_private_key_hex")"
transparent_nsec="$(nsec_from_private_hex "$transparent_private_key_hex")"
agent1_nsec="$(nsec_from_private_hex "$agent1_private_key_hex")"
agent2_nsec="$(nsec_from_private_hex "$agent2_private_key_hex")"
project_a_tag="31933:${user_pubkey}:${project_d_tag}"

status "Writing backend and CLI config"
jq -n \
  --arg backendName "tenex nak interop backend" \
  --arg projectsBase "$projects_base" \
  --arg relay "$relay_url" \
  --arg privateKey "$backend_private_key_hex" \
  --arg userPubkey "$user_pubkey" \
  '{
    backendName: $backendName,
    projectsBase: $projectsBase,
    relays: [$relay],
    tenexPrivateKey: $privateKey,
    whitelistedPubkeys: [$userPubkey],
    nip46: { enabled: true }
  }' > "$backend_base/config.json"

jq -n \
  --arg baseUrl "$ollama_base_url" \
  '{
    providers: {
      ollama: {
        apiKey: $baseUrl,
        baseUrl: $baseUrl
      }
    }
  }' > "$backend_base/providers.json"

jq -n \
  '{
    configurations: {
      "qwen3.5": {
        provider: "ollama",
        model: "qwen3.5:397b-cloud"
      },
      "glm-5": {
        provider: "ollama",
        model: "glm-5:cloud"
      }
    },
    default: "qwen3.5",
    summarization: "qwen3.5",
    supervision: "qwen3.5",
    search: "qwen3.5",
    promptCompilation: "qwen3.5"
  }' > "$backend_base/llms.json"

jq -n \
  --arg nsec "$user_nsec" \
  '{ credentials: { key: $nsec } }' > "$cli_data_dir/config.json"

jq -n \
  --arg backendPubkey "$backend_pubkey" \
  --arg projectATag "$project_a_tag" \
  --arg relay "$relay_url" \
  '{
    last_project_a_tag: $projectATag,
    selected_projects: [$projectATag],
    approved_backend_pubkeys: [$backendPubkey],
    blocked_backend_pubkeys: [],
    configured_relay_url: $relay
  }' > "$cli_data_dir/preferences.json"

status "Writing generated agent identities"
write_agent_copy "$transparent_source" "$agents_dir/$transparent_pubkey.json" "$transparent_nsec"
write_agent_copy "$agent1_source" "$agents_dir/$agent1_pubkey.json" "$agent1_nsec"
write_agent_copy "$agent2_source" "$agents_dir/$agent2_pubkey.json" "$agent2_nsec"
jq -n '{ bySlug: {}, byEventId: {}, byProject: {} }' > "$agents_dir/index.json"

chmod 600 "$backend_base/config.json" "$backend_base/providers.json" "$backend_base/llms.json" "$cli_data_dir/config.json" "$cli_data_dir/preferences.json"
chmod 600 "$agents_dir"/*.json

whitelist_event_id=""
project_event_id=""
if [[ "$skip_publish" == "1" ]]; then
  status "Skipping relay publishing because TENEX_INTEROP_SKIP_PUBLISH=1"
else
  status "Publishing user-authored 14199 whitelist event via nak"
  whitelist_event_json="$(publish_whitelist_event)"
  whitelist_event_id="$(printf '%s' "$whitelist_event_json" | jq -r '.id')"
  validate_hex_key "14199 event id" "$whitelist_event_id"

  status "Publishing user-authored 31933 project event via nak"
  project_event_json="$(publish_project_event)"
  project_event_id="$(printf '%s' "$project_event_json" | jq -r '.id')"
  validate_hex_key "31933 event id" "$project_event_id"
fi

jq -n \
  --arg fixtureRoot "$fixture_root" \
  --arg backendBase "$backend_base" \
  --arg cliDataDir "$cli_data_dir" \
  --arg relay "$relay_url" \
  --arg ollamaBaseUrl "$ollama_base_url" \
  --arg userPubkey "$user_pubkey" \
  --arg backendPubkey "$backend_pubkey" \
  --arg transparentPubkey "$transparent_pubkey" \
  --arg agent1Pubkey "$agent1_pubkey" \
  --arg agent2Pubkey "$agent2_pubkey" \
  --arg projectDTag "$project_d_tag" \
  --arg projectATag "$project_a_tag" \
  --arg whitelistEventId "$whitelist_event_id" \
  --arg projectEventId "$project_event_id" \
  '{
    fixtureRoot: $fixtureRoot,
    backendBaseDir: $backendBase,
    cliDataDir: $cliDataDir,
    relayUrl: $relay,
    ollamaBaseUrl: $ollamaBaseUrl,
    userPubkey: $userPubkey,
    backendPubkey: $backendPubkey,
    agentPubkeys: {
      transparent: $transparentPubkey,
      agent1: $agent1Pubkey,
      agent2: $agent2Pubkey
    },
    projectDTag: $projectDTag,
    projectATag: $projectATag,
    publishedEvents: {
      whitelist14199: $whitelistEventId,
      project31933: $projectEventId
    }
  }' > "$backend_base/interop-fixture.json"
chmod 600 "$backend_base/interop-fixture.json"

cat <<EOF
TENEX_BACKEND_BASE_DIR=$backend_base
TENEX_CLI_DATA_DIR=$cli_data_dir
TENEX_BASE_DIR=$backend_base
TENEX_NSEC=$user_nsec
USER_PUBKEY=$user_pubkey
BACKEND_PUBKEY=$backend_pubkey
PROJECT_D_TAG=$project_d_tag
PROJECT_A_TAG=$project_a_tag
TRANSPARENT_AGENT_PUBKEY=$transparent_pubkey
AGENT1_PUBKEY=$agent1_pubkey
AGENT2_PUBKEY=$agent2_pubkey
WHITELIST_14199_EVENT_ID=$whitelist_event_id
PROJECT_31933_EVENT_ID=$project_event_id

Backend daemon:
  cd "$repo_root" && TENEX_BASE_DIR="$backend_base" cargo run -p tenex-daemon --bin daemon -- --tenex-base-dir "$backend_base"

tenex-cli daemon:
  cd "$cli_repo" && TENEX_BASE_DIR="$backend_base" cargo run -p tenex-cli --bin tenex-cli -- daemon --watch --auto-approve

tenex-cli status:
  cd "$cli_repo" && TENEX_BASE_DIR="$backend_base" cargo run -p tenex-cli --bin tenex-cli -- status
EOF
