#!/usr/bin/env bash
#
# Architecture Review Script
# Uses Claude Code to review staged changes against architectural principles
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get the root directory
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

# Check if there are staged changes
if ! git diff --cached --quiet; then
    echo -e "${YELLOW}Running architecture review...${NC}"

    # Get staged files
    STAGED_FILES=$(git diff --cached --name-only)

    echo "Staged files:"
    echo "$STAGED_FILES"
    echo ""

    # Check if Claude Code is available
    if ! command -v claude-code &> /dev/null; then
        echo -e "${YELLOW}Warning: claude-code not found. Skipping AI review.${NC}"
        echo "Install Claude Code to enable AI-powered architecture reviews."
        exit 0
    fi

    # Run Claude Code review using the hook instructions
    # Note: This is a placeholder - actual implementation depends on Claude Code CLI
    # For now, just run the architecture linter
    if [ -f "scripts/lint-architecture.ts" ]; then
        echo "Running static architecture checks..."
        bun run scripts/lint-architecture.ts
        exit $?
    fi

    # If linter doesn't exist yet, pass through
    echo -e "${GREEN}Static checks not yet implemented. Proceeding...${NC}"
    exit 0
else
    echo "No staged changes to review."
    exit 0
fi
