#!/usr/bin/env bun

// MUST BE FIRST - Initialize OpenTelemetry before any other imports
// Read config synchronously to check telemetry setting before importing anything else
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { initializeTelemetry } from "./telemetry/setup";

function isTelemetryEnabled(): boolean {
    const configPath = join(homedir(), ".tenex", "config.json");
    if (!existsSync(configPath)) return true; // default: enabled
    try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        return config.telemetry?.enabled !== false;
    } catch {
        return true; // default: enabled on parse error
    }
}

initializeTelemetry(isTelemetryEnabled());

import { handleCliError } from "@/utils/cli-error";
// CLI entry point for TENEX
import { Command } from "commander";
import { agentCommand } from "./commands/agent/index";
import { daemonCommand } from "./commands/daemon";
import { setupCommand } from "./commands/setup/index";
import { createVCRCommand } from "./commands/vcr/index";
import { createMCPCommand } from "./commands/mcp/index";
import { initNDK } from "./nostr/ndkClient";

const program = new Command();

program.name("tenex").description("TENEX Command Line Interface").version("0.1.0");

// Add main commands
program.addCommand(agentCommand);
program.addCommand(daemonCommand);
program.addCommand(setupCommand);
program.addCommand(createVCRCommand());
program.addCommand(createMCPCommand());

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
