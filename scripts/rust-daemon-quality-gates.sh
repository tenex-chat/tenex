#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

run_ignored_test() {
  local gate_label="$1"
  local test_filter="$2"

  echo "==> rust interop gate: ${gate_label}"
  cargo test -p tenex-daemon "${test_filter}" -- --ignored --exact --test-threads=1
}

worker_interop_enabled="${TENEX_RUN_RUST_WORKER_INTEROP:-0}"
publish_interop_enabled="${TENEX_RUN_RUST_PUBLISH_INTEROP:-0}"
all_interop_enabled="${TENEX_RUN_RUST_ALL_INTEROP:-0}"
legacy_interop_enabled="${TENEX_RUN_RUST_INTEROP:-0}"
runtime_spine_enabled="${TENEX_RUN_RUST_DAEMON_RUNTIME_SPINE:-0}"
runtime_spine_test_filter="${TENEX_RUN_RUST_DAEMON_RUNTIME_SPINE_FILTER:-daemon_worker_runtime::tests::bun_agent_worker_real_bun_runtime_spine_round_trips_filesystem_state}"

cargo fmt --check
cargo test -p tenex-daemon --no-fail-fast
cargo clippy -p tenex-daemon --all-targets -- -D warnings

if [[ "${all_interop_enabled}" == "1" ]]; then
  worker_interop_enabled="1"
  publish_interop_enabled="1"
  runtime_spine_enabled="1"
fi

if [[ "${legacy_interop_enabled}" == "1" ]]; then
  publish_interop_enabled="1"
fi

if [[ "${worker_interop_enabled}" == "1" ]]; then
  run_ignored_test "worker: protocol probe" \
    "worker_process::tests::bun_protocol_probe_round_trips_over_stdio"
  run_ignored_test "worker: mock execution" \
    "worker_process::tests::bun_agent_worker_mock_execution_round_trips_over_stdio"
  run_ignored_test "worker: real tool execution" \
    "worker_process::tests::bun_agent_worker_real_tool_execution_round_trips_filesystem_state"
  run_ignored_test "worker: real non-initial ral" \
    "worker_process::tests::bun_agent_worker_real_non_initial_ral_round_trips_filesystem_state"
  run_ignored_test "worker: real delegation" \
    "worker_process::tests::bun_agent_worker_real_delegation_reports_waiting_state"
  run_ignored_test "worker: real no response" \
    "worker_process::tests::bun_agent_worker_real_no_response_reports_terminal_state"
fi

if [[ "${worker_interop_enabled}" == "1" || "${runtime_spine_enabled}" == "1" ]]; then
  run_ignored_test "daemon worker runtime: real Bun spine" \
    "${runtime_spine_test_filter}"
fi

if [[ "${publish_interop_enabled}" == "1" ]]; then
  run_ignored_test "publish" \
    "worker_process::tests::bun_agent_worker_publish_requests_relay_through_rust_outbox"
fi
