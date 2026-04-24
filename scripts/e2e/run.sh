#!/usr/bin/env bash
# TENEX e2e scenario runner.
#
# Usage:
#   scripts/e2e/run.sh                             # all scenarios, serial
#   scripts/e2e/run.sh scripts/e2e/scenarios/01_*.sh
#   scripts/e2e/run.sh --jobs 4
#   scripts/e2e/run.sh --jobs 4 scripts/e2e/scenarios/0*.sh
#
# Responsibilities:
#   1. Build the Rust daemon once (skipped if up-to-date).
#   2. Run each scenario in a fresh `bash` process; capture stdout+stderr;
#      parse the LAST `[harness] RESULT` line for classification.
#   3. Persist run results to scripts/e2e/.status.json (atomic write).
#   4. Regenerate the E2E matrix block in docs/rust/MIGRATION-STATUS.md
#      (only between the <!-- e2e-matrix:start --> / <!-- e2e-matrix:end -->
#      delimiters).
#   5. Print a summary and exit nonzero if any scenario failed or timed out.

set -uo pipefail

# --- Paths -------------------------------------------------------------------

runner_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$runner_dir/../.." && pwd)"
scenarios_root="$runner_dir/scenarios"
artifacts_root="$repo_root/artifacts/e2e"
status_path="$runner_dir/.status.json"
status_doc="$repo_root/docs/rust/MIGRATION-STATUS.md"

# --- Argument parsing --------------------------------------------------------

jobs=1
scenario_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jobs)
      jobs="${2:?--jobs requires a value}"
      shift 2
      ;;
    --jobs=*)
      jobs="${1#--jobs=}"
      shift
      ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --)
      shift
      scenario_args+=("$@")
      break
      ;;
    *)
      scenario_args+=("$1")
      shift
      ;;
  esac
done

