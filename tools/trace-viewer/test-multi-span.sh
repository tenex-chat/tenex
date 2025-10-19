#!/bin/bash
# Test script to view a trace with multiple spans
cd "$(dirname "$0")"
TRACE_ID="09463ee0f13c779e76719a70fad0f17f"
echo "Testing trace viewer with multi-span trace: $TRACE_ID"
echo "This trace has $(curl -s "http://localhost:16686/api/traces/$TRACE_ID" | jq '.data[0].spans | length') spans"
echo ""
echo "Starting trace viewer..."
bun run dev
