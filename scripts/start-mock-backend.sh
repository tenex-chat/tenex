#!/usr/bin/env bash

# Start TENEX Backend with Mock LLM Provider for iOS Testing
# This script launches the backend with predetermined responses for iOS app testing

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🎭 TENEX Mock Backend for iOS Testing${NC}"
echo "========================================"
echo ""

# Configuration
MOCK_TYPE=${1:-all}  # Default to all scenarios
PORT=${PORT:-3000}
DEBUG=${DEBUG:-false}

# Display configuration
echo -e "${YELLOW}Configuration:${NC}"
echo "  Mock Scenarios: ios-$MOCK_TYPE"
echo "  Port: $PORT"
echo "  Debug: $DEBUG"
echo ""

# Check if in correct directory
if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: Not in TENEX backend directory${NC}"
    echo "Please run this script from the TENEX-ff3ssq directory"
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    bun install
fi

# Create test project directory if it doesn't exist
TEST_PROJECT_DIR="./tests/fixtures/ios-testing"
if [ ! -d "$TEST_PROJECT_DIR" ]; then
    echo -e "${YELLOW}Creating test project directory...${NC}"
    mkdir -p "$TEST_PROJECT_DIR"
    
    # Create a basic tenex.json config
    cat > "$TEST_PROJECT_DIR/tenex.json" << EOF
{
  "version": "1.0.0",
  "projectName": "iOS Test Project",
  "description": "Test project for iOS app validation",
  "agents": {
    "executor": {
      "name": "executor",
      "description": "Executes implementation tasks",
      "llmConfig": "mock"
    },
    "planner": {
      "name": "planner", 
      "description": "Plans and designs solutions",
      "llmConfig": "mock"
    }
  }
}
EOF
    
    # Create README for the test project
    cat > "$TEST_PROJECT_DIR/README.md" << EOF
# iOS Test Project

This is a mock project used for testing the iOS app with predetermined backend responses.

## Testing Scenarios

The backend is configured to respond with mock data for:
- Basic greetings
- File operations
- Error handling
- Multi-agent workflows
- Long-running tasks

## Files

This directory simulates a real project structure for testing.
EOF

    # Create mock source files
    mkdir -p "$TEST_PROJECT_DIR/src"
    echo "// Mock main.swift file for testing" > "$TEST_PROJECT_DIR/src/main.swift"
    echo "// Mock utils.swift file for testing" > "$TEST_PROJECT_DIR/src/utils.swift"
    
    mkdir -p "$TEST_PROJECT_DIR/tests"
    echo "// Mock test.swift file for testing" > "$TEST_PROJECT_DIR/tests/test.swift"
    
    # Create Package.swift
    cat > "$TEST_PROJECT_DIR/Package.swift" << EOF
// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "IOSTestProject",
    dependencies: [],
    targets: [
        .target(name: "IOSTestProject", dependencies: [])
    ]
)
EOF
fi

echo -e "${GREEN}✓ Test project ready at: $TEST_PROJECT_DIR${NC}"
echo ""

# Export environment variables
export LLM_PROVIDER=mock
export MOCK_MODE=true
export MOCK_SCENARIOS="ios-$MOCK_TYPE"
export DEBUG=$DEBUG
export PORT=$PORT
export PROJECT_PATH="$TEST_PROJECT_DIR"

# Available mock scenario types
echo -e "${BLUE}Available Mock Scenarios:${NC}"
echo "  • basic     - Simple greeting and responses"
echo "  • files     - File creation and listing"
echo "  • errors    - Error simulation"
echo "  • multi-agent - Multi-agent delegation"
echo "  • long-tasks - Long-running operations"
echo "  • all       - All scenarios (default)"
echo ""

# Function to handle cleanup
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down mock backend...${NC}"
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Display testing instructions
echo -e "${GREEN}🚀 Starting mock backend...${NC}"
echo ""
echo -e "${BLUE}iOS Testing Instructions:${NC}"
echo "1. Configure iOS app to connect to: http://localhost:$PORT"
echo "2. Use relay URL: ws://localhost:8080"
echo "3. Test scenarios will provide deterministic responses"
echo ""
echo -e "${YELLOW}Test Commands from iOS:${NC}"
echo '  "hello" or "hi"          → Greeting with project status'
echo '  "create a file"          → File creation workflow'
echo '  "list files"             → Show project inventory'
echo '  "analyze code"           → Multi-agent delegation'
echo '  "build project"          → Long-running task simulation'
echo '  "simulate error"         → Error handling test'
echo ""
echo -e "${GREEN}Press Ctrl+C to stop the server${NC}"
echo "----------------------------------------"
echo ""

echo -e "${RED}This script used the removed TypeScript daemon CLI.${NC}"
echo "Use the Rust daemon and Rust/Bun worker fixtures for mock backend testing."
exit 1