if ! [[ "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  printf '[run.sh] invalid --jobs value: %s\n' "$jobs" >&2
  exit 2
fi

# --- Scenario discovery ------------------------------------------------------

scenarios=()
if [[ ${#scenario_args[@]} -eq 0 ]]; then
  shopt -s nullglob
  for f in "$scenarios_root"/*.sh; do
    scenarios+=("$f")
  done
  shopt -u nullglob
else
  shopt -s nullglob
  for arg in "${scenario_args[@]}"; do
    if [[ -f "$arg" ]]; then
      scenarios+=("$arg")
      continue
    fi
    # Treat as glob, relative to CWD then to repo root.
    local_matches=()
    # shellcheck disable=SC2206
    local_matches=( $arg )
    if [[ ${#local_matches[@]} -eq 0 ]]; then
      # shellcheck disable=SC2206
      local_matches=( "$repo_root"/$arg )
    fi
    for m in "${local_matches[@]:-}"; do
      [[ -n "$m" && -f "$m" ]] && scenarios+=("$m")
    done
  done
  shopt -u nullglob
fi

if [[ ${#scenarios[@]} -eq 0 ]]; then
  printf '[run.sh] no scenarios matched\n' >&2
  exit 2
fi

# Sort for deterministic ordering.
IFS=$'\n' scenarios=($(printf '%s\n' "${scenarios[@]}" | sort)); unset IFS

# --- Build Rust daemon -------------------------------------------------------

daemon_bin="$repo_root/target/release/daemon"
daemon_src="$repo_root/crates/tenex-daemon/src"

_needs_build() {
  [[ ! -x "$daemon_bin" ]] && return 0
  local bin_mtime src_mtime
  bin_mtime="$(stat -f %m "$daemon_bin" 2>/dev/null || stat -c %Y "$daemon_bin" 2>/dev/null || echo 0)"
  src_mtime="$(find "$daemon_src" -type f \( -name '*.rs' -o -name 'Cargo.toml' \) -print0 2>/dev/null \
    | xargs -0 stat -f %m 2>/dev/null \
    | sort -n | tail -1)"
  if [[ -z "$src_mtime" ]]; then
    src_mtime="$(find "$daemon_src" -type f \( -name '*.rs' -o -name 'Cargo.toml' \) -exec stat -c %Y {} \; 2>/dev/null \
      | sort -n | tail -1)"
  fi
  [[ -z "$src_mtime" ]] && return 0
  [[ "$src_mtime" -gt "$bin_mtime" ]]
}

if _needs_build; then
  printf '[run.sh] building tenex-daemon (release)...\n' >&2
  if ! ( cd "$repo_root" && cargo build -p tenex-daemon --release ); then
    printf '[run.sh] cargo build failed\n' >&2
    exit 3
  fi
else
  printf '[run.sh] tenex-daemon binary is up to date; skipping build\n' >&2
fi

# --- Run metadata ------------------------------------------------------------

run_started_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
branch="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
commit="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || echo unknown)"

mkdir -p "$artifacts_root"

# --- Scenario runner (one-shot) ----------------------------------------------

# Invoked either inline (serial) or via xargs -P (parallel). Writes a
# result descriptor file per scenario so the parent can aggregate.
run_one() {
  local scenario_path="$1"
  local results_dir="$2"
  local scenario
  scenario="$(basename "$scenario_path")"
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local run_dir="$artifacts_root/$scenario/$ts"
  local log_path="$run_dir/log.txt"
  mkdir -p "$run_dir"

  local t0 t1 duration exit_code
  t0="$(date +%s)"
  bash "$scenario_path" >"$log_path" 2>&1
  exit_code=$?
  t1="$(date +%s)"
  duration=$(( t1 - t0 ))

  # Parse the LAST RESULT line; fall back to exit-code classification.
  local parsed_status=""
  local parsed_detail=""
  local line
  line="$(grep -E '^\[harness\] RESULT status=' "$log_path" 2>/dev/null | tail -1 || true)"
  if [[ -n "$line" ]]; then
    parsed_status="$(printf '%s' "$line" | sed -n 's/^\[harness\] RESULT status=\([a-z_]*\).*$/\1/p')"
    parsed_detail="$(printf '%s' "$line" | sed -n 's/^.*detail=\(.*\)$/\1/p')"
  fi

  local status
  if [[ -n "$parsed_status" ]]; then
    status="$parsed_status"
  else
    case "$exit_code" in
      0)   status="pass" ;;
      77)  status="skip" ;;
      124) status="unknown" ;;  # timeout
      *)   status="fail" ;;
    esac
  fi

  # Emit per-scenario result record (one JSON object per line).
  jq -cn \
    --arg scenario "$scenario" \
    --arg status "$status" \
    --arg detail "$parsed_detail" \
    --arg log_path "$log_path" \
    --argjson exit_code "$exit_code" \
    --argjson duration_s "$duration" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{scenario:$scenario, status:$status, detail:$detail, log_path:$log_path, exit_code:$exit_code, duration_s:$duration_s, ts:$ts}' \
    > "$results_dir/$scenario.json"

  printf '[run.sh] %-48s %-8s (%ds, exit=%d)\n' "$scenario" "$status" "$duration" "$exit_code"
}
export -f run_one
export artifacts_root

# --- Execute -----------------------------------------------------------------

results_dir="$(mktemp -d)"
trap 'rm -rf "$results_dir"' EXIT

if [[ "$jobs" -eq 1 ]]; then
  for s in "${scenarios[@]}"; do
    run_one "$s" "$results_dir"
  done
else
  # xargs -P for true parallelism; -n1 so each scenario is a separate argv.
  printf '%s\n' "${scenarios[@]}" \
    | xargs -I{} -P "$jobs" -n1 bash -c 'run_one "$1" "$2"' _ {} "$results_dir"
fi

# --- Aggregate status --------------------------------------------------------

# Load previous status (for retaining rolling runs[] per scenario).
prev_status="{}"
if [[ -f "$status_path" ]]; then
  prev_status="$(cat "$status_path" 2>/dev/null || echo '{}')"
  # Guard against a corrupted file — jq will error on invalid JSON.
  if ! printf '%s' "$prev_status" | jq -e . >/dev/null 2>&1; then
    prev_status="{}"
  fi
fi

# Build the scenarios object. Start from previous scenarios so selective
# runs (e.g. a single glob) don't wipe history of scenarios we didn't touch
# this invocation.
run_finished_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
new_scenarios_json="$(printf '%s' "$prev_status" | jq -c '.scenarios // {}')"
total=0; pass=0; fail=0; skip=0; unknown=0; phase_partial=0

for s in "${scenarios[@]}"; do
  scenario="$(basename "$s")"
  record_path="$results_dir/$scenario.json"
  [[ -f "$record_path" ]] || continue
  total=$(( total + 1 ))

  record="$(cat "$record_path")"
  status="$(printf '%s' "$record" | jq -r .status)"
  duration_s="$(printf '%s' "$record" | jq -r .duration_s)"
  log_path_v="$(printf '%s' "$record" | jq -r .log_path)"
  detail="$(printf '%s' "$record" | jq -r .detail)"
  ts="$(printf '%s' "$record" | jq -r .ts)"

  case "$status" in
    pass)          pass=$(( pass + 1 )) ;;
    fail)          fail=$(( fail + 1 )) ;;
    skip)          skip=$(( skip + 1 )) ;;
    unknown)       unknown=$(( unknown + 1 )) ;;
    phase_partial) phase_partial=$(( phase_partial + 1 )) ;;
  esac

  # Append to runs[] (keep last 10).
  prev_runs="$(printf '%s' "$prev_status" | jq -c --arg k "$scenario" '.scenarios[$k].runs // []' 2>/dev/null || echo '[]')"
  new_runs="$(jq -cn --argjson prev "$prev_runs" --arg ts "$ts" --arg status "$status" --argjson duration_s "$duration_s" \
    '($prev + [{ts:$ts, status:$status, duration_s:$duration_s}]) | .[-10:]')"

  new_scenarios_json="$(jq -c \
    --arg k "$scenario" \
    --arg status "$status" \
    --arg last_run "$ts" \
    --argjson duration_s "$duration_s" \
    --arg log_path "$log_path_v" \
    --arg detail "$detail" \
    --argjson runs "$new_runs" \
    '. + {($k): {status:$status, last_run:$last_run, duration_s:$duration_s, log_path:$log_path, detail:$detail, runs:$runs}}' \
    <<<"$new_scenarios_json")"
done

final_status_json="$(jq -n \
  --arg last_run "$run_finished_iso" \
  --arg branch "$branch" \
  --arg commit "$commit" \
  --argjson scenarios "$new_scenarios_json" \
  '{last_run:$last_run, branch:$branch, commit:$commit, scenarios:$scenarios}')"

# Atomic write.
tmp_status="$(mktemp "$status_path.tmp.XXXXXX")"
printf '%s\n' "$final_status_json" > "$tmp_status"
mv "$tmp_status" "$status_path"

# --- Regenerate MIGRATION-STATUS.md block ------------------------------------

_regenerate_matrix_block() {
  local doc="$1" status_json="$2"

  [[ -f "$doc" ]] || {
    printf '[run.sh] MIGRATION-STATUS.md not found at %s; skipping matrix update\n' "$doc" >&2
    return 0
  }

  if ! grep -q '<!-- e2e-matrix:start -->' "$doc" || ! grep -q '<!-- e2e-matrix:end -->' "$doc"; then
    printf '[run.sh] matrix delimiters missing in %s; skipping matrix update\n' "$doc" >&2
    return 0
  fi

  # Build table body from status_json scenarios.
  local table
  table="$(jq -r '
    .scenarios
    | to_entries
    | sort_by(.key)
    | (["| scenario | status | last_run | duration | known-issues |",
        "|---|---|---|---|---|"] + (map(
          "| \(.key) | \(.value.status) | \(.value.last_run) | \(.value.duration_s)s | \(.value.detail // "") |"
        )))
    | .[]
  ' <<<"$status_json")"

  local summary_line
  summary_line="_Last run: ${run_finished_iso} · branch \`${branch}\` · commit \`${commit:0:12}\` · total=${total} pass=${pass} fail=${fail} skip=${skip} unknown=${unknown} phase_partial=${phase_partial}_"

  local block_tmp
  block_tmp="$(mktemp)"
  {
    printf '<!-- e2e-matrix:start -->\n'
    printf '%s\n\n' "$summary_line"
    printf '%s\n' "$table"
    printf '<!-- e2e-matrix:end -->\n'
  } > "$block_tmp"

  # awk-based in-place replacement between delimiters.
  local doc_tmp
  doc_tmp="$(mktemp)"
  awk -v block_file="$block_tmp" '
    BEGIN { in_block=0; inserted=0 }
    /<!-- e2e-matrix:start -->/ {
      if (!inserted) {
        while ((getline line < block_file) > 0) print line
        close(block_file)
        inserted=1
      }
      in_block=1
      next
    }
    /<!-- e2e-matrix:end -->/ {
      if (in_block) { in_block=0; next }
    }
    { if (!in_block) print }
  ' "$doc" > "$doc_tmp"

  mv "$doc_tmp" "$doc"
  rm -f "$block_tmp"
}

_regenerate_matrix_block "$status_doc" "$final_status_json"

# --- Summary + exit ----------------------------------------------------------

printf '[run.sh] total=%d pass=%d fail=%d skip=%d unknown=%d\n' \
  "$total" "$pass" "$fail" "$skip" "$unknown"

if [[ $fail -gt 0 || $unknown -gt 0 || $phase_partial -gt 0 ]]; then
  exit 1
fi
exit 0
