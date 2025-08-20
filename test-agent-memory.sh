#!/bin/bash

# Test script to verify agents remember their previous responses

echo "Starting TENEX daemon in background..."
bun run daemon &
DAEMON_PID=$!

# Wait for daemon to fully start
sleep 5

echo -e "\n=== Test 1: Ask for a random number ==="
echo "don't use any tools: show me a random number between 1 and 1000" | bun run chat

# Wait for response
sleep 3

echo -e "\n=== Test 2: Ask what number was chosen ==="
echo "what number did you just tell me?" | bun run chat

# Wait for response
sleep 3

echo -e "\n=== Test 3: Ask again to confirm memory ==="
echo "can you repeat the number you said earlier?" | bun run chat

# Wait for final response
sleep 3

echo -e "\n=== Stopping daemon ==="
kill $DAEMON_PID

echo -e "\n=== Checking logs for conversation history ==="
tail -30 .tenex/logs/llms/llm-calls-*.jsonl | grep -A5 -B5 "what number did you"

echo -e "\nTest complete! Check if the agent remembered its previous number."