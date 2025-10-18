#!/bin/bash

# Quick test script to verify OpenTelemetry is working

echo "🧪 Testing OpenTelemetry Integration"
echo "===================================="
echo ""

# Check if Jaeger is running
if ! curl -s http://localhost:16686 > /dev/null 2>&1; then
    echo "⚠️  Jaeger is not running. Starting with Docker..."
    echo ""
    docker run -d --name jaeger \
        -e COLLECTOR_OTLP_ENABLED=true \
        -p 16686:16686 \
        -p 4318:4318 \
        jaegertracing/all-in-one:latest

    echo "⏳ Waiting for Jaeger to start..."
    sleep 5
fi

echo "✅ Jaeger is running at http://localhost:16686"
echo ""
echo "🚀 Starting TENEX daemon..."
echo "   (Press Ctrl+C after a few seconds to stop)"
echo ""

# Run the daemon with telemetry enabled
bun run src/tenex.ts daemon
