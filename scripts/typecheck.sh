#!/bin/bash

# Type check script that avoids node_modules memory issues
echo "Running TypeScript type check on src/ files..."

# Use tsc with project config but increase memory
NODE_OPTIONS="--max-old-space-size=8192" npx tsc \
  --noEmit \
  --skipLibCheck \
  --project tsconfig.json \
  2>&1 | grep -E "^src/" || true

# Check exit code of tsc (not grep)
if [ ${PIPESTATUS[0]} -eq 0 ]; then
  echo "✅ No TypeScript errors found!"
  exit 0
else
  echo "❌ TypeScript errors found in src/ files"
  exit 1
fi