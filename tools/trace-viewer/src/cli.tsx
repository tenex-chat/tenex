#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './components/App.js';

// Parse command-line arguments
const args = process.argv.slice(2);
const jaegerUrl = args.find(arg => arg.startsWith('--jaeger='))?.split('=')[1] || 'http://localhost:16686';
const serviceName = args.find(arg => arg.startsWith('--service='))?.split('=')[1] || 'tenex-daemon';

// Show usage if help flag is present
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
TENEX Trace Viewer

Usage: trace-viewer [options]

Options:
  --jaeger=<url>      Jaeger URL (default: http://localhost:16686)
  --service=<name>    Service name to filter traces (default: tenex-daemon)
  -h, --help          Show this help message

Examples:
  trace-viewer
  trace-viewer --jaeger=http://localhost:16686
  trace-viewer --service=my-service
  `);
  process.exit(0);
}

// Render the TUI
const { waitUntilExit } = render(<App jaegerUrl={jaegerUrl} serviceName={serviceName} />);

// Wait for user to quit
await waitUntilExit();
