# TENEX Khatru Relay Makefile
# Builds for macOS arm64 and x86_64
# Pure Go - no CGO required for cross-compilation

VERSION ?= 0.1.0
LDFLAGS := -ldflags="-s -w -X main.Version=$(VERSION)"

# Output directory
DIST_DIR := dist

# Binary names
BINARY_NAME := tenex-relay
ARM64_BINARY := $(DIST_DIR)/$(BINARY_NAME)-arm64
AMD64_BINARY := $(DIST_DIR)/$(BINARY_NAME)-x86_64

.PHONY: all clean build-arm64 build-amd64 build deps test run gen-config version

# Default target: build both architectures
all: build

# Build for both architectures
build: build-arm64 build-amd64

# Create dist directory
$(DIST_DIR):
	mkdir -p $(DIST_DIR)

# Download dependencies
deps:
	go mod download
	go mod tidy

# Build for macOS ARM64 (Apple Silicon)
build-arm64: $(DIST_DIR) deps
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build $(LDFLAGS) -o $(ARM64_BINARY) .
	@echo "Built $(ARM64_BINARY)"

# Build for macOS AMD64 (Intel)
build-amd64: $(DIST_DIR) deps
	GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build $(LDFLAGS) -o $(AMD64_BINARY) .
	@echo "Built $(AMD64_BINARY)"

# Run tests
test:
	go test -v ./...

# Clean build artifacts
clean:
	rm -rf $(DIST_DIR)
	go clean

# Development: build and run locally
run: deps
	go run . -config ~/.tenex/relay/relay.json

# Generate default config
gen-config:
	go run . -gen-config -config ~/.tenex/relay/relay.json

# Show version
version:
	@echo "Version: $(VERSION)"

# Verify binary works (for CI)
verify-arm64: build-arm64
	file $(ARM64_BINARY) | grep -q "arm64"
	@echo "ARM64 binary verified"

verify-amd64: build-amd64
	file $(AMD64_BINARY) | grep -q "x86_64"
	@echo "AMD64 binary verified"
