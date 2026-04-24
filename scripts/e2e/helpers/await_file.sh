#!/usr/bin/env bash
# await_file_contains <path> <regex> [timeout_s]
#
# Polls a file until its contents match the given regex (grep -E), or until
# timeout. Returns 0 on match, 1 on timeout, 2 on misuse.
#
# Design notes:
#   - Uses a polling loop with a fixed short interval. This is not an
#     "arbitrary sleep" — the wait terminates the instant the condition is
#     true, which matches superpowers:condition-based-waiting.
#   - Poll interval is 200 ms. Tests tolerate a 200 ms tail-latency; anything
#     finer eats CPU for negligible benefit on wall-clock-bound flows.
#   - If the file doesn't exist yet, keep polling — this is the common case
#     where the producer hasn't opened the file.

await_file_contains() {
  local path="${1:?await_file_contains: path required}"
  local regex="${2:?await_file_contains: regex required}"
  local timeout="${3:-30}"

  local deadline=$(( $(date +%s) + timeout ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if [[ -f "$path" ]] && grep -Eq -- "$regex" "$path" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  printf '[await_file] TIMEOUT: %s did not match /%s/ within %ss\n' "$path" "$regex" "$timeout" >&2
  return 1
}
export -f await_file_contains
