#!/usr/bin/env bun

// MUST BE FIRST - Initialize OpenTelemetry before any other imports
// Read config synchronously to check telemetry setting before importing anything else
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { initializeTelemetry } from "./telemetry/setup";

/**
 * Get the base TENEX directory path for early initialization.
 * Respects TENEX_BASE_DIR environment variable for running multiple isolated instances.
 * This is a minimal inline version used before other imports are available.
 */
function getBasePath(): string {
    return process.env.TENEX_BASE_DIR || join(homedir(), ".tenex");
}

interface TelemetryConfig {
    enabled: boolean;
    serviceName: string;
}

function getTelemetryConfig(): TelemetryConfig {
    const configPath = join(getBasePath(), "config.json");
    const defaults: TelemetryConfig = { enabled: true, serviceName: "tenex-daemon" };

    if (!existsSync(configPath)) return defaults;
    try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        return {
            enabled: config.telemetry?.enabled !== false,
            serviceName: config.telemetry?.serviceName || defaults.serviceName,
        };
    } catch {
        return defaults; // default on parse error
    }
}

const telemetryConfig = getTelemetryConfig();
initializeTelemetry(telemetryConfig.enabled, telemetryConfig.serviceName);

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
