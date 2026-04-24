#!/usr/bin/env bash
# collect_artifacts <dest_dir>
#
# On scenario failure, gather the daemon log, RAL journal, dispatch queue,
# and booted-projects snapshot into <dest_dir>/artifacts.tar.gz.
#
# Reads DAEMON_DIR and HARNESS_DAEMON_LOG from the harness environment. Silently
# skips any file that isn't present (e.g. scenario failed before the daemon
# started).

collect_artifacts() {
  local dest_dir="${1:?collect_artifacts: dest_dir required}"
  mkdir -p "$dest_dir"

  local scratch
  scratch="$(mktemp -d)"
  local bundle_root="$scratch/artifacts"
  mkdir -p "$bundle_root"

  local path dest
  for path in \
    "${HARNESS_DAEMON_LOG:-}" \
    "${DAEMON_DIR:-}/daemon.log" \
    "${DAEMON_DIR:-}/ral/journal.jsonl" \
    "${DAEMON_DIR:-}/ral/snapshot.json" \
    "${DAEMON_DIR:-}/workers/dispatch-queue.jsonl" \
    "${DAEMON_DIR:-}/booted-projects.json" \
    "${HARNESS_RELAY_LOG:-}" \
  ; do
    [[ -n "$path" && -f "$path" ]] || continue
    dest="$bundle_root/$(basename "$(dirname "$path")")_$(basename "$path")"
    cp "$path" "$dest"
  done

  local tarball="$dest_dir/artifacts.tar.gz"
  if ! tar -czf "$tarball" -C "$scratch" artifacts 2>/dev/null; then
    printf '[collect_artifacts] failed to create tarball at %s\n' "$tarball" >&2
    rm -rf "$scratch"
    return 1
  fi

  rm -rf "$scratch"
  printf '[collect_artifacts] wrote %s\n' "$tarball" >&2
  return 0
}
export -f collect_artifacts
