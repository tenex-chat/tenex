#!/bin/bash

# Start TENEX backend with mock LLM provider for iOS testing
# This preserves all backend business logic - only LLM calls are mocked

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🧪 Starting TENEX Backend with Mock LLM Provider"
echo "================================================"
echo ""
echo "This mode runs the REAL backend with all business logic intact:"
echo "  ✅ Agent routing and orchestration"
echo "  ✅ Tool execution and validation"  
echo "  ✅ Event publishing and handling"
echo "  ✅ Conversation management"
echo "  ❌ Only LLM API calls are mocked"
echo ""

# Create test project directory
TEST_PROJECT_DIR="/tmp/tenex-ios-test-$(date +%s)"
mkdir -p "$TEST_PROJECT_DIR"

echo "📁 Test project directory: $TEST_PROJECT_DIR"
echo ""

# Start backend with mock provider
cd "$PROJECT_DIR"

# Simple mock mode (default)
if [ "$1" == "simple" ] || [ -z "$1" ]; then
    echo "🎯 Using Simple Mock Provider"
    echo "   Predetermined responses based on patterns"
    echo ""
    
    LLM_PROVIDER=mocked \
    DEBUG=true \
    bun run daemon --projectPath "$TEST_PROJECT_DIR"

# Complex mock with scenarios
elif [ "$1" == "scenarios" ]; then
    echo "🎬 Using Scenario-based Mock Provider"
    echo "   Complex event sequences for testing"
    echo ""
    
    LLM_PROVIDER=mock \
    MOCK_SCENARIOS=ios-all \
    DEBUG=true \
    bun run daemon --projectPath "$TEST_PROJECT_DIR"

# Custom provider
else
    echo "🔧 Using custom provider: $1"
    echo ""
    
    LLM_PROVIDER="$1" \
    DEBUG=true \
    bun run daemon --projectPath "$TEST_PROJECT_DIR"
fi