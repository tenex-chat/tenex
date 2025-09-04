#!/bin/bash

# Run TypeScript check with proper flags
NODE_OPTIONS="--max-old-space-size=4096" npx tsc \
  --noEmit \
  --skipLibCheck \
  --project tsconfig.json \
  2>&1 | grep -v "node_modules"