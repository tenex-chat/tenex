#!/usr/bin/env bun

// Internal package entrypoint.
// User-facing TENEX commands are owned by the Rust binaries. The TypeScript
// package is kept for runtime modules that Rust invokes directly, such as the
// Bun agent worker entrypoint.

console.error(
    "The TypeScript TENEX entrypoint is internal. Use the Rust TENEX binary; Rust invokes TypeScript worker modules directly."
);
process.exit(1);
