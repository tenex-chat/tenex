#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/jaeger-errors.sh --minutes <n> [options]

Find error spans in Jaeger traces for a service within the last N minutes.

Options:
  -m, --minutes <n>     Look back N minutes (required)
  -s, --service <name>  Jaeger service name (default: tenex-daemon)
  -l, --limit <n>       Max traces to inspect (default: 20)
  --jaeger-url <url>    Jaeger query base URL (default: http://127.0.0.1:16686)
  --ui-url <url>        Jaeger UI base URL (default: same as --jaeger-url)
  -h, --help            Show this help

Examples:
  scripts/jaeger-errors.sh --minutes 10
  scripts/jaeger-errors.sh -m 30 -s tenex-daemon --jaeger-url http://23.88.91.234:16686
EOF
}

minutes=""
service="tenex-daemon"
limit="20"
jaeger_url="http://127.0.0.1:16686"
ui_url=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--minutes)
      minutes="${2:-}"; shift 2 ;;
    -s|--service)
      service="${2:-}"; shift 2 ;;
    -l|--limit)
      limit="${2:-}"; shift 2 ;;
    --jaeger-url)
      jaeger_url="${2:-}"; shift 2 ;;
    --ui-url)
      ui_url="${2:-}"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage; exit 1 ;;
  esac
done

if [[ -z "$minutes" ]]; then
  echo "Error: --minutes is required." >&2
  usage
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required but not found in PATH." >&2
  exit 1
fi

if [[ -z "$ui_url" ]]; then
  ui_url="$jaeger_url"
fi

now_s="$(date +%s)"
start_s="$((now_s - (minutes * 60)))"
start_us="$((start_s * 1000000))"
end_us="$((now_s * 1000000))"

query_url="${jaeger_url}/api/traces?service=${service}&start=${start_us}&end=${end_us}&limit=${limit}"

results="$(curl -sS "$query_url" | jq -r --arg ui "$ui_url" '
  def tagval($span; $k):
    ($span.tags[]? | select(.key == $k) | .value) // null;

  def is_error_span($span):
    (tagval($span; "error") == true)
    or (tagval($span; "error") == "true")
    or (tagval($span; "otel.status_code") == "ERROR")
    or (
      (tagval($span; "http.status_code") != null)
      and ((tagval($span; "http.status_code") | tonumber) >= 400)
    );

  .data[]? as $trace
  | $trace.traceID as $traceID
  | $trace.spans[]? as $span
  | select(is_error_span($span))
  | [
      $traceID,
      $span.spanID,
      $span.operationName,
      ($span.duration / 1000 | floor | tostring) + "ms",
      ($ui + "/trace/" + $traceID + "?uiFind=" + $span.spanID)
    ]
  | @tsv
')"

if [[ -z "$results" ]]; then
  echo "No error spans found for service '${service}' in the last ${minutes} minutes."
  exit 0
fi

printf "traceID\tspanID\toperation\tduration\tlink\n"
printf "%s\n" "$results"
