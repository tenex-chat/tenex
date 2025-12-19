#!/usr/bin/env bun

// MUST BE FIRST - Initialize OpenTelemetry before any other imports
import { initializeTelemetry } from "./telemetry/setup";
initializeTelemetry();

import { handleCliError } from "@/utils/cli-error";
// CLI entry point for TENEX
import { Command } from "commander";
import { agentCommand } from "./commands/agent/index";
import { daemonCommand } from "./commands/daemon";
import { setupCommand } from "./commands/setup/index";
import { createVCRCommand } from "./commands/vcr/index";
import { initNDK } from "./nostr/ndkClient";

const program = new Command();

program.name("tenex").description("TENEX Command Line Interface").version("0.1.0");

// Add main commands
program.addCommand(agentCommand);
program.addCommand(daemonCommand);
program.addCommand(setupCommand);
program.addCommand(createVCRCommand());

// Initialize NDK before parsing commands
export async function main(): Promise<void> {
    await initNDK();
    program.parse(process.argv);
}

// Only run if called directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        handleCliError(error, "Fatal error in TENEX CLI");
    });
}
