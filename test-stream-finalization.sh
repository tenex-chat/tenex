#!/bin/bash
set -e

echo "Testing stream finalization before tool calls..."
echo ""

# Start tenex daemon if not running
npx tenex daemon start

# Create a test request that will trigger multiple tool calls
echo "Sending test request that uses the shell tool multiple times..."
echo ""

# Send a message that will trigger multiple shell tool calls
TEST_RESPONSE=$(npx tenex send "Please run 'ls' command exactly 3 times" --agent system --model gemini-2.5-pro-preview 2>&1)

echo "Response received. Checking event flow..."
echo ""

# The fix should ensure that:
# 1. Each tool call is preceded by a finalized stream (kind:1111)
# 2. New streams start fresh after each tool execution
# 3. No accumulated content across tool boundaries

echo "Test completed. Check the Nostr events to verify:"
echo "1. kind:21111 streaming events are properly segmented"
echo "2. kind:1111 finalization happens before each tool execution"
echo "3. Content doesn't accumulate across tool boundaries"
echo ""
echo "You can verify the events using your Nostr client or event viewer."