#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

cargo fmt --check
cargo test -p tenex-daemon --no-fail-fast
cargo clippy -p tenex-daemon --all-targets -- -D warnings

if [[ "${TENEX_RUN_RUST_INTEROP:-0}" == "1" ]]; then
  cargo test -p tenex-daemon \
    worker_process::tests::bun_agent_worker_publish_requests_relay_through_rust_outbox \
    -- --ignored --exact --test-threads=1
fi
